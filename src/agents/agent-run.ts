import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  AgentSubmissionResult,
  RunNotificationBinding,
  RunResultStats,
  SubagentRun,
  SubagentRunOutcome,
  SubagentRunPhase,
  SubagentRunResult,
} from "../types.ts";

const QUEUE_CLEANUP_FAILED = "The previous run's message queue could not be cleared. This subagent cannot continue.";
const RUN_SETTLING = "The subagent is finishing its previous run. Retry after settlement.";

/** The manager's sole mutable owner for one execution and its two wait gates. */
export class AgentRun {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  readonly acceptedAt = Date.now();
  private currentPhase: SubagentRunPhase;
  startedAt?: number;
  private stopRequestedAt?: number;
  private terminalResult?: SubagentRunResult;
  private settlementPublished = false;
  private promptState?: "started" | "finished";
  private executionFinished = false;
  private queueCleanupFailed = false;
  private pendingSteers?: string[];
  private callbacks = new Set<Promise<void>>();
  readonly parentWait: Promise<string>;
  readonly completion: Promise<void>;
  private resolveParent?: (value: string) => void;
  private resolveCompletion!: () => void;

  constructor(
    readonly agentId: string,
    readonly sequence: number,
    queued = false,
    readonly notification?: RunNotificationBinding,
  ) {
    this.currentPhase = queued ? "queued" : "running";
    this.parentWait = new Promise((resolve) => {
      this.resolveParent = resolve;
    });
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  get phase(): SubagentRunPhase {
    return this.currentPhase;
  }

  get outcome(): SubagentRunResult | undefined {
    return this.terminalResult;
  }

  start(): void {
    this.currentPhase = "running";
    this.startedAt = Date.now();
  }

  requestStop(): boolean {
    if (this.phase !== "queued" && this.phase !== "running") return false;
    this.stopRequestedAt = Date.now();
    this.currentPhase = "stopping";
    this.pendingSteers = undefined;
    return true;
  }

  get acceptsCallbacks(): boolean {
    return !this.executionFinished && (this.phase === "running" || this.phase === "stopping");
  }

  recordPromptState(state: "started" | "finished"): void {
    this.promptState = state;
  }

  finishExecution(): void {
    this.executionFinished = true;
    this.currentPhase = this.stopRequestedAt !== undefined ? "stopping" : "settling";
  }

  admitMessage(
    message: string,
    session: AgentSession | undefined,
  ): AgentSubmissionResult | Promise<AgentSubmissionResult> | { continuationSession: AgentSession } {
    switch (this.phase) {
      case "stopping":
        return {
          accepted: false,
          reason: "stopping",
          message: "The subagent is still stopping. Wait for execution to settle.",
        };
      case "queued":
        return { accepted: false, reason: "queued", message: "The subagent is queued and has not started." };
      case "settling":
        return { accepted: false, reason: "settling", message: RUN_SETTLING };
      case "running":
        if (session) return this.steer(session, message);
        (this.pendingSteers ??= []).push(message);
        return { accepted: true, agentId: this.agentId, runId: this.id, delivery: "pending_steer" };
      case "settled":
        if (!this.settlementPublished) return { accepted: false, reason: "settling", message: RUN_SETTLING };
        if (this.queueCleanupFailed) return { accepted: false, reason: "unavailable", message: QUEUE_CLEANUP_FAILED };
        if (!session || session.isStreaming)
          return { accepted: false, reason: "unavailable", message: "The subagent session is unavailable or busy." };
        return { continuationSession: session };
    }
  }

  flushPendingSteers(getSession: () => AgentSession | undefined): void {
    if (this.controller.signal.aborted) return;
    for (const message of this.pendingSteers ?? []) {
      const session = getSession();
      if (session) void this.steer(session, message);
    }
    this.pendingSteers = undefined;
  }

  private async steer(session: AgentSession, message: string): Promise<AgentSubmissionResult> {
    if (this.isPromptClosed(session.isStreaming)) return { accepted: false, reason: "settling", message: RUN_SETTLING };
    try {
      await this.trackCallback(session.steer(message));
      // Input hooks can outlive both the prompt and the stop request.
      if (this.controller.signal.aborted || this.isPromptClosed(session.isStreaming)) {
        return {
          accepted: false,
          reason: this.controller.signal.aborted ? "stopping" : "settling",
          message: "The run ended before the message could be delivered. Retry after settlement.",
        };
      }
      return { accepted: true, agentId: this.agentId, runId: this.id, delivery: "steer" };
    } catch {
      return { accepted: false, reason: "delivery_failed", message: "The session refused the message." };
    }
  }

  /** The SDK stays streaming through tools, but clears it before publishing agent_settled. */
  private isPromptClosed(isStreaming: boolean): boolean {
    // Before startup, a bound session can already queue steering for this run.
    return (
      this.executionFinished || this.promptState === "finished" || (this.promptState === "started" && !isStreaming)
    );
  }

  private trackCallback<T>(work: Promise<T>): Promise<T> {
    const done = work.then(
      () => {},
      () => {},
    );
    this.callbacks.add(done);
    void done.then(() => this.callbacks.delete(done));
    return work;
  }

  private async drainCallbacks(): Promise<void> {
    while (this.callbacks.size > 0) await Promise.all(this.callbacks);
  }

  async finishSettlement(getSession: () => AgentSession | undefined, publish: () => void): Promise<void> {
    await this.drainCallbacks();
    try {
      // Read after draining: owner teardown can detach the session while we wait.
      getSession()?.clearQueue();
    } catch {
      // Completion and capacity release still proceed. Reuse does not.
      this.queueCleanupFailed = true;
    }
    this.pendingSteers = undefined;
    publish();
  }

  openParent(value = ""): void {
    this.resolveParent?.(value);
    this.resolveParent = undefined;
  }

  settle(
    outcome: SubagentRunOutcome,
    display: Pick<SubagentRunResult, "type" | "description" | "worktreePath" | "outputFile">,
    stats: RunResultStats,
  ): SubagentRunResult | undefined {
    if (this.terminalResult) return undefined;
    const error = this.queueCleanupFailed
      ? outcome.error
        ? `${outcome.error}\n${QUEUE_CLEANUP_FAILED}`
        : QUEUE_CLEANUP_FAILED
      : outcome.error;
    const result: SubagentRunResult = Object.freeze({
      ...outcome,
      type: display.type,
      description: display.description,
      worktreePath: display.worktreePath,
      outputFile: display.outputFile,
      agentId: this.agentId,
      runId: this.id,
      sequence: this.sequence,
      started: this.startedAt !== undefined,
      elapsedMs: outcome.completedAt - (this.startedAt ?? this.acceptedAt),
      stats,
      status: this.stopRequestedAt !== undefined ? "stopped" : outcome.status,
      ...(error !== undefined && { error }),
      stopDetail: outcome.stopDetail ? Object.freeze({ ...outcome.stopDetail }) : undefined,
    });
    this.terminalResult = result;
    this.currentPhase = "settled";
    this.openParent(result.result);
    this.resolveCompletion();
    return result;
  }

  /** Allow continuation after the manager finishes publishing this run. */
  publishSettlement(): void {
    this.settlementPublished = true;
  }

  snapshot(): SubagentRun {
    return Object.freeze({
      id: this.id,
      agentId: this.agentId,
      sequence: this.sequence,
      phase: this.phase,
      acceptedAt: this.acceptedAt,
      startedAt: this.startedAt,
      stopRequestedAt: this.stopRequestedAt,
      outcome: this.outcome,
      completion: this.completion,
    });
  }
}
