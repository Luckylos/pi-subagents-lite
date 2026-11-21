/**
 * session-run.ts — Run policy for one prompt against an existing session.
 *
 * Turn limits and cancellation, response collection, model-error classification,
 * and event forwarding. Session setup stays in agent-runner.ts.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { extractText } from "../prompt/context.ts";
import type { AgentUsage } from "./usage.ts";
import type { RunCallbacks } from "../types.ts";
import { DEFAULT_GRACE_TURNS } from "../config/agent-settings.ts";
import { normalizeMaxTurns } from "./run-limits.ts";
import { steerForRun } from "./sdk-run-steering.ts";

type FinishTurn = NonNullable<AgentSession["agent"]["finishTurn"]>;

/** The session surface a run uses. Sessions without core hooks use event-based cancellation. */
export type RunSession = Pick<AgentSession, "subscribe" | "prompt" | "steer" | "abort"> & {
  agent?: Pick<AgentSession["agent"], "finishTurn" | "hasQueuedMessages"> &
    Partial<Pick<AgentSession["agent"], "continue">>;
  abortCompaction?: AgentSession["abortCompaction"];
  isStreaming?: AgentSession["isStreaming"];
};

/** A settled run against a session; generic so callers keep their session type. */
export interface SessionRunResult<S extends RunSession = RunSession> {
  responseText: string;
  session: S;
  /** True if cancellation or the hard turn cutoff stopped unfinished work. */
  aborted: boolean;
  /** True if the run reached the soft limit or was stopped by the hard cutoff. */
  turnLimited: boolean;
  /** Provider error from this prompt's final assistant message, unless cancelled. */
  modelError?: string;
}

export type PromptState = "started" | "settled" | "finished";

/**
 * Options for prompting a session, whether first run or continuation.
 * Carries the callbacks the manager wires for record tracking and live-view
 * updates; the session itself is reused by continuations.
 */
export interface SessionPromptOptions extends RunCallbacks {
  maxTurns?: number;
  graceTurns?: number;
  /** SDK activity boundaries and actual prompt completion, separate from run settlement. */
  onPromptStateChange?: (state: PromptState) => void;
  /** Abort signal forwarded to session.abort() while the prompt runs. */
  signal?: AbortSignal;
}

function collectPromptOutput(onTextDelta?: (delta: string, fullText: string) => void) {
  let streamedText = "";
  let finalizedText = "";
  let earlierText = "";
  let modelError: string | undefined;
  const onEvent = (event: AgentSessionEvent) => {
    if (
      event.type === "auto_retry_start" ||
      (event.type === "compaction_end" && event.reason === "overflow" && event.willRetry)
    ) {
      // Pi omits the failed response from its model projection when retrying.
      // Drop only that attempt, keeping fallback text from earlier turns.
      streamedText = "";
      finalizedText = "";
      modelError = undefined;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      streamedText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      streamedText += event.assistantMessageEvent.delta;
      onTextDelta?.(event.assistantMessageEvent.delta, streamedText);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      // Compaction, edits and recovery can rewrite the session projection.
      // Collect finalized output here, including errors without turn_end.
      const { content, stopReason, errorMessage } = event.message;
      earlierText = finalizedText || earlierText;
      finalizedText = extractText(content).trim();
      modelError = stopReason === "error" && errorMessage?.trim() ? errorMessage : undefined;
    }
  };
  return {
    getResult: () => ({ responseText: streamedText.trim() || finalizedText || earlierText, modelError }),
    onEvent,
  };
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
  // SDK input/auth preflight precedes _startRun, which resets its abort
  // intent. Reapply our run-owned intent at the public start boundary. The
  // low-level event loop awaits listeners: returning abort() would wait for
  // that same loop to become idle and deadlock it.
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start" && signal.aborted) onAbort();
  });
  if (signal.aborted) onAbort();
  return () => {
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
  };
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

type EndedTurn = Extract<AgentSessionEvent, { type: "turn_end" }>;

function wouldContinueAtCutoff(
  session: RunSession,
  event: EndedTurn,
  decision: "continue" | "end" | undefined,
  terminatingTools: ReadonlySet<string>,
): boolean {
  const { message, toolResults } = event;
  if (message?.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) {
    return false;
  }
  if (session.agent?.hasQueuedMessages?.() || decision === "continue") return true;
  if (decision === "end") return false;

  // Pi's natural tool continuation ends only if all finalized calls opt
  // out. A result message does not carry `terminate`, but the tool event does.
  const hasToolCalls = message?.role === "assistant" ? message.content.some((part) => part.type === "toolCall") : true;
  return hasToolCalls && !(toolResults?.length && toolResults.every((tool) => terminatingTools.has(tool.toolCallId)));
}

function wireTurnTracking(
  session: RunSession,
  options: Pick<SessionPromptOptions, "maxTurns" | "graceTurns" | "onTurnEnd" | "signal">,
) {
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns);
  const graceTurns = options.graceTurns ?? DEFAULT_GRACE_TURNS;
  const hardLimit = maxTurns == null ? Infinity : maxTurns + Math.max(0, graceTurns);
  let hardLimitReached = false;
  let aborted = false;
  let wrapUp: Promise<"queued" | "handled" | void> | undefined;
  const wrapUpLifetime = new AbortController();
  const terminatingTools = new Set<string>();

  const agent = session.agent;
  const previousFinishTurn = agent?.finishTurn;
  let coreDecision: "continue" | "end" | undefined;
  // Pi selects the next action before emitting turn_end. End the core loop
  // here so it never drains input or attempts an aborted extra turn.
  const finishTurn: FinishTurn | undefined =
    agent && "finishTurn" in agent && maxTurns != null
      ? async (turn, signal) => {
          const decision = await previousFinishTurn?.call(agent, turn, signal);
          if (turnCount + 1 >= hardLimit) {
            coreDecision = decision?.action;
            return { action: "end" };
          }
          return decision || undefined;
        }
      : undefined;
  if (agent && finishTurn) agent.finishTurn = finishTurn;

  const abortAtCutoff = () => {
    // The SDK latches abort synchronously, then waits for the very prompt
    // we're handling to finish. Awaiting it here would deadlock.
    if (!options.signal?.aborted) void session.abort().catch(() => {});
  };
  const previousContinue = agent?.continue;
  const hadOwnContinue = agent != null && Object.hasOwn(agent, "continue");
  const continueAgent =
    finishTurn && previousContinue && session.abortCompaction
      ? async () => {
          if (!hardLimitReached) return previousContinue.call(agent);
          // Session-level retries and continuations enter here before the core
          // drains queues or creates a turn. A settlement boundary has already
          // committed its drafts if it selected this continuation.
          if (!options.signal?.aborted) aborted = true;
          abortAtCutoff();
        }
      : undefined;
  if (agent && continueAgent) agent.continue = continueAgent;

  const onEvent = (event: AgentSessionEvent) => {
    if (event.type === "compaction_start" && hardLimitReached && event.reason !== "manual") {
      // Automatic compaction checks its own signal before invoking extensions
      // or the summarizer. Cancelling just compaction leaves settlement intact.
      session.abortCompaction?.();
    }
    if (
      event.type === "tool_execution_end" &&
      !event.parentToolCallId &&
      maxTurns != null &&
      event.result?.terminate === true
    ) {
      terminatingTools.add(event.toolCallId);
    }
    if (event.type !== "turn_end") return;
    turnCount++;
    options.onTurnEnd?.(turnCount);
    const { message } = event;
    if (!hardLimitReached && turnCount >= hardLimit) {
      hardLimitReached = true;
      // Preserve real provider failures and incomplete responses before Pi
      // can schedule a retry or omit a recoverable response for compaction.
      const interrupted =
        message?.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length");
      if (!options.signal?.aborted) {
        aborted = wouldContinueAtCutoff(session, event, coreDecision, terminatingTools);
        if (aborted || interrupted || !continueAgent) abortAtCutoff();
      }
    } else if (
      !hardLimitReached &&
      !wrapUp &&
      maxTurns != null &&
      turnCount >= maxTurns &&
      !options.signal?.aborted &&
      !(message?.role === "assistant" && message.stopReason === "aborted")
    ) {
      const signal = options.signal ? AbortSignal.any([options.signal, wrapUpLifetime.signal]) : wrapUpLifetime.signal;
      wrapUp = steerForRun(
        session,
        "You have reached your turn limit. Wrap up immediately — provide your final answer now.",
        signal,
        () => session.isStreaming !== false,
      ).catch(() => {});
    }
    terminatingTools.clear();
  };

  return {
    onEvent,
    restoreHooks: () => {
      wrapUpLifetime.abort();
      if (agent && finishTurn && agent.finishTurn === finishTurn) agent.finishTurn = previousFinishTurn;
      if (agent && continueAgent && agent.continue === continueAgent) {
        if (hadOwnContinue) agent.continue = previousContinue;
        else delete agent.continue;
      }
    },
    getAborted: () => aborted,
    getTurnLimited: () => wrapUp !== undefined || aborted,
    // Drain the SDK submission, which can finish without the cancelled input hook.
    drainWrapUp: () => wrapUp,
  };
}

async function runTurnLoop(
  session: RunSession,
  prompt: string,
  options: SessionPromptOptions,
  turns: ReturnType<typeof wireTurnTracking>,
) {
  const collector = collectPromptOutput(options.onTextDelta);
  let settled = false;
  const unsubscribeRun = session.subscribe((event) => {
    if (settled) return;
    if (event.type === "agent_settled") {
      // Retries and queued continuations are part of this run. Prompts an
      // extension starts from agent_settled run after this public boundary.
      settled = true;
      turns.restoreHooks();
      options.onPromptStateChange?.("settled");
      return;
    }
    if (event.type === "agent_start") options.onPromptStateChange?.("started");
    turns.onEvent(event);
    collector.onEvent(event);
  });
  // Keep session accounting and Stop attached until the awaited SDK prompt
  // returns, including any deferred extension activity.
  const unsubEvents = subscribeToSessionEvents(session, options);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  try {
    if (!options.signal?.aborted) await session.prompt(prompt);
  } finally {
    unsubscribeRun();
    turns.restoreHooks();
    unsubEvents();
    cleanupAbort();
    options.onPromptStateChange?.("finished");
  }
  return collector.getResult();
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
  const turns = wireTurnTracking(session, options);
  let output: Pick<SessionRunResult, "responseText" | "modelError">;
  try {
    output = await runTurnLoop(session, prompt, options, turns);
  } finally {
    await turns.drainWrapUp();
  }
  const cancelled = options.signal?.aborted === true;
  return {
    responseText: output.responseText,
    session,
    aborted: turns.getAborted() || cancelled,
    turnLimited: turns.getTurnLimited(),
    modelError: cancelled ? undefined : output.modelError,
  };
}
