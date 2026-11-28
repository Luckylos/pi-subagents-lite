import type { ExtensionOwner } from "../shell.ts";
/**
 * agent-manager.ts — Tracks agents, per-model concurrency, background execution.
 *
 * Supports per-model and per-provider concurrency limits with queuing.
 */

import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { continueAgentSession, runAgent, type RunResult } from "./agent-runner.ts";
import type { SessionPromptOptions } from "./session-run.ts";
import { normalizeMaxTurns, resolveSpawnLimits } from "./run-limits.ts";
import { disposeChildSession } from "./session-teardown.ts";
import { AgentOutputLog } from "./output-file.ts";
import { Watchdog } from "./watchdog.ts";
import { getStore } from "../shell.ts";
import { AgentRun } from "./agent-run.ts";
import { RunCapacity, type ConcurrencyConfig } from "./run-capacity.ts";
import {
  type AgentSubmissionResult,
  type AgentSubmissionRejection,
  type SubagentRun,
  type SubagentRunStatus,
  type SubagentRunOutcome,
  type SubagentRunResult,
  type RunNotificationBinding,
  type AgentRecord,
  type AgentStatus,
  type LiveView,
  type RunCallbacks,
  type StopInitiator,
  type WatchdogStopDetail,
  type SpawnConfig,
} from "../types.ts";
import type { SubagentType } from "./types.ts";

import { addUsage, getLifetimeTotal } from "./usage.ts";
import { captureResultStats } from "./agent-result.ts";
import { errorMessage, toSingleLine } from "../utils.ts";
import { DEFAULT_GRACE_TURNS } from "../config/agent-settings.ts";
import { DEFAULT_CONCURRENCY } from "../config/config-layers.ts";

export const WATCHDOG_TICK_MS = 5_000;

/** Milliseconds in one minute (config timeout thresholds are stored in minutes). */
const MINUTE_MS = 60_000;

/** Exact error message for queued agents that never start because the manager disposed (US-9). */
const DISPOSE_QUEUED_MESSAGE = "Agent manager disposed before the queued agent could start.";

/** UUID prefix length for agent IDs stored in the agents map (uniqueness). */
const AGENT_ID_PREFIX_LENGTH = 17;

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

// Preserve the existing deep-import path for consumers.
export type { ConcurrencyConfig } from "./run-capacity.ts";

type OnAgentComplete = (result: SubagentRunResult, notification?: RunNotificationBinding) => void;
type OnAgentStart = (record: AgentRecord) => void;

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions extends SpawnConfig, RunCallbacks {
  isBackground?: boolean;
  /** Parent scope supplied by the owner-bound coordinator. */
  notificationOwner?: Pick<RunNotificationBinding, "ownerGeneration" | "parentSessionId">;
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
  private capacity: RunCapacity;
  private disposed = false;

  /** Parent-interrupt bindings by record, removed at every terminal transition. */
  private parentBindings = new WeakMap<AgentRecord, { signal: AbortSignal; handler: () => void }>();

  /** In-flight child-session teardowns, tracked so dispose() can await them. */
  private pendingDisposals = new Set<Promise<void>>();

  /** Actual execution lifetimes, registered before start callbacks can reenter dispose(). */
  private inFlightRuns = new Set<Promise<void>>();

  /** Session-level cumulative agent cost. Survives record removal (Clear/dispose). */
  private totalAgentCost = 0;

  /** Session-level completed agent count. Survives record removal (Clear/dispose). */
  private totalAgentCount = 0;

  constructor(
    private owner: ExtensionOwner,
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
    onStart?: OnAgentStart,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.capacity = new RunCapacity({
      ...concurrency,
      default: concurrency?.default ?? DEFAULT_CONCURRENCY.default,
    });

    this.watchdogInterval = setInterval(() => this.checkWatchdogs(), WATCHDOG_TICK_MS);
    this.watchdogInterval.unref();
  }

  /**
   * Update the concurrency configuration.
   * Existing leases remain owned by their originating run. Admission counts
   * all active leases under the new routing policy before draining the queue.
   */
  setConcurrency(config: ConcurrencyConfig): void {
    this.capacity.setConcurrency(config);
  }

  /** Spawn an agent, returning its ID immediately; queued when the concurrency limit is reached. */
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string {
    if (this.disposed) throw new Error("Agent manager is disposed.");
    const id = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const agentConfig = options.agentConfig ?? this.owner.registry.getAgentConfig(type);
    const limits = resolveSpawnLimits(options, agentConfig);
    // Freeze the run limits before a queued launch. Zero prevents the SDK adapter
    // from re-inheriting a type default when the chosen limit is unlimited.
    options = {
      ...options,
      maxTurns: limits.maxTurns ?? 0,
      maxTokens: limits.maxTokens ?? 0,
      graceTurns: options.graceTurns ?? DEFAULT_GRACE_TURNS,
    };
    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    const modelKey = options.modelKey || (options.model && `${options.model.provider}/${options.model.id}`);

    const record: AgentRecord = {
      id,
      lifecycle: {
        status: "queued",
        startedAt: Date.now(),
        // Flipped synchronously in startAgent; distinguishes never-started stops.
        started: false,
      },
      display: {
        type,
        description: options.description,
        invocation: options.invocation,
        toolCall: options.toolCallId
          ? { id: options.toolCallId, background: options.isBackground === true }
          : undefined,
        worktreePath: options.worktreePath,
        worktreeLabel: options.worktreeLabel,
      },
      execution: {
        modelKey,
        graceTurns: options.graceTurns,
      },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        turnCount: 0,
        compactionCount: 0,
        maxTurns: normalizeMaxTurns(options.maxTurns),
      },
    };
    record.execution.continuationActivityCallbacks = {
      onToolActivity: options.onToolActivity,
      onTextDelta: options.onTextDelta,
    };
    this.agents.set(id, record);

    const notification =
      options.notificationOwner &&
      Object.freeze({
        ...options.notificationOwner,
        spawnCtx: ctx,
        required: options.isBackground === true,
      });
    // Capacity schedules synchronous activation after the parent-abort early return.
    const run = this.acceptRun(record, true, notification);

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

    // Immediate errors retain the original failStart/delete/rethrow channel;
    // queued activation failures retain the record and notify through the owner.
    try {
      this.capacity.schedule(run, modelKey, {
        canStart: () => this.agents.get(id) === record && run.phase === "queued",
        start: () => this.trackExecution(() => this.startAgent(id, record, args)),
        onError: (err) => {
          const terminal = this.failStart(record, err);
          // Failed starts notify but aren't tallied as completed agents.
          if (terminal) this.notifyComplete(terminal, run.notification);
        },
      });
    } catch (err) {
      this.failStart(record, err);
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /** Activate an admitted initial run now or from the capacity queue. */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    const run = this.currentRun(record);
    run.start();
    this.projectRun(record, run);

    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();
    // Set synchronously before the run so a stop before the session exists
    // still renders as ran-then-stopped, not never-started.
    record.lifecycle.started = true;
    // The idle clock starts here, so a hung pre-session init phase is covered.
    this.watchdog.start(id);

    // Output transcript: agent frontmatter overrides the global setting (default false).
    const agentConfig = options.agentConfig ?? this.owner.registry.getAgentConfig(type);
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
      agentConfig: options.agentConfig,
      deferredDefaultThinking: options.deferredDefaultThinking,
      model: options.model,
      maxTurns: options.maxTurns,
      maxTokens: options.maxTokens,
      thinkingLevel: options.thinkingLevel,
      cwd: options.worktreePath,
      graceTurns: options.graceTurns,
      projectTrusted: options.projectTrusted,
      customTools: options.customTools,
      signal: run.controller.signal,
      ...this.runTrackingCallbacks(record, run, options),
      onStartupModel: (model) => this.admitStartupModel(record, run, model && `${model.provider}/${model.id}`),
      onSessionCreated: (session) => {
        if (!this.isCurrentRun(record, run)) return;
        record.execution.session = session;
        try {
          run.flushPendingSteers(() => record.execution.session);
          record.execution.outputLog?.attach(session);
          options.onSessionCreated?.(session);
        } catch (error) {
          // The runner disposes a session whose handoff throws.
          if (record.execution.session === session) record.execution.session = undefined;
          throw error;
        }
      },
    });
    return this.attachSettlementChain(record, run, promise);
  }

  /** Reconcile the run's provisional lease with Pi's post-bind model, before the first prompt. */
  private admitStartupModel(record: AgentRecord, run: AgentRun, modelKey: string | undefined): void | Promise<void> {
    const { signal } = run.controller;
    if (signal.aborted) return;

    record.execution.modelKey = modelKey;
    return this.capacity.reconcile(run, modelKey, {
      signal,
      canStart: () =>
        this.agents.get(record.id) === record &&
        this.currentRun(record) === run &&
        (run.phase === "running" || run.phase === "queued"),
      onWaiting: () => {
        run.waitForCapacity();
        this.projectRun(record, run);
      },
      onResume: () => {
        run.start();
        this.projectRun(record, run);
        this.watchdog.start(record.id);
        this.onStart?.(record);
      },
    });
  }

  /** Reserve the shutdown wait synchronously, then tie it to the entire settlement chain. */
  private trackExecution(start: () => Promise<void>): void {
    let attach!: (settlement: Promise<void> | void) => void;
    const execution = new Promise<void>((resolve) => {
      attach = resolve;
    });
    this.inFlightRuns.add(execution);
    const forget = () => {
      this.inFlightRuns.delete(execution);
    };
    try {
      attach(start().finally(forget));
    } catch (error) {
      // No execution chain exists. Keep synchronous start errors in the capacity owner's channel.
      forget();
      attach();
      throw error;
    }
  }

  /** Settle only the execution promise; Stop opens the parent gate separately. */
  private attachSettlementChain(record: AgentRecord, run: AgentRun, runPromise: Promise<RunResult>): Promise<void> {
    let status: SubagentRunStatus = "completed";
    let result: string | undefined;
    let error: string | undefined;
    return runPromise
      .then(({ responseText, session, aborted, turnLimited, modelError }) => {
        run.finishExecution();
        this.projectRun(record, run);
        status = aborted ? "aborted" : modelError ? "error" : turnLimited ? "turn_limited" : "completed";
        result = responseText;
        if (modelError) error = formatModelError(record.display.type, session?.model, modelError);
        record.execution.session = session;
      })
      .catch((err) => {
        run.finishExecution();
        this.projectRun(record, run);
        status = "error";
        error = errorMessage(err);
      })
      .finally(() =>
        run.finishSettlement(
          () => record.execution.session,
          () => {
            this.finalizeOutput(record);
            this.capacity.release(run);
            this.detachParentBinding(record);
            const terminal = this.settleRun(record, run, {
              status,
              result,
              error,
              stoppedBy: record.lifecycle.stoppedBy,
              stopDetail: record.lifecycle.stopDetail,
            });
            if (!this.agents.has(record.id)) this.releaseSession(record);
            if (terminal) {
              this.tallyCompletion(record, terminal.stats.lifetimeUsage.cost);
              this.notifyComplete(terminal, run.notification);
            }
            this.capacity.drain();
            run.publishSettlement();
          },
        ),
      );
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

  private settleRun(
    record: AgentRecord,
    run: AgentRun,
    outcome: Omit<SubagentRunOutcome, "completedAt">,
  ): SubagentRunResult | undefined {
    const completedAt = Date.now();
    const stats = captureResultStats(record);
    const result = run.settle({ ...outcome, completedAt }, record.display, stats);
    if (result) {
      record.stats.contextPercent = stats.contextPercent;
      this.projectRun(record, run);
    }
    return result;
  }

  private failStart(record: AgentRecord, error: unknown): SubagentRunResult | undefined {
    const run = this.currentRun(record);
    this.finalizeOutput(record);
    this.capacity.release(run);
    this.detachParentBinding(record);
    const result = this.settleRun(record, run, { status: "error", error: errorMessage(error) });
    run.publishSettlement();
    return result;
  }

  private currentRun(record: AgentRecord): AgentRun {
    const run = this.runs.get(record)?.at(-1);
    if (!run) throw new Error("Subagent record has no accepted run.");
    return run;
  }

  private isCurrentRun(record: AgentRecord, run: AgentRun): boolean {
    return this.agents.get(record.id) === record && this.currentRun(record) === run && run.acceptsCallbacks;
  }

  private acceptRun(record: AgentRecord, queued = false, notification?: RunNotificationBinding): AgentRun {
    const history = this.runs.get(record) ?? [];
    const run = new AgentRun(record.id, history.length + 1, queued, notification);
    history.push(run);
    this.runs.set(record, history);
    record.execution.abortController = run.controller;
    record.execution.promise = run.parentWait;
    record.lifecycle.stoppedBy = undefined;
    record.lifecycle.stopDetail = undefined;
    this.projectRun(record, run);
    return run;
  }

  /** Central compatibility projection; old outcomes never read mutable record results. */
  private projectRun(record: AgentRecord, run: AgentRun): void {
    if (this.currentRun(record) !== run) return;
    record.stats.runTurnCount = run.turnCount;
    record.lifecycle.phase = run.phase;
    record.lifecycle.status =
      run.outcome?.status ?? (run.phase === "queued" || run.startedAt === undefined ? "queued" : "running");
    record.lifecycle.startedAt = run.startedAt ?? run.acceptedAt;
    record.lifecycle.completedAt = run.outcome?.completedAt;
    record.result = run.outcome?.result;
    record.error = run.outcome?.error;
  }

  getLiveView(id: string): LiveView | undefined {
    const record = this.agents.get(id);
    return record && this.currentRun(record).liveView;
  }

  getCurrentRunId(id: string): string | undefined {
    const record = this.agents.get(id);
    return record && this.currentRun(record).id;
  }

  getInitialRun(id: string): SubagentRun | undefined {
    const record = this.agents.get(id);
    return record && this.runs.get(record)?.[0]?.snapshot();
  }

  getRuns(id: string): readonly SubagentRun[] {
    const record = this.agents.get(id);
    return Object.freeze(record ? (this.runs.get(record) ?? []).map((run) => run.snapshot()) : []);
  }

  /** Remove a record's parent-interrupt binding; a later abort of the signal is a no-op. */
  private detachParentBinding(record: AgentRecord): void {
    const binding = this.parentBindings.get(record);
    if (!binding) return;
    this.parentBindings.delete(record);
    binding.signal.removeEventListener("abort", binding.handler);
  }

  private notifyComplete(result: SubagentRunResult, notification?: RunNotificationBinding): void {
    try {
      this.onComplete?.(result, notification);
    } catch {
      /* ignore */
    }
  }

  private tallyCompletion(record: AgentRecord, cost: number): void {
    // Usage is monotonic (addUsage only accumulates), so the delta from the
    // last tally is the cost this run added. The first tally (talliedCost
    // undefined) also counts the agent; continuations never double-count.
    const baseline = record.execution.talliedCost ?? 0;
    this.totalAgentCost += cost - baseline;
    const firstTally = record.execution.talliedCost === undefined;
    record.execution.talliedCost = cost;
    if (firstTally) this.totalAgentCount++;
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
   * Callback set shared by a first run and a continuation. Updates run activity
   * and record stats, feeds the watchdog, and forwards the caller's callbacks.
   * Continuations carry forward the conversation's total before this run.
   */
  private runTrackingCallbacks(
    record: AgentRecord,
    run: AgentRun,
    forward: RunCallbacks | undefined,
    previousTurns = 0,
  ): SessionPromptOptions {
    return {
      onPromptStateChange: (state) => {
        if (this.isCurrentRun(record, run)) run.recordPromptState(state);
      },
      onToolActivity: (activity) => {
        if (!this.isCurrentRun(record, run)) return;
        if (activity.type === "end") record.stats.toolUses++;
        this.watchdog.recordActivity(record.id, activity);
        if (run.promptSettled) return; // Accounting and watchdogs cover the still-active SDK prompt.
        run.recordToolActivity(activity);
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
        run.recordText(fullText);
        // Streamed response text counts as activity for the idle watchdog.
        this.watchdog.recordText(record.id);
        forward?.onTextDelta?.(delta, fullText);
      },
      onTurnEnd: (turnCount) => {
        if (!this.isCurrentRun(record, run)) return;
        run.turnCount = turnCount;
        record.stats.runTurnCount = run.turnCount;
        record.stats.turnCount = previousTurns + run.turnCount;
        forward?.onTurnEnd?.(turnCount);
      },
    };
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
    const admission = this.currentRun(record).admitMessage(message, record.execution.session);
    if (!("continuationSession" in admission)) return admission;
    const { continuationSession } = admission;
    const model = continuationSession.model;
    const modelKey = model && `${model.provider}/${model.id}`;
    const run = this.capacity.tryAccept(modelKey, () => {
      // Only construction occurs inside the atomic admission; rejected requests create no run/sequence.
      const parent = this.currentRun(record).notification;
      const notification = parent && Object.freeze({ ...parent, required: true });
      return this.acceptRun(record, false, notification);
    });
    if (!run) return reject("capacity", "The model concurrency limit is full. Retry when capacity is available.");
    record.execution.modelKey = modelKey;
    this.trackExecution(() => this.continueSettledAgent(record, continuationSession, message, run));
    return { accepted: true, agentId: id, runId: run.id, delivery: "continuation" };
  }

  /** Compatibility adapter for the existing boolean result. */
  async steer(id: string, message: string): Promise<boolean> {
    return (await this.submitMessage(id, message)).accepted;
  }

  /** Start a continuation after the previous run and model slot both admit it. */
  private continueSettledAgent(
    record: AgentRecord,
    session: AgentSession,
    message: string,
    run: AgentRun,
  ): Promise<void> {
    // Capacity has already accepted and associated this run's lease.
    run.start();
    this.projectRun(record, run);
    // A stale idle clock from the first run would kill the continuation
    // immediately — restart the watchdog before the new turn begins.
    this.watchdog.start(record.id);

    const previousTurns = record.stats.turnCount ?? 0;
    const promise = (async () =>
      continueAgentSession(session, message, {
        ...this.runTrackingCallbacks(record, run, record.execution.continuationActivityCallbacks, previousTurns),
        maxTurns: record.stats.maxTurns,
        graceTurns: record.execution.graceTurns,
        signal: run.controller.signal,
      }))();
    // The parent abort binding is deliberately NOT re-attached — the parent turn that spawned the agent is over.
    return this.attachSettlementChain(record, run, promise);
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
    if (!run.requestStop()) return false;
    this.capacity.cancelWaiting(run);
    record.lifecycle.stoppedBy = stoppedBy;
    record.lifecycle.stopDetail = stopDetail;
    // Publish intent before abort: listeners may run synchronously.
    this.projectRun(record, run);
    this.detachParentBinding(record);
    run.controller.abort();
    // Abort listeners can synchronously update this run's statistics.
    if (record.lifecycle.started) {
      run.acknowledgeStop(record.display, captureResultStats(record));
    } else {
      const terminal = this.settleRun(record, run, { status: "stopped", stoppedBy, stopDetail });
      run.publishSettlement();
      if (terminal) this.notifyComplete(terminal, run.notification);
    }
    return true;
  }

  private removeRecord(id: string, record: AgentRecord): void {
    this.releaseSession(record);
    this.detachParentBinding(record);
    // The run's gate is already open at settlement. Clear drops retained history.
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
    this.capacity.close();
    clearInterval(this.watchdogInterval);
    for (const record of this.agents.values()) {
      const run = this.currentRun(record);
      if (run.phase === "queued" && !record.lifecycle.started) {
        this.settleRun(record, run, { status: "error", error: DISPOSE_QUEUED_MESSAGE });
        run.publishSettlement();
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
