import type { ExtensionOwner } from "../shell.ts";
/**
 * renderer.ts — Rendering helpers for the Agent tool and subagent-result messages.
 *
 * Extracted from index.ts to separate display concerns from extension wiring.
 */

import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "./types.ts";
import {
  buildStatsParts,
  formatMs,
  getDisplayName,
  buildModelThinkingTag,
  resolveModelLabel,
  statusIcon,
} from "./format.ts";
import { getManager } from "../shell.ts";

// --- Stats rendering helpers ---

/** Format agent display name with optional model/thinking level: "Agent (mimo-v2.5-pro · high)" or "Agent". */
export function agentNameLabel(
  owner: ExtensionOwner,
  d: Record<string, unknown>,
  theme: Theme,
  modelDisplayStyle: "id" | "name" = "id",
): string {
  const typeName = getDisplayName(owner, (d.type as string) || "");
  const tag = modelTag(d, theme, modelDisplayStyle);
  return tag ? `${theme.bold(typeName)} ${theme.fg("dim", tag)}` : theme.bold(typeName);
}

function modelTag(d: Record<string, unknown>, theme: Theme, modelDisplayStyle: "id" | "name" = "id"): string {
  const modelLabel = resolveModelLabel(
    modelDisplayStyle,
    d.modelName as string | undefined,
    d.modelId as string | undefined,
  );
  const thinkingLevel = d.thinkingLevel as string | undefined;
  return buildModelThinkingTag(modelLabel, thinkingLevel);
}

export function buildStatsLine(d: Record<string, unknown>, theme: Theme, showCost: boolean): string {
  const parts = buildStatsParts(
    {
      toolUses: (d.toolUses as number) ?? 0,
      turnCount: d.turnCount as number | undefined,
      maxTurns: d.maxTurns as number | undefined,
      input: (d.input as number) ?? 0,
      output: (d.output as number) ?? 0,
      contextPercent: d.contextPercent as number | null,
      compactions: (d.compactions as number) ?? 0,
      cost: showCost ? (d.cost as number | undefined) : undefined,
    },
    theme,
  );
  parts.push(formatMs(d.durationMs as number));
  return parts.join("·");
}

// --- Agent invalidation map ---

/** Register a row's invalidate function for an agent. Called when rendering a background agent row. */
export function registerAgentInvalidation(owner: ExtensionOwner, agentId: string, invalidate: () => void): void {
  owner.rendererInvalidations.set(agentId, invalidate);
}

/** Trigger re-render of a completed/errored agent's tool row. Called by onComplete callback. */
export function invalidateAgentRow(owner: ExtensionOwner, agentId: string): void {
  owner.rendererInvalidations.get(agentId)?.();
}

/** Clear all invalidation registrations. Called on session_shutdown. */
export function cleanupInvalidations(owner: ExtensionOwner): void {
  owner.rendererInvalidations.clear();
}

// --- Agent tool renderers ---

/** Render the Agent tool call line (e.g., "▸ Agent (model)"). */
export function renderAgentToolCall(
  owner: ExtensionOwner,
  args: Record<string, unknown>,
  theme: Theme,
  context?: { state?: Record<string, unknown>; toolCallId?: string },
): Text {
  const typeName = getDisplayName(owner, (args.agent as string) || "");
  const label = typeName || "Agent";

  // Background agents: show live status from manager, fallback to queued state
  // Check args.run_in_background (initial render) OR context.state.isBackground (re-render after result)
  const isBackground = args.run_in_background === true || context?.state?.isBackground === true;
  let icon: string;

  if (isBackground) {
    // Look up live status from manager using stored agentId
    // Try context.state first, then toolCallId from manager records
    let agentId = context?.state?.agentId as string | undefined;
    if (!agentId) {
      // Find agent by toolCallId from context
      const toolCallId = context?.toolCallId as string | undefined;
      if (toolCallId) {
        const manager = getManager(owner);
        if (manager) {
          const record = manager.listAgents().find((r) => r.display.toolCallId === toolCallId);
          if (record) {
            agentId = record.id;
            if (context?.state) {
              context.state.agentId = agentId;
              context.state.isBackground = true;
            }
          }
        }
      }
    }
    const liveRecord = agentId ? getManager(owner)?.getRecord(agentId) : undefined;
    const status = liveRecord?.lifecycle.status ?? "queued";
    icon = statusIcon(owner, status, theme, (args.agent as string) || undefined);
    let text = `${icon} ${theme.fg("accent", theme.bold(label))}`;

    const modelOverride = args._modelOverride as string | undefined;
    if (modelOverride) {
      text += ` (${modelOverride})`;
    }

    return new Text(text, 0, 0);
  } else {
    // Foreground agents: look up live status from manager using stored agentId
    let agentId = context?.state?.agentId as string | undefined;
    if (!agentId) {
      // Find agent by toolCallId from context
      const toolCallId = context?.toolCallId as string | undefined;
      if (toolCallId) {
        const manager = getManager(owner);
        if (manager) {
          const record = manager.listAgents().find((r) => r.display.toolCallId === toolCallId);
          if (record) {
            agentId = record.id;
            if (context?.state) {
              context.state.agentId = agentId;
            }
          }
        }
      }
    }
    const liveRecord = agentId ? getManager(owner)?.getRecord(agentId) : undefined;
    const status = liveRecord?.lifecycle.status;
    icon = statusIcon(owner, status, theme, (args.agent as string) || undefined);
  }

  // Build the call line text
  let text = `${icon} ${theme.fg("accent", theme.bold(label))}`;

  const modelOverride = args._modelOverride as string | undefined;
  if (modelOverride) {
    text += ` (${modelOverride})`;
  }

  return new Text(text, 0, 0);
}

export function renderAgentToolResult(
  result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
  options: { expanded?: boolean },
  theme: Theme,
  showCost: boolean,
  modelDisplayStyle: "id" | "name" = "id",
  _context?: { state?: Record<string, unknown>; executionStarted?: boolean },
): Text {
  const { expanded } = options;
  const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
  const d = result.details;
  const desc = (d?.description as string) || "";

  // Foreground agents (stats present) — show model + stats + description (icon + name in call line)
  if (d && d.turnCount != null) {
    const statsLine = buildStatsLine(d, theme, showCost);
    const tag = modelTag(d, theme, modelDisplayStyle);
    const modelPart = tag ? `${theme.fg("dim", tag)}·` : "";
    let lines = `  ${modelPart}${statsLine}\n  ${theme.fg("text", desc)}`;
    if (expanded && text) {
      lines +=
        "\n" +
        text
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n");
    }
    return new Text(lines, 0, 0);
  }

  // Background agents — description only (icon + status are in the call line)
  // The call renderer handles the icon and status text
  return new Text(desc ? `  ${theme.fg("text", desc)}` : "", 0, 0);
}

/**
 * Result row for the agent tools that report one status line (StopAgent, MessageAgent):
 * pi's result text with the success/error mark. The mark comes from pi's render context,
 * not the result, because a thrown error reaches here as a failed call.
 */
export function renderStatusLine(
  result: { content: Array<{ type: string; text?: string }> },
  _options: { expanded?: boolean },
  theme: Theme,
  context?: { isError?: boolean },
): Text {
  const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
  const icon = context?.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  return new Text(`${icon} ${text}`, 0, 0);
}

// --- Message renderer — subagent-result ---

/** Render a subagent-result message injected after background agent completion. */
export function renderSubagentResult(
  owner: ExtensionOwner,
  message: { content?: string; details?: Record<string, unknown> },
  options: { expanded?: boolean },
  theme: Theme,
  showCost: boolean,
  modelDisplayStyle: "id" | "name" = "id",
  hide = false,
): Container {
  const { expanded } = options;
  if (hide) return new Container();

  const d = message.details;
  const text = (message.content as string)?.trim() || "";

  const inner = new Container();
  inner.addChild(new Text(theme.fg("customMessageLabel", "Subagent Result"), 0, 0));
  inner.addChild(new Spacer(1));

  if (d && d.turnCount != null) {
    const icon = statusIcon(owner, d.status as string, theme, (d.type as string) || undefined);

    const namePart = agentNameLabel(owner, d, theme, modelDisplayStyle);
    const statsLine = buildStatsLine(d, theme, showCost);
    const description = typeof d.description === "string" ? d.description : "";
    let headerLine = `${icon} ${namePart}·${statsLine}\n  ${theme.fg("text", description)}`;
    if (typeof d.outputFile === "string" && d.outputFile) {
      headerLine += `\n  ${theme.fg("dim", `tail -f ${d.outputFile}`)}`;
    }
    if (typeof d.worktreePath === "string" && d.worktreePath) {
      headerLine += `\n  ${theme.fg("dim", `worktree: ${d.worktreePath}`)}`;
    }
    inner.addChild(new Text(headerLine, 0, 0));

    if (expanded && text) {
      inner.addChild(new Spacer(1));
      inner.addChild(
        new Text(
          text
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n"),
          0,
          0,
        ),
      );
    }
  } else {
    inner.addChild(new Text(buildFallbackResultLine(owner, d, theme, modelDisplayStyle), 0, 0));
  }

  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(inner);

  const outer = new Container();
  outer.addChild(new Spacer(1));
  outer.addChild(box);
  outer.addChild(new Spacer(1));
  return outer;
}

function buildFallbackResultLine(
  owner: ExtensionOwner,
  d: Record<string, unknown> | undefined,
  theme: Theme,
  modelDisplayStyle: "id" | "name" = "id",
): string {
  const icon = statusIcon(owner, "completed", theme, (d?.type as string) || undefined);
  let line = icon;
  if (d?.type) {
    line += ` ${agentNameLabel(owner, d, theme, modelDisplayStyle)}`;
  }
  const desc = typeof d?.description === "string" ? d.description : "";
  if (desc) line += `\n  ${theme.fg("text", desc)}`;
  if (typeof d?.outputFile === "string" && d.outputFile) {
    line += `\n  ${theme.fg("dim", `tail -f ${d.outputFile}`)}`;
  }
  if (typeof d?.worktreePath === "string" && d.worktreePath) {
    line += `\n  ${theme.fg("dim", `worktree: ${d.worktreePath}`)}`;
  }
  return line;
}
