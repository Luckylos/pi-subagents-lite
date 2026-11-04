/**
 * session-run.ts — Run policy for one prompt against an existing session.
 *
 * Turn limits (steer, then abort after grace turns), parent-abort forwarding,
 * response collection, model-error classification, and event forwarding. It
 * needs only the RunSession surface, so tests drive it with an in-memory
 * session instead of the SDK. Session setup stays in agent-runner.ts.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { extractText } from "../prompt/context.ts";
import type { AgentUsage } from "./usage.ts";
import type { RunCallbacks } from "../types.ts";
import { DEFAULT_GRACE_TURNS } from "../config/config-io.ts";

/** The session surface a run uses; AgentSession satisfies it. */
export type RunSession = Pick<AgentSession, "subscribe" | "prompt" | "steer" | "abort" | "messages">;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** A settled run against a session; generic so callers keep their session type. */
export interface SessionRunResult<S extends RunSession = RunSession> {
  responseText: string;
  session: S;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent hit the soft turn limit and wrapped up within grace turns. */
  turnLimited: boolean;
  /**
   * Provider error message when the run ended in a model error: the final
   * assistant message has stopReason "error". Absent for normal, aborted,
   * and turn-limited runs, and for transient errors superseded by a later turn.
   */
  modelError?: string;
}

/**
 * Options for prompting a session, whether first run or continuation.
 * Carries the callbacks the manager wires for record tracking and live-view
 * updates; the session itself is reused by continuations.
 */
export interface SessionPromptOptions extends RunCallbacks {
  maxTurns?: number;
  graceTurns?: number;
  /** Abort signal forwarded to session.abort() while the prompt runs. */
  signal?: AbortSignal;
}

function collectResponseText(session: RunSession, onTextDelta?: (delta: string, fullText: string) => void) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
      onTextDelta?.(event.assistantMessageEvent.delta, text);
    }
  });
  return { getText: () => text, unsubscribe };
}

function getLastAssistantText(session: RunSession, fromIndex: number): string {
  for (let i = session.messages.length - 1; i >= fromIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * The provider error message when the run ended in a model error: the final
 * assistant message has stopReason "error". Returns undefined when the final
 * assistant message ended normally (or was aborted), so a transient error
 * followed by a successful turn never fails the run.
 */
function getFinalModelError(session: RunSession): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason !== "error") return undefined;
    return msg.errorMessage && msg.errorMessage.trim() ? msg.errorMessage : undefined;
  }
  return undefined;
}

function forwardAbortSignal(session: RunSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  // abort() returns a promise and this fires from an event listener, so a
  // rejection escapes the run rather than failing it. Node re-throws a
  // listener's returned rejected promise as an uncaught exception, and the
  // parent is already going down when this runs.
  const onAbort = () => {
    void session.abort().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Extract a LifetimeUsage from a runtime assistant message_end event.
 * pi-ai attaches `usage: { input, output, cacheWrite, cost: { total } }` to
 * assistant messages at runtime, but this shape isn't reflected in the
 * AgentSessionEvent public types.
 */
function usageFromAssistantMessage(msg: Record<string, unknown>): AgentUsage | undefined {
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return {
    input: (usage.input as number) ?? 0,
    output: (usage.output as number) ?? 0,
    cacheWrite: (usage.cacheWrite as number) ?? 0,
    cacheRead: (usage.cacheRead as number) ?? 0,
    cost: ((usage.cost as Record<string, unknown>)?.total as number) ?? 0,
  };
}

export function subscribeToSessionEvents(
  session: RunSession,
  options: Pick<RunCallbacks, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
): () => void {
  if (!options.onToolActivity && !options.onAssistantUsage && !options.onCompaction) {
    return () => {};
  }
  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName, toolCallId: event.toolCallId });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName, toolCallId: event.toolCallId });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const msg = event.message as unknown as Record<string, unknown>;
      const usage = usageFromAssistantMessage(msg);
      if (usage) {
        options.onAssistantUsage?.(usage);
      }
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });
}

function wireTurnTracking(
  session: RunSession,
  options: Pick<SessionPromptOptions, "maxTurns" | "graceTurns" | "onTurnEnd">,
) {
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns);
  let softLimitReached = false;
  let aborted = false;
  const graceTurns = options.graceTurns ?? DEFAULT_GRACE_TURNS;

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type !== "turn_end") return;
    turnCount++;
    options.onTurnEnd?.(turnCount);
    if (maxTurns == null) return;
    if (!softLimitReached && turnCount >= maxTurns) {
      softLimitReached = true;
      // steer() returns a promise and fires from a subscribe callback: a
      // rejection would escape the run. It only costs the graceful wrap-up;
      // the hard abort below still fires.
      void session
        .steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.")
        .catch(() => {});
    } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
      aborted = true;
      // `aborted` is already set, so a rejected abort() cannot change the
      // reported outcome — only swallow the rejection.
      void session.abort().catch(() => {});
    }
  });

  return { unsubscribe, getAborted: () => aborted, getTurnLimited: () => softLimitReached };
}

async function runTurnLoop(
  session: RunSession,
  prompt: string,
  options: { signal?: AbortSignal } & RunCallbacks,
  unsubTurns: () => void,
) {
  const unsubEvents = subscribeToSessionEvents(session, options);
  const collector = collectResponseText(session, options.onTextDelta);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  // Messages already in the session before this prompt belong to earlier runs;
  // the fallback must not surface their text when this run fails (model error
  // or abort with no output) — that would resurrect a prior run's result.
  const messageStart = session.messages.length;
  try {
    await session.prompt(prompt);
  } finally {
    unsubTurns();
    unsubEvents();
    collector.unsubscribe();
    cleanupAbort();
  }
  return collector.getText().trim() || getLastAssistantText(session, messageStart);
}

/**
 * Run a single prompt against a session: wire turn tracking, event
 * subscription, response collection, and abort forwarding, prompt, then
 * assemble the RunResult. Shared by the first run (runAgentImpl) and
 * continuations (continueAgentSession) so the two paths cannot drift.
 */
export async function runSessionPrompt<S extends RunSession>(
  session: S,
  prompt: string,
  options: SessionPromptOptions,
): Promise<SessionRunResult<S>> {
  const { unsubscribe: unsubTurns, getAborted, getTurnLimited } = wireTurnTracking(session, options);
  const responseText = await runTurnLoop(session, prompt, options, unsubTurns);
  return {
    responseText,
    session,
    aborted: getAborted(),
    turnLimited: getTurnLimited(),
    modelError: getFinalModelError(session),
  };
}
