import { expect, it, vi } from "vite-plus/test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { captureResultStats } from "../../src/agents/agent-result.js";
import { registerTools } from "../../src/registration.js";
import { SpawnCoordinator, type SpawnResult } from "../../src/spawn/spawn-coordinator.js";
import { resolveSpawn } from "../../src/spawn/spawn-resolution.js";
import type { SubagentParentReport } from "../../src/types.js";
import { createMockExtensionAPI, fakeCtx, makeAgentRecord } from "../fixtures.js";
import { createTestOwner } from "../owner-fixtures.js";
import { asExtensionAPI } from "../pi-boundaries.js";

vi.mock(import("../../src/spawn/spawn-resolution.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveSpawn: vi.fn(async (...args: Parameters<typeof resolveSpawn>) => ({
    type: args[2],
    agentConfig: undefined,
    worktreePath: undefined,
    worktreeLabel: undefined,
    projectTrusted: false,
    model: undefined,
    modelKey: undefined,
    thinkingLevel: undefined,
    deferredDefaultThinking: undefined,
  })),
}));

const steps = [
  { agent: "explore", prompt: "Analyze the repository." },
  { agent: "reviewer", prompt: "Review the existing implementation." },
];

async function setup() {
  const owner = await createTestOwner();
  const ctx: ExtensionToolContext = {
    ...fakeCtx(),
    tools: [],
    executeTool: vi.fn<ExtensionToolContext["executeTool"]>(),
  };
  owner.sessionCtx = ctx;
  const api = createMockExtensionAPI();
  const coordinator = new SpawnCoordinator(owner, new AgentManager(owner));
  owner.coordinator = coordinator;
  const spawn = vi.spyOn(coordinator, "spawn");
  const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
  registerTools(asExtensionAPI({ ...api.api, registerTool }), owner);
  const tool = registerTool.mock.calls.map(([entry]) => entry).find((entry) => entry.name === "Workflow");
  expect(tool).toBeDefined();
  return {
    owner,
    ctx,
    spawn,
    run: (signal?: AbortSignal, params = { steps }) => tool!.execute("workflow-1", params, signal, undefined, ctx),
  };
}

function result(agentId: string, status: SubagentParentReport["status"] = "completed"): SpawnResult {
  const record = makeAgentRecord({ id: agentId });
  const common = { ...record.display, stats: captureResultStats(record) };
  const foregroundReport: SubagentParentReport =
    status === "stopping"
      ? { ...common, status }
      : {
          ...common,
          status,
          agentId,
          started: true,
          elapsedMs: 1,
          completedAt: 1,
          runId: agentId + "-run",
          sequence: 1,
          result: "Output from " + agentId,
        };
  return { agentId, record, foregroundReport };
}

it("uses foreground Spawn, waits for completion, and returns both run references in order", async () => {
  const { spawn, run } = await setup();
  let resolve!: (report: SpawnResult) => void;
  const promise = new Promise<SpawnResult>((done) => {
    resolve = done;
  });
  spawn.mockReturnValueOnce(promise).mockResolvedValueOnce(result("second"));
  const abort = new AbortController();
  const pending = run(abort.signal);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({
    type: "explore",
    prompt: steps[0]?.prompt,
    runInBackground: false,
    signal: abort.signal,
    projectTrusted: false,
  });
  resolve(result("first"));
  const output = await pending;
  expect(spawn.mock.calls.map(([, , intent]) => intent.prompt)).toEqual(steps.map((step) => step.prompt));
  expect(output.details).toMatchObject({
    status: "completed",
    steps: [
      { agentId: "first", runId: "first-run", status: "completed" },
      { agentId: "second", runId: "second-run", status: "completed" },
    ],
  });
  const content = output.content[0];
  expect(content?.type === "text" && content.text).toContain("Output from first");
  expect(content?.type === "text" && content.text).toContain("Output from second");
});

it.each(["stopping", "turn_limited", "error"] as const)("stops after a step reports %s", async (status) => {
  const { spawn, run } = await setup();
  spawn.mockResolvedValueOnce(result("first", status));
  const output = await run();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(output.details).toMatchObject({ status: "stopped", steps: [{ agentId: "first", status }] });
});

it.each(["switch", "interrupt"] as const)("does not start the next step after parent %s", async (reason) => {
  const { owner, spawn, run } = await setup();
  const abort = new AbortController();
  spawn.mockImplementationOnce(async () => {
    if (reason === "switch") owner.generation++;
    else abort.abort();
    return result("first");
  });
  const output = await run(abort.signal);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(output.details).toMatchObject({ status: "stopped", steps: [{ agentId: "first", status: "completed" }] });
});

it("keeps the completed run when admission rejects a later step", async () => {
  const { spawn, run } = await setup();
  spawn.mockResolvedValueOnce(result("first")).mockRejectedValueOnce(new Error("Concurrency limit reached"));
  const output = await run();
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(output.details).toMatchObject({ status: "stopped", steps: [{ agentId: "first", runId: "first-run" }] });
  const content = output.content[0];
  expect(content?.type === "text" && content.text).toContain("Workflow stopped at step 2: Concurrency limit reached");
  expect(content?.type === "text" && content.text).toContain("Output from first");
});

it("does not override Force Background", async () => {
  const { owner, spawn, run } = await setup();
  const store = owner.store!;
  const agent = vi.spyOn(store, "agent", "get").mockReturnValue({ ...store.agent, forceBackground: true });
  try {
    await expect(run()).rejects.toThrow(/Force Background/);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    agent.mockRestore();
  }
});

it("rejects an invalid later step before spawning anything", async () => {
  const { spawn, run } = await setup();
  await expect(run(undefined, { steps: [steps[0]!, { agent: "reviewer", prompt: " " }] })).rejects.toThrow(
    /invalid workflow steps/i,
  );
  expect(spawn).not.toHaveBeenCalled();
});
