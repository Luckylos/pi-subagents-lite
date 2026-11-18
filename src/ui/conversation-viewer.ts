import type { ExtensionOwner } from "../shell.ts";
/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 * Adapted for pi-subagents-lite type shapes.
 */

import { getHideThinkingBlock } from "../pi-settings.ts";

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { canRequestStop } from "../agents/agent-status.ts";
import { captureRunAction, messageIntent, MessageComposer, STALE_RUN_REASON, submitToRun } from "./message-composer.ts";
import type { AgentRecord, AgentSubmissionResult } from "../types.ts";
import { getSessionContextPercent } from "../agents/usage.ts";
import { extractText } from "../prompt/context.ts";
import type { Theme } from "./types.ts";
import { makeMarkdownTheme } from "./markdown-theme.ts";
import {
  buildInvocationTags,
  buildStatsParts,
  fgPreservingNestedStyles,
  getDisplayName,
  resolveAgentModelLabel,
  statusIcon,
} from "./format.ts";
import { plainText } from "./sanitize.ts";
import { summarizeToolArgs } from "../utils.ts";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.ts";

/** Fixed chrome lines: top border + 2 header rows + 2 separators + footer + bottom border. */
const CHROME_LINES_BASE = 7;
const MIN_VIEWPORT = 3;
/** Cap viewport height at this % of terminal rows so the bordered box fits without clipping. */
export const VIEWPORT_HEIGHT_PCT = 70;
/** Debounce interval for streaming renders — reduces CPU during fast token arrival. */
const STREAM_RENDER_DEBOUNCE_MS = 100;
type AgentMessage = AgentSession["messages"][number];

interface DisplayToolObject {
  [key: string]: DisplayToolValue;
}
type DisplayToolValue = string | number | boolean | null | undefined | DisplayToolValue[] | DisplayToolObject;

/** Copy JSON tool arguments before summarizing: JSON escaping would hide raw C0 controls. */
function plainToolValue(value: unknown): DisplayToolValue {
  if (typeof value === "string") return plainText(value);
  if (Array.isArray(value)) return value.map(plainToolValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [plainText(key), plainToolValue(item)]));
  }
  return typeof value === "number" || typeof value === "boolean" || value === null ? value : undefined;
}

/**
 * What a tool result contributes to rendering: only whether the call errored.
 * Result content never renders — the lookup exists solely to pick the call
 * line's status color.
 */
interface ToolResultStatus {
  isError: boolean;
}

export class ConversationViewer implements Component {
  private modelDisplayStyle: "id" | "name" = "id";
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Cache only completed transcript rows. The SDK owns the in-flight assistant. */
  private messageCache = new Map<number, string[]>();
  private cacheMeta: { count: number; width: number; messagesRef?: AgentMessage[] } = { count: 0, width: 0 };
  private cachedContentLines: string[] | undefined;
  private streamingCache: { message: AgentMessage; width: number; lines: string[] } | undefined;
  /** Execution ends can precede the durable toolResult messages in parallel mode. */
  private provisionalToolResults = new Map<string, ToolResultStatus>();
  private toolResults = new Map<string, ToolResultStatus>();

  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed: ReturnType<typeof captureRunAction> | undefined;
  private stopFeedback: { text: string; phase: AgentRecord["lifecycle"]["phase"] } | undefined;
  private keys: ViewerKeys;
  private composer: MessageComposer | undefined;
  private draft: { composer: MessageComposer; target: ReturnType<typeof captureRunAction> } | undefined;
  /** Debounce timer for streaming renders — avoids fighting the TUI's 16ms loop. */
  private renderTimer: ReturnType<typeof setTimeout> | undefined;

  /** Thinking visibility: starts with pi's setting, toggled locally with ctrl+T. */
  private thinkingVisible: boolean;

  constructor(
    private owner: ExtensionOwner,
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted -> no stop affordance (e.g. read-only history). */
    private onStop?: (target: ReturnType<typeof captureRunAction>) => string | void,
    /** User keybindings from `ctx.ui.custom()`. Omitted -> hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted -> no compose affordance. */
    private onSteer?: (message: string) => Promise<AgentSubmissionResult>,
  ) {
    this.thinkingVisible = !getHideThinkingBlock();
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe((event) => {
      if (this.closed) return;
      switch (event?.type) {
        case "message_start":
        case "message_update":
        case "message_end":
          // The SDK may reuse the same cumulative partial object across updates.
          this.streamingCache = undefined;
          this.scheduleRender();
          break;
        case "entry_appended":
        case "compaction_end":
          this.scheduleRender();
          break;
        case "tool_execution_end":
          if (event.parentToolCallId) break;
          this.provisionalToolResults.set(event.toolCallId, { isError: event.isError });
          this.invalidateToolCalls(new Set([event.toolCallId]));
          this.scheduleRender();
          break;
        case "agent_end":
        case "agent_settled":
          this.scheduleRender();
          break;
      }
    });
  }
  private scheduleRender(): void {
    if (this.renderTimer !== undefined) return; // already scheduled
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, STREAM_RENDER_DEBOUNCE_MS);
  }

  private renderMessage(msg: AgentMessage, width: number, toolResults: Map<string, ToolResultStatus>): string[] {
    switch (msg.role) {
      case "user":
        return this.renderUserMessage(msg, width);
      case "assistant":
        return this.renderAssistantMessage(msg, width, toolResults);
      case "toolResult":
        // Results never render: only the tool call line (with its status
        // background) represents the call in the viewer.
        return [];
      default:
        return [];
    }
  }

  handleInput(data: string): void {
    if (this.closed) return; // already closing, ignore stray keys
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels -- both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens a composer only when the current run accepts messages.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = undefined;
      this.stopFeedback = undefined;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "s" arms, second confirms -- any other key disarms.
    if (matchesKey(data, "s")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          const target = this.stopArmed;
          this.stopArmed = undefined;
          const text = this.onStop?.(target);
          this.stopFeedback = text ? { text, phase: this.record.lifecycle.phase } : undefined;
        } else {
          this.stopArmed = captureRunAction(this.owner, this.record);
          this.stopFeedback = undefined;
        }
        this.tui.requestRender();
      } else {
        this.stopArmed = undefined;
      }
      return;
    }
    this.stopArmed = undefined;
    this.stopFeedback = undefined;

    if (data === "\x14") {
      this.thinkingVisible = !this.thinkingVisible;
      this.invalidate(); // Clear cache so messages re-render with new visibility
      this.tui.requestRender();
      return;
    }

    const viewportHeight = this.viewportHeight();
    const maxScroll = this.scrollMax();

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home") || data === "g") {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end") || data === "G") {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (this.closed) return []; // closing — framework may still call render after done()
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const row = (content: string) => {
      const padded = content + " ".repeat(Math.max(0, innerW - visibleWidth(content)));
      return th.fg("border", "│") + " " + truncateToWidth(padded, innerW, "...", true) + " " + th.fg("border", "│");
    };
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const name = getDisplayName(this.owner, this.record.display.type);

    const icon = statusIcon(this.owner, this.record.lifecycle.status, th, this.record.display.type || undefined);
    // Build stats line like the widget
    const durationMs = (this.record.lifecycle.completedAt ?? Date.now()) - this.record.lifecycle.startedAt;
    const statsParts = buildStatsParts(
      {
        toolUses: this.record.stats.toolUses,
        turnCount: this.record.stats.turnCount,
        maxTurns: this.record.stats.maxTurns,
        input: this.record.stats.lifetimeUsage.input,
        output: this.record.stats.lifetimeUsage.output,
        contextPercent: getSessionContextPercent(this.session),
        compactions: this.record.stats.compactionCount,
        cost: this.record.stats.lifetimeUsage.cost,
        durationMs,
      },
      th,
    );

    const worktreeTag = this.record.display.worktreeLabel
      ? th.fg("muted", ` @${plainText(this.record.display.worktreeLabel)}`)
      : "";
    const stopping = this.record.lifecycle.phase === "stopping" ? th.fg("warning", " stopping") : "";
    // Row 1: status icon, name, description, worktree
    lines.push(
      row(
        `${icon} ${th.bold(name)}${stopping}  ${th.fg("muted", plainText(this.record.display.description))}${worktreeTag}`,
      ),
    );

    // Row 2: model name + compact usage stats
    const resolvedInvocation = {
      ...this.record.display.invocation,
      thinkingLevel: this.record.execution.session?.thinkingLevel ?? this.record.display.invocation?.thinkingLevel,
    };
    const tags = buildInvocationTags(resolvedInvocation);
    const statsLine = fgPreservingNestedStyles(th, "dim", statsParts.join("·"));

    const modelLabel = resolveAgentModelLabel(this.record, this.modelDisplayStyle);
    if (modelLabel) {
      const parts = [statsLine, ...tags].filter(Boolean);
      lines.push(row(th.fg("dim", `  ${modelLabel} · ${parts.join(" · ")}`)));
    } else {
      lines.push(row(statsLine));
    }
    lines.push(hrMid);

    // Content area
    const completed = this.buildContentLines(innerW);
    const streaming = this.buildStreamingLines(innerW);
    const totalContentLines = completed.length + streaming.length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalContentLines - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    for (let i = 0; i < viewportHeight; i++) {
      const index = visibleStart + i;
      lines.push(row((index < completed.length ? completed[index] : streaming[index - completed.length]) ?? ""));
    }

    // Footer
    lines.push(hrMid);
    // US-2: the action verb distinguishes steering a running agent from
    // continuing a settled one.
    const steerVerb = messageIntent(this.record);
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.input.render(innerW)[0] ?? ""));
      const hint = this.composer.pending ? "Submitting…" : this.composer.feedback;
      if (hint) {
        lines.push(row(th.fg(this.composer.pending ? "dim" : "warning", hint.replace(/\n/g, " "))));
      } else {
        const composeHint = th.fg("dim", "Enter send · Esc cancel");
        const composeLeft = th.fg("accent", `✎ ${this.composer.intent}`);
        const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
        lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
      }
    } else if (this.stopFeedback && this.stopFeedback.phase === this.record.lifecycle.phase) {
      lines.push(row(th.fg("dim", this.stopFeedback.text)));
    } else {
      // Actions on the left, navigation on the right.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", `Enter ${steerVerb}`));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "s again to STOP") : th.fg("dim", "s stop"));
      }
      actions.push(th.fg("dim", "C-t thinking"));
      const footerRight = th.fg("dim", "↑↓ scroll · g/G top/bottom · PgUp/PgDn · Esc/q close");

      // Prepend scroll position readout only when there's spare width
      const currentLine = Math.min(visibleStart + viewportHeight, totalContentLines);
      const scrollPct = totalContentLines <= viewportHeight ? 100 : Math.round((currentLine / totalContentLines) * 100);
      const count = th.fg("dim", `(${currentLine}/${totalContentLines} · ${scrollPct}%)`);
      const withCount = [count, ...actions].join(sep);
      // Always show readout; drop thinking state if needed
      const footerLeft =
        visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
          ? withCount
          : visibleWidth(count) + visibleWidth(footerRight) + 1 <= innerW
            ? count
            : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  private isStoppable(): boolean {
    return !!this.onStop && canRequestStop(this.record);
  }

  private canSteer(): boolean {
    return !!this.onSteer && this.record.execution.session === this.session && !!messageIntent(this.record);
  }

  private openComposer(): void {
    const submit = this.onSteer;
    const intent = messageIntent(this.record);
    if (!submit || !intent) return;
    if (!this.draft?.target.isCurrent() || this.draft.composer.intent !== intent) {
      const target = captureRunAction(this.owner, this.record);
      const composer = new MessageComposer(
        intent,
        submitToRun(this.record, target, intent, (message) => {
          if (this.record.execution.session !== this.session) {
            return Promise.resolve({ accepted: false, reason: "unavailable", message: STALE_RUN_REASON });
          }
          return submit(message);
        }),
        () => {
          this.composer = undefined;
          this.tui.requestRender();
        },
        () => this.tui.requestRender(),
      );
      this.draft = { composer, target };
    }
    this.composer = this.draft.composer;
    this.composer.open();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.messageCache.clear();
    this.cachedContentLines = undefined;
    this.cacheMeta = { count: 0, width: 0 };
    this.streamingCache = undefined;
  }

  dispose(): void {
    this.closed = true;
    this.composer?.hide();
    this.invalidate();
    this.provisionalToolResults.clear();
    this.toolResults.clear();
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }
  setModelDisplayStyle(style: "id" | "name") {
    this.modelDisplayStyle = style;
  }

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight -- otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // Composer adds one extra row (input + hint instead of single footer).
    return CHROME_LINES_BASE + (this.composer ? 1 : 0);
  }

  private scrollMax(): number {
    const width = this.lastInnerW;
    const totalLines = this.buildContentLines(width).length + this.buildStreamingLines(width).length;
    return Math.max(0, totalLines - this.viewportHeight());
  }

  /** A change in the result color invalidates only the corresponding assistant rows. */
  private invalidateToolCalls(ids: Set<string>): void {
    if (ids.size === 0) return;
    this.cachedContentLines = undefined;
    this.streamingCache = undefined;
    const messages = this.cacheMeta.messagesRef;
    for (const index of this.messageCache.keys()) {
      const msg = messages?.[index];
      if (msg?.role === "assistant" && msg.content.some((block) => block.type === "toolCall" && ids.has(block.id))) {
        this.messageCache.delete(index);
      }
    }
  }

  private wrapInBg(bg: string, inner: string[], width: number): string[] {
    const fill = this.theme.bg(bg, " ".repeat(width));
    return [fill, ...inner, fill];
  }

  private renderUserMessage(msg: Extract<AgentMessage, { role: "user" }>, width: number): string[] {
    const th = this.theme;
    const text = plainText(typeof msg.content === "string" ? msg.content : extractText(msg.content));
    if (!text.trim()) return [];
    const wrapped = wrapTextWithAnsi(text.trim(), width - 2);
    const inner: string[] = [];
    for (const line of wrapped) {
      const padNeeded = Math.max(0, width - 2 - visibleWidth(line));
      inner.push(th.bg("userMessageBg", th.fg("userMessageText", ` ${line}${" ".repeat(padNeeded)} `)));
    }
    return [...this.wrapInBg("userMessageBg", inner, width), ""];
  }

  private renderAssistantMessage(
    msg: Extract<AgentMessage, { role: "assistant" }>,
    width: number,
    toolResults: Map<string, ToolResultStatus>,
    streaming = false,
  ): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<{ id?: string; name: string; args?: Record<string, unknown> }> = [];
    for (const c of msg.content) {
      if (c.type === "text" && c.text) textParts.push(c.text);
      else if (c.type === "thinking" && c.thinking) thinkingParts.push(c.thinking);
      else if (c.type === "toolCall") {
        toolCalls.push({ id: c.id, name: c.name, args: c.arguments });
      }
    }
    // Thinking blocks — italic Markdown, matching Pi's assistant-message.ts
    if (thinkingParts.length > 0) {
      if (this.thinkingVisible) {
        const md = new Markdown(plainText(thinkingParts.join("\n\n")).trim(), 1, 0, makeMarkdownTheme(th), {
          color: (text: string) => th.fg("thinkingText", text),
          italic: true,
        });
        lines.push(...md.render(width));
        if (!streaming) lines.push("");
      } else {
        lines.push(...this.renderHiddenThinkingLabel());
      }
    }
    // Assistant text
    if (textParts.length > 0) {
      const md = new Markdown(plainText(textParts.join("\n\n")).trim(), 1, 0, makeMarkdownTheme(th));
      const textLines = md.render(width);
      if (textLines.length > 0) {
        lines.push(...textLines);
        if (!streaming) lines.push("");
      }
    }
    // Tool calls
    for (const tc of toolCalls) {
      lines.push(...this.renderToolCall(tc, width, toolResults));
      lines.push("");
    }
    return lines;
  }

  private renderToolCall(
    tc: { id?: string; name: string; args?: Record<string, unknown> },
    width: number,
    toolResults: Map<string, ToolResultStatus>,
  ): string[] {
    const th = this.theme;
    const args = tc.args
      ? Object.fromEntries(Object.entries(tc.args).map(([key, value]) => [plainText(key), plainToolValue(value)]))
      : undefined;
    const argsSummary = args ? plainText(summarizeToolArgs(tc.name, args)) : "";
    const name = plainText(tc.name);
    const label = argsSummary ? `${name}${argsSummary}` : name;
    // The result's content never renders; this lookup only picks the call
    // line's status color — pending while it runs, success/error once settled.
    const result = tc.id ? toolResults.get(tc.id) : undefined;
    const bg = result ? (result.isError ? "toolErrorBg" : "toolSuccessBg") : "toolPendingBg";
    const inner: string[] = [];
    const toolLine = ` ${th.bold(label)} `;
    for (const tl of wrapTextWithAnsi(toolLine, width - 2)) {
      const padNeeded = Math.max(0, width - visibleWidth(tl));
      inner.push(th.bg(bg, th.fg("toolTitle", `${tl}${" ".repeat(padNeeded)}`)));
    }
    return this.wrapInBg(bg, inner, width);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const messages = this.session.messages;
    const previous = this.cacheMeta;
    const replaced = messages !== previous.messagesRef || messages.length < previous.count;
    if (replaced || width !== previous.width) {
      this.messageCache.clear();
      this.cachedContentLines = undefined;
    }
    if (replaced) this.toolResults.clear();
    if (replaced || messages.length !== previous.count) {
      const changed = new Set<string>();
      for (let i = replaced ? 0 : previous.count; i < messages.length; i++) {
        const result = messages[i];
        if (result.role !== "toolResult") continue;
        const id = result.toolCallId;
        const provisional = this.provisionalToolResults.get(id);
        this.provisionalToolResults.delete(id);
        this.toolResults.set(id, { isError: result.isError });
        if (provisional?.isError !== result.isError) changed.add(id);
      }
      this.invalidateToolCalls(changed);
      this.cachedContentLines = undefined;
    }
    this.cacheMeta = { count: messages.length, width, messagesRef: messages };
    if (this.cachedContentLines) return this.cachedContentLines;

    const results = new Map([...this.provisionalToolResults, ...this.toolResults]);
    const lines: string[] = [];
    for (let i = 0; i < messages.length; i++) {
      let cached = this.messageCache.get(i);
      if (!cached) {
        cached = this.renderMessage(messages[i], width, results);
        this.messageCache.set(i, cached);
      }
      lines.push(...cached);
    }
    this.cachedContentLines = lines;
    return lines;
  }

  private buildStreamingLines(width: number): string[] {
    if (width <= 0) return [];
    const message = this.session.state?.streamingMessage;
    if (message?.role !== "assistant") {
      return this.session.messages.length === 0 ? [this.theme.fg("dim", "(waiting for first message...)")] : [];
    }
    if (this.streamingCache?.message === message && this.streamingCache.width === width) {
      return this.streamingCache.lines;
    }
    // Partial blocks use the same cumulative raw-text sanitization as completed ones.
    const lines = this.renderAssistantMessage(message, width, this.provisionalToolResults, true);
    this.streamingCache = { message, width, lines };
    return lines;
  }

  /**
   * Render the "Thinking..." label shown when thinking blocks are hidden.
   * Matches pi's behavior: italic styling with thinkingText color.
   */
  private renderHiddenThinkingLabel(): string[] {
    const th = this.theme;
    const thinkingText = th.fg("thinkingText", "Thinking...");
    const label = th.italic ? th.italic(thinkingText) : thinkingText;
    return [label, ""];
  }
}
