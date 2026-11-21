import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.js";
import { mockModules, mockAgentSession, mockRunResult } from "./manager-mocks.js";
import { AgentManager, type ConcurrencyConfig } from "../../src/agents/agent-manager.js";
import { createTestOwner } from "../owner-fixtures.js";

const owner = await createTestOwner();
let manager: AgentManager;
beforeEach(() => {
  mockModules.resetUuidCounter();
  mockModules.mockRunAgent.mockReset();
  mockModules.mockContinueAgentSession.mockReset();
});
afterEach(() => {
  void manager?.dispose();
});
const spawn = (prompt: string, modelKey = "test/model") =>
  manager.spawn(fakePi(), fakeCtx(), "general-purpose", prompt, { description: prompt, modelKey });
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("Subagent run ownership", () => {
  it("opens the parent wait on Stop while ignored cancellation retains capacity until actual settlement", async () => {
    const complete = vi.fn();
    manager = new AgentManager(owner, complete, { default: 1 });
    const first = makeResolvablePromise();
    const second = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = spawn("first");
    const b = spawn("second");
    const record = manager.getRecord(a)!;
    const run = manager.getRuns(a)[0];
    let completed = false;
    void run.completion.then(() => {
      completed = true;
    });
    let returned = false;
    void record.execution.promise!.then(() => {
      returned = true;
    });
    expect(manager.abort(a, "user")).toBe(true);
    await flush();
    expect(returned).toBe(true);
    expect.soft(await record.execution.promise).toMatchObject({
      status: "stopping",
      stats: { turnCount: 0, runTurnCount: 0 },
    });
    expect(completed).toBe(false);
    expect(record.lifecycle.status).toBe("running");
    expect(record.lifecycle.phase).toBe("stopping");
    expect(manager.getRuns(a)[0].outcome).toBeUndefined();
    expect(record.lifecycle.completedAt).toBeUndefined();
    expect(manager.getTotalAgentCount()).toBe(0);
    expect(manager.clear(a)).toBe(false);
    expect(await manager.submitMessage(a, "continue")).toMatchObject({ accepted: false, reason: "stopping" });
    expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();
    expect(manager.getRuns(a)).toHaveLength(1);
    expect(manager.getRecord(b)!.lifecycle.status).toBe("queued");
    expect(complete).not.toHaveBeenCalled();
    first.resolve(mockRunResult({ responseText: "partial" }));
    await run.completion;
    expect(completed).toBe(true);
    expect(record.lifecycle.status).toBe("stopped");
    expect(record.lifecycle.completedAt).toBeDefined();
    expect(manager.getTotalAgentCount()).toBe(1);
    expect(manager.getRuns(a)[0]).toMatchObject({
      phase: "settled",
      outcome: { status: "stopped", result: "partial" },
    });
    expect.soft(manager.getRuns(a)[0].outcome?.stats).toMatchObject({ turnCount: 0, runTurnCount: 0 });
    expect(manager.getRecord(b)!.lifecycle.status).toBe("running");
    const c = spawn("third");
    expect(manager.getRecord(c)!.lifecycle.status).toBe("queued");
    expect(complete).toHaveBeenCalledTimes(1);
    second.resolve(mockRunResult());
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    await flush();
    expect(manager.getRecord(c)!.lifecycle.status).toBe("completed");
  });

  it("retains independent outcomes and ignores late callbacks from an earlier run", async () => {
    manager = new AgentManager(owner);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ responseText: "first answer" }));
    const text = vi.fn();
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
      description: "first",
      onTextDelta: text,
    });
    const old = mockModules.mockRunAgent.mock.calls[0][4];
    await manager.getRecord(id)!.execution.promise;
    const first = manager.getRuns(id)[0];
    const continuation = makeResolvablePromise();
    mockModules.mockContinueAgentSession.mockReturnValue(continuation.promise);
    const accepted = await manager.submitMessage(id, "next");
    expect(accepted).toMatchObject({ accepted: true, delivery: "continuation" });
    const current = manager.getRuns(id)[1];
    expect(current.id).not.toBe(first.id);
    expect(first.outcome).toMatchObject({ status: "completed", result: "first answer" });
    expect(Object.isFrozen(first.outcome)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(manager.getRuns(id))).toBe(true);
    old.onToolActivity({ type: "end", toolName: "late" });
    old.onAssistantUsage({ input: 10, output: 1, cacheWrite: 0, cost: 4 });
    old.onTurnEnd(99);
    old.onTextDelta("late", "late");
    old.onCompaction({ reason: "manual", tokensBefore: 1 });
    old.onSessionCreated(mockAgentSession());
    expect.soft(manager.getRecord(id)!.stats).toMatchObject({
      toolUses: 0,
      turnCount: 0,
      runTurnCount: 0,
      compactionCount: 0,
      lifetimeUsage: { cost: 0 },
    });
    expect(text).not.toHaveBeenCalled();
    mockModules.mockContinueAgentSession.mock.calls[0][2].onTurnEnd(1);
    continuation.resolve(mockRunResult({ responseText: "second answer" }));
    await flush();
    const outcomes = manager.getRuns(id).map((run) => run.outcome);
    expect(outcomes.map((outcome) => outcome?.result)).toEqual(["first answer", "second answer"]);
    expect.soft(outcomes.map((outcome) => [outcome?.stats.turnCount, outcome?.stats.runTurnCount])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(first.outcome).toMatchObject({ result: "first answer" });
    expect(manager.getRecord(id)!.result).toBe("second answer");
  });

  it.each<ConcurrencyConfig>([
    { default: 1 },
    { default: 9, providers: { test: 1 } },
    { default: 9, models: { "test/model": 1 } },
  ])("keeps active leases counted when concurrency routing changes: %j", async (config) => {
    manager = new AgentManager(owner, undefined, { default: 1, models: { "test/model": 1 } });
    const first = makeResolvablePromise();
    const second = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = spawn("first");
    manager.abort(a);
    const b = spawn("second");
    manager.setConcurrency(config);
    expect(manager.getRecord(b)!.lifecycle.status).toBe("queued");
    first.resolve(mockRunResult());
    await flush();
    expect(manager.getRecord(b)!.lifecycle.status).toBe("running");
    manager.setConcurrency(config);
    expect(manager.getRecord(spawn("third"))!.lifecycle.status).toBe("queued");
    second.resolve(mockRunResult());
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    await flush();
  });

  it("rejects continuation during completion publication and accepts it afterwards", async () => {
    const first = makeResolvablePromise();
    const second = makeResolvablePromise();
    const session = mockAgentSession();
    const submissions: ReturnType<AgentManager["submitMessage"]>[] = [];
    manager = new AgentManager(owner, (result) => {
      if (submissions.length === 0) submissions.push(manager.submitMessage(result.agentId, "too early"));
    });
    mockModules.mockRunAgent.mockReturnValue(first.promise);
    mockModules.mockContinueAgentSession.mockReturnValue(second.promise);
    const id = spawn("first");
    const run = manager.getRuns(id)[0];
    first.resolve(mockRunResult({ session }));
    await run.completion;

    expect(submissions).toHaveLength(1);
    expect(await submissions[0]).toMatchObject({ accepted: false, reason: "settling" });
    expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();
    expect(await manager.submitMessage(id, "after publication")).toMatchObject({
      accepted: true,
      delivery: "continuation",
    });
    second.resolve(mockRunResult({ session }));
    await manager.getRuns(id)[1].completion;
  });

  it("returns structured delivery_failed when the SDK rejects a steer asynchronously", async () => {
    manager = new AgentManager(owner);
    const run = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(run.promise);
    const id = spawn("task");
    const session = mockAgentSession();
    session.steer.mockRejectedValue(new Error("input hook refused"));
    mockModules.mockRunAgent.mock.calls[0][4].onSessionCreated(session);
    expect(await manager.submitMessage(id, "message")).toEqual({
      accepted: false,
      reason: "delivery_failed",
      message: "The session refused the message.",
    });
    expect(manager.getRuns(id)).toHaveLength(1);
    run.resolve(mockRunResult({ session }));
    await manager.getRuns(id)[0].completion;
  });

  it.each([false, true])("keeps run-owned steering cleanup in its originating run (stopped=%s)", async (stopped) => {
    manager = new AgentManager(owner, undefined, { default: 1 });
    const run = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(run.promise);
    const id = spawn("task");
    const session = mockAgentSession();
    let release!: () => void;
    session.steer.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    mockModules.mockRunAgent.mock.calls[0][4].onSessionCreated(session);
    const submitted = manager.submitMessage(id, "delayed");
    if (stopped) manager.abort(id, "user");
    const phase = stopped ? "stopping" : "settling";
    run.resolve(mockRunResult({ session }));
    await flush();
    expect(manager.getRuns(id)[0].phase).toBe(phase);
    expect(manager.getRecord(id)!.lifecycle.status).toBe("running");
    expect(manager.getRecord(id)!.lifecycle.phase).toBe(phase);
    expect(manager.getRecord(id)!.lifecycle.completedAt).toBeUndefined();
    expect(manager.getRuns(id)[0].outcome).toBeUndefined();
    expect(manager.clear(id)).toBe(false);
    expect(await manager.submitMessage(id, "next")).toMatchObject({ accepted: false, reason: phase });
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    const replacement = spawn("replacement");
    expect(manager.getRecord(replacement)!.lifecycle.status).toBe("queued");
    expect(session.clearQueue).not.toHaveBeenCalled();
    release();
    expect(await submitted).toMatchObject({ accepted: false, reason: phase });
    await manager.getRuns(id)[0].completion;
    expect(manager.getRecord(id)!.lifecycle.status).toBe(stopped ? "stopped" : "completed");
    expect(manager.getRecord(id)!.lifecycle.completedAt).toBeDefined();
    expect(session.clearQueue).toHaveBeenCalledTimes(1);
    await flush();
    expect(manager.getRecord(replacement)!.lifecycle.status).toBe("completed");
  });

  it.each(["cleared", "failed"] as const)(
    "settles a rejected prompt when its bound queue cleanup %s",
    async (cleanup) => {
      const completed = vi.fn();
      manager = new AgentManager(owner, completed, { default: 1 });
      const prompt = makeResolvablePromise();
      const replacementPrompt = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(
          prompt.promise.then(() => {
            throw new Error("prompt failed");
          }),
        )
        .mockReturnValueOnce(replacementPrompt.promise);
      const id = spawn("task");
      const session = mockAgentSession();
      const record = manager.getRecord(id)!;
      mockModules.mockRunAgent.mock.calls[0][4].onSessionCreated(session);
      const run = manager.getRuns(id)[0];
      const replacement = spawn("replacement");
      const replacementRun = manager.getRuns(replacement)[0];
      expect(replacementRun.phase).toBe("queued");
      const phaseAtCleanup = vi.fn(() => manager.getRuns(replacement)[0].phase);
      session.clearQueue.mockImplementation(() => {
        phaseAtCleanup();
        if (cleanup === "failed") throw new Error("queue cannot be cleared");
        return { steering: ["old steer"], followUp: ["old follow-up"] };
      });
      mockModules.mockContinueAgentSession.mockResolvedValue(mockRunResult({ session }));
      try {
        prompt.resolve(undefined);
        await run.completion;
        expect(await record.execution.promise).toBe(manager.getRuns(id)[0].outcome);
        expect(session.clearQueue).toHaveBeenCalledTimes(1);
        expect(phaseAtCleanup).toHaveReturnedWith("queued");
        expect(completed).toHaveBeenCalledExactlyOnceWith(manager.getRuns(id)[0].outcome, undefined);
        expect(record.execution.session).toBe(session);
        expect(manager.getRuns(id)[0].outcome).toMatchObject({
          status: "error",
          error: expect.stringContaining("prompt failed"),
        });
        expect.soft(manager.getRuns(id)[0].outcome?.stats).toMatchObject({ turnCount: 0, runTurnCount: 0 });
        expect(manager.getRuns(replacement)[0].phase).toBe("running");
        replacementPrompt.resolve(mockRunResult());
        await replacementRun.completion;
        if (cleanup === "failed") {
          const rejected = await manager.submitMessage(id, "next");
          expect(rejected).toMatchObject({
            accepted: false,
            reason: "unavailable",
            message: expect.stringContaining("queue could not be cleared"),
          });
          expect(manager.getRuns(id)[0].outcome?.error).toContain("queue could not be cleared");
          expect(manager.getRuns(id)).toHaveLength(1);
          expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();
        } else {
          expect(await manager.submitMessage(id, "next")).toMatchObject({ accepted: true, delivery: "continuation" });
          await manager.getRuns(id)[1].completion;
          expect(mockModules.mockContinueAgentSession).toHaveBeenCalledTimes(1);
        }
      } finally {
        replacementPrompt.resolve(mockRunResult());
        await manager.dispose();
      }
    },
  );

  it("finalizes a failed start's output and releases its lease exactly once", async () => {
    manager = new AgentManager(owner, undefined, { default: 1 });
    mockModules.mockRunAgent.mockImplementationOnce(() => {
      throw new Error("start failed");
    });
    expect(() => spawn("failed")).toThrow("start failed");
    const output = mockModules.mockAgentOutputLog.mock.results.at(-1)!;
    expect(output.type).toBe("return");
    expect(output.value.finalize).toHaveBeenCalledTimes(1);
    const run = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(run.promise);
    const next = spawn("next");
    expect(manager.getRecord(next)!.lifecycle.status).toBe("running");
    const queued = spawn("queued");
    expect(manager.getRecord(queued)!.lifecycle.status).toBe("queued");
    manager.abort(queued);
    run.resolve(mockRunResult());
    await manager.getRuns(next)[0].completion;
    expect(output.value.finalize).toHaveBeenCalledTimes(1);
  });

  it("reports structured admission without creating rejected runs", async () => {
    manager = new AgentManager(owner, undefined, { default: 1 });
    const first = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(first.promise);
    expect(await manager.submitMessage("missing", "next")).toMatchObject({ accepted: false, reason: "not_found" });
    const id = spawn("task");
    expect(await manager.submitMessage(id, "  ")).toMatchObject({ accepted: false, reason: "empty_message" });
    expect(await manager.submitMessage(id, "early")).toMatchObject({ accepted: true, delivery: "pending_steer" });
    const session = mockAgentSession();
    mockModules.mockRunAgent.mock.calls[0][4].onSessionCreated(session);
    expect(await manager.submitMessage(id, "live")).toMatchObject({ accepted: true, delivery: "steer" });
    first.resolve(mockRunResult({ session }));
    await flush();
    const occupied = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(occupied.promise);
    const occupying = spawn("occupy");
    const queued = spawn("queued");
    expect(await manager.submitMessage(queued, "wait")).toMatchObject({ accepted: false, reason: "queued" });
    expect(manager.getRuns(queued)).toHaveLength(1);
    const queuedRecord = manager.getRecord(queued)!;
    const abortProjection = vi.fn(() => ({ ...queuedRecord.lifecycle }));
    queuedRecord.execution.abortController!.signal.addEventListener("abort", abortProjection);
    manager.abort(queued);
    expect(abortProjection).toHaveReturnedWith(
      expect.objectContaining({ status: "queued", phase: "stopping", completedAt: undefined }),
    );
    expect(queuedRecord.lifecycle).toMatchObject({ status: "stopped", phase: "settled", started: false });
    expect(manager.getRecord(queued)!.lifecycle.completedAt).toBeDefined();
    await manager.getRuns(queued)[0].completion;
    expect(manager.getRuns(queued)[0]).toMatchObject({ phase: "settled", outcome: { status: "stopped" } });
    expect(await manager.submitMessage(queued, "wait")).toMatchObject({ accepted: false, reason: "unavailable" });
    expect(await manager.submitMessage(id, "next")).toMatchObject({ accepted: false, reason: "capacity" });
    expect(manager.getRuns(id)).toHaveLength(1);
    occupied.resolve(mockRunResult());
    await manager.getRuns(occupying)[0].completion;
  });
});
