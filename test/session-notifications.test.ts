import { parent, emit, spawn, services, finishedRun } from "./instance-fixtures.js";
import { scanAgentFilesInDir } from "../src/agents/agent-discovery.js";
import { describe, expect, it, vi } from "vite-plus/test";
import { fakeCtx, createMockExtensionAPI } from "./fixtures.js";
import factory from "../src/index.js";
import { withChildExtensionLoad } from "../src/child-load-context.js";
import { asExtensionAPI } from "./pi-boundaries.js";
import type { AgentManager } from "../src/agents/agent-manager.js";
import type { RunCallbacks } from "../src/types.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { continueAgentSession, runAgent } from "../src/agents/agent-runner.js";

function expectResult(api: ReturnType<typeof parent>["api"], deliverAs: "followUp" | "steer") {
  expect(api.api.sendMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ customType: "subagent-result", content: expect.stringContaining("A finished work") }),
    { deliverAs, triggerTurn: true },
  );
}

function parentHistory(sessionId = "parent-session") {
  const ctx = fakeCtx({ hasUI: false });
  const entries: SessionEntry[] = [];
  const getEntries = vi.fn(() => [...entries]);
  const getBranch = vi.fn((): SessionEntry[] => []);
  const sessionManager = { ...ctx.sessionManager, getSessionId: () => sessionId, getEntries, getBranch };
  return {
    ctx: { ...ctx, sessionManager },
    entries,
    getEntries,
    getBranch,
    append(details: unknown, customType = "subagent-result") {
      entries.push({
        type: "custom_message",
        id: `entry-${entries.length}`,
        parentId: null,
        timestamp: "2025-01-01T00:00:00.000Z",
        content: "result",
        display: true,
        customType,
        details,
      });
    },
  };
}

async function startWithHistory(history = parentHistory()) {
  const a = parent();
  await emit(a, "session_start", history.ctx);
  const { agentId } = await spawn(a, history.ctx);
  const { coordinator, manager } = services(a);
  const runId = manager.getRuns(agentId)[0].id;
  return { ...history, a, agentId, runId, coordinator, manager };
}

describe("session-bound completion notifications", () => {
  it.each([false, true])(
    "records an already-aborted spawn before manager.spawn returns (background=%s)",
    async (background) => {
      const a = parent();
      const { ctx } = parentHistory();
      await emit(a, "session_start", ctx);
      const { coordinator, manager } = services(a);
      const spawnAgent = manager.spawn.bind(manager);
      const getRuns = vi.spyOn(manager, "getRuns");
      const atReturn = vi.fn();
      vi.spyOn(manager, "spawn").mockImplementation((...args: Parameters<AgentManager["spawn"]>) => {
        const id = spawnAgent(...args);
        atReturn(coordinator.getCompletionNotification(manager.getCurrentRunId(id)!).status);
        return id;
      });

      const { agentId } = await coordinator.spawn(asExtensionAPI(a.api.api), ctx, {
        type: "general-purpose",
        prompt: "already aborted",
        description: "already aborted",
        graceTurns: 6,
        runInBackground: background,
        signal: AbortSignal.abort(),
      });
      expect(atReturn).toHaveBeenCalledExactlyOnceWith(background ? "pending" : "not-required");
      expect(getRuns).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      const messages = a.api.api.sendMessage.mock.calls;
      expect(messages).toHaveLength(background ? 1 : 0);
      if (background) {
        expect(messages[0][0].content).toContain(` ${agentId.slice(0, 8)} stopped]`);
        expect(messages[0][0].content).toContain("before the agent started");
      }
    },
  );

  it("isolates concurrent multi-child runs, notifications and teardown across parent sessions", async () => {
    vi.setSystemTime(1_000);
    const a = parent();
    const b = parent();
    const historyA = parentHistory("web-parent-A");
    const historyB = parentHistory("web-parent-B");
    const ctxA = historyA.ctx;
    const ctxB = { ...historyB.ctx, isIdle: () => false };
    await Promise.all([emit(a, "session_start", ctxA), emit(b, "session_start", ctxB)]);
    const servicesA = services(a);
    const servicesB = services(b);

    const finish = new Map<string, (tokens: number) => void>();
    const controlledRun = (name: string, options?: Pick<RunCallbacks, "onAssistantUsage"> & { signal?: AbortSignal }) =>
      new Promise<ReturnType<typeof finishedRun>>((resolve) => {
        const sessionResult = finishedRun();
        const abort = () => resolve({ ...sessionResult, responseText: `${name} stopped`, aborted: true });
        options?.signal?.addEventListener("abort", abort, { once: true });
        finish.set(name, (tokens) => {
          options?.signal?.removeEventListener("abort", abort);
          options?.onAssistantUsage?.({ input: tokens, output: tokens * 2, cacheWrite: 1, cacheRead: 8, cost: tokens });
          resolve({ ...sessionResult, responseText: `${name} output` });
        });
      });
    vi.mocked(runAgent).mockImplementation((_owner, _ctx, _type, prompt, options) => controlledRun(prompt, options));
    vi.mocked(continueAgentSession).mockImplementation((_session, message, options) => controlledRun(message, options));
    const dispatch = (p: typeof a, ctx: typeof ctxA, name: string) =>
      services(p).coordinator.spawn(asExtensionAPI(p.api.api), ctx, {
        type: "general-purpose",
        prompt: name,
        description: name,
        modelKey: "test/local",
        graceTurns: 6,
        runInBackground: true,
      });
    const [a1, b1, a2, b2] = await Promise.all([
      dispatch(a, ctxA, "A1"),
      dispatch(b, ctxB, "B1"),
      dispatch(a, ctxA, "A2"),
      dispatch(b, ctxB, "B2"),
    ]);
    expect(vi.mocked(runAgent).mock.calls.map(([owner, ctx, , name]) => [owner === a.owner, ctx, name])).toEqual([
      [true, ctxA, "A1"],
      [false, ctxB, "B1"],
      [true, ctxA, "A2"],
      [false, ctxB, "B2"],
    ]);
    const aFirst = servicesA.manager.getRuns(a1.agentId)[0];
    const bFirst = servicesB.manager.getRuns(b1.agentId)[0];
    const aOther = servicesA.manager.getRuns(a2.agentId)[0];
    const bOther = servicesB.manager.getRuns(b2.agentId)[0];
    const firstRuns = [aFirst, aOther, bFirst, bOther];
    expect(firstRuns.map((run) => run.phase)).toEqual(["running", "running", "running", "running"]);
    expect(new Set(firstRuns.map((run) => run.id)).size).toBe(4);
    expect(servicesA.manager.getRuns(b1.agentId)).toEqual([]);
    expect(servicesB.manager.getRuns(a1.agentId)).toEqual([]);

    await vi.advanceTimersByTimeAsync(30);
    finish.get("B1")!(10);
    finish.get("A1")!(2);
    await Promise.all([aFirst.completion, bFirst.completion]);
    const firstAResult = servicesA.manager.getRuns(a1.agentId)[0].outcome!;
    const firstBResult = servicesB.manager.getRuns(b1.agentId)[0].outcome!;
    expect(firstAResult).toMatchObject({ runId: aFirst.id, agentId: a1.agentId, sequence: 1, elapsedMs: 30 });
    expect(firstBResult).toMatchObject({ runId: bFirst.id, agentId: b1.agentId, sequence: 1, elapsedMs: 30 });
    expect(Object.isFrozen(firstAResult)).toBe(true);
    expect(Object.isFrozen(firstAResult.stats)).toBe(true);
    expect(Object.isFrozen(firstAResult.stats.lifetimeUsage)).toBe(true);

    await vi.advanceTimersByTimeAsync(10);
    expect(await servicesA.manager.submitMessage(a1.agentId, "A1 next")).toMatchObject({ delivery: "continuation" });
    expect(await servicesB.manager.submitMessage(b1.agentId, "B1 next")).toMatchObject({ delivery: "continuation" });
    const aNext = servicesA.manager.getRuns(a1.agentId)[1];
    const bNext = servicesB.manager.getRuns(b1.agentId)[1];
    await vi.advanceTimersByTimeAsync(40);
    finish.get("A1 next")!(3);
    await aNext.completion;
    expect(servicesA.manager.getRuns(a1.agentId)[0].outcome).toBe(firstAResult);
    expect(firstAResult.stats.lifetimeUsage).toEqual({ input: 2, output: 4, cacheWrite: 1, cost: 2 });
    expect(servicesA.manager.getRuns(a1.agentId)[1].outcome).toMatchObject({
      result: "A1 next output",
      elapsedMs: 40,
      stats: { lifetimeUsage: { input: 5, output: 10, cacheWrite: 2, cost: 5 } },
    });

    await vi.advanceTimersByTimeAsync(150);
    const messages = (p: typeof a) => p.api.api.sendMessage.mock.calls.map(([message]) => message);
    const summary = (p: typeof a) =>
      messages(p).map(({ content, details }) => [
        details.parentSessionId,
        details.runId,
        content.split("\n\n")[1],
        details.durationMs,
        details.input,
        details.output,
        details.cost,
      ]);
    expect(summary(a)).toEqual([
      ["web-parent-A", aFirst.id, "A1 output", 30, 2, 4, 2],
      ["web-parent-A", aNext.id, "A1 next output", 40, 5, 10, 5],
    ]);
    expect(summary(b)).toEqual([["web-parent-B", bFirst.id, "B1 output", 30, 10, 20, 10]]);
    expect(a.api.api.sendMessage.mock.calls.map(([, options]) => options)).toEqual([
      { deliverAs: "followUp", triggerTurn: true },
      { deliverAs: "followUp", triggerTurn: true },
    ]);
    const bOriginal = messages(b)[0];
    historyA.append(bOriginal.details);
    await emit(b, "agent_settled", ctxA);
    expect(servicesB.coordinator.getCompletionNotification(bFirst.id).status).toBe("submitted");
    expect(servicesA.manager.clear(a1.agentId)).toBe(true);
    expect(servicesA.coordinator.getCompletionNotification(aFirst.id).status).toBe("unavailable");
    expect(servicesA.coordinator.getCompletionNotification(aNext.id).status).toBe("unavailable");

    await emit(a, "session_start", ctxA); // Same parent session, new extension generation.
    await aOther.completion;
    expect(a2.record.lifecycle.status).toBe("stopped");
    expect(services(a).manager).not.toBe(servicesA.manager);
    expect(servicesB.manager.getRuns(b1.agentId)[1].phase).toBe("running");
    expect(servicesB.manager.getRuns(b2.agentId)[0].phase).toBe("running");
    expect(servicesB.coordinator.getCompletionNotification(bFirst.id).canRetry).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    finish.get("B2")!(8);
    finish.get("B1 next")!(4);
    await Promise.all([bOther.completion, bNext.completion]);
    await vi.advanceTimersByTimeAsync(200);
    expect(summary(b)).toEqual([
      ["web-parent-B", bFirst.id, "B1 output", 30, 10, 20, 10],
      ["web-parent-B", bOther.id, "B2 output", 240, 8, 16, 8],
      ["web-parent-B", bNext.id, "B1 next output", 200, 14, 28, 14],
    ]);
    expect(b.api.api.sendMessage.mock.calls.map(([, options]) => options)).toEqual(
      Array.from({ length: 3 }, () => ({ deliverAs: "steer", triggerTurn: true })),
    );
    expect(servicesB.manager.getRuns(b1.agentId)[0].outcome).toBe(firstBResult);
    expect(servicesB.coordinator.retryCompletionNotification(bFirst.id, bOriginal.details.notificationId, ctxB)).toBe(
      "submitted",
    );
    expect(messages(b)[3]).toBe(bOriginal);
    historyB.append(bOriginal.details);
    await emit(b, "agent_settled", ctxB);
    expect(servicesB.coordinator.getCompletionNotification(bFirst.id).status).toBe("observed");
    expect(servicesB.coordinator.getCompletionNotification(bNext.id).status).toBe("submitted");
    expect(messages(a)).toHaveLength(2);
    expect(messages(b)).toHaveLength(4);
  });

  it("keeps void submission unconfirmed across time and lifecycle, without scanning before submission", async () => {
    const { a, coordinator, runId, ctx, getEntries } = await startWithHistory();
    expect(coordinator.getCompletionNotification(runId)).toMatchObject({ status: "pending", canRetry: false });
    await emit(a, "turn_start", ctx);
    expect(getEntries).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(coordinator.getCompletionNotification(runId)).toMatchObject({ status: "submitted", canRetry: true });
    await emit(a, "agent_settled", ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(coordinator.getCompletionNotification(runId).status).toBe("submitted");
    expect(a.api.api.sendMessage).toHaveBeenCalledOnce();
  });

  it("observes positive history during synchronous send reentry and keeps receipt after a branch change", async () => {
    const { a, coordinator, runId, ctx, append, getEntries, getBranch } = await startWithHistory();
    a.api.api.sendMessage.mockImplementation((message) => {
      expect(coordinator.getCompletionNotification(runId).status).toBe("submitted");
      append(message.details);
      coordinator.observeCompletionNotifications(ctx);
      expect(coordinator.getCompletionNotification(runId).status).toBe("observed");
    });
    await vi.advanceTimersByTimeAsync(200);
    const { notificationId } = coordinator.getCompletionNotification(runId);
    expect(coordinator.getCompletionNotification(runId)).toMatchObject({ status: "observed", canRetry: false });
    const scans = getEntries.mock.calls.length;
    await emit(a, "session_tree", ctx);
    expect(coordinator.retryCompletionNotification(runId, notificationId!, ctx)).toBe("observed");
    expect(getEntries).toHaveBeenCalledTimes(scans);
    expect(getBranch).not.toHaveBeenCalled();
    expect(a.api.api.sendMessage).toHaveBeenCalledOnce();
  });

  it("requires owning history and a custom message matching the whole identity", async () => {
    const { a, coordinator, runId, ctx, append } = await startWithHistory();
    await vi.advanceTimersByTimeAsync(200);
    const { details } = a.api.api.sendMessage.mock.calls[0][0];
    const foreign = parentHistory("another-session");
    foreign.append(details);
    await emit(a, "turn_start", foreign.ctx);
    append(details, "subagent-message");
    for (const key of ["parentSessionId", "ownerGeneration", "runId", "notificationId"]) {
      append({ ...details, [key]: "incorrect" });
    }
    await emit(a, "turn_start", ctx);
    expect(coordinator.getCompletionNotification(runId).status).toBe("submitted");
    append(details);
    await emit(a, "turn_start", ctx);
    expect(coordinator.getCompletionNotification(runId).status).toBe("observed");
  });

  it.each([false, true])("checks history after a synchronous throw (entry present: %s)", async (hasEntry) => {
    const { a, coordinator, runId, append } = await startWithHistory();
    a.api.api.sendMessage.mockImplementation((message) => {
      if (hasEntry) append(message.details);
      throw new Error("host failed after receiving the call");
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(coordinator.getCompletionNotification(runId)).toMatchObject({
      status: hasEntry ? "observed" : "submitted",
      canRetry: !hasEntry,
    });
    expect(a.api.api.sendMessage).toHaveBeenCalledOnce();
  });

  it("keeps an asynchronous host failure unconfirmed without retrying", async () => {
    const { a, coordinator, runId, ctx } = await startWithHistory();
    const emitError = vi.fn();
    const failure = new Error("asynchronous failure reported only by the host");
    let reject!: (error: Error) => void;
    a.api.api.sendMessage.mockImplementation(() => {
      void new Promise<void>((_resolve, rejectSend) => (reject = rejectSend)).catch(emitError);
    });
    await vi.advanceTimersByTimeAsync(200);
    reject(failure);
    await vi.advanceTimersByTimeAsync(30_000);
    await emit(a, "agent_settled", ctx);
    expect(emitError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(coordinator.getCompletionNotification(runId)).toMatchObject({ status: "submitted", canRetry: true });
    expect(a.api.api.sendMessage).toHaveBeenCalledOnce();
  });

  it("finds a matching receipt off the active branch in the installed SDK history", async () => {
    const { SessionManager } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
    const sessionManager = SessionManager.inMemory();
    const anchor = sessionManager.appendCustomEntry("anchor", {});
    const ctx = { ...fakeCtx({ hasUI: false }), sessionManager };
    const a = parent();
    await emit(a, "session_start", ctx);
    const { agentId } = await spawn(a, ctx);
    const { coordinator, manager } = services(a);
    const runId = manager.getRuns(agentId)[0].id;
    await vi.advanceTimersByTimeAsync(200);
    const { details } = a.api.api.sendMessage.mock.calls[0][0];
    const receipt = sessionManager.appendCustomMessageEntry("subagent-result", "result", true, details);
    sessionManager.branch(anchor);
    expect(sessionManager.getBranch().some((entry) => entry.id === receipt)).toBe(false);
    await emit(a, "session_tree", ctx);
    expect(coordinator.getCompletionNotification(runId).status).toBe("observed");
    expect(coordinator.retryCompletionNotification(runId, details.notificationId, ctx)).toBe("observed");
    expect(a.api.api.sendMessage).toHaveBeenCalledOnce();
  });

  it("retries only the selected old snapshot and blocks synchronous retry reentry", async () => {
    const { a, coordinator, runId, agentId, manager, ctx, append } = await startWithHistory();
    await vi.advanceTimersByTimeAsync(200);
    const original = a.api.api.sendMessage.mock.calls[0][0];
    const id = original.details.notificationId;
    vi.mocked(continueAgentSession).mockResolvedValueOnce({ ...finishedRun(), responseText: "newer result" });
    expect(await manager.steer(agentId, "continue")).toBe(true);
    const next = manager.getRuns(agentId).at(-1)!;
    await next.completion;
    await vi.advanceTimersByTimeAsync(200);
    expect(coordinator.retryCompletionNotification(next.id, id, ctx)).toBe("unavailable");
    a.api.api.sendMessage.mockImplementationOnce(() => {
      expect(coordinator.retryCompletionNotification(runId, id, ctx)).toBe("not-eligible");
    });
    expect(coordinator.retryCompletionNotification(runId, id, ctx)).toBe("submitted");
    expect(a.api.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(a.api.api.sendMessage.mock.calls[2][0]).toEqual(original);
    append(original.details);
    expect(coordinator.retryCompletionNotification(runId, id, ctx)).toBe("observed");
    expect(a.api.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(manager.getRuns(agentId)[0].outcome?.result).toBe("A finished work");
  });

  it("drops an unconfirmed receipt when its agent is cleared", async () => {
    const { a, coordinator, manager, agentId, runId, ctx, append, getEntries } = await startWithHistory();
    await vi.advanceTimersByTimeAsync(200);
    const { details } = a.api.api.sendMessage.mock.calls[0][0];
    expect(manager.clear(agentId)).toBe(true);
    append(details);
    await emit(a, "turn_start", ctx);
    expect(getEntries).not.toHaveBeenCalled();
    expect(coordinator.getCompletionNotification(runId).status).toBe("unavailable");
    expect(coordinator.retryCompletionNotification(runId, details.notificationId, ctx)).toBe("unavailable");
    expect(a.api.api.sendMessage).toHaveBeenCalledOnce();
  });

  it("invalidates queued sends and receipt state after clear and same-session reload", async () => {
    const { a, coordinator, manager, agentId, runId, ctx, append } = await startWithHistory();
    expect(manager.clear(agentId)).toBe(true);
    expect(manager.getRuns(agentId)).toEqual([]);
    expect(coordinator.getCompletionNotification(runId).status).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(200);
    expect(a.api.api.sendMessage).not.toHaveBeenCalled();

    const submitted = await spawn(a, ctx);
    const submittedRun = manager.getRuns(submitted.agentId)[0];
    await vi.advanceTimersByTimeAsync(200);
    const [{ details }] = a.api.api.sendMessage.mock.calls[0];
    expect(details.ownerGeneration).toBe(a.owner.generation);
    await spawn(a, ctx); // A second notification still queued when the owner closes.
    append(details);
    await emit(a, "session_start", ctx);
    coordinator.observeCompletionNotifications(ctx);
    expect(coordinator.retryCompletionNotification(submittedRun.id, details.notificationId, ctx)).toBe("unavailable");
    const newSpawn = await spawn(a, ctx);
    const replacement = services(a);
    const newRun = replacement.manager.getRuns(newSpawn.agentId)[0];
    await vi.advanceTimersByTimeAsync(200);
    await emit(a, "turn_start", ctx);
    expect(replacement.coordinator.getCompletionNotification(newRun.id).status).toBe("submitted");
    expect(a.api.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(a.api.api.sendMessage.mock.calls[1][0].details.ownerGeneration).toBeGreaterThan(details.ownerGeneration);
  });
  it("retains run 1's settled result when a continuation starts inside its batch window", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    const { agentId } = await spawn(a, ctx);
    const { manager } = services(a);
    let finish!: (value: ReturnType<typeof finishedRun>) => void;
    vi.mocked(continueAgentSession).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    expect(await manager.steer(agentId, "continue")).toBe(true);
    try {
      const record = manager.getRecord(agentId)!;
      expect(record.lifecycle.status).toBe("running");
      record.stats.turnCount = 12;
      record.stats.lifetimeUsage.output = 100;
      await vi.advanceTimersByTimeAsync(200);
      expectResult(a.api, "followUp");
      expect(a.api.api.sendMessage.mock.calls[0][0].details).toMatchObject({
        status: "completed",
        turnCount: 1,
        output: 0,
      });
    } finally {
      finish({ ...finishedRun(), responseText: "Second result" });
      await manager.getRuns(agentId).at(-1)?.completion;
    }
  });

  it("sends a distinct snapshot for every run that settles inside one batch window", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    const { agentId } = await spawn(a, ctx);
    const { manager } = services(a);
    for (const responseText of ["Second result", "Third result"]) {
      vi.mocked(continueAgentSession).mockResolvedValueOnce({ ...finishedRun(), responseText });
      expect(await manager.steer(agentId, "continue")).toBe(true);
      await manager.getRuns(agentId).at(-1)?.completion;
    }
    await vi.advanceTimersByTimeAsync(200);
    const calls = a.api.api.sendMessage.mock.calls;
    expect(calls).toHaveLength(3);
    const runIds = manager.getRuns(agentId).map((run) => run.id);
    expect(calls.map(([message]) => message.details.runId)).toEqual(runIds);
    expect(new Set(calls.map(([message]) => message.details.notificationId)).size).toBe(3);
    for (const [index, result] of ["A finished work", "Second result", "Third result"].entries()) {
      expect(calls[index][0].content).toContain(result);
    }
  });
  it.each([
    { idle: true, deliverAs: "followUp" as const },
    { idle: false, deliverAs: "steer" as const },
  ])("keeps the bound parent after an unbound factory reload ($deliverAs)", async ({ idle, deliverAs }) => {
    const a = parent();
    const ctx = await emit(a, "session_start", fakeCtx({ hasUI: false, isIdle: () => idle }));
    await spawn(a, ctx);

    const b = parent();
    b.api.api.sendMessage.mockImplementation(() => {
      throw new Error("Extension runtime not initialized");
    });
    await vi.advanceTimersByTimeAsync(200);

    expectResult(a.api, deliverAs);
    expect(b.api.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("keeps A's queued notification on A while B awaits discovery", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start", fakeCtx({ hasUI: false, isIdle: () => true }));
    await spawn(a, ctx);

    const b = parent();
    let releaseScan!: (value: Awaited<ReturnType<typeof scanAgentFilesInDir>>) => void;
    vi.mocked(scanAgentFilesInDir).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseScan = resolve;
      }),
    );
    const starting = emit(b, "session_start", fakeCtx({ hasUI: false, isIdle: () => false }));
    try {
      await vi.advanceTimersByTimeAsync(200);
      expectResult(a.api, "followUp");
      expect(b.api.api.sendMessage).not.toHaveBeenCalled();
    } finally {
      releaseScan([]);
      await starting;
    }
  });

  it("keeps child factories inert during marked child loading", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    await spawn(a, ctx);
    const child = createMockExtensionAPI();
    withChildExtensionLoad(true, () => factory(asExtensionAPI(child.api)));
    await vi.advanceTimersByTimeAsync(200);
    expect(child.listeners).toEqual([]);
    expectResult(a.api, "followUp");
    expect(child.api.sendMessage).not.toHaveBeenCalled();
  });
});
