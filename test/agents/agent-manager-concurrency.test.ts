/**
 * agent-manager-concurrency.test.ts — Concurrency limiting for AgentManager.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vite-plus/test";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.js";
import { mockModules, mockRunResult, type OnAgentComplete } from "./manager-mocks.js";
import { AgentManager } from "../../src/agents/agent-manager.js";
import type { ConcurrencyConfig } from "../../src/agents/agent-manager.js";
import type { runAgent, RunResult } from "../../src/agents/agent-runner.js";
import { asAgentSession } from "../pi-boundaries.js";

function pendingCapacityRun() {
  let resolve!: (value: RunResult) => void;
  const promise = new Promise<RunResult>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: () => {
      const result = mockRunResult();
      resolve({ ...result, session: asAgentSession(result.session) });
    },
  };
}

function trackCapacityRuns(events: string[], pending: ReturnType<typeof pendingCapacityRun>) {
  const execute = vi.fn<typeof runAgent>((_owner, _ctx, _type, prompt) => {
    events.push(`run:${prompt}`);
    return pending.promise;
  });
  mockModules.mockRunAgent.mockImplementation(execute);
}

describe("AgentManager", () => {
  let manager: AgentManager;
  let onComplete: Mock<OnAgentComplete>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    mockModules.mockAgentOutputLog.mockClear();
    mockModules.mockGetAgentConfig.mockClear();
    onComplete = vi.fn<OnAgentComplete>();
  });

  afterEach(() => {
    void manager?.dispose().catch(() => {});
  });

  describe("queued callback reentry", () => {
    it("keeps synchronous nested configuration/drain ordering and starts each waiter once", async () => {
      const events: string[] = [];
      const pending = pendingCapacityRun();
      trackCapacityRuns(events, pending);
      manager = new AgentManager(owner, onComplete, { default: 1 }, (record) => {
        const name = record.display.description;
        if (name === "a") {
          events.push("a-before");
          manager.setConcurrency({ default: 3 });
          events.push("a-after");
        } else events.push(`start:${name}`);
      });
      const spawn = (description: string) =>
        manager.spawn(fakePi(), fakeCtx(), "general-purpose", description, {
          description,
          modelKey: "test/model",
        });
      const ids = [spawn("held"), spawn("a"), spawn("b")];
      manager.setConcurrency({ default: 2 });
      expect(events).toEqual(["start:held", "run:held", "a-before", "start:b", "run:b", "a-after", "run:a"]);
      manager.setConcurrency({ default: 3 });
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);
      pending.resolve();
      await Promise.all(ids.map((id) => manager.getRuns(id)[0].completion));
    });

    it("removes cancelled waiting work during nested drain without releasing a stopping active run", async () => {
      const events: string[] = [];
      const pending = pendingCapacityRun();
      trackCapacityRuns(events, pending);
      let cancelled = "";
      manager = new AgentManager(
        owner,
        (result) => events.push(`complete:${result.description}`),
        { default: 1 },
        (record) => {
          const name = record.display.description;
          if (name === "a") {
            events.push("a-before");
            expect(manager.abort(cancelled)).toBe(true);
            expect(manager.abort(record.id)).toBe(true);
            manager.setConcurrency({ default: 2 });
            events.push("a-after");
          } else events.push(`start:${name}`);
        },
      );
      const spawn = (description: string) =>
        manager.spawn(fakePi(), fakeCtx(), "general-purpose", description, {
          description,
          modelKey: "test/model",
        });
      const held = spawn("held");
      const a = spawn("a");
      cancelled = spawn("cancelled");
      const c = spawn("c");
      manager.setConcurrency({ default: 2 });
      expect(events).toEqual(["start:held", "run:held", "a-before", "complete:cancelled", "a-after", "run:a"]);
      expect(manager.getRuns(a)[0].phase).toBe("stopping");
      expect(manager.getRuns(c)[0].phase).toBe("queued");
      manager.setConcurrency({ default: 3 });
      expect(events).toEqual([
        "start:held",
        "run:held",
        "a-before",
        "complete:cancelled",
        "a-after",
        "run:a",
        "start:c",
        "run:c",
      ]);
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);
      expect(manager.getRuns(cancelled)[0].outcome).toMatchObject({ status: "stopped", started: false });
      pending.resolve();
      await Promise.all([held, a, c].map((id) => manager.getRuns(id)[0].completion));
    });

    it("waits for the queued start that synchronously disposes the manager and cancels later waiters", async () => {
      const events: string[] = [];
      const held = makeResolvablePromise();
      const queued = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(held.promise).mockReturnValueOnce(queued.promise);
      let shutdown!: Promise<void>;
      manager = new AgentManager(owner, onComplete, { default: 1 }, (record) => {
        if (record.display.description !== "a") return;
        events.push("start:a");
        vi.spyOn(record.execution.outputLog!, "finalize").mockImplementation(() => {
          events.push("finalize:a");
        });
        shutdown = manager.dispose().then(() => {
          events.push("disposed");
        });
        manager.setConcurrency({ default: 9 });
      });
      const spawn = (description: string) =>
        manager.spawn(fakePi(), fakeCtx(), "general-purpose", description, {
          description,
          modelKey: "test/model",
        });
      const heldRun = manager.getRuns(spawn("held"))[0];
      const queuedRun = manager.getRuns(spawn("a"))[0];
      const cancelledRun = manager.getRuns(spawn("b"))[0];
      const completed = queuedRun.completion.then(() => {
        events.push("completed:a");
      });
      manager.setConcurrency({ default: 2 });
      expect(events).toEqual(["start:a"]);
      expect(mockModules.mockRunAgent.mock.calls.map((call) => call[3])).toEqual(["held", "a"]);
      expect(manager.listAgents()).toEqual([]);
      held.resolve(mockRunResult());
      await Promise.all([heldRun.completion, cancelledRun.completion]);
      // Let the first settlement and all of its teardown reactions finish.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toEqual(["start:a"]);

      const lateResult = mockRunResult();
      lateResult.session.dispose.mockImplementation(() => {
        events.push("teardown:a");
      });
      queued.resolve(lateResult);
      await Promise.all([completed, shutdown]);
      expect(events).toEqual(["start:a", "finalize:a", "completed:a", "teardown:a", "disposed"]);
    });

    it("does not reserve capacity before an already-aborted initial request notifies", async () => {
      const signal = new AbortController();
      signal.abort();
      const events: string[] = [];
      let replacement: string | undefined;
      manager = new AgentManager(
        owner,
        (result) => {
          events.push(`complete:${result.description}`);
          replacement = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "replacement", {
            description: "replacement",
            modelKey: "test/model",
          });
        },
        { default: 1 },
        (record) => events.push(`start:${record.display.description}`),
      );
      const pending = pendingCapacityRun();
      mockModules.mockRunAgent.mockReturnValue(pending.promise);
      const stopped = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "aborted", {
        description: "aborted",
        modelKey: "test/model",
        signal: signal.signal,
      });
      expect(events).toEqual(["complete:aborted", "start:replacement"]);
      expect(manager.getRuns(stopped)[0].outcome).toMatchObject({ status: "stopped", started: false });
      expect(manager.getRuns(replacement!)[0].phase).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);
      manager.setOnComplete(() => {});
      pending.resolve();
      await manager.getRuns(replacement!)[0].completion;
    });

    it("releases a reentrant shutdown wait when start throws synchronously", async () => {
      let shutdown!: Promise<void>;
      const error = new Error("start failed after disposal");
      manager = new AgentManager(owner, onComplete, { default: 1 }, () => {
        shutdown = manager.dispose();
        throw error;
      });
      expect(() => manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task" })).toThrow(
        error,
      );
      await shutdown;
      expect(mockModules.mockRunAgent).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("keeps immediate and queued start callback failures in their original owner channels", async () => {
      const error = new Error("queued callback failed");
      manager = new AgentManager(owner, onComplete, { default: 1 }, (record) => {
        if (record.display.description === "failing") throw error;
      });
      const spawn = (description: string) =>
        manager.spawn(fakePi(), fakeCtx(), "general-purpose", description, {
          description,
          modelKey: "test/model",
        });
      expect(() => spawn("failing")).toThrow(error);
      expect(manager.listAgents()).toEqual([]);
      expect(onComplete).not.toHaveBeenCalled();
      const held = pendingCapacityRun();
      mockModules.mockRunAgent.mockReturnValueOnce(held.promise).mockResolvedValue(mockRunResult());
      const active = spawn("active");
      const failing = spawn("failing");
      const next = spawn("next");
      held.resolve();
      await manager.getRuns(active)[0].completion;
      await manager.getRuns(next)[0].completion;
      expect(manager.getRuns(failing)[0].outcome).toMatchObject({ status: "error", error: error.message });
      expect(onComplete.mock.calls.map(([result]) => result.description)).toEqual(["active", "failing", "next"]);
      expect(manager.getTotalAgentCount()).toBe(2);
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
      await manager.dispose();
    });
  });

  describe("concurrency", () => {
    it("starts all agents when under per-model limit", () => {
      const config: ConcurrencyConfig = { default: 4, models: {} };
      manager = new AgentManager(owner, onComplete, config);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);
    });

    it("queues agents when per-model limit is reached", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b_small": 1 } };
      manager = new AgentManager(owner, onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred.resolve(mockRunResult());
    });

    it("starts queued agent when running agent completes", async () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b_small": 1 } };
      manager = new AgentManager(owner, onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred2.resolve(mockRunResult());
    });

    it.each([
      {
        name: "frontmatter limits",
        config: { maxTurns: 3, maxTokens: 400 },
        expected: { maxTurns: 3, maxTokens: 400 },
      },
      { name: "omitted limits", config: {}, expected: { maxTurns: 0, maxTokens: 0 } },
      {
        name: "explicit limits",
        config: { maxTurns: 3, maxTokens: 400 },
        explicit: { maxTurns: 0, maxTokens: 700, graceTurns: 0 },
        expected: { maxTurns: 0, maxTokens: 700, graceTurns: 0 },
      },
    ])("freezes $name when a direct spawn is queued", async ({ config, explicit, expected }) => {
      manager = new AgentManager(owner, onComplete, { default: 1 });
      const getAgentConfig = vi.mocked(owner.registry.getAgentConfig);
      const initialConfig = { name: "general-purpose", description: "Test agent", systemPrompt: "", ...config };
      getAgentConfig.mockReturnValue(initialConfig);
      const first = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(first.promise).mockResolvedValue(mockRunResult());
      const ctx = fakeCtx();
      const pi = fakePi();
      const options = { description: "same model", modelKey: "test/model" };

      try {
        const active = manager.spawn(pi, ctx, initialConfig.name, "active", options);
        const queued = manager.spawn(pi, ctx, initialConfig.name, "queued", { ...options, ...explicit });
        expect(manager.getRecord(queued)?.lifecycle.status).toBe("queued");
        expect(manager.getRecord(queued)?.stats.maxTurns).toBe(expected.maxTurns || undefined);
        expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

        getAgentConfig.mockReturnValue({ ...initialConfig, maxTurns: 9, maxTokens: 900 });
        first.resolve(mockRunResult());
        await manager.getRuns(active)[0].completion;
        await manager.getRuns(queued)[0].completion;
        expect(mockModules.mockRunAgent.mock.lastCall?.[4]).toMatchObject(expected);
      } finally {
        first.resolve(mockRunResult());
        getAgentConfig.mockReset();
      }
    });

    it("queues agents per-model independently", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        models: { "llamacpp/27b": 1, "llamacpp/4b": 4 },
      };
      manager = new AgentManager(owner, onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      const deferred3 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise)
        .mockReturnValueOnce(deferred3.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred1.resolve(mockRunResult());
      deferred2.resolve(mockRunResult());
      deferred3.resolve(mockRunResult());
    });

    it("applies default limit for unknown models", () => {
      const config: ConcurrencyConfig = { default: 2, models: {} };
      manager = new AgentManager(owner, onComplete, config);

      const deferred1 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred1.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "claude/sonnet",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred1.resolve(mockRunResult());
    });

    it("applies per-provider limit to all models from that provider", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: {},
      };
      manager = new AgentManager(owner, onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      const deferred3 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise)
        .mockReturnValueOnce(deferred3.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/3b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "claude/sonnet",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);

      deferred1.resolve(mockRunResult());
      deferred2.resolve(mockRunResult());
      deferred3.resolve(mockRunResult());
    });

    it("per-model limit overrides per-provider limit", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: { "llamacpp/4b": 1 },
      };
      manager = new AgentManager(owner, onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred.resolve(mockRunResult());
    });

    it("applies new limit when setConcurrency is called", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(owner, onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      manager.setConcurrency({ default: 1, models: { "llamacpp/4b": 2 } });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred.resolve(mockRunResult());
    });

    it("re-applying an unchanged config keeps running slots and the queue", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(owner, onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      manager.setConcurrency({ default: 1, models: { "llamacpp/4b": 1 } });
      manager.setConcurrency({ default: 1, models: { "llamacpp/4b": 1 } });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred.resolve(mockRunResult());
    });

    it("removes per-model slot when model entry is removed from config", () => {
      const config: ConcurrencyConfig = { default: 4, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(owner, onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

      manager.setConcurrency({ default: 4, models: {} });

      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(4);

      deferred.resolve(mockRunResult());
    });

    it("removes per-provider slot when provider entry is removed from config", () => {
      const config: ConcurrencyConfig = { default: 4, providers: { llamacpp: 1 }, models: {} };
      manager = new AgentManager(owner, onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

      manager.setConcurrency({ default: 4, providers: {}, models: {} });

      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "llamacpp/3b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(4);

      deferred.resolve(mockRunResult());
    });

    it("reset to defaults clears per-model and per-provider slots", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: { "llamacpp/4b": 1, "claude/sonnet": 2 },
      };
      manager = new AgentManager(owner, onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");

      manager.setConcurrency({ default: 4 });

      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id5 = manager.spawn(pi, ctx, "general-purpose", "task 5", {
        description: "task 5",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id5)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(5);

      deferred.resolve(mockRunResult());
    });

    it("running agent under removed slot still settles without error", async () => {
      const config: ConcurrencyConfig = { default: 4, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(owner, onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

      manager.setConcurrency({ default: 4, models: {} });

      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");

      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("completed");
      expect(onComplete).toHaveBeenCalledTimes(1);

      deferred2.resolve(mockRunResult());
    });
    it("queues foreground agent when limit is reached", async () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(owner, onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "bg task", {
        description: "bg task",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "fg task", {
        description: "fg task",
        modelKey: "llamacpp/4b",
        isBackground: false,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
      deferred2.resolve(mockRunResult());
    });
  });
});

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
