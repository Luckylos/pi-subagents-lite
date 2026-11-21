import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentOutputLog } from "./agents/output-file.ts";
import type { LifetimeUsage, AgentUsage } from "./agents/usage.ts";
import type { SubagentType, AgentInvocation, AgentConfig } from "./agents/types.ts";

export type ThinkingLevel = ModelThinkingLevel;

/**
 * A configured thinking choice: a concrete level, or `parent` — the parent
 * session's current level. `parent` never survives resolution, so it never
 * reaches a child session, a run option, or a stored invocation record.
 */
export type ThinkingChoice = ThinkingLevel | "parent";

export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
  /** SDK tool call id; absent on synthetic events (e.g. extension-error end). */
  toolCallId?: string;
}

/** Transient display data for one Subagent run, fed by tool and stream callbacks. */
export interface LiveView {
  readonly activeTools: ReadonlyMap<string, string>; // keyed by SDK toolCallId
  readonly responseText: string;
}

/**
 * Resolved model + run-limit tunables shared by every spawn/run shape
 * (RunOptions, SpawnOptions, SpawnIntent). Add a tunable here once and it
 * flows through the whole chain.
 */
export interface RunTunables {
  model?: Model<any>;
  /** Omitted limits inherit defaults; zero explicitly disables the corresponding agent cap. */
  maxTurns?: number;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  graceTurns?: number;
}

export type SubagentRunPhase = "queued" | "running" | "stopping" | "settling" | "settled";
export type SubagentRunStatus = Exclude<AgentStatus, "queued" | "running">;

/** Outcome data used to settle one run. */
export interface SubagentRunOutcome {
  readonly status: SubagentRunStatus;
  readonly result?: string;
  readonly error?: string;
  readonly completedAt: number;
  readonly stoppedBy?: StopInitiator;
  readonly stopDetail?: Readonly<WatchdogStopDetail>;
}

/** Conversation totals and display stats captured at settlement. */
export interface RunResultStats {
  readonly lifetimeUsage: Readonly<LifetimeUsage>;
  readonly turnCount?: number;
  /** Completed turns in the run that produced this report. */
  readonly runTurnCount?: number;
  readonly maxTurns?: number;
  readonly toolUses: number;
  readonly contextPercent: number | null;
  readonly compactionCount: number;
  readonly modelName?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
}

/** The exact terminal result of one run, retained separately from mutable agent state. */
export interface SubagentRunResult extends SubagentRunOutcome {
  readonly runId: string;
  readonly agentId: string;
  readonly sequence: number;
  readonly type: SubagentType;
  readonly description: string;
  readonly worktreePath?: string;
  readonly outputFile?: string;
  readonly started: boolean;
  readonly elapsedMs: number;
  readonly stats: RunResultStats;
}

/** The run-owned report that releases a foreground Agent call. */
export type SubagentParentReport =
  | SubagentRunResult
  | (Pick<SubagentRunResult, "type" | "description" | "worktreePath" | "stats"> & { readonly status: "stopping" });

/** Delivery binding captured before execution, separate from retained result data. */
export interface RunNotificationBinding {
  readonly ownerGeneration: number;
  readonly parentSessionId: string;
  readonly spawnCtx: ExtensionContext;
  readonly required: boolean;
}

/** One accepted initial request or continuation; no transcript duplication. */
export interface SubagentRun {
  readonly id: string;
  readonly agentId: string;
  readonly sequence: number;
  readonly phase: SubagentRunPhase;
  readonly acceptedAt: number;
  readonly startedAt?: number;
  readonly stopRequestedAt?: number;
  readonly outcome?: SubagentRunResult;
  /** Resolves only after execution and run-owned cleanup have actually finished. */
  readonly completion: Promise<void>;
}

export type AgentSubmissionRejection =
  | "not_found"
  | "empty_message"
  | "queued"
  | "stopping"
  | "settling"
  | "unavailable"
  | "capacity"
  | "delivery_failed";

/** Acceptance is admission, not confirmation that the model consumed a message. */
export type AgentSubmissionResult =
  | {
      readonly accepted: true;
      readonly agentId: string;
      readonly runId: string;
      readonly delivery: "steer" | "pending_steer" | "continuation";
    }
  | { readonly accepted: false; readonly reason: AgentSubmissionRejection; readonly message: string };

export interface AgentRecord {
  id: string;
  result?: string;
  error?: string;
  lifecycle: AgentLifecycle;
  display: AgentDisplayInfo;
  execution: AgentExecutionState;
  stats: AgentAccumulatedStats;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string | null;
  platform: string;
}

/**
 * Streaming/callback surface shared by RunOptions and SpawnOptions.
 * Bridges agent-runner events to record tracking and live-view updates.
 */
export interface RunCallbacks {
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: AgentUsage) => void;
  onCompaction?: (info: CompactionInfo) => void;
}

/**
 * Coordinator-side spawn config shared by SpawnOptions and SpawnIntent.
 * The resolved run params that both the manager and coordinator agree on;
 * extends RunTunables with display/identity fields.
 */
export interface SpawnConfig extends RunTunables {
  description: string;
  /** Definition selected for this spawn, including target-local frontmatter. */
  agentConfig?: AgentConfig;
  /** Applied only after Pi selects a model without a per-model Thinking setting. */
  deferredDefaultThinking?: ThinkingLevel;
  modelKey?: string;
  worktreePath?: string;
  worktreeLabel?: string;
  toolCallId?: string;
  /**
   * Whether the subagent session treats the target project as trusted.
   * Absent/true = load project resources; false = ignore them (untrusted
   * cross-repo target, resolved by the trust gate).
   */
  projectTrusted?: boolean;
  invocation?: AgentInvocation;
}

/** How many characters of agent ID to show in display. */
export const SHORT_ID_LENGTH = 8;

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface CompactionInfo {
  reason: CompactionReason;
  tokensBefore: number;
}

// --- Sub-object interfaces for decomposed AgentRecord ---

export type AgentStatus = "queued" | "running" | "completed" | "turn_limited" | "aborted" | "stopped" | "error";

/** Who initiated an agent stop: "user" via UI menu, "agent" via StopAgent tool, or "watchdog" (stuck-agent detection). */
export type StopInitiator = "user" | "agent" | "watchdog";

/** Structured reason for a watchdog stop: which check fired, and the offending tool for tool kills. */
export type WatchdogStopDetail =
  | { kind: "tool"; toolName: string; elapsedMs: number }
  | { kind: "idle"; elapsedMs: number };

/**
 * Lifecycle state: when the agent started, completed, and its current status.
 * Used by agent-manager (lifecycle control), menus (status display), widget (linger logic).
 */
export interface AgentLifecycle {
  status: AgentStatus;
  /** Current run phase; manager-owned records always provide it. */
  phase?: SubagentRunPhase;
  startedAt: number;
  completedAt?: number;
  stoppedBy?: StopInitiator;
  /** Reason detail for watchdog stops (tool name + elapsed). Absent for user/agent stops. */
  stopDetail?: WatchdogStopDetail;
  /**
   * Whether the agent ever started running. Set false at spawn, flipped true
   * synchronously in startAgent before the run — distinguishes never-started
   * stops from ran-then-stopped ones so the status note is accurate.
   */
  started: boolean;
}

/**
 * Display-oriented fields: type name, description, output file, invocation params.
 * Used by widget (rendering), menus (listing), renderer (display).
 */
export interface AgentDisplayInfo {
  type: SubagentType;
  description: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** The original Agent tool call and its accepted execution mode. */
  toolCall?: { readonly id: string; readonly background: boolean };
  worktreePath?: string;
  /** Short display label for the worktree (e.g., "feature" or "feature/packages/web"). */
  worktreeLabel?: string;
}

/**
 * Execution internals projected for consumers of the agent record.
 * Used by agent-manager (session lifecycle), tool-execution (steering, nudge).
 */
export interface AgentExecutionState {
  session?: AgentSession;
  /** Spawn-time grace period, reused for each continuation. */
  graceTurns?: number;
  abortController?: AbortController;
  /**
   * Current run's parent wait gate. Opens on Stop acceptance or settlement;
   * distinct from the actual run execution and SubagentRun.completion.
   */
  promise?: Promise<SubagentParentReport>;
  /** Lifecycle wrapper for the output file stream. */
  outputLog?: AgentOutputLog;
  /** Model key used for concurrency admission, confirmed by Pi and reused by continuations. */
  modelKey?: string;
  /**
   * Lifetime cost already added to the session total (tallyCompletion
   * baseline). Undefined until the first settlement; continuations add only
   * the delta since the last tally.
   */
  talliedCost?: number;
  /** The current run's live view, projected when the manager accepts the run. */
  /** Spawn caller's tool and text callbacks, also forwarded during continuations. */
  continuationActivityCallbacks?: Pick<RunCallbacks, "onToolActivity" | "onTextDelta">;
}

/**
 * Accumulated statistics: usage breakdown, tool uses, turn count.
 * Used by widget (stats display), tool-execution (details building), menus (result viewer).
 */
export interface AgentAccumulatedStats {
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output (see getLifetimeTotal; cacheRead/cacheWrite
   * and cost deliberately excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  toolUses: number;
  /** Cumulative turn count across the conversation. */
  turnCount?: number;
  /** Completed turns in the current or most recently settled run. */
  runTurnCount?: number;
  /** Max turns limit (from invocation or default). */
  maxTurns?: number;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /** Last-known context usage percentage (0–100), captured at completion. */
  contextPercent?: number | null;
}
