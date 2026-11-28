import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PromptState } from "./session-run.ts";
import { RunSteerClosed, steerForRun } from "./sdk-run-steering.ts";
import type {
  AgentSubmissionResult,
  RunNotificationBinding,
  RunResultStats,
  SubagentParentReport,
  SubagentRun,
  SubagentRunOutcome,
  SubagentRunPhase,
  SubagentRunResult,
  ToolActivity,
} from "../types.ts";

const QUEUE_CLEANUP_FAILED = "The previous run's message queue could not be cleared. This subagent cannot continue.";
const RUN_SETTLING = "The subagent is finishing its previous run. Retry after settlement.";

/** The manager's sole mutable owner for one execution and its two wait gates. */
export class AgentRun {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  readonly acceptedAt = Date.now();
  readonly liveView = { activeTools: new Map<string, string>(), responseText: "" };
  turnCount = 0;
  private currentPhase: SubagentRunPhase;
  startedAt?: number;
  private stopRequestedAt?: number;
  private terminalResult?: SubagentRunResult;
  private settlementPublished = false;
  private promptState?: PromptState;
  private executionFinished = false;
  private queueCleanupFailed = false;
  private readonly steerLifetime = new AbortController();
  private pendingSteers?: string[];
  private steerTail?: Promise<void>;
  readonly parentWait: Promise<SubagentParentReport>;
  readonly completion: Promise<void>;
  private resolveParent?: (report: SubagentParentReport) => void;
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
    this.startedAt ??= Date.now();
  }

  waitForCapacity(): void {
    this.currentPhase = "queued";
  }

  requestStop(): boolean {
    if (this.phase !== "queued" && this.phase !== "running") return false;
    this.stopRequestedAt = Date.now();
    this.currentPhase = "stopping";
    this.pendingSteers = undefined;
    this.steerLifetime.abort();
    return true;
  }

  get acceptsCallbacks(): boolean {
    return !this.executionFinished && (this.phase === "running" || this.phase === "stopping");
  }

  recordToolActivity({ type, toolCallId, toolName }: ToolActivity): void {
    const tools = this.liveView.activeTools;
    if (type === "start") {
      if (toolCallId) tools.set(toolCallId, toolName);
    } else if (toolCallId) {
      tools.delete(toolCallId);
    } else {
      // Synthetic end events have only a tool name, as in the watchdog.
      for (const [id, name] of tools) {
        if (name === toolName) {
          tools.delete(id);
          break;
        }
      }
    }
  }

  recordText(fullText: string): void {
    this.liveView.responseText = fullText;
  }

  recordPromptState(state: PromptState): void {
    this.promptState = state;
    if (state !== "started") this.steerLifetime.abort();
  }

  get promptSettled(): boolean {
    return this.promptState === "settled" || this.promptState === "finished";
  }

  finishExecution(): void {
    this.executionFinished = true;
    this.currentPhase = this.stopRequestedAt !== undefined ? "stopping" : "settling";
    this.steerLifetime.abort();
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
        return {
          accepted: false,
          reason: "queued",
          message: "The subagent is queued and has not started.",
        };
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
          return {
            accepted: false,
            reason: "unavailable",
            message: "The subagent session is unavailable or busy.",
          };
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

  private steer(session: AgentSession, message: string): Promise<AgentSubmissionResult> {
    // Keep the first submission eager, but make later calls wait through its SDK queue write.
    const previous = this.steerTail;
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.steerTail = tail;
    const delivery = previous
      ? previous.then(() => this.deliverSteer(session, message))
      : this.deliverSteer(session, message);
    const settled = () => {
      if (this.steerTail === tail) this.steerTail = undefined;
      release();
    };
    void delivery.then(settled, settled);
    return delivery;
  }

  private async deliverSteer(session: AgentSession, message: string): Promise<AgentSubmissionResult> {
    if (this.steerLifetime.signal.aborted || this.isPromptClosed(session.isStreaming)) return this.closedSteer();
    try {
      await steerForRun(session, message, this.steerLifetime.signal, () => !this.isPromptClosed(session.isStreaming));
    } catch (err) {
      if (!(err instanceof RunSteerClosed)) {
        return {
          accepted: false,
          reason: "delivery_failed",
          message: "The session refused the message.",
        };
      }
      return this.closedSteer();
    }
    if (this.steerLifetime.signal.aborted || this.isPromptClosed(session.isStreaming)) return this.closedSteer();
    return { accepted: true, agentId: this.agentId, runId: this.id, delivery: "steer" };
  }

  private closedSteer(): AgentSubmissionResult {
    return {
      accepted: false,
      reason: this.stopRequestedAt !== undefined ? "stopping" : "settling",
      message: "The run ended before the message could be delivered. Retry after settlement.",
    };
  }

  /** Independent SDK activity can become streaming again after this run's agent_settled. */
  private isPromptClosed(isStreaming: boolean): boolean {
    // Before startup, a bound session can already queue steering for this run.
    return this.executionFinished || this.promptSettled || (this.promptState === "started" && !isStreaming);
  }

  async finishSettlement(getSession: () => AgentSession | undefined, publish: () => void): Promise<void> {
    await this.steerTail;
    // The SDK can still consume independent inputs after agent_settled. Read
    // the session after draining because owner teardown can detach it.
    const session = getSession();
    try {
      if (session?.isStreaming) this.queueCleanupFailed = true;
      else session?.clearQueue();
    } catch {
      // Completion and capacity release still proceed. Reuse does not.
      this.queueCleanupFailed = true;
    }
    this.pendingSteers = undefined;
    publish();
  }

  acknowledgeStop(
    { type, description, worktreePath }: Pick<SubagentRunResult, "type" | "description" | "worktreePath">,
    stats: RunResultStats,
  ): void {
    this.openParent(Object.freeze({ status: "stopping", type, description, worktreePath, stats }));
  }

  private openParent(report: SubagentParentReport): void {
    this.resolveParent?.(report);
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
    this.liveView.activeTools.clear();
    this.liveView.responseText = "";
    this.openParent(result);
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
