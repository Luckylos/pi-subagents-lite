import { expect, it, vi } from "vite-plus/test";
import {
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { ensureManagerAndWidget } from "../../src/events.js";
import { registerAgentTool } from "../../src/registration.js";
import * as runner from "../../src/agents/agent-runner.js";
import { fakeCtx } from "../fixtures.js";
import { createTestOwner } from "../owner-fixtures.js";
import { asAgentSession, asExtensionAPI, asTui } from "../pi-boundaries.js";

it("refreshes the same foreground Agent tool row at settlement and retains the historical Stop result", async () => {
  initTheme("dark", false);
  const owner = await createTestOwner();
  const ctx = fakeCtx();
  owner.sessionCtx = ctx;
  vi.spyOn(owner.store!, "agent", "get").mockReturnValue({ ...owner.store!.agent, outputTranscript: false });
  ensureManagerAndWidget(owner);
  const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
  registerAgentTool(asExtensionAPI({ registerTool }), owner);
  const tool = registerTool.mock.calls[0][0];
  const requestRender = vi.fn();
  const params = { prompt: "task", description: "Foreground task", run_in_background: false };
  const row = new ToolExecutionComponent(
    tool.name,
    "foreground-call",
    params,
    {},
    tool,
    asTui({ requestRender }),
    ctx.cwd,
  );
  const lines = () =>
    row
      .render(120)
      .map((line) => stripVTControlCharacters(line).trim())
      .filter(Boolean);
  const session = asAgentSession({ messages: [], dispose: vi.fn(), isStreaming: false });
  let finish!: (result: runner.RunResult) => void;
  const execution = new Promise<runner.RunResult>((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runAgent = vi.spyOn(runner, "runAgent").mockImplementation(() => {
    started();
    return execution;
  });
  const manager = owner.manager!;
  try {
    const toolCtx: ExtensionToolContext = {
      ...ctx,
      tools: [],
      executeTool: vi.fn<ExtensionToolContext["executeTool"]>(),
    };
    const output = tool.execute("foreground-call", params, undefined, undefined, toolCtx);
    await start;
    row.markExecutionStarted();
    const [record] = manager.listAgents();
    const [run] = manager.getRuns(record.id);
    expect(manager.abort(record.id, "user")).toBe(true);
    const result = await output;
    const history = `Stop requested for ${record.id.slice(0, 8)} — stopping.`;
    expect(result.content).toEqual([{ type: "text", text: history }]);
    row.setExpanded(true);
    row.updateResult({ ...result, isError: false });
    expect(lines()[0]).toBe("◈ Agent stopping");
    expect(lines()).toContain(history);
    requestRender.mockClear();
    finish({ responseText: "partial", session, aborted: false, turnLimited: false });
    await run.completion;
    expect(record.lifecycle).toMatchObject({ status: "stopped", phase: "settled" });
    expect.soft(requestRender).toHaveBeenCalledTimes(1);
    expect.soft(lines()[0]).toBe("■ Agent");
    expect(lines()).toContain(history);
    expect(result.content).toEqual([{ type: "text", text: history }]);
  } finally {
    finish({ responseText: "partial", session, aborted: false, turnLimited: false });
    owner.widget?.dispose();
    owner.coordinator?.dispose();
    await manager.dispose();
    runAgent.mockRestore();
  }
});
