import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SpawnIntent, SpawnResult } from "../../src/spawn/spawn-coordinator.js";
import type { AgentConfig } from "../../src/agents/types.js";
import type { ThinkingLevel, ThinkingChoice } from "../../src/types.js";
import type { WorktreeValidationResult } from "../../src/spawn/worktree-validator.js";
import { fakeCtx, makeAgentRecord, shellMock } from "../fixtures.js";
import { defaultModel } from "../mock-utils.js";
import { createTestOwner } from "../owner-fixtures.js";
import { captureResultStats } from "../../src/agents/agent-result.js";
import { executeAgentTool } from "../../src/agents/tool-execution.js";

const { state, getAgentConfig, spawn, validateWorktreePath, resolveSubagentTrust, readThinking } = vi.hoisted(() => ({
  state: { defaultThinking: undefined as ThinkingChoice | undefined, defaultMaxTurns: undefined as number | undefined },
  getAgentConfig: vi.fn<() => AgentConfig>(),
  spawn: vi.fn<(_pi: unknown, _ctx: unknown, intent: SpawnIntent) => Promise<SpawnResult>>(),
  validateWorktreePath: vi.fn<() => Promise<WorktreeValidationResult>>(),
  resolveSubagentTrust: vi.fn<() => boolean>(),
  readThinking: vi.fn<(cwd: string, scope?: { projectTrusted?: boolean }) => Record<string, ThinkingLevel>>(),
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveTypeOrDiscover: vi.fn(async (key: string) => ({ kind: "resolved", key })),
  getAgentConfig,
}));
vi.mock("../../src/spawn/worktree-validator.js", () => ({ validateWorktreePath }));
vi.mock("../../src/spawn/project-trust.js", () => ({
  resolveSubagentTrust,
  createSubagentTrustDeps: vi.fn(),
  untrustedProjectWarning: (cwd: string) => `untrusted: ${cwd}`,
}));
vi.mock("../../src/pi-settings.js", () => ({ getPiModelThinkingLevels: readThinking }));
vi.mock("../../src/shell.js", async () =>
  (await import("../owner-fixtures.js")).ownerShellMock(
    shellMock({
      coordinator: { spawn, assertCurrentParent: vi.fn() },
      store: {
        get agent() {
          return { ...state, graceTurns: 5 };
        },
        modelFor: () => "",
      },
    }),
  ),
);

const owner = await createTestOwner();
const agent: AgentConfig = { name: "general-purpose", description: "Agent", systemPrompt: "" };
const model = { ...defaultModel()!, reasoning: true, thinkingLevelMap: { max: "max" } };
const modelKey = `${model.provider}/${model.id}`;

beforeEach(() => {
  vi.clearAllMocks();
  getAgentConfig.mockReturnValue(agent);
  const record = makeAgentRecord();
  spawn.mockResolvedValue({
    agentId: record.id,
    record,
    foregroundReport: {
      ...record.display,
      agentId: record.id,
      runId: "initial-run",
      sequence: 1,
      status: "completed",
      started: true,
      completedAt: Date.now(),
      elapsedMs: 0,
      stats: captureResultStats(record),
    },
  });
  readThinking.mockReturnValue({});
  resolveSubagentTrust.mockReturnValue(true);
  validateWorktreePath.mockResolvedValue({ ok: true, resolvedPath: "/resolved", sameRepo: false });
  state.defaultThinking = undefined;
  state.defaultMaxTurns = undefined;
});

async function execute(params: Record<string, unknown> = {}, thinkingLevel?: ThinkingLevel) {
  const input = { prompt: "do it", ...params };
  await executeAgentTool(owner, "call", input, undefined, undefined, fakeCtx({ model, thinkingLevel }));
  expect(input).toEqual({ prompt: "do it", ...params });
  return spawn.mock.calls[0][2];
}

describe("executeAgentTool — Thinking precedence and trust", () => {
  it.each([
    [undefined, undefined, undefined, "max", undefined, "max"],
    [undefined, undefined, "high", "max", undefined, "high"],
    [undefined, "low", "high", "max", undefined, "low"],
    ["medium", "low", "high", "max", undefined, "medium"],
    ["parent", "low", "high", "max", "medium", "medium"],
    [undefined, "parent", "high", "max", "minimal", "minimal"],
    [undefined, "parent", "high", "max", undefined, "high"],
    [undefined, undefined, undefined, "parent", "low", "low"],
    [undefined, "parent", undefined, undefined, undefined, undefined],
    [undefined, undefined, undefined, undefined, undefined, undefined],
  ] as const)(
    "resolves explicit=%s frontmatter=%s Pi=%s default=%s parent=%s to %s",
    async (explicit, frontmatter, perModel, defaultThinking, parent, expected) => {
      state.defaultThinking = defaultThinking;
      getAgentConfig.mockReturnValue({ ...agent, thinkingLevel: frontmatter });
      if (perModel) readThinking.mockReturnValue({ [modelKey]: perModel });
      const intent = await execute(explicit ? { thinking: explicit } : {}, parent);
      expect(intent.thinkingLevel).toBe(expected);
      expect(intent.invocation?.thinkingLevel).toBe(expected);
    },
  );

  it.each([
    [true, "max"],
    [false, "high"],
  ] as const)("reads validated target settings with trust=%s", async (trusted, expected) => {
    resolveSubagentTrust.mockReturnValue(trusted);
    state.defaultThinking = "parent";
    readThinking.mockImplementation((_cwd, scope) => ({ [modelKey]: scope?.projectTrusted ? "max" : "high" }));
    expect((await execute({ worktree_path: "/raw" }, "minimal")).thinkingLevel).toBe(expected);
    expect(readThinking).toHaveBeenCalledWith("/resolved", { projectTrusted: trusted });
  });

  it("uses the subagent default if the untrusted target is the only per-model source", async () => {
    resolveSubagentTrust.mockReturnValue(false);
    state.defaultThinking = "medium";
    readThinking.mockImplementation((_cwd, scope) => (scope?.projectTrusted ? { [modelKey]: "max" } : {}));
    expect((await execute({ worktree_path: "/raw" })).thinkingLevel).toBe("medium");
  });

  it("does not read Thinking if the target fails validation", async () => {
    validateWorktreePath.mockResolvedValue({ ok: false, error: "worktree_path does not exist" });
    await expect(execute({ worktree_path: "/missing" })).rejects.toThrow("worktree_path does not exist");
    expect(readThinking).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("executeAgentTool — max turns precedence", () => {
  it.each([
    [undefined, undefined, 50, 50],
    [10, 20, 50, 10],
    [undefined, 30, 50, 30],
    [0, 30, 50, 0],
    [undefined, 0, 50, 0],
    [null, undefined, 50, 50],
    [undefined, undefined, 0, 0],
    [undefined, undefined, undefined, undefined],
  ])("resolves explicit=%s frontmatter=%s default=%s to %s", async (explicit, frontmatter, configured, expected) => {
    state.defaultMaxTurns = configured;
    getAgentConfig.mockReturnValue({ ...agent, maxTurns: frontmatter, maxTokens: 400 });
    const intent = await execute({ max_turns: explicit });
    expect(intent.maxTurns).toBe(expected);
    expect(intent.invocation?.maxTurns).toBe(expected || undefined);
    expect(intent.maxTokens).toBe(400);
  });
});
