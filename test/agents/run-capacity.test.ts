import { describe, expect, it, vi } from "vite-plus/test";
import {
  RunCapacity,
  type ConcurrencyConfig,
  type RunCapacityWork,
  type StartupCapacityWork,
} from "../../src/agents/run-capacity.js";

function work(overrides: Partial<RunCapacityWork> = {}) {
  return {
    canStart: vi.fn<RunCapacityWork["canStart"]>(overrides.canStart ?? (() => true)),
    start: vi.fn<RunCapacityWork["start"]>(overrides.start ?? (() => {})),
    onError: vi.fn<RunCapacityWork["onError"]>(overrides.onError ?? (() => {})),
  };
}

function startup(controller = new AbortController(), overrides: Partial<StartupCapacityWork> = {}) {
  return {
    signal: overrides.signal ?? controller.signal,
    canStart: vi.fn<StartupCapacityWork["canStart"]>(overrides.canStart ?? (() => true)),
    onWaiting: vi.fn<StartupCapacityWork["onWaiting"]>(overrides.onWaiting ?? (() => {})),
    onResume: vi.fn<StartupCapacityWork["onResume"]>(overrides.onResume ?? (() => {})),
  };
}

// Opaque run tokens and public callbacks only: no Manager/SDK or private accounting inspection.
describe("RunCapacity", () => {
  it("ignores invalid overrides at construction and reconfiguration", () => {
    const config = { default: 1, providers: { p: 1.5 }, models: { "p/a": Infinity } };
    const capacity = new RunCapacity(config);
    for (const suffix of ["a", "b"]) {
      expect(capacity.schedule({}, `p/${suffix}`, work())).toBe("started");
      expect(capacity.schedule({}, `p/${suffix}`, work())).toBe("queued");
      capacity.setConcurrency(config);
    }
  });

  it("routes model before provider before default, with independent default pools", () => {
    const capacity = new RunCapacity({ default: 1, providers: { p: 2 }, models: { "p/a": 1 } });
    expect(capacity.schedule({}, "p/a", work())).toBe("started");
    expect(capacity.schedule({}, "p/a", work())).toBe("queued");
    expect(capacity.schedule({}, "p/b", work())).toBe("started");
    expect(capacity.schedule({}, "p/c", work())).toBe("started");
    expect(capacity.schedule({}, "p/d", work())).toBe("queued");
    expect(capacity.schedule({}, "q/a", work())).toBe("started");
    expect(capacity.schedule({}, "q/b", work())).toBe("started");
    expect(capacity.schedule({}, undefined, work())).toBe("started");
  });

  it("preserves final-model lease across provider split", () => {
    const capacity = new RunCapacity({ default: 1, providers: { p: 1 } });
    const run = {};
    capacity.schedule(run, "p/a", work());
    const final = startup();
    expect(capacity.reconcile(run, "p/b", final)).toBeUndefined();
    expect(final.onWaiting).not.toHaveBeenCalled();
    expect(final.onResume).not.toHaveBeenCalled();
    capacity.setConcurrency({ default: 1, models: { "p/b": 1 } });
    expect(capacity.tryAccept("p/a", () => ({}))).toBeDefined();
    const accept = vi.fn(() => ({}));
    expect(capacity.tryAccept("p/b", accept)).toBeUndefined();
    expect(accept).not.toHaveBeenCalled();
    capacity.release(run);
    expect(capacity.tryAccept("p/b", accept)).toBeDefined();
  });

  it("snapshots concurrency input at construction and explicit updates", () => {
    const config: ConcurrencyConfig = { default: 1, providers: { p: 1 }, models: { "q/a": 1 } };
    const capacity = new RunCapacity(config);
    capacity.schedule({}, "p/a", work());
    capacity.schedule({}, "q/a", work());
    const providerWaiter = work();
    const modelWaiter = work();
    capacity.schedule({}, "p/b", providerWaiter);
    capacity.schedule({}, "q/a", modelWaiter);
    config.providers!.p = 2;
    config.models!["q/a"] = 2;
    capacity.drain();
    expect(providerWaiter.start).not.toHaveBeenCalled();
    expect(modelWaiter.start).not.toHaveBeenCalled();
    capacity.setConcurrency(config);
    expect(providerWaiter.start).toHaveBeenCalledTimes(1);
    expect(modelWaiter.start).toHaveBeenCalledTimes(1);
    config.providers!.p = 3;
    config.models!["q/a"] = 3;
    expect(capacity.tryAccept("p/c", () => ({}))).toBeUndefined();
    expect(capacity.tryAccept("q/a", () => ({}))).toBeUndefined();
  });

  it("keeps run-owned leases counted through routing changes and overcommit", () => {
    const capacity = new RunCapacity({ default: 1 });
    const a = {};
    const b = {};
    capacity.schedule(a, "p/a", work());
    capacity.schedule(b, "p/b", work());
    const waiting = work();
    capacity.schedule({}, "p/a", waiting);
    capacity.setConcurrency({ default: 9, providers: { p: 1 } });
    capacity.release(a);
    capacity.drain();
    expect(waiting.start).not.toHaveBeenCalled();
    capacity.release(a);
    capacity.release(b);
    capacity.drain();
    expect(waiting.start).toHaveBeenCalledTimes(1);
  });

  it("transfers across pools behind destination FIFO and advances the old pool", async () => {
    const capacity = new RunCapacity({ default: 1 });
    const transfer = {};
    const target = {};
    const firstTarget = {};
    const events: string[] = [];
    capacity.schedule(transfer, "p/a", work());
    capacity.schedule(target, "p/b", work());
    capacity.schedule({}, "p/a", work({ start: () => events.push("old") }));
    capacity.schedule(firstTarget, "p/b", work({ start: () => events.push("target-first") }));
    const final = startup(new AbortController(), { onResume: () => events.push("transfer") });
    const gate = capacity.reconcile(transfer, "p/b", final);
    expect(final.onWaiting).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["old"]);
    capacity.release(target);
    capacity.drain();
    expect(events).toEqual(["old", "target-first"]);
    capacity.release(firstTarget);
    capacity.drain();
    await gate;
    expect(events).toEqual(["old", "target-first", "transfer"]);
    expect(capacity.tryAccept("p/b", () => ({}))).toBeUndefined();
  });

  it("counts acceptance before callback and rolls back throwing creation", () => {
    const capacity = new RunCapacity({ default: 1 });
    const nested = vi.fn(() => ({}));
    const token = {};
    expect(
      capacity.tryAccept("p/a", () => {
        expect(capacity.tryAccept("p/a", nested)).toBeUndefined();
        return token;
      }),
    ).toBe(token);
    expect(nested).not.toHaveBeenCalled();
    expect(capacity.tryAccept("p/a", nested)).toBeUndefined();
    capacity.release(token);
    const error = new Error("creation failed");
    expect(() =>
      capacity.tryAccept("p/a", () => {
        throw error;
      }),
    ).toThrow(error);
    expect(capacity.tryAccept("p/a", nested)).toBeDefined();
    expect(nested).toHaveBeenCalledTimes(1);
  });

  it("does not drain on release and does not let notification arrivals bypass FIFO", () => {
    const capacity = new RunCapacity({ default: 1 });
    const held = {};
    const first = {};
    const events: string[] = [];
    capacity.schedule(held, "p/a", work());
    const waiter = work({ start: () => events.push("first") });
    capacity.schedule(first, "p/a", waiter);
    capacity.release(held);
    expect(waiter.start).not.toHaveBeenCalled();
    expect(capacity.tryAccept("p/a", () => ({}))).toBeUndefined();
    expect(capacity.schedule({}, "p/a", work({ start: () => events.push("arrival") }))).toBe("queued");
    capacity.schedule({}, "p/b", work({ start: () => events.push("other") }));
    capacity.drain();
    expect(events).toEqual(["other", "first"]);
    capacity.release(first);
    capacity.drain();
    capacity.drain();
    expect(events).toEqual(["other", "first", "arrival"]);
  });

  it("rescans synchronously after nested concurrency update with committed activation", () => {
    const capacity = new RunCapacity({ default: 1 });
    const held = {};
    const events: string[] = [];
    capacity.schedule(held, "p/a", work());
    capacity.schedule(
      {},
      "p/a",
      work({
        start: () => {
          events.push("a-before");
          // The started entry is gone and its lease already counts, even in a nested drain.
          expect(capacity.tryAccept("p/a", () => ({}))).toBeUndefined();
          capacity.setConcurrency({ default: 2 });
          events.push("a-after");
        },
      }),
    );
    capacity.schedule({}, "p/a", work({ start: () => events.push("b") }));
    capacity.release(held);
    capacity.drain();
    expect(events).toEqual(["a-before", "b", "a-after"]);
  });

  it("rescans after synchronous cancel and nested drain without duplicating starts", () => {
    const capacity = new RunCapacity({ default: 1 });
    const held = {};
    const active = {};
    const cancelled = {};
    const events: string[] = [];
    capacity.schedule(held, "p/a", work());
    capacity.schedule(
      active,
      "p/a",
      work({
        start: () => {
          events.push("a-before");
          capacity.cancelWaiting(cancelled);
          capacity.cancelWaiting(active); // Not a stop or a release of the active lease.
          capacity.drain();
          expect(events).toEqual(["a-before"]);
          capacity.release(active);
          capacity.drain();
          events.push("a-after");
        },
      }),
    );
    capacity.schedule(cancelled, "p/a", work({ start: () => events.push("cancelled") }));
    capacity.schedule({}, "p/a", work({ start: () => events.push("c") }));
    capacity.release(held);
    capacity.drain();
    expect(events).toEqual(["a-before", "c", "a-after"]);
  });

  it("closes synchronously in a queued callback but retains active ownership for late release", () => {
    const capacity = new RunCapacity({ default: 1 });
    const held = {};
    const active = {};
    const events: string[] = [];
    capacity.schedule(held, "p/a", work());
    capacity.schedule(
      active,
      "p/a",
      work({
        start: () => {
          events.push("a-before");
          capacity.close();
          capacity.setConcurrency({ default: 9 });
          capacity.drain();
          events.push("a-after");
        },
      }),
    );
    const cancelled = work({ start: () => events.push("b") });
    capacity.schedule({}, "p/a", cancelled);
    capacity.release(held);
    capacity.drain();
    expect(events).toEqual(["a-before", "a-after"]);
    expect(capacity.schedule({}, undefined, work())).toBe("closed");
    const accept = vi.fn(() => ({}));
    expect(capacity.tryAccept(undefined, accept)).toBeUndefined();
    expect(accept).not.toHaveBeenCalled();
    capacity.release(active);
    capacity.release(active);
    capacity.close();
    expect(cancelled.start).not.toHaveBeenCalled();
  });

  it.each(["abort", "cancel", "close"] as const)("cancels parked gate without resuming (%s)", async (action) => {
    const capacity = new RunCapacity({ default: 1 });
    const held = {};
    const parked = {};
    capacity.schedule(held, "p/a", work());
    capacity.schedule(parked, undefined, work());
    const controller = new AbortController();
    const final = startup(controller);
    const gate = capacity.reconcile(parked, "p/a", final);
    if (action === "abort") controller.abort();
    else if (action === "cancel") capacity.cancelWaiting(parked);
    else capacity.close();
    await gate;
    capacity.cancelWaiting(parked);
    capacity.drain();
    expect(final.onResume).not.toHaveBeenCalled();
    // Cancelling waiting does not relinquish the unrelated active execution's lease.
    expect(capacity.tryAccept("p/a", () => ({}))).toBeUndefined();
    capacity.release(held);
    capacity.drain();
    expect(final.onResume).not.toHaveBeenCalled();
  });

  it("uses canStart as the owner bridge, cancelling ineligible work and parked gates", async () => {
    const capacity = new RunCapacity({ default: 1 });
    const invalid = work({ canStart: () => false });
    expect(capacity.schedule({}, "p/a", invalid)).toBe("cancelled");
    expect(invalid.start).not.toHaveBeenCalled();
    const held = {};
    capacity.schedule(held, "p/a", work());
    let eligible = true;
    const waiter = work({ canStart: () => eligible });
    capacity.schedule({}, "p/a", waiter);
    const final = startup(new AbortController(), { canStart: () => eligible });
    const gate = capacity.reconcile({}, "p/a", final);
    eligible = false;
    capacity.release(held);
    capacity.drain();
    await gate;
    expect(waiter.start).not.toHaveBeenCalled();
    expect(final.onResume).not.toHaveBeenCalled();
    expect(capacity.tryAccept("p/a", () => ({}))).toBeDefined();
  });

  it("keeps immediate initial throws in the caller channel and queued throws in onError", () => {
    const capacity = new RunCapacity({ default: 1 });
    const immediateRun = {};
    const error = new Error("initial failed");
    const immediate = work({
      start: () => {
        throw error;
      },
    });
    expect(() => capacity.schedule(immediateRun, "p/a", immediate)).toThrow(error);
    expect(immediate.onError).not.toHaveBeenCalled();
    const queuedRun = {};
    const queued = work({
      start: () => {
        throw error;
      },
    });
    capacity.schedule(queuedRun, "p/a", queued);
    capacity.release(immediateRun); // Owner failStart cleanup authorizes release, not the module.
    capacity.drain();
    expect(queued.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(capacity.tryAccept("p/a", () => ({}))).toBeUndefined();
    capacity.release(queuedRun);
    expect(capacity.tryAccept("p/a", () => ({}))).toBeDefined();
  });

  it("rejects startup resume errors while retaining the lease until cleanup release", async () => {
    const capacity = new RunCapacity({ default: 1 });
    const held = {};
    const parked = {};
    capacity.schedule(held, "p/a", work());
    const final = startup(new AbortController(), {
      onResume: () => {
        throw new Error("resume failed");
      },
    });
    const gate = capacity.reconcile(parked, "p/a", final);
    const rejection = expect(gate).rejects.toThrow("resume failed");
    capacity.release(held);
    capacity.drain();
    await rejection;
    expect(capacity.tryAccept("p/a", () => ({}))).toBeUndefined();
    const next = work();
    capacity.schedule({}, "p/a", next);
    capacity.release(parked);
    expect(next.start).not.toHaveBeenCalled();
    capacity.drain();
    expect(next.start).toHaveBeenCalledTimes(1);
  });
});
