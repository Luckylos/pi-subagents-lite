import type { ExtensionOwner } from "../shell.ts";
/**
 * agent-manager.ts — Tracks agents, per-model concurrency, background execution.
 *
 * Supports per-model and per-provider concurrency limits with queuing.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { continueAgentSession, runAgent, type RunResult } from "./agent-runner.ts";
import type { SessionPromptOptions } from "./session-run.ts";
import { disposeChildSession } from "./session-teardown.ts";
import { AgentOutputLog } from "./output-file.ts";
import { Watchdog } from "./watchdog.ts";
import { getStore } from "../shell.ts";
import { AgentRun } from "./agent-run.ts";
import {
  type AgentSubmissionResult,
  type AgentSubmissionRejection,
  type SubagentRun,
  type SubagentRunStatus,
  type AgentRecord,
  type AgentStatus,
  type RunCallbacks,
  type StopInitiator,
  type WatchdogStopDetail,
  type SpawnConfig,
} from "../types.ts";
import type { SubagentType } from "./types.ts";

import { addUsage, getLifetimeTotal, getSessionContextPercent } from "./usage.ts";
import { errorMessage, toSingleLine } from "../utils.ts";
import { DEFAULT_GRACE_TURNS } from "../config/config-io.ts";

export const WATCHDOG_TICK_MS = 5_000;

/** Milliseconds in one minute (config timeout thresholds are stored in minutes). */
const MINUTE_MS = 60_000;

/** Exact error message for queued agents that never start because the manager disposed (US-9). */
const DISPOSE_QUEUED_MESSAGE = "Agent manager disposed before the queued agent could start.";

/** UUID prefix length for agent IDs stored in the agents map (uniqueness). */
const AGENT_ID_PREFIX_LENGTH = 17;

const DEFAULT_CONCURRENCY_LIMIT = 4;

const QUEUE_CLEANUP_FAILED = "The previous run's message queue could not be cleared. This subagent cannot continue.";

/** Whether the agent status is terminal (no longer running or queued). */
function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
}

function formatModelError(
  type: SubagentType,
  model: { provider: string; id: string } | undefined,
  providerError: string,
): string {
  const sanitizedError = toSingleLine(providerError);
  return model ? `${type} (${model.provider}/${model.id}): ${sanitizedError}` : `${type}: ${sanitizedError}`;
}

export interface ConcurrencyConfig {
  /** Default concurrency limit for models not in the models or providers map. */
  default: number;
  /** Per-provider concurrency limits keyed by provider name (e.g. "llamacpp"). */
  providers?: Record<string, number>;
  /** Per-model concurrency limits keyed by "provider/modelId". */
  models?: Record<string, number>;
}

type OnAgentComplete = (record: AgentRecord) => void;
type OnAgentStart = (record: AgentRecord) => void;

interface ConcurrencySlot {
  limit: number;
  running: number;
  modelKey?: string;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions extends SpawnConfig, RunCallbacks {
  isBackground?: boolean;
  /** Extra tools bound into this agent's child session at creation (e.g. MessageParent). */
  customTools?: ToolDefinition[];
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private watchdog = new Watchdog();
  private watchdogInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onClear?: (id: string) => void;
  private onStart?: OnAgentStart;

  private runs = new WeakMap<AgentRecord, AgentRun[]>();
  /** Fixed run-owned leases; configuration changes never replace ownership. */
  private activeLeases = new Set<ConcurrencySlot>();
  private runLeases = new WeakMap<AgentRun, ConcurrencySlot>();
  private disposed = false;

  /** Parent-interrupt bindings by record, removed at every terminal transition. */
  private parentBindings = new WeakMap<AgentRecord, { signal: AbortSignal; handler: () => void }>();

  /** In-flight child-session teardowns, tracked so dispose() can await them. */
  private pendingDisposals = new Set<Promise<void>>();

  /** Attached-but-unsettled run promises, tracked so dispose() can await them. */
  private inFlightRuns = new Set<Promise<string>>();

  /** Session-level cumulative agent cost. Survives record removal (Clear/dispose). */
  private totalAgentCost = 0;

  /** Session-level completed agent count. Survives record removal (Clear/dispose). */
  private totalAgentCount = 0;

  /** Per-model concurrency slots keyed by "provider/modelId". */
  private concurrencySlots = new Map<string, ConcurrencySlot>();

  /** Per-provider concurrency slots — shared pool for all models from a provider. */
  private providerSlots = new Map<string, ConcurrencySlot>();

  private defaultConcurrency: number;

  private queue: { id: string; modelKey: string; args: SpawnArgs }[] = [];

  constructor(
    private owner: ExtensionOwner,
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
    onStart?: OnAgentStart,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.defaultConcurrency = concurrency?.default ?? DEFAULT_CONCURRENCY_LIMIT;

    for (const [provider, limit] of Object.entries(concurrency?.providers ?? {})) {
      this.applyConcurrencyEntry(this.providerSlots, provider, limit);
    }

    for (const [modelKey, limit] of Object.entries(concurrency?.models ?? {})) {
      this.applyConcurrencyEntry(this.concurrencySlots, modelKey, limit);
    }

    this.watchdogInterval = setInterval(() => this.checkWatchdogs(), WATCHDOG_TICK_MS);
    this.watchdogInterval.unref();
  }

  /**
   * Update the concurrency configuration.
   * Existing leases remain owned by their originating run. Admission counts
   * all active leases under the new routing policy before draining the queue.
   */
  setConcurrency(config: ConcurrencyConfig): void {
    this.defaultConcurrency = config.default;

    for (const [provider, limit] of Object.entries(config.providers ?? {})) {
      this.applyConcurrencyEntry(this.providerSlots, provider, limit);
    }

    for (const key of this.providerSlots.keys()) {
      if (!(config.providers ?? {})[key]) {
        this.providerSlots.delete(key);
      }
    }

    for (const [modelKey, limit] of Object.entries(config.models ?? {})) {
      this.applyConcurrencyEntry(this.concurrencySlots, modelKey, limit);
    }

    for (const key of this.concurrencySlots.keys()) {
      if (!(config.models ?? {})[key]) {
        this.concurrencySlots.delete(key);
      }
    }

    this.drainQueue();
  }

  private applyConcurrencyEntry(map: Map<string, ConcurrencySlot>, key: string, limit: number): void {
    const safeLimit = Math.max(1, limit);
    const existing = map.get(key);
    if (existing) {
      existing.limit = safeLimit;
    } else {
      map.set(key, { limit: safeLimit, running: 0 });
    }
  }

  /**
   * Get or create a concurrency slot for a model key.
   * Precedence: per-model slot > per-provider shared slot > default (per-model).
   */
  private getSlot(modelKey: string): ConcurrencySlot {
    const pool = (key: string): string => {
      if (this.concurrencySlots.has(key)) return `model:${key}`;
      const provider = key.split("/")[0];
      return this.providerSlots.has(provider) ? `provider:${provider}` : `model:${key}`;
    };
    const provider = modelKey.split("/")[0];
    const limit =
      this.concurrencySlots.get(modelKey)?.limit ?? this.providerSlots.get(provider)?.limit ?? this.defaultConcurrency;
    const key = pool(modelKey);
    const running = [...this.activeLeases].filter((lease) => lease.modelKey && pool(lease.modelKey) === key).length;
    return { modelKey, limit: Math.max(1, limit), running };
  }

  /** Spawn an agent, returning its ID immediately; queued when the concurrency limit is reached. */
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string {
    if (this.disposed) throw new Error("Agent manager is disposed.");
    const id = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    let queued = false;
    let concurrencySlot: ConcurrencySlot | undefined;
    if (options.modelKey) {
      const slot = this.getSlot(options.modelKey);
      if (slot.running >= slot.limit) {
        queued = true;
        this.queue.push({ id, modelKey: options.modelKey, args });
      } else {
        concurrencySlot = slot;
      }
    }

    const record: AgentRecord = {
      id,
      lifecycle: {
        status: queued ? "queued" : "running",
        startedAt: Date.now(),
        // Flipped synchronously in startAgent; distinguishes never-started stops.
        started: false,
      },
      display: {
        type,
        description: options.description,
        invocation: options.invocation,
        worktreePath: options.worktreePath,
        worktreeLabel: options.worktreeLabel,
      },
      execution: {
        modelKey: options.modelKey,
        settled: false,
        settlementCount: 0,
      },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        turnCount: 1,
        compactionCount: 0,
        maxTurns: options.maxTurns,
      },
    };
    // Capture the coordinator's live-view bridge so a continuation can re-wire
    // tool activity and streamed text into the widget's live view.
    record.execution.liveViewCallbacks = {
      onToolActivity: options.onToolActivity,
      onTextDelta: options.onTextDelta,
    };
    this.agents.set(id, record);

    this.acceptRun(record, queued);

    // Parent interrupt binding: registered before the queued early-return so
    // queued subagents are covered too. An already-aborted signal never starts
    // the subagent — it is recorded as stopped immediately instead (ADR-0005).
    if (options.signal) {
      if (options.signal.aborted) {
        // Never-started record: no run will settle it, so stopAgent opens the gate and notifies.
        this.stopAgent(record, "user");
        return id;
      }
      const handler = () => this.abort(id, "user");
      options.signal.addEventListener("abort", handler, { once: true });
      this.parentBindings.set(record, { signal: options.signal, handler });
    }

    if (queued) return id;

    // startAgent can throw — clean up record so callers don't see an orphan
    try {
      this.startAgent(id, record, args, concurrencySlot);
    } catch (err) {
      this.failStart(record, err);
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /** Start an agent now or from queue drain; manages the slot's running count when one is held. */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
    concurrencySlot?: ConcurrencySlot,
  ) {
    const run = this.currentRun(record);
    if (concurrencySlot) {
      this.activeLeases.add(concurrencySlot);
      this.runLeases.set(run, concurrencySlot);
    }
    run.phase = "running";
    run.startedAt = Date.now();
    this.projectRun(record, run);

    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();
    // Set synchronously before the run so a stop before the session exists
    // still renders as ran-then-stopped, not never-started.
    record.lifecycle.started = true;
    // The idle clock starts here, so a hung pre-session init phase is covered.
    this.watchdog.start(id);

    // Output transcript: agent frontmatter overrides the global setting (default false).
    const agentConfig = this.owner.registry.getAgentConfig(type);
    const outputTranscript = agentConfig?.outputTranscript ?? getStore(this.owner).agent.outputTranscript;
    if (outputTranscript) {
      record.execution.outputLog = new AgentOutputLog(
        id,
        prompt,
        undefined,
        getStore(this.owner).agent.outputThinkingBufferSize,
      );
      record.display.outputFile = record.execution.outputLog.path;
    }

    this.onStart?.(record);

    const promise = runAgent(this.owner, ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      maxTokens: options.maxTokens,
      thinkingLevel: options.thinkingLevel,
      cwd: options.worktreePath,
      graceTurns: options.graceTurns,
      projectTrusted: options.projectTrusted,
      customTools: options.customTools,
      signal: run.controller.signal,
      ...this.runTrackingCallbacks(record, run, options, (turnCount) => {
        record.stats.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      }),
      onSessionCreated: (session) => {
        if (!this.isCurrentRun(record, run)) return;
        record.execution.session = session;
        // Flush any steers that arrived before the session was ready
        if (!run.controller.signal.aborted && record.execution.pendingSteers?.length) {
          for (const msg of record.execution.pendingSteers) {
            void this.deliverSteer(record, run, msg);
          }
          record.execution.pendingSteers = undefined;
        }
        if (record.execution.outputLog) {
          record.execution.outputLog.attach(session);
        }
        options.onSessionCreated?.(session);
      },
    });
    this.attachSettlementChain(record, run, promise);
  }

  /** Settle only the execution promise; Stop opens the parent gate separately. */
  private attachSettlementChain(record: AgentRecord, run: AgentRun, runPromise: Promise<RunResult>) {
    let status: SubagentRunStatus = "completed";
    let result: string | undefined;
    let error: string | undefined;
    const settled = runPromise
      .then(({ responseText, session, aborted, turnLimited, modelError }) => {
        run.executionFinished = true;
        run.phase = run.stopRequestedAt !== undefined ? "stopping" : "settling";
        this.projectRun(record, run);
        status = aborted ? "aborted" : modelError ? "error" : turnLimited ? "turn_limited" : "completed";
        result = responseText;
        if (modelError) error = formatModelError(record.display.type, session?.model, modelError);
        record.execution.session = session;
        record.stats.contextPercent = getSessionContextPercent(session);
        return responseText;
      })
      .catch((err) => {
        run.executionFinished = true;
        run.phase = run.stopRequestedAt !== undefined ? "stopping" : "settling";
        this.projectRun(record, run);
        status = "error";
        error = errorMessage(err);
        return "";
      })
      .finally(async () => {
        await run.drainCallbacks();
        // The SDK may leave steering or follow-up messages behind on any exit.
        // Both the prompt (including its wrap-up steer) and live steers have
        // drained, so clear their remaining messages before reuse.
        try {
          record.execution.session?.clearQueue();
        } catch {
          // Keep the transcript and execution outcome, but never reuse a queue
          // we could not verify was cleared. Settlement must still release capacity.
          run.queueCleanupFailed = true;
          error = error ? `${error}\n${QUEUE_CLEANUP_FAILED}` : QUEUE_CLEANUP_FAILED;
        }
        record.execution.pendingSteers = undefined;
        record.execution.settlementCount++;
        this.finalizeOutput(record);
        this.releaseLease(run);
        if (!this.agents.has(record.id)) this.releaseSession(record);
        this.detachParentBinding(record);
        run.settle({
          status: run.stopRequestedAt !== undefined ? "stopped" : status,
          result,
          error,
          completedAt: Date.now(),
          stoppedBy: record.lifecycle.stoppedBy,
          stopDetail: record.lifecycle.stopDetail,
        });
        this.projectRun(record, run);
        this.tallyCompletion(record);
        this.drainQueue();
        record.execution.settled = true;
        this.inFlightRuns.delete(settled);
      });
    this.inFlightRuns.add(settled);
  }

  private releaseLease(run: AgentRun): void {
    const lease = this.runLeases.get(run);
    if (!lease) return;
    this.runLeases.delete(run);
    this.activeLeases.delete(lease);
  }

  private finalizeOutput(record: AgentRecord): void {
    const output = record.execution.outputLog;
    if (!output) return;
    record.execution.outputLog = undefined;
    try {
      output.finalize({
        turnCount: record.stats.turnCount ?? 0,
        toolUseCount: record.stats.toolUses,
        totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
      });
    } catch {
      /* Output failure must not prevent execution cleanup. */
    }
  }

  private failStart(record: AgentRecord, error: unknown): void {
    const run = this.currentRun(record);
    this.finalizeOutput(record);
    this.releaseLease(run);
    this.detachParentBinding(record);
    run.settle({
      status: run.stopRequestedAt !== undefined ? "stopped" : "error",
      error: errorMessage(error),
      completedAt: Date.now(),
    });
    this.projectRun(record, run);
    record.execution.settled = true;
  }

  private currentRun(record: AgentRecord): AgentRun {
    const run = this.runs.get(record)?.at(-1);
    if (!run) throw new Error("Subagent record has no accepted run.");
    return run;
  }

  private isCurrentRun(record: AgentRecord, run: AgentRun): boolean {
    return (
      this.agents.get(record.id) === record &&
      this.currentRun(record) === run &&
      !run.executionFinished &&
      (run.phase === "running" || run.phase === "stopping")
    );
  }

  private acceptRun(record: AgentRecord, queued = false): AgentRun {
    const history = this.runs.get(record) ?? [];
    const run = new AgentRun(record.id, history.length + 1, queued);
    history.push(run);
    this.runs.set(record, history);
    record.execution.currentRunId = run.id;
    record.execution.abortController = run.controller;
    record.execution.promise = run.parentWait;
    record.execution.settled = false;
    record.execution.pendingSteers = undefined;
    record.lifecycle.stoppedBy = undefined;
    record.lifecycle.stopDetail = undefined;
    this.projectRun(record, run);
    return run;
  }

  /** Central compatibility projection; old outcomes never read mutable record results. */
  private projectRun(record: AgentRecord, run: AgentRun): void {
    if (this.currentRun(record) !== run) return;
    record.lifecycle.phase = run.phase;
    record.lifecycle.status = run.outcome?.status ?? (run.startedAt === undefined ? "queued" : "running");
    record.lifecycle.startedAt = run.startedAt ?? run.acceptedAt;
    record.lifecycle.completedAt = run.outcome?.completedAt;
    record.result = run.outcome?.result;
    record.error = run.outcome?.error;
  }

  getRuns(id: string): readonly SubagentRun[] {
    const record = this.agents.get(id);
    return Object.freeze(record ? (this.runs.get(record) ?? []).map((run) => run.snapshot()) : []);
  }

  private openGate(id: string, value: string): void {
    const record = this.agents.get(id);
    if (record) this.currentRun(record).openParent(value);
  }

  /** Remove a record's parent-interrupt binding; a later abort of the signal is a no-op. */
  private detachParentBinding(record: AgentRecord): void {
    const binding = this.parentBindings.get(record);
    if (!binding) return;
    this.parentBindings.delete(record);
    binding.signal.removeEventListener("abort", binding.handler);
  }

  private notifyComplete(record: AgentRecord): void {
    try {
      this.onComplete?.(record);
    } catch {
      /* ignore */
    }
  }

  private tallyCompletion(record: AgentRecord): void {
    // Usage is monotonic (addUsage only accumulates), so the delta from the
    // last tally is the cost this run added. The first tally (talliedCost
    // undefined) also counts the agent; continuations never double-count.
    const cost = record.stats.lifetimeUsage.cost;
    const baseline = record.execution.talliedCost ?? 0;
    this.totalAgentCost += cost - baseline;
    const firstTally = record.execution.talliedCost === undefined;
    record.execution.talliedCost = cost;
    if (firstTally) this.totalAgentCount++;
    this.notifyComplete(record);
  }

  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }

  setOnClear(cb: (id: string) => void): void {
    this.onClear = cb;
  }

  /** Get the session-level cumulative agent cost. Survives record removal (Clear/dispose). */
  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  /** Get the session-level completed agent count. Survives record removal (Clear/dispose). */
  getTotalAgentCount(): number {
    return this.totalAgentCount;
  }

  /**
   * Callback set shared by a first run and a continuation: accumulates stats
   * on the record, feeds the watchdog, and forwards to the caller's own
   * callbacks. writeTurnCount is the per-path policy — the first run records
   * the absolute count, a continuation adds to the previous total.
   */
  private runTrackingCallbacks(
    record: AgentRecord,
    run: AgentRun,
    forward: RunCallbacks | undefined,
    writeTurnCount: (turnCount: number) => void,
  ): SessionPromptOptions {
    return {
      onPromptStateChange: (state) => {
        if (this.isCurrentRun(record, run)) run.promptState = state;
      },
      onToolActivity: (activity) => {
        if (!this.isCurrentRun(record, run)) return;
        if (activity.type === "end") record.stats.toolUses++;
        this.watchdog.recordActivity(record.id, activity);
        forward?.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        if (!this.isCurrentRun(record, run)) return;
        addUsage(record.stats.lifetimeUsage, usage);
        forward?.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        if (!this.isCurrentRun(record, run)) return;
        record.stats.compactionCount++;
        forward?.onCompaction?.(info);
      },
      onTextDelta: (delta: string, fullText: string) => {
        if (!this.isCurrentRun(record, run)) return;
        // Streamed response text counts as activity for the idle watchdog.
        this.watchdog.recordText(record.id);
        forward?.onTextDelta?.(delta, fullText);
      },
      onTurnEnd: (turnCount) => {
        if (this.isCurrentRun(record, run)) writeTurnCount(turnCount);
      },
    };
  }

  private drainQueue() {
    if (this.disposed) return;
    const started = new Set<string>();
    for (const entry of this.queue) {
      const record = this.agents.get(entry.id);
      if (!record || record.lifecycle.status !== "queued") continue;

      const slot = this.getSlot(entry.modelKey);
      if (slot.running >= slot.limit) continue;

      try {
        this.startAgent(entry.id, record, entry.args, slot);
        started.add(entry.id);
      } catch (err) {
        // Late failure — surface on the record so the user can see it
        this.failStart(record, err);
        started.add(entry.id);
        // Failed starts notify the UI but aren't tallied as completed agents
        this.notifyComplete(record);
      }
    }
    this.queue = this.queue.filter((e) => !started.has(e.id));
  }

  /** Structured admission: live steering waits for the SDK's input handlers. */
  async submitMessage(id: string, message: string): Promise<AgentSubmissionResult> {
    const reject = (reason: AgentSubmissionRejection, text: string): AgentSubmissionResult => ({
      accepted: false,
      reason,
      message: text,
    });
    const record = this.agents.get(id);
    if (!record) return reject("not_found", "Subagent was not found.");
    if (!message.trim()) return reject("empty_message", "Message is required.");
    if (this.disposed) return reject("unavailable", "The subagent manager is unavailable.");
    const run = this.currentRun(record);
    if (run.phase === "stopping")
      return reject("stopping", "The subagent is still stopping. Wait for execution to settle.");
    if (run.phase === "queued") return reject("queued", "The subagent is queued and has not started.");
    if (run.phase === "settling" || (run.phase === "settled" && !record.execution.settled))
      return reject("settling", "The subagent is finishing its previous run. Retry after settlement.");
    if (run.phase === "running") {
      if (!record.execution.session) {
        (record.execution.pendingSteers ??= []).push(message);
        return { accepted: true, agentId: id, runId: run.id, delivery: "pending_steer" };
      }
      return this.deliverSteer(record, run, message);
    }
    if (run.queueCleanupFailed) return reject("unavailable", QUEUE_CLEANUP_FAILED);
    const session = record.execution.session;
    if (!session || session.isStreaming) return reject("unavailable", "The subagent session is unavailable or busy.");
    const modelKey = record.execution.modelKey;
    if (modelKey) {
      const slot = this.getSlot(modelKey);
      if (slot.running >= slot.limit)
        return reject("capacity", "The model concurrency limit is full. Retry when capacity is available.");
    }
    this.continueSettledAgent(record, message);
    return { accepted: true, agentId: id, runId: this.currentRun(record).id, delivery: "continuation" };
  }

  private async deliverSteer(record: AgentRecord, run: AgentRun, message: string): Promise<AgentSubmissionResult> {
    const session = record.execution.session;
    if (!session) return { accepted: false, reason: "unavailable", message: "The subagent session is unavailable." };
    if (run.isPromptClosed(session.isStreaming)) {
      return {
        accepted: false,
        reason: "settling",
        message: "The subagent is finishing its previous run. Retry after settlement.",
      };
    }
    try {
      await run.trackCallback(session.steer(message));
      // An input hook can finish after the SDK prompt closes or Stop is requested.
      // Report that rejection here and leave queue cleanup to settlement.
      if (run.controller.signal.aborted || run.isPromptClosed(session.isStreaming)) {
        return {
          accepted: false,
          reason: run.controller.signal.aborted ? "stopping" : "settling",
          message: "The run ended before the message could be delivered. Retry after settlement.",
        };
      }
      return { accepted: true, agentId: record.id, runId: run.id, delivery: "steer" };
    } catch {
      return { accepted: false, reason: "delivery_failed", message: "The session refused the message." };
    }
  }

  /** Compatibility adapter for the existing boolean result. */
  async steer(id: string, message: string): Promise<boolean> {
    return (await this.submitMessage(id, message)).accepted;
  }

  /**
   * Continue a settled agent: re-reserve the concurrency slot, reset the
   * record to running, and prompt the session again. Returns false when the
   * record cannot be continued (still settling, no session, streaming, or
   * the model's concurrency slot is full).
   */
  private continueSettledAgent(record: AgentRecord, message: string): boolean {
    // settled flips to true only after the previous run chain's .finally, so
    // a continuation cannot race the settlement cleanup (slot release, gate).
    if (!record.execution.settled) return false;
    const session = record.execution.session;
    if (!session) return false;
    // Defensive: a streaming session is mid-response and cannot be prompted.
    if (session.isStreaming) return false;

    // Re-reserve the concurrency slot (reject when full, don't queue). Skip
    // entirely when the spawn had no model key — the record never held a slot.
    let concurrencySlot: ConcurrencySlot | undefined;
    const modelKey = record.execution.modelKey;
    if (modelKey) {
      const slot = this.getSlot(modelKey);
      if (slot.running >= slot.limit) return false;
      concurrencySlot = slot;
      this.activeLeases.add(concurrencySlot);
    }

    // Accept a new run; cumulative conversation statistics carry over.
    const run = this.acceptRun(record);
    if (concurrencySlot) this.runLeases.set(run, concurrencySlot);
    run.startedAt = Date.now();
    this.projectRun(record, run);
    // A stale idle clock from the first run would kill the continuation
    // immediately — restart the watchdog before the new turn begins.
    this.watchdog.start(record.id);

    const previousTurns = record.stats.turnCount ?? 0;
    const promise = (async () =>
      continueAgentSession(session, message, {
        ...this.runTrackingCallbacks(record, run, record.execution.liveViewCallbacks, (turnCount) => {
          record.stats.turnCount = previousTurns + turnCount;
        }),
        maxTurns: record.stats.maxTurns,
        graceTurns: getStore(this.owner).agent.graceTurns ?? DEFAULT_GRACE_TURNS,
        signal: run.controller.signal,
      }))();
    this.attachSettlementChain(record, run, promise);
    // The run proceeds asynchronously; the caller only learns the wiring
    // succeeded. The parent abort binding is deliberately NOT re-attached —
    // the parent turn that spawned the agent is over.
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /**
   * Records addressed by a tool-supplied id: the exact key when present, else
   * every retained record whose id starts with it (ADR-0010). A blank prefix is
   * a prefix of every id, so it matches nothing. getRecord() stays exact-match
   * for internal callers, which already hold real keys.
   */
  matchAgents(id: string): AgentRecord[] {
    if (!id.trim()) return [];
    const exact = this.agents.get(id);
    if (exact) return [exact];
    return [...this.agents.values()].filter((record) => record.id.startsWith(id));
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt);
  }

  /**
   * Remove a terminal record: dispose its session and detach any parent
   * interrupt binding (ADR-0006). Running/queued records are rejected — Stop is
   * the action there. Clear is the only per-record removal besides dispose().
   */
  clear(id: string): boolean {
    const record = this.agents.get(id);
    if (!record || !isTerminalStatus(record.lifecycle.status) || this.currentRun(record).phase !== "settled")
      return false;
    this.removeRecord(id, record);
    this.onClear?.(id);
    return true;
  }

  abort(id: string, stoppedBy?: StopInitiator, stopDetail?: WatchdogStopDetail): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    return this.stopAgent(record, stoppedBy, stopDetail);
  }

  /** Abort the session or remove the agent from the queue. Returns false if not running/queued. */
  private stopAgent(record: AgentRecord, stoppedBy?: StopInitiator, stopDetail?: WatchdogStopDetail): boolean {
    const run = this.currentRun(record);
    if (run.phase !== "queued" && run.phase !== "running") return false;
    this.queue = this.queue.filter((q) => q.id !== record.id);
    run.stopRequestedAt = Date.now();
    run.phase = "stopping";
    record.lifecycle.stoppedBy = stoppedBy;
    record.lifecycle.stopDetail = stopDetail;
    record.execution.pendingSteers = undefined;
    // Publish intent before abort: listeners may run synchronously.
    this.projectRun(record, run);
    this.detachParentBinding(record);
    run.openParent();
    run.controller.abort();
    if (!record.lifecycle.started) {
      run.settle({ status: "stopped", completedAt: Date.now(), stoppedBy, stopDetail });
      this.projectRun(record, run);
      record.execution.settled = true;
      this.notifyComplete(record);
    }
    return true;
  }

  private removeRecord(id: string, record: AgentRecord): void {
    this.releaseSession(record);
    this.detachParentBinding(record);
    // Gates already opened on Stop or settlement; Clear drops retained history.
    this.openGate(id, "");
    this.agents.delete(id);
  }

  /**
   * Release the record's session through the shared teardown and drop the
   * reference. Tracked fire-and-forget: dispose() drains every pending teardown
   * before returning, so no session outlives the manager.
   */
  private releaseSession(record: AgentRecord): void {
    const session = record.execution.session;
    if (!session) return;
    record.execution.session = undefined;
    const done = disposeChildSession(session);
    this.pendingDisposals.add(done);
    // Both outcomes must remove the entry: dispose() waits on this set in a
    // loop, so an entry that only settles on fulfilment would never leave.
    const forget = (): void => {
      this.pendingDisposals.delete(done);
    };
    void done.then(forget, forget);
  }

  /** Stop agents violating tool/idle timeouts. Thresholds are read live so menu changes apply to running agents. */
  private checkWatchdogs(): void {
    const { toolTimeoutMinutes, idleTimeoutMinutes } = getStore(this.owner).agent;
    const decisions = this.watchdog.check(
      toolTimeoutMinutes * MINUTE_MS,
      idleTimeoutMinutes * MINUTE_MS,
      (id) => this.agents.get(id)?.lifecycle.phase === "running",
    );
    for (const [id, detail] of decisions) {
      this.abort(id, "watchdog", detail);
    }
  }

  /**
   * Terminate every child session and stop accepting work. The synchronous
   * pass fails queued agents, tears down the sessions it can see, and detaches
   * bindings; the awaits cover the rest: runs still in flight settle (their
   * vanished-record sessions are torn down and tracked), then every pending
   * teardown drains, so no session outlives this call.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.watchdogInterval);
    this.queue = [];
    for (const record of this.agents.values()) {
      const run = this.currentRun(record);
      if (run.phase === "queued") {
        run.settle({ status: "error", error: DISPOSE_QUEUED_MESSAGE, completedAt: Date.now() });
        this.projectRun(record, run);
        record.execution.settled = true;
      } else {
        this.stopAgent(record, "user");
      }
      this.releaseSession(record);
      this.detachParentBinding(record);
    }
    // Owner end drops retained records; actual runs and leases remain tracked.
    this.agents.clear();
    // Runs still settling may create or re-attach sessions after the sweep
    // above; their vanished-record teardowns land in pendingDisposals during
    // this await (reaction order: .then → .catch → .finally → this).
    await Promise.allSettled(this.inFlightRuns);
    while (this.pendingDisposals.size > 0) {
      await Promise.allSettled(this.pendingDisposals);
    }
  }
}
