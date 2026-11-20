import { mockModules, mockRunResult } from "../agents/manager-mocks.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AgentManager } from "../../src/agents/agent-manager.js";
import type { SessionPromptOptions } from "../../src/agents/session-run.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { fakeCtx, makeResolvablePromise } from "../fixtures.js";
import { createTestOwner } from "../owner-fixtures.js";
import { renderWidgetLines } from "../ui/widget-helpers.js";

describe("Subagent run activity", () => {
  let manager: AgentManager;
  let coordinator: SpawnCoordinator;
  let widget: AgentWidget;
  let first: ReturnType<typeof makeResolvablePromise>;
  let next: ReturnType<typeof makeResolvablePromise>;
  let spawn: () => ReturnType<SpawnCoordinator["spawn"]>;

  beforeEach(async () => {
    vi.useFakeTimers();
    const owner = await createTestOwner();
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
    spawn = () =>
      coordinator.spawn(owner.pi, ctx, {
        type: "general-purpose",
        prompt: "task",
        description: "task",
        graceTurns: 6,
        runInBackground: true,
      });
  });

  afterEach(async () => {
    first.resolve(mockRunResult());
    next.resolve(mockRunResult());
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
