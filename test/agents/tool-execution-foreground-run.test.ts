import { emit, finishedRun, parent, services, type ParentFixture } from "../instance-fixtures.js";
import { createConfigIO } from "../../src/config/config-io.js";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { continueAgentSession, runAgent, type RunResult } from "../../src/agents/agent-runner.js";
import { fakeCtx } from "../fixtures.js";
import type { Theme } from "../../src/ui/types.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function registeredExecute(fixture: ParentFixture, name: string): ToolDefinition["execute"] {
  const tool = fixture.api.tools.filter((tool) => tool.name === name).at(-1);
  if (!tool || !("execute" in tool) || typeof tool.execute !== "function") {
    throw new Error(`Registered tool ${name} is missing its execute handler`);
  }
  return tool.execute as ToolDefinition["execute"];
}

function foregroundCallLine(fixture: ParentFixture) {
  const tool = fixture.api.tools.filter((tool) => tool.name === "Agent").at(-1);
  const theme: Theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const context = { toolCallId: "foreground-call", state: {} };
  return () => {
    const line = tool?.renderCall?.({}, theme, context);
    if (!line || typeof line !== "object" || !("render" in line) || typeof line.render !== "function") {
      throw new Error("The registered Agent tool did not render a call line");
    }
    return String(line.render(80));
  };
}

describe("registered foreground Agent tool", () => {
  it.each(["turn_limited", "error"] as const)(
    "reports the initial %s run after a sibling accepts a continuation",
    async (status) => {
      const fixture = parent();
      const ctx = {
        ...(await emit(fixture, "session_start", fakeCtx({ hasUI: false }))),
        tools: [],
        executeTool: vi.fn(),
      };
      const { manager, coordinator } = services(fixture);
      const execute = registeredExecute(fixture, "Agent");
      const initial = deferred<RunResult>();
      const continuation = deferred<RunResult>();
      const runStarted = deferred<string>();
      const firstResult = { ...finishedRun(), responseText: "original answer" };
      vi.setSystemTime(1_000);
      vi.mocked(runAgent).mockImplementationOnce((_owner, _ctx, _type, _prompt, options) => {
        options.onAssistantUsage?.({ input: 100, output: 20, cacheWrite: 0, cacheRead: 0, cost: 0.25 });
        options.onTurnEnd?.(2);
        runStarted.resolve(options.agentId!);
        return initial.promise;
      });
      vi.mocked(continueAgentSession).mockImplementationOnce((_session, _message, options) => {
        options?.onAssistantUsage?.({ input: 999, output: 199, cacheWrite: 0, cacheRead: 0, cost: 3 });
        options?.onTurnEnd?.(4);
        return continuation.promise;
      });

      const sibling = deferred<Awaited<ReturnType<typeof manager.submitMessage>>>();
      manager.setOnComplete((result, notification) => {
        coordinator.onAgentComplete(result, notification);
        if (result.sequence !== 1) return;
        // A reaction on completion runs after publication and before the tool resumes from spawn().
        const [run] = manager.getRuns(result.agentId);
        sibling.resolve(run.completion.then(() => manager.submitMessage(result.agentId, "continue the conversation")));
      });
      const toolResult = execute("foreground-call", { prompt: "initial work" }, undefined, undefined, ctx);
      const firstId = await runStarted.promise;
      try {
        const renderCall = foregroundCallLine(fixture);
        expect(renderCall()).toContain("◈");
        vi.setSystemTime(1_500);
        initial.resolve({
          ...firstResult,
          turnLimited: status === "turn_limited",
          ...(status === "error" && { modelError: "provider refused" }),
        });
        if (status === "error") {
          await expect(toolResult).rejects.toThrow("Agent failed: general-purpose: provider refused");
        } else {
          await expect(toolResult).resolves.toMatchObject({
            content: [{ type: "text", text: "original answer (wrapped up at the turn limit — output may be partial)" }],
            details: { turnCount: 2, input: 100, output: 20, cost: 0.25, durationMs: 500 },
          });
        }
        const accepted = await sibling.promise;
        expect(accepted).toMatchObject({ accepted: true, delivery: "continuation", agentId: firstId });
        const [first, second] = manager.getRuns(firstId);
        expect(first.outcome).toMatchObject({ status, result: "original answer" });
        expect(second).toMatchObject({ phase: "running" });
        const icon = status === "error" ? "✗" : "✓";
        expect(renderCall()).toContain(icon);
        expect(foregroundCallLine(fixture)()).toContain(icon);
        expect(manager.getRecord(firstId)).toMatchObject({
          lifecycle: { status: "running" },
          display: { toolCall: { id: "foreground-call", background: false } },
          stats: { turnCount: 6, lifetimeUsage: { input: 1099, output: 219, cost: 3.25 } },
        });
      } finally {
        initial.resolve(firstResult);
        continuation.resolve({ ...firstResult, responseText: "continuation answer" });
      }
    },
  );

  it("follows the current run when settings force the tool call into the background", async () => {
    const io = createConfigIO(undefined);
    vi.mocked(io.load).mockReturnValue({
      global: { agent: { forceBackground: true } },
      project: null,
      projectStatus: "untrusted",
    });
    vi.mocked(createConfigIO).mockReturnValueOnce(io);
    const fixture = parent();
    const ctx = {
      ...(await emit(fixture, "session_start", fakeCtx({ hasUI: false }))),
      tools: [],
      executeTool: vi.fn(),
    };
    const { manager } = services(fixture);
    const execute = registeredExecute(fixture, "Agent");
    const initial = deferred<RunResult>();
    const continuation = deferred<RunResult>();
    vi.mocked(runAgent).mockReturnValueOnce(initial.promise);
    vi.mocked(continueAgentSession).mockReturnValueOnce(continuation.promise);
    const renderCall = foregroundCallLine(fixture);

    await execute("foreground-call", { prompt: "background work" }, undefined, undefined, ctx);
    const [record] = manager.listAgents();
    const [run] = manager.getRuns(record.id);
    try {
      expect(renderCall()).toContain("◈");
      initial.resolve(finishedRun());
      await run.completion;
      expect(renderCall()).toContain("✓");
      await expect(manager.submitMessage(record.id, "continue")).resolves.toMatchObject({ accepted: true });
      expect(renderCall()).toContain("◈");
    } finally {
      initial.resolve(finishedRun());
      continuation.resolve(finishedRun());
      await Promise.all(manager.getRuns(record.id).map((run) => run.completion));
    }
  });

  it("acknowledges Stop while the SDK still holds the model slot", async () => {
    const fixture = parent();
    const ctx = {
      ...(await emit(fixture, "session_start", fakeCtx({ hasUI: false }))),
      tools: [],
      executeTool: vi.fn(),
    };
    const { manager } = services(fixture);
    manager.setConcurrency({ default: 1 });
    const execute = registeredExecute(fixture, "Agent");
    const stop = registeredExecute(fixture, "StopAgent");
    const initial = deferred<RunResult>();
    const runStarted = deferred<string>();
    vi.mocked(runAgent).mockImplementationOnce((_owner, _ctx, _type, _prompt, options) => {
      options.signal?.addEventListener("abort", () => {
        options.onToolActivity?.({ type: "end", toolName: "read", toolCallId: "cancelled-read" });
        options.onAssistantUsage?.({ input: 7, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
      });
      runStarted.resolve(options.agentId!);
      return initial.promise;
    });
    const toolResult = execute("foreground-call", { prompt: "blocked SDK" }, undefined, undefined, ctx);
    const reported = vi.fn();
    void toolResult.then(reported, reported);
    const id = await runStarted.promise;
    const [run] = manager.getRuns(id);
    try {
      const stopText = `Stop requested for ${id.slice(0, 8)} — stopping.`;
      await expect(stop("stop-call", { agent_id: id }, undefined, undefined, ctx)).resolves.toMatchObject({
        content: [{ type: "text", text: stopText }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(reported).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          content: [{ type: "text", text: stopText }],
          details: expect.objectContaining({ toolUses: 1, input: 7 }),
        }),
      );
      expect(manager.getRuns(id)[0]).toMatchObject({ phase: "stopping", outcome: undefined });
      const renderCall = foregroundCallLine(fixture);
      expect(renderCall()).toContain("stopping");
      expect(await manager.submitMessage(id, "still too early")).toMatchObject({ accepted: false, reason: "stopping" });
      const next = await execute(
        "next-call",
        { prompt: "queued work", run_in_background: true },
        undefined,
        undefined,
        ctx,
      );
      expect(next.details).toMatchObject({ status: "queued" });
      expect(runAgent).toHaveBeenCalledTimes(1);

      initial.resolve({ ...finishedRun(), responseText: "partial answer" });
      await run.completion;
      expect(manager.getRuns(id)[0].outcome).toMatchObject({ status: "stopped", result: "partial answer" });
      expect(renderCall()).toContain("■");
      expect(runAgent).toHaveBeenCalledTimes(2);
    } finally {
      initial.resolve(finishedRun());
    }
  });
});
