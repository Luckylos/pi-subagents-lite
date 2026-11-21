/**
 * restart-last-agents-thinking.test.ts — Thinking resolution on the replay path.
 *
 * Seam: handleRestartLastAgents → resolveAndSpawn → coordinator.spawn intent.
 * A replayed run resolves a `parent` value against its own parent session, so a
 * level frozen into the historical tool call never pins the replay, and the
 * `parent` value itself never reaches the spawn intent or invocation record.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { ExtensionCommandContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { JsonObject, ToolCall } from "@earendil-works/pi-ai";
import { fakeCtx, shellMock } from "../fixtures.js";
import { asCommandContext } from "../pi-boundaries.js";
import { defaultModel } from "../mock-utils.js";
import type { AgentRecord, ThinkingChoice, ThinkingLevel } from "../../src/types.js";
import type { SpawnIntent, SpawnResult } from "../../src/spawn/spawn-coordinator.js";
import type { AgentConfig } from "../../src/agents/types.js";
import type { TypeResolution } from "../../src/agents/agent-types.js";

const { mockCoordinatorSpawn, mockGetAgentConfig, storeState } = vi.hoisted(() => ({
  mockCoordinatorSpawn: vi.fn<(pi: unknown, ctx: unknown, intent: SpawnIntent) => Promise<SpawnResult>>(async () => ({
    agentId: "agent-id-1",
    record: fakeRecord(),
  })),
  mockGetAgentConfig: vi.fn<() => AgentConfig | undefined>(() => ({
    name: "general-purpose",
    description: "Test agent",
    systemPrompt: "test prompt",
    maxTurns: 25,
  })),
  storeState: { defaultThinking: undefined as ThinkingChoice | undefined, defaultMaxTurns: 25 },
}));

function fakeRecord(): AgentRecord {
  return {
    id: "agent-id-1",
    display: { type: "general-purpose", description: "Do it" },
    lifecycle: { status: "running", startedAt: Date.now(), started: false },
    execution: {},
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      toolUses: 0,
      compactionCount: 0,
    },
  };
}

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveTypeOrDiscover: vi.fn(async (type: string): Promise<TypeResolution> => ({ kind: "resolved", key: type })),
  getAgentConfig: mockGetAgentConfig,
  resolveType: vi.fn((type: string) => ({ kind: "resolved", key: type })),
  discoverNewAgents: vi.fn(async () => 0),
}));

vi.mock("../../src/shell.js", async () =>
  (await import("../owner-fixtures.js")).ownerShellMock(
    await (() =>
      shellMock({
        coordinator: { spawn: mockCoordinatorSpawn, isCurrentParent: () => true, assertCurrentParent: vi.fn() },
        store: {
          get agent() {
            return {
              graceTurns: 6,
              forceBackground: false,
              defaultMaxTurns: storeState.defaultMaxTurns,
              defaultThinking: storeState.defaultThinking,
            };
          },
          modelFor: () => "",
        },
      }))(),
  ),
);

import { handleRestartLastAgents } from "../../src/agents/restart-last-agents.js";

function agentConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    name: "general-purpose",
    description: "Test agent",
    systemPrompt: "test prompt",
    maxTurns: 25,
    ...overrides,
  };
}

/** A session history holding one Agent tool call with the given arguments. */
function historyWithCall(args: JsonObject, parentLevel?: ThinkingLevel): ExtensionCommandContext {
  const entry = {
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-1", name: "Agent", arguments: args } satisfies ToolCall & { type: "toolCall" },
      ],
    },
  } as SessionMessageEntry;
  const ctx = asCommandContext(fakeCtx({ model: { ...defaultModel()!, reasoning: true }, thinkingLevel: parentLevel }));
  vi.mocked(ctx.sessionManager.getEntries).mockReturnValue([entry]);
  return ctx;
}

function lastSpawnIntent(): SpawnIntent {
  return mockCoordinatorSpawn.mock.calls[0][2];
}

beforeEach(() => {
  vi.clearAllMocks();
  storeState.defaultThinking = undefined;
  storeState.defaultMaxTurns = 25;
  mockGetAgentConfig.mockReturnValue(agentConfig({}));
});

describe("restart — thinking resolution", () => {
  it("replays a frontmatter `parent` at the replay session's own parent level", async () => {
    mockGetAgentConfig.mockReturnValue(agentConfig({ thinkingLevel: "parent" }));

    await handleRestartLastAgents(owner, historyWithCall({ prompt: "Do it" }, "minimal"));

    expect(lastSpawnIntent().thinkingLevel).toBe("minimal");
    expect(lastSpawnIntent().invocation?.thinkingLevel).toBe("minimal");
  });

  it("spawns with nothing rather than the `parent` value when no parent level is available", async () => {
    mockGetAgentConfig.mockReturnValue(agentConfig({ thinkingLevel: "parent" }));

    await handleRestartLastAgents(owner, historyWithCall({ prompt: "Do it" }));

    expect(lastSpawnIntent().thinkingLevel).toBeUndefined();
    expect(lastSpawnIntent().invocation?.thinkingLevel).toBeUndefined();
  });

  it("keeps the level of a historical explicit thinking param", async () => {
    mockGetAgentConfig.mockReturnValue(agentConfig({ thinkingLevel: "low" }));

    await handleRestartLastAgents(owner, historyWithCall({ prompt: "Do it", thinking: "high" }, "minimal"));

    expect(lastSpawnIntent().thinkingLevel).toBe("high");
  });

  it("resolves a configured `parent` against the current parent on restart", async () => {
    storeState.defaultThinking = "parent";

    await handleRestartLastAgents(owner, historyWithCall({ prompt: "Do it" }, "minimal"));

    expect(lastSpawnIntent().thinkingLevel).toBe("minimal");
    expect(lastSpawnIntent().invocation?.thinkingLevel).toBe("minimal");
  });
});

describe("restart — historical max turns", () => {
  it.each([
    [undefined, undefined, 40],
    [null, 12, 12],
    [undefined, 0, 0],
    [0, 12, 0],
    [5, 12, 5],
  ])("replays max_turns=%s with frontmatter maxTurns=%s as %s", async (savedTurns, frontmatter, expected) => {
    const args = { prompt: "Do it", ...(savedTurns === undefined ? {} : { max_turns: savedTurns }) };
    const ctx = historyWithCall(args);
    mockGetAgentConfig.mockReturnValue(agentConfig({ maxTurns: frontmatter, maxTokens: 400 }));
    storeState.defaultMaxTurns = 40;

    expect(await handleRestartLastAgents(owner, ctx)).toEqual({ restarted: ["general-purpose: Do it"], skipped: [] });
    expect(lastSpawnIntent()).toMatchObject({ maxTurns: expected, maxTokens: 400 });
    expect(lastSpawnIntent().invocation?.maxTurns).toBe(expected || undefined);
  });
});

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
