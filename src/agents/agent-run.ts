import { randomUUID } from "node:crypto";
import type { SubagentRun, SubagentRunOutcome, SubagentRunPhase } from "../types.ts";

/** The manager's sole mutable owner for one execution and its two wait gates. */
export class AgentRun {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  readonly acceptedAt = Date.now();
  phase: SubagentRunPhase;
  startedAt?: number;
  stopRequestedAt?: number;
  outcome?: SubagentRunOutcome;
  promptState?: "started" | "finished";
  executionFinished = false;
  queueCleanupFailed = false;
  private callbacks = new Set<Promise<void>>();
  readonly parentWait: Promise<string>;
  readonly completion: Promise<void>;
  private resolveParent?: (value: string) => void;
  private resolveCompletion!: () => void;

  constructor(
    readonly agentId: string,
    readonly sequence: number,
    queued = false,
  ) {
    this.phase = queued ? "queued" : "running";
    this.parentWait = new Promise((resolve) => {
      this.resolveParent = resolve;
    });
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  /** The SDK stays streaming through tools, but clears it before publishing agent_settled. */
  isPromptClosed(isStreaming: boolean): boolean {
    // Before startup, a bound session can already queue steering for this run.
    return (
      this.executionFinished || this.promptState === "finished" || (this.promptState === "started" && !isStreaming)
    );
  }

  trackCallback<T>(work: Promise<T>): Promise<T> {
    const done = work.then(
      () => {},
      () => {},
    );
    this.callbacks.add(done);
    void done.then(() => this.callbacks.delete(done));
    return work;
  }

  async drainCallbacks(): Promise<void> {
    while (this.callbacks.size > 0) await Promise.all(this.callbacks);
  }

  openParent(value = ""): void {
    this.resolveParent?.(value);
    this.resolveParent = undefined;
  }

  settle(outcome: SubagentRunOutcome): void {
    if (this.outcome) return;
    this.outcome = Object.freeze({
      ...outcome,
      stopDetail: outcome.stopDetail ? Object.freeze({ ...outcome.stopDetail }) : undefined,
    });
    this.phase = "settled";
    this.openParent(outcome.result);
    this.resolveCompletion();
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
