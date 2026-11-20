import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultModel } from "../mock-utils.js";
import { asCommandContext, asExtensionAPI } from "../pi-boundaries.js";
import { fakeCtx, makeAgentMd, makeAgentRecord, tempDirWithFiles } from "../fixtures.js";
import { createTestOwner } from "../owner-fixtures.js";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { captureResultStats } from "../../src/agents/agent-result.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import { executeAgentTool } from "../../src/agents/tool-execution.js";
import { handleRestartLastAgents } from "../../src/agents/restart-last-agents.js";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";

const parentModel = { ...defaultModel()!, id: "parent", reasoning: true };
const chosenModel = { ...parentModel, id: "chosen" };
const chosenKey = `${chosenModel.provider}/${chosenModel.id}`;
const parentKey = `${parentModel.provider}/${parentModel.id}`;
const owner = await createTestOwner();
const parent = fakeCtx({ model: parentModel });
const originalRegistryFind = parent.modelRegistry.find;
let workspace: ReturnType<typeof tempDirWithFiles>;
let agentDir: string;
let target: string;

function put(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const pi = asExtensionAPI({
  exec: vi.fn(async (_cmd, args, opts) => ({
    code: 0,
    stdout: args.includes("--show-toplevel") ? opts!.cwd! : join(opts!.cwd!, ".git"),
    stderr: "",
  })),
});
const spawn = vi.spyOn(SpawnCoordinator.prototype, "spawn");
const live = (args: Record<string, unknown>) =>
  executeAgentTool(owner, "tc", { prompt: "task", ...args }, undefined, undefined, parent);
const lastIntent = () => spawn.mock.calls.at(-1)?.[2];

beforeEach(() => {
  workspace = tempDirWithFiles([]);
  agentDir = join(workspace.dir, "agent");
  target = join(workspace.dir, "target");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  put(join(agentDir, "settings.json"), JSON.stringify({ modelThinkingLevels: { [parentKey]: "low" } }));
  owner.registry.registerAgents(new Map());
  owner.store!.mutate.session.clearAll();
  const manager = new AgentManager(owner);
  owner.manager = manager;
  owner.sessionCtx = parent;
  owner.coordinator = new SpawnCoordinator(owner, manager);
  vi.spyOn(owner.pi, "exec").mockImplementation(pi.exec);
  vi.spyOn(parent.modelRegistry, "find").mockImplementation((provider, id) =>
    [chosenModel, parentModel].find((m) => m.provider === provider && m.id === id),
  );
  vi.spyOn(parent.modelRegistry, "getAvailable").mockReturnValue([chosenModel, parentModel]);
  spawn.mockClear().mockImplementation(async (_pi, _ctx, intent) => {
    const record = makeAgentRecord({ id: "agent-id" });
    if (intent.runInBackground) return { agentId: record.id, record };
    return {
      agentId: record.id,
      record,
      foregroundReport: {
        ...record.display,
        agentId: record.id,
        runId: "run-id",
        sequence: 1,
        status: "completed",
        started: true,
        completedAt: 100,
        elapsedMs: 100,
        stats: captureResultStats(record),
      },
    };
  });
});

afterEach(async () => {
  owner.coordinator?.dispose();
  await owner.manager?.dispose();
  parent.modelRegistry.find = originalRegistryFind;
  vi.unstubAllEnvs();
  workspace.cleanup();
});

describe("Spawn resolution at the Agent and Restart boundaries", () => {
  it("resolves a first-discovered target type before its model and Thinking, and limits the definition to that trusted target", async () => {
    put(
      join(target, ".pi", "agents", "review.md"),
      makeAgentMd({ name: "ReviewLocal", model: chosenKey, thinking: undefined }),
    );
    put(join(target, ".pi", "settings.json"), JSON.stringify({ modelThinkingLevels: { [chosenKey]: "high" } }));
    new ProjectTrustStore(agentDir).set(target, true);

    await live({ agent: "reviewlocal", worktree_path: target });
    expect(lastIntent()).toMatchObject({ type: "ReviewLocal", model: chosenModel, thinkingLevel: "high" });
    await expect(live({ agent: "reviewlocal" })).rejects.toThrow("Unknown agent type");
    const other = join(workspace.dir, "other");
    mkdirSync(other);
    await expect(live({ agent: "reviewlocal", worktree_path: other })).rejects.toThrow("Unknown agent type");
    put(
      join(other, ".pi", "agents", "review.md"),
      makeAgentMd({ name: "ReviewLocal", model: parentKey, thinking: "medium" }),
    );
    new ProjectTrustStore(agentDir).set(other, true);
    await live({ agent: "reviewlocal", worktree_path: other });
    expect(lastIntent()).toMatchObject({ type: "ReviewLocal", model: parentModel, thinkingLevel: "medium" });
    await live({ agent: "reviewlocal", worktree_path: target });
    expect(lastIntent()).toMatchObject({ type: "ReviewLocal", model: chosenModel, thinkingLevel: "high" });
    new ProjectTrustStore(agentDir).set(target, false);
    await expect(live({ agent: "reviewlocal", worktree_path: target })).rejects.toThrow("Unknown agent type");
  });

  it("gates a cross-repo target offering only plugin context files and preserves trusted parent types", async () => {
    put(join(target, "AGENTS.md"), "target instructions");
    const parentAgentsDir = join(workspace.dir, "parent-agents");
    put(join(parentAgentsDir, "parent.md"), makeAgentMd({ name: "ParentAgent", model: chosenKey }));
    owner.registry.setAgentScanDirs("", parentAgentsDir);
    new ProjectTrustStore(agentDir).set(target, false);

    await live({ agent: "parentagent", worktree_path: target });
    expect(lastIntent()).toMatchObject({
      type: "ParentAgent",
      worktreePath: target,
      projectTrusted: false,
      model: chosenModel,
    });
  });

  it("uses the canonical type's defaults, rejects unavailable explicit models, and reads Thinking for the parent fallback", async () => {
    owner.store!.mutate.session.setOverride("Explore", chosenKey);
    await live({ agent: "explore" });
    expect(lastIntent()?.model).toBe(chosenModel);

    await expect(live({ model: "anthropic/retired" })).rejects.toThrow("anthropic/retired");
    vi.mocked(parent.modelRegistry.getAvailable).mockReturnValueOnce([parentModel]);
    await expect(live({ model: chosenKey })).rejects.toThrow(chosenKey);
    owner.store!.mutate.session.setOverride("default", "anthropic/retired");
    await live({});
    expect(lastIntent()).toMatchObject({ model: parentModel, thinkingLevel: "low" });
    await live({ model: chosenKey, thinking: "high" });
    expect(lastIntent()).toMatchObject({ model: chosenModel, thinkingLevel: "high" });
  });

  it("restarts original and legacy choices from the full tree with current defaults and background execution", async () => {
    owner.store!.mutate.session.setOverride("default", "test/retired");
    const session = SessionManager.inMemory(parent.cwd);
    function append(args: JsonObject[]) {
      const msg: AssistantMessage = {
        role: "assistant",
        content: args.map((a, i) => ({ type: "toolCall", id: `tc-${i}`, name: "Agent", arguments: a })),
        api: parentModel.api,
        provider: parentModel.provider,
        model: parentModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
      return session.appendMessage(msg);
    }
    const root = session.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    append([
      { prompt: "explicit", model: chosenKey, thinking: "parent", run_in_background: false },
      { prompt: "omitted" },
      { prompt: "legacy", model: "test/old-model", _modelOverride: "old-model", thinking: "medium" },
      { prompt: "explicit missing", model: "test/old-model" },
    ]);
    session.branch(root);
    session.appendMessage({ role: "user", content: "other branch", timestamp: Date.now() });
    const restartCtx = { ...parent, sessionManager: session, thinkingLevel: "high" as const };
    owner.coordinator?.dispose();
    owner.sessionCtx = restartCtx;
    owner.coordinator = new SpawnCoordinator(owner, owner.manager!);
    const result = await handleRestartLastAgents(owner, asCommandContext({ ...restartCtx }));
    expect(result.skipped).toEqual(["general-purpose: explicit missing (Model not found: test/old-model)"]);
    expect(
      spawn.mock.calls.map(([, , intent]) => [
        intent.prompt,
        intent.model?.id,
        intent.thinkingLevel,
        intent.runInBackground,
      ]),
    ).toEqual([
      ["explicit", chosenModel.id, "high", true],
      ["omitted", parentModel.id, "low", true],
      ["legacy", parentModel.id, "medium", true],
    ]);
  });
});
