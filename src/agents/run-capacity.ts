import { DEFAULT_CONCURRENCY, isConcurrencyLimit } from "../config/config-layers.ts";

/** Run-owned admission, startup model transfer and per-pool FIFO; no execution lifecycle ownership. */
export interface ConcurrencyConfig {
  /** Default concurrency is per model, not a global pool. */
  default: number;
  providers?: Record<string, number>;
  models?: Record<string, number>;
}

export type RunCapacityToken = object;
export type CapacityAdmission = "started" | "queued" | "cancelled" | "closed";

export interface RunCapacityWork {
  canStart(): boolean;
  start(): void;
  onError(error: unknown): void;
}

export interface StartupCapacityWork {
  signal: AbortSignal;
  canStart(): boolean;
  onWaiting(): void;
  onResume(): void;
}

interface Lease {
  modelKey: string;
}

interface WaitingWork {
  run: RunCapacityToken;
  modelKey: string;
  canStart(): boolean;
  activate(): void;
  cancel(): void;
  onError(error: unknown): void;
}

export class RunCapacity {
  private defaultConcurrency = DEFAULT_CONCURRENCY.default;
  private providers = new Map<string, number>();
  private models = new Map<string, number>();
  /** Ownership stays fixed; counts are derived from each lease's actual model under current routing. */
  private activeLeases = new Set<Lease>();
  private runLeases = new WeakMap<RunCapacityToken, Lease>();
  private queue: WaitingWork[] = [];
  private closed = false;

  constructor(config: ConcurrencyConfig) {
    this.setConcurrency(config);
  }

  setConcurrency(config: ConcurrencyConfig): void {
    this.defaultConcurrency = isConcurrencyLimit(config.default) ? config.default : DEFAULT_CONCURRENCY.default;
    this.copyLimits(this.providers, config.providers);
    this.copyLimits(this.models, config.models);
    this.drain();
  }

  private copyLimits(target: Map<string, number>, entries: Record<string, number> | undefined): void {
    target.clear();
    for (const [key, limit] of Object.entries(entries ?? {})) {
      if (isConcurrencyLimit(limit)) target.set(key, limit);
    }
  }

  private poolKey(modelKey: string): string {
    if (this.models.has(modelKey)) return `model:${modelKey}`;
    const provider = modelKey.split("/")[0];
    return this.providers.has(provider) ? `provider:${provider}` : `model:${modelKey}`;
  }

  private hasCapacity(modelKey: string): boolean {
    const provider = modelKey.split("/")[0];
    const limit = this.models.get(modelKey) ?? this.providers.get(provider) ?? this.defaultConcurrency;
    const pool = this.poolKey(modelKey);
    let running = 0;
    for (const lease of this.activeLeases) {
      if (this.poolKey(lease.modelKey) === pool) running++;
    }
    return running < limit;
  }

  private canAdmit(modelKey: string): boolean {
    const pool = this.poolKey(modelKey);
    // A new arrival, including one from a completion callback, cannot overtake this pool's FIFO.
    return !this.queue.some((entry) => this.poolKey(entry.modelKey) === pool) && this.hasCapacity(modelKey);
  }

  private claim(run: RunCapacityToken, modelKey: string): void {
    const lease = { modelKey };
    this.activeLeases.add(lease);
    this.runLeases.set(run, lease);
  }

  schedule(run: RunCapacityToken, modelKey: string | undefined, work: RunCapacityWork): CapacityAdmission {
    if (this.closed) return "closed";
    if (!work.canStart()) return "cancelled";
    if (modelKey && !this.canAdmit(modelKey)) {
      this.queue.push({
        run,
        modelKey,
        canStart: () => work.canStart(),
        activate: () => work.start(),
        cancel: () => {},
        onError: (error) => work.onError(error),
      });
      return "queued";
    }
    if (modelKey) this.claim(run, modelKey);
    // An immediate failure belongs to the caller's failStart/delete/rethrow path.
    work.start();
    return "started";
  }

  reconcile(run: RunCapacityToken, modelKey: string | undefined, work: StartupCapacityWork): void | Promise<void> {
    if (this.closed || work.signal.aborted || !work.canStart()) return;
    const lease = this.runLeases.get(run);
    if (lease && modelKey && this.poolKey(lease.modelKey) === this.poolKey(modelKey)) {
      // Keep admission order and ownership, but use the final model when routing changes later.
      lease.modelKey = modelKey;
      return;
    }

    this.release(run);
    if (!modelKey || this.canAdmit(modelKey)) {
      if (modelKey) this.claim(run, modelKey);
      if (lease) this.drain();
      return;
    }

    work.onWaiting();
    const gate = new Promise<void>((resolve, reject) => {
      const stop = () => this.cancelWaiting(run);
      const detach = () => work.signal.removeEventListener("abort", stop);
      this.queue.push({
        run,
        modelKey,
        canStart: () => !work.signal.aborted && work.canStart(),
        activate: () => {
          detach();
          work.onResume();
          resolve();
        },
        cancel: () => {
          detach();
          resolve(); // Runner checks the signal and owns parked-session teardown.
        },
        onError: (error) => {
          detach();
          reject(error); // Resume failures must settle through the Runner's cleanup chain.
        },
      });
      work.signal.addEventListener("abort", stop, { once: true });
      if (work.signal.aborted) this.cancelWaiting(run);
    });
    if (lease) this.drain();
    return gate;
  }

  tryAccept<T extends RunCapacityToken>(modelKey: string | undefined, accept: () => T): T | undefined {
    if (this.closed || (modelKey && !this.canAdmit(modelKey))) return undefined;
    // Reserve before constructing the run: callback reentry must see the acceptance in progress.
    const lease = modelKey ? { modelKey } : undefined;
    if (lease) this.activeLeases.add(lease);
    try {
      const run = accept();
      if (lease) this.runLeases.set(run, lease);
      return run;
    } catch (error) {
      if (lease) this.activeLeases.delete(lease);
      throw error;
    }
  }

  cancelWaiting(run: RunCapacityToken): void {
    const cancelled = this.queue.filter((entry) => entry.run === run);
    this.queue = this.queue.filter((entry) => entry.run !== run);
    for (const entry of cancelled) entry.cancel();
  }

  /** Actual settlement authorizes release. This operation deliberately does not advance waiting work. */
  release(run: RunCapacityToken): void {
    const lease = this.runLeases.get(run);
    if (!lease) return;
    this.runLeases.delete(run);
    this.activeLeases.delete(lease);
  }

  drain(): void {
    // No suppression guard: callbacks may synchronously drain under a new configuration.
    // Remove and claim before activation, then rescan the live FIFO after every callback.
    for (let index = 0; !this.closed && index < this.queue.length;) {
      const entry = this.queue[index];
      if (!entry.canStart()) {
        this.queue.splice(index, 1);
        entry.cancel();
        continue;
      }
      if (!this.hasCapacity(entry.modelKey)) {
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      this.claim(entry.run, entry.modelKey);
      index = 0;
      try {
        entry.activate();
      } catch (error) {
        entry.onError(error);
      }
    }
  }

  close(): void {
    this.closed = true;
    const cancelled = this.queue;
    this.queue = [];
    for (const entry of cancelled) entry.cancel();
    // Active leases outlive admission closure and are released only by their original run owner.
  }
}
