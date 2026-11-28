import { mockAgentSession, mockModules, mockRunResult } from "../agents/manager-mocks.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { formatResultStats } from "../../src/agents/agent-result.js";
import type { SessionPromptOptions } from "../../src/agents/session-run.js";
import { ConfigStore } from "../../src/config/config-store.js";
import { registerAgentTool } from "../../src/registration.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { ConversationViewer } from "../../src/ui/conversation-viewer.js";
import { renderSubagentResult } from "../../src/ui/renderer.js";
import { fakeCtx, makeResolvablePromise } from "../fixtures.js";
import { createTestOwner } from "../owner-fixtures.js";
import { asAgentSession, asExtensionAPI, asTui } from "../pi-boundaries.js";
import { makeMockTheme, makeMockTUI, renderWidgetLines } from "../ui/widget-helpers.js";

vi.mock("../../src/pi-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/pi-settings.js")>()),
  getPiModelThinkingLevels: () => ({}),
}));

describe("Subagent run activity", () => {
  let manager: AgentManager;
  let coordinator: SpawnCoordinator;
  let widget: AgentWidget;
  let first: ReturnType<typeof makeResolvablePromise>;
  let next: ReturnType<typeof makeResolvablePromise>;
  let viewer: ConversationViewer | undefined;
  let owner: Awaited<ReturnType<typeof createTestOwner>>;
  let spawn: (maxTurns?: number) => ReturnType<SpawnCoordinator["spawn"]>;

  beforeEach(async () => {
    vi.useFakeTimers();
    owner = await createTestOwner();
    const ctx = fakeCtx();
    owner.sessionCtx = ctx;
    manager = new AgentManager(owner);
    coordinator = new SpawnCoordinator(owner, manager);
    owner.coordinator = coordinator;
    widget = new AgentWidget(owner, manager, (id) => manager.getLiveView(id));
    first = makeResolvablePromise();
    next = makeResolvablePromise();
    mockModules.mockRunAgent.mockReset().mockReturnValue(first.promise);
    mockModules.mockContinueAgentSession.mockReset().mockReturnValue(next.promise);
    spawn = (maxTurns) =>
      coordinator.spawn(owner.pi, ctx, {
        type: "general-purpose",
        prompt: "task",
        description: "task",
        maxTurns,
        graceTurns: 6,
        runInBackground: true,
      });
  });

  afterEach(async () => {
    first.resolve(mockRunResult());
    next.resolve(mockRunResult());
    viewer?.dispose();
    viewer = undefined;
    widget.dispose();
    coordinator.dispose();
    await manager.dispose();
    vi.useRealTimers();
  });

  it("tracks same-name tool calls started in the same millisecond and removes them by ID", async () => {
    const { agentId } = await spawn();
    const { onToolActivity }: SessionPromptOptions = mockModules.mockRunAgent.mock.calls[0][4];
    const activeToolIds = () => Array.from(manager.getLiveView(agentId)!.activeTools.keys());
    const frame = () => renderWidgetLines(widget).join("\n");
    expect(manager.getLiveView(agentId)).toEqual({ activeTools: new Map(), responseText: "" });

    onToolActivity!({ type: "start", toolName: "read", toolCallId: "first" });
    onToolActivity!({ type: "start", toolName: "read", toolCallId: "second" });
    const both = { ids: activeToolIds(), frame: frame() };

    onToolActivity!({ type: "end", toolName: "read", toolCallId: "unknown" });
    const afterUnknownEnd = activeToolIds();
    onToolActivity!({ type: "end", toolName: "read", toolCallId: "second" });
    const afterSecondEnd = { ids: activeToolIds(), frame: frame() };
    onToolActivity!({ type: "end", toolName: "read" });
    const afterSyntheticEnd = { ids: activeToolIds(), frame: frame() };

    expect([both.ids, afterUnknownEnd, afterSecondEnd.ids, afterSyntheticEnd.ids]).toEqual([
      ["first", "second"],
      ["first", "second"],
      ["first"],
      [],
    ]);
    expect(both.frame).toContain("reading 2 files…");
    expect(afterSecondEnd.frame).toContain("reading…");
    expect(afterSyntheticEnd.frame).toContain("thinking…");

    first.resolve(mockRunResult());
    await manager.dispose();
    expect(manager.getLiveView(agentId)).toBeUndefined();
  });

  it.each([false, true])("uses the current run's limit in the Widget (compact=%s) and Viewer", async (compact) => {
    widget.setForceCompact(compact);
    const { agentId, record } = await spawn(3);
    const session = mockAgentSession();
    const initial: SessionPromptOptions = mockModules.mockRunAgent.mock.calls[0][4];
    const theme = makeMockTheme();
    viewer = new ConversationViewer(
      owner,
      asTui({ terminal: { rows: 30 }, requestRender: vi.fn() }),
      asAgentSession(session),
      record,
      theme,
      vi.fn(),
    );
    const liveStats = () => [renderWidgetLines(widget, makeMockTUI(), theme).join("\n"), viewer!.render(200)[2]];
    const expectTurns = (text: string, showsLimit = false) => {
      const stats = liveStats();
      expect(stats).toEqual([expect.stringContaining(text), expect.stringContaining(text)]);
      expect(stats.map((line) => line.includes("≤"))).toEqual([showsLimit, showsLimit]);
    };
    const retainedStats = (index: number) => {
      const result = manager.getRuns(agentId)[index].outcome!;
      return renderSubagentResult(
        owner,
        { details: { ...formatResultStats(result.stats, result.elapsedMs), type: result.type, status: result.status } },
        {},
        theme,
        true,
      )
        .render(200)
        .join("\n");
    };

    const [initialWidgetStats, initialViewerStats] = liveStats();
    expect.soft(initialWidgetStats).toContain("0⟳ ");
    expect.soft(initialViewerStats).toContain("0⟳ ");
    expect(initialWidgetStats).toContain("thinking…");
    initial.onTurnEnd!(1);
    expectTurns("1⟳ ");
    initial.onTurnEnd!(2);
    expectTurns("2⟳ ");
    first.resolve(mockRunResult({ session }));
    await manager.getRuns(agentId)[0].completion;
    expectTurns("2⟳ ");

    expect(await manager.submitMessage(agentId, "brief continuation")).toMatchObject({ delivery: "continuation" });
    expectTurns("2⟳ ");
    const brief: SessionPromptOptions = mockModules.mockContinueAgentSession.mock.calls[0][2];
    brief.onTurnEnd!(1);
    expectTurns("3⟳ ");
    next.resolve(mockRunResult({ session }));
    await manager.getRuns(agentId)[1].completion;
    expectTurns("3⟳ ");
    expect(retainedStats(1)).toContain("3⟳ ");
    expect(retainedStats(1)).not.toContain("≤");

    const limited = makeResolvablePromise();
    mockModules.mockContinueAgentSession.mockReturnValueOnce(limited.promise);
    try {
      expect(await manager.submitMessage(agentId, "longer continuation")).toMatchObject({ delivery: "continuation" });
      expectTurns("3⟳ ");
      initial.onTurnEnd!(99);
      brief.onTurnEnd!(99);
      expectTurns("3⟳ ");
      const current: SessionPromptOptions = mockModules.mockContinueAgentSession.mock.calls[1][2];
      current.onTurnEnd!(1);
      current.onTurnEnd!(2);
      expectTurns("5⟳ ");
      current.onTurnEnd!(3);
      expectTurns("6⟳ [error:(run 3≤3) ]", true);
    } finally {
      limited.resolve(mockRunResult({ session, turnLimited: true }));
    }
    await manager.getRuns(agentId)[2].completion;
    expectTurns("6⟳ [error:(run 3≤3) ]", true);
    expect(retainedStats(2)).toContain("6⟳ [error:(run 3≤3) ]");

    mockModules.mockContinueAgentSession.mockRejectedValueOnce(new Error("prompt failed before its first turn"));
    const retry = manager.submitMessage(agentId, "retry after limit");
    expectTurns("6⟳ ");
    expect(await retry).toMatchObject({ delivery: "continuation" });
    await manager.getRuns(agentId)[3].completion;
    expectTurns("6⟳ ");
    expect(retainedStats(2)).toContain("6⟳ [error:(run 3≤3) ]");
    expect(
      manager.getRuns(agentId).map((run) => [run.outcome?.stats.turnCount, run.outcome?.stats.runTurnCount]),
    ).toEqual([
      [2, 2],
      [3, 1],
      [6, 3],
      [6, 0],
    ]);
  });

  it("reports zero completed turns when a registered foreground Agent is cancelled while queued", async () => {
    manager.setConcurrency({ default: 1 });
    owner.store = new ConfigStore({
      load: () => ({ global: { agent: { defaultMaxTurns: 1 } }, project: null, projectStatus: "absent" }),
      updateLayer: vi.fn(),
      saveGlobal: vi.fn(),
      saveProject: vi.fn(),
    });
    owner.registry.registerAgents(new Map());
    const registerTool = vi.fn<(tool: ToolDefinition) => void>();
    registerAgentTool(asExtensionAPI({ ...owner.pi, registerTool }), owner);
    const [[agent]] = registerTool.mock.calls;
    const ctx: ExtensionToolContext = {
      ...owner.sessionCtx!,
      tools: [],
      executeTool: vi.fn<ExtensionToolContext["executeTool"]>(),
    };
    const running = await agent.execute(
      "running",
      { prompt: "running", run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    expect(running.details).toMatchObject({ status: "running" });

    const stop = new AbortController();
    const args = { prompt: "queued" };
    const foreground = agent.execute("queued", args, stop.signal, undefined, ctx);
    try {
      await vi.waitFor(() => expect(manager.listAgents()).toHaveLength(2));
      const queued = manager.listAgents().find((record) => record.display.toolCall?.id === "queued")!;
      expect(queued.lifecycle).toMatchObject({ status: "queued", started: false });
      expect(renderWidgetLines(widget).join("\n")).toContain("1 queued");
      expect.soft(queued.stats).toMatchObject({ turnCount: 0, runTurnCount: 0, maxTurns: 1 });

      stop.abort();
      const result = await foreground;
      expect.soft(result.details).toMatchObject({ turnCount: 0, runTurnCount: 0, maxTurns: 1 });
      expect.soft(manager.getInitialRun(queued.id)?.outcome).toMatchObject({
        status: "stopped",
        started: false,
        stats: { turnCount: 0, runTurnCount: 0 },
      });
      const finished = renderWidgetLines(widget).find((line) => line.includes("queued"));
      expect.soft(finished).toContain("0⟳ ");
      expect(finished).not.toContain("≤");

      const { theme } = ctx.ui;
      vi.mocked(theme.fg).mockImplementation((_color, text) => text);
      const options = { expanded: false, isPartial: false };
      const component = agent.renderResult!(result, options, theme, {
        ...options,
        args,
        toolCallId: "queued",
        invalidate: vi.fn(),
        lastComponent: undefined,
        state: {},
        cwd: ctx.cwd,
        executionStarted: true,
        argsComplete: true,
        showImages: false,
        isError: false,
        durationMs: undefined,
        outputPad: 0,
        keyText: () => "",
        keyHint: () => "",
      });
      const frame = component.render(200).join("\n");
      expect.soft(frame).toContain("0⟳ ");
      expect(frame).not.toContain("≤");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);
    } finally {
      stop.abort();
      await Promise.allSettled([foreground]);
    }
  });

  it.each([false, true])("renders a fresh first Continuation frame (previous tool active=%s)", async (previousTool) => {
    const { agentId } = await spawn();
    const initial: SessionPromptOptions = mockModules.mockRunAgent.mock.calls[0][4];
    const initialView = manager.getLiveView(agentId);
    const frame = () => renderWidgetLines(widget).join("\n");
    initial.onTextDelta!("prior response", "prior response");
    expect(frame()).toContain("prior response");
    if (previousTool) {
      initial.onToolActivity!({ type: "start", toolName: "read", toolCallId: "prior-call" });
      expect(frame()).toContain("reading…");
    }
    first.resolve(mockRunResult({ responseText: "prior response" }));
    await manager.getRuns(agentId)[0].completion;
    expect(manager.getLiveView(agentId)).toBe(initialView);
    expect(initialView?.responseText).toBe("");
    expect(initialView?.activeTools.size).toBe(0);
    expect(manager.getRuns(agentId)[0].outcome?.result).toBe("prior response");

    expect(await manager.submitMessage(agentId, "next")).toMatchObject({ accepted: true, delivery: "continuation" });
    expect(frame()).toContain("thinking…");
    expect(manager.getLiveView(agentId)).not.toBe(initialView);

    initial.onTextDelta!("late response", "late response");
    initial.onToolActivity!({ type: "start", toolName: "bash", toolCallId: "late-call" });
    expect(frame()).toContain("thinking…");

    const continued: SessionPromptOptions = mockModules.mockContinueAgentSession.mock.calls[0][2];
    continued.onTextDelta!("new response", "new response");
    expect(frame()).toContain("new response");
    continued.onToolActivity!({ type: "start", toolName: "edit", toolCallId: "new-call" });
    expect(frame()).toContain("editing…");

    next.resolve(mockRunResult({ responseText: "new response" }));
    await manager.getRuns(agentId)[1].completion;
    expect(manager.clear(agentId)).toBe(true);
    expect(manager.getLiveView(agentId)).toBeUndefined();
  });
});
