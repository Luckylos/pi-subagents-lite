/**
 * spawn-coordinator.test.ts — Tests for SpawnCoordinator.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentRecord,
  RunNotificationBinding,
  SubagentParentReport,
  SubagentRunResult,
  SubagentRunStatus,
} from "../../src/types.js";
import { captureResultStats } from "../../src/agents/agent-result.js";
import type { AgentManager, SpawnOptions } from "../../src/agents/agent-manager.js";
import { asExtensionAPI, asExtensionContext } from "../pi-boundaries.js";
import type { ExtensionOwner } from "../../src/shell.js";
import { SpawnCoordinator as RealSpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";

/** Bind the real service to its owner, as session startup does. */
class SpawnCoordinator extends RealSpawnCoordinator {
  constructor(owner: ExtensionOwner, manager: AgentManager) {
    super(owner, manager);
    owner.coordinator = this;
  }
}

// --- Mock modules ---

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => ({ kind: "resolved", key: name })),
  getAgentConfig: vi.fn(() => undefined),
  discoverNewAgents: vi.fn(async () => 0),
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: vi.fn(async () => ({ ok: true, resolvedPath: "/wt", label: "wt" })),
}));

vi.mock("../../src/utils.js", () => ({
  parseModelKey: vi.fn(() => null),
  findModelInRegistry: vi.fn(() => undefined),
  parseThinkingChoice: vi.fn(() => undefined),
}));

// Hoist mock pi so shell mock can return it
const { mockPi, mockGetPiInstance, parentState } = vi.hoisted(() => ({
  parentState: { idle: true, sessionManager: { getSessionId: () => "parent", getEntries: () => [] } },
  mockPi: {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    exec: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
  },
  mockGetPiInstance: vi.fn<() => ExtensionAPI | null>(() => null),
}));
// ExtensionAPI-typed view of the mock for the call boundary; mockPi stays a
// raw Mock so tests can reach .mock calls and implementations.
const mockPiApi = asExtensionAPI(mockPi);

vi.mock("../../src/shell.js", async () =>
  (await import("../owner-fixtures.js")).ownerShellMock(
    await (() => ({
      getPiInstance: () => mockGetPiInstance(),
      getSessionCtx: () => ({
        isIdle: () => parentState.idle,
        sessionManager: parentState.sessionManager,
      }),
      getWidget: () => null,
    }))(),
  ),
);

function settledResult(record: AgentRecord, sequence: number): SubagentRunResult {
  const { id, lifecycle, display } = record;
  const status = lifecycle.status === "queued" || lifecycle.status === "running" ? "completed" : lifecycle.status;
  const completedAt = Date.now();
  return Object.freeze({
    runId: `${id}-run-${sequence}`,
    agentId: id,
    sequence,
    type: display.type,
    description: display.description,
    started: lifecycle.started,
    status,
    completedAt,
    elapsedMs: completedAt - lifecycle.startedAt,
    result: record.result,
    error: record.error,
    stoppedBy: lifecycle.stoppedBy,
    stopDetail: lifecycle.stopDetail,
    stats: captureResultStats(record),
  });
}

function makeMockManager(opts: { pendingGate?: boolean } = {}): AgentManager & MockManager {
  const records = new Map<string, AgentRecord>();
  // Capture forwarded spawn arguments (named fields, not positional indices) so
  // tests assert the coordinator's output to the manager without call indexing.
  const spawnCalls: SpawnCall[] = [];
  // Completion-gate resolvers for records whose gate the test holds open.
  const gateResolvers = new Map<string, (value: SubagentParentReport) => void>();
  return asAgentManager({
    spawn: vi.fn((pi: ExtensionAPI, ctx: ExtensionContext, type: string, prompt: string, options: SpawnOptions) => {
      const id = `agent-${records.size}`;
      spawnCalls.push({ id, pi, ctx, type, prompt, options });
      const record: AgentRecord = {
        id,
        display: { type, description: options.description },
        lifecycle: { status: "running", startedAt: Date.now(), started: true },
        execution: {},
        stats: {
          lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
          toolUses: 0,
          turnCount: 1,
          maxTurns: options.maxTurns,
          compactionCount: 0,
        },
        result: "done",
      };
      record.execution.promise = opts.pendingGate
        ? new Promise<SubagentParentReport>((resolve) => gateResolvers.set(id, resolve))
        : Promise.resolve(settledResult(record, 1));
      records.set(id, record);
      return id;
    }),
    getRecord: vi.fn((id: string) => records.get(id)),
    getCurrentRunId: (id: string) => (records.has(id) ? id + "-run-1" : undefined),
    mockSettlement(id: string, sequence = 1) {
      const record = records.get(id);
      const spawn = spawnCalls.find((call) => call.id === id);
      if (!record || !spawn) return undefined;
      const result = settledResult(record, sequence);
      const binding: RunNotificationBinding | undefined = spawn.options.notificationOwner && {
        ...spawn.options.notificationOwner,
        required: sequence > 1 || spawn.options.isBackground === true,
        spawnCtx: spawn.ctx,
      };
      return { result, binding };
    },
    getSpawnCalls: () => spawnCalls,
    getGateResolver: (id: string) => gateResolvers.get(id),
    dispose: async () => {
      records.clear();
    },
  });
}

/** A forwarded spawn call captured by the mock manager. */
interface SpawnCall {
  id: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: string;
  prompt: string;
  options: SpawnOptions;
}

/**
 * The AgentManager surface the coordinator drives (spawn/getRecord) plus the
 * call captures tests assert on. Required members that also exist on the real
 * AgentManager (spawn/getRecord/dispose) keep real param types; the captures
 * are test-only. asAgentManager intersects the mock with the real class so
 * the coordinator boundary accepts it with a single cast.
 */
interface MockManager {
  spawn: (pi: ExtensionAPI, ctx: ExtensionContext, type: string, prompt: string, options: SpawnOptions) => string;
  getRecord: (id: string) => AgentRecord | undefined;
  getSpawnCalls: () => SpawnCall[];
  getGateResolver: (id: string) => ((value: SubagentParentReport) => void) | undefined;
  mockSettlement: (
    id: string,
    sequence?: number,
  ) => { result: SubagentRunResult; binding?: RunNotificationBinding } | undefined;
  dispose: () => Promise<void>;
}

/** Assert the mock manager against the real AgentManager at a call boundary. */
function asAgentManager<S extends object>(mock: S): AgentManager & S {
  return mock as AgentManager & S;
}

function makeMockCtx() {
  return asExtensionContext({ cwd: "/test", sessionManager: parentState.sessionManager });
}

// --- Tests ---

describe("SpawnCoordinator", () => {
  let manager: ReturnType<typeof makeMockManager>;
  let ctx: ExtensionContext;

  function complete(coordinator: InstanceType<typeof SpawnCoordinator>, id: string, sequence = 1): void {
    const settlement = manager.mockSettlement(id, sequence);
    if (settlement) coordinator.onAgentComplete(settlement.result, settlement.binding);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    manager = makeMockManager();
    ctx = makeMockCtx();
    mockPi.sendMessage.mockReset(); // full reset — no impl or calls leak between tests
    mockGetPiInstance.mockReturnValue(mockPiApi);
    owner = await createTestOwner();
  });

  it("spawns a background agent and returns result", async () => {
    const coordinator = new SpawnCoordinator(owner, manager);
    const result = await coordinator.spawn(mockPiApi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test spawn",
      graceTurns: 6,
      runInBackground: true,
    });

    expect(result.agentId).toBeTruthy();
    // Args forwarded to the spawn manager are the coordinator's observable output.
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const spawn = manager.getSpawnCalls()[0];
    expect(spawn.type).toBe("builder");
    expect(spawn.prompt).toBe("do something");
    expect(spawn.options.isBackground).toBe(true);
  });

  it("spawns a foreground agent and awaits its promise", async () => {
    const coordinator = new SpawnCoordinator(owner, manager);
    const result = await coordinator.spawn(mockPiApi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test foreground",
      graceTurns: 6,
      runInBackground: false,
    });

    expect(result.agentId).toBeTruthy();
    expect(result.record).toBeTruthy();
    expect(manager.getSpawnCalls()[0].options.isBackground).toBe(false);
  });

  it.each([true, false])(
    "binds the parent scope and initial run mode before spawning (background=%s)",
    async (background) => {
      const coordinator = new SpawnCoordinator(owner, manager);
      await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test",
        graceTurns: 6,
        runInBackground: background,
      });

      expect(manager.getSpawnCalls()[0].options).toMatchObject({
        isBackground: background,
        notificationOwner: { ownerGeneration: owner.generation, parentSessionId: "parent" },
      });
    },
  );

  describe("nudge scheduling", () => {
    it("emits individual nudge after delay window", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      complete(coordinator, result.agentId);

      expect(mockPi.sendMessage).not.toHaveBeenCalled();

      // Advance past the 200ms batch window
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("batches multiple nudges within the delay window", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const r1 = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task 1",
        description: "Test 1",
        graceTurns: 6,
        runInBackground: true,
      });
      const r2 = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task 2",
        description: "Test 2",
        graceTurns: 6,
        runInBackground: true,
      });

      complete(coordinator, r1.agentId);
      complete(coordinator, r2.agentId);

      // Advance past the batch window
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("does not emit nudge for agent without record", () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      // agent-999 doesn't exist in the mock manager
      complete(coordinator, "agent-999");

      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("starts new batch window for nudges arriving after the previous window", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const r1 = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task 1",
        description: "Test 1",
        graceTurns: 6,
        runInBackground: true,
      });
      const r2 = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task 2",
        description: "Test 2",
        graceTurns: 6,
        runInBackground: true,
      });

      complete(coordinator, r1.agentId);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      complete(coordinator, r2.agentId);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("nudge content", () => {
    it("includes the recorded error message when the background agent failed", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      result.record.lifecycle.status = "error";
      result.record.error = "model failed to load";

      complete(coordinator, result.agentId);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      // The nudge message we send the user IS the observable outcome.
      const content = mockPi.sendMessage.mock.calls[0][0].content as string;
      // Header (status) and result content still present; error text appended
      expect(content).toBe('[Subagent "builder" agent-0 error]\n\ndone\n\nError: model failed to load');
    });

    it("keeps the nudge unchanged for non-error completions", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      result.record.lifecycle.status = "completed";

      complete(coordinator, result.agentId);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      // The nudge message we send the user IS the observable outcome.
      const content = mockPi.sendMessage.mock.calls[0][0].content as string;
      expect(content).toBe('[Subagent "builder" agent-0 completed]\n\ndone');
    });
  });

  describe("onAgentComplete", () => {
    it("schedules nudge for background agents", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      complete(coordinator, result.agentId);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      expect(manager.getSpawnCalls()[0].options.isBackground).toBe(true);
    });

    it("does not schedule nudge for foreground agents", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      complete(coordinator, result.agentId);
      expect(coordinator.getCompletionNotification(`${result.agentId}-run-1`)).toMatchObject({
        status: "not-required",
        canRetry: false,
      });

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("nudges on every continuation settlement of a background agent", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // The first background run nudges once.
      complete(coordinator, result.agentId);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      // Each continuation settlement nudges again.
      complete(coordinator, result.agentId, 2);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);

      complete(coordinator, result.agentId, 3);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(3);
    });

    it("schedules a nudge for a continued foreground agent", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      complete(coordinator, result.agentId, 2);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("does not nudge a foreground agent's initial completion", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      complete(coordinator, result.agentId);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("delivers no nudge for a never-started foreground stop", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      // Never-started stops notify directly without incrementing the counter.
      result.record.lifecycle.status = "stopped";
      result.record.lifecycle.started = false;
      complete(coordinator, result.agentId);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("keeps the never-started background stop nudge unchanged", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // The first run still nudges when stopped before starting.
      result.record.lifecycle.status = "stopped";
      result.record.lifecycle.started = false;
      complete(coordinator, result.agentId);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("never emits more than one nudge for repeated callbacks for the same run", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      const { result: settled, binding } = manager.mockSettlement(result.agentId)!;
      coordinator.onAgentComplete(settled, binding);
      coordinator.onAgentComplete(settled, binding);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("keeps a continued foreground agent reporting as foreground", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      complete(coordinator, result.agentId, 2);
      vi.advanceTimersByTime(200);

      expect(manager.getSpawnCalls()[0].options.isBackground).toBe(false);
    });

    it("catches sendMessage errors silently (stale pi)", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // Make sendMessage throw (simulates stale pi)
      mockPi.sendMessage.mockImplementation(() => {
        throw new Error("stale context");
      });

      complete(coordinator, result.agentId);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("skips nudge emission when disposed", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      complete(coordinator, result.agentId);

      // Dispose before timer fires — should prevent emission
      coordinator.dispose();

      vi.advanceTimersByTime(500);

      // No sendMessage because disposed
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("ui.notify fallback for continuation nudges", () => {
    it("falls back to ui.notify for a continued foreground agent when sendMessage fails", async () => {
      const notify = vi.fn();
      const ctxWithUi = asExtensionContext({ ...makeMockCtx(), ui: { notify } });
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctxWithUi, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      // sendMessage fails — the spawning ctx must still be reachable.
      mockPi.sendMessage.mockImplementation(() => {
        throw new Error("stale context");
      });

      complete(coordinator, result.agentId, 2);
      vi.advanceTimersByTime(200);

      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("does not fall back to ui.notify for a foreground agent's initial completion", async () => {
      const notify = vi.fn();
      const ctxWithUi = asExtensionContext({ ...makeMockCtx(), ui: { notify } });
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctxWithUi, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      mockPi.sendMessage.mockImplementation(() => {
        throw new Error("stale context");
      });

      // Initial completion delivers inline — no nudge, no fallback.
      complete(coordinator, result.agentId);
      vi.advanceTimersByTime(200);

      expect(notify).not.toHaveBeenCalled();
    });

    it("keeps the spawning ctx across a background agent's first nudge for the continuation fallback", async () => {
      const notify = vi.fn();
      const ctxWithUi = asExtensionContext({ ...makeMockCtx(), ui: { notify } });
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctxWithUi, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // First settlement: sendMessage works, notify untouched.
      complete(coordinator, result.agentId);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();

      // Continuation settlement: sendMessage fails, fallback still has the ctx.
      mockPi.sendMessage.mockImplementation(() => {
        throw new Error("stale context");
      });
      complete(coordinator, result.agentId, 2);
      vi.advanceTimersByTime(200);
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe("dispose", () => {
    it("clears nudge timer", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      complete(coordinator, result.agentId);

      coordinator.dispose();

      // Timer should be cleared — advancing time should not emit
      vi.advanceTimersByTime(500);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("stale pi protection", () => {
    it("uses the owner API captured at construction, independent of the spawn API", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const otherPi = asExtensionAPI({ sendMessage: vi.fn() });
      const result = await coordinator.spawn(otherPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      complete(coordinator, result.agentId);
      vi.advanceTimersByTime(200);
      expect(otherPi.sendMessage).not.toHaveBeenCalled();
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("keeps its own API when another fixture API changes before the nudge", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);

      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // Simulate shell being updated (e.g. after reload)
      const freshPi = asExtensionAPI({ ...mockPi, sendMessage: vi.fn() });
      mockGetPiInstance.mockReturnValue(freshPi);

      complete(coordinator, result.agentId);
      vi.advanceTimersByTime(200);

      expect(freshPi.sendMessage).not.toHaveBeenCalled();
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("keeps its own API when an unbound fixture has no API", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      const notify = vi.fn();
      const ctxWithUi = asExtensionContext({ ...makeMockCtx(), ui: { notify } });

      const result = await coordinator.spawn(mockPiApi, ctxWithUi, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // Simulate shell having no pi at nudge time
      mockGetPiInstance.mockReturnValue(null);

      complete(coordinator, result.agentId);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("nudge message status", () => {
    it("uses lifecycle status in the nudge message", async () => {
      const statuses: Array<{ status: SubagentRunStatus; expected: string }> = [
        { status: "completed", expected: "completed" },
        { status: "error", expected: "error" },
        { status: "aborted", expected: "aborted" },
        { status: "stopped", expected: "stopped" },
        { status: "turn_limited", expected: "turn_limited" },
      ];

      for (const { status, expected } of statuses) {
        mockPi.sendMessage.mockClear();
        const coordinator = new SpawnCoordinator(owner, manager);

        const result = await coordinator.spawn(mockPiApi, ctx, {
          type: "builder",
          prompt: "task",
          description: "Test",
          graceTurns: 6,
          runInBackground: true,
        });

        manager.getRecord(result.agentId)!.lifecycle.status = status;
        manager.getRecord(result.agentId)!.result = "Result text";

        complete(coordinator, result.agentId);
        vi.advanceTimersByTime(200);

        expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
        // The nudge message header mirrors the lifecycle status — the message IS the outcome.
        const content = mockPi.sendMessage.mock.calls[0][0].content;
        const shortId = result.agentId.slice(0, 8);
        expect(content).toContain(`[Subagent "builder" ${shortId} ${expected}]`);
      }
    });
  });

  describe("completion gate — foreground wait", () => {
    it("blocks a foreground spawn until the completion gate opens", async () => {
      const manager = makeMockManager({ pendingGate: true });
      const coordinator = new SpawnCoordinator(owner, manager);
      let settled = false;
      const spawnPromise = coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test fg",
        graceTurns: 6,
        runInBackground: false,
      });
      void spawnPromise.then(() => {
        settled = true;
      });

      // Gate still closed — the foreground call must stay suspended.
      await Promise.resolve();
      expect(settled).toBe(false);

      const id = manager.getSpawnCalls()[0].id;
      const { result: terminal } = manager.mockSettlement(id)!;
      manager.getGateResolver(id)!(terminal);
      const result = await spawnPromise;

      expect(result.agentId).toBe(id);
      expect(result.foregroundReport).toBe(terminal);
      expect(settled).toBe(true);
    });

    it("returns immediately for background spawns regardless of the gate", async () => {
      const manager = makeMockManager({ pendingGate: true });
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test bg",
        graceTurns: 6,
        runInBackground: true,
      });

      expect(result.agentId).toBeTruthy();
    });

    it("carries the parent signal through to the manager spawn options", async () => {
      const controller = new AbortController();
      const coordinator = new SpawnCoordinator(owner, manager);
      await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test fg",
        graceTurns: 6,
        runInBackground: false,
        signal: controller.signal,
      });

      expect(manager.getSpawnCalls()[0].options.signal).toBe(controller.signal);
    });
  });

  describe("nudge content — queued background stop", () => {
    it("delivers exactly one Stopped nudge carrying the never-started note", async () => {
      const coordinator = new SpawnCoordinator(owner, manager);
      const result = await coordinator.spawn(mockPiApi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      const record = manager.getRecord(result.agentId)!;
      record.lifecycle.status = "stopped";
      record.lifecycle.started = false;
      record.result = undefined;

      complete(coordinator, result.agentId);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      const content = mockPi.sendMessage.mock.calls[0][0].content as string;
      expect(content).toContain("stopped");
      expect(content).toContain("before the agent started");
      expect(content).not.toContain("output is partial");
    });
  });
});

describe("SpawnCoordinator parent messages", () => {
  let manager: ReturnType<typeof makeMockManager>;
  let ctx: ExtensionContext;

  beforeEach(async () => {
    vi.useFakeTimers();
    manager = makeMockManager();
    ctx = makeMockCtx();
    mockPi.sendMessage.mockReset();
    mockGetPiInstance.mockReturnValue(mockPiApi);
    parentState.idle = true;
    owner = await createTestOwner();
  });

  async function spawnWith(coordinator: InstanceType<typeof SpawnCoordinator>, runInBackground: boolean) {
    const result = await coordinator.spawn(mockPiApi, ctx, {
      type: "builder",
      prompt: "work",
      description: "Investigate",
      graceTurns: 6,
      runInBackground,
    });
    const options = manager.getSpawnCalls().at(-1)!.options;
    return { ...result, options };
  }

  const toolOf = (options: SpawnOptions) => options.customTools?.find((t) => t.name === "MessageParent");
  const send = (options: SpawnOptions, message: string) =>
    toolOf(options)!.execute("call", { message }, undefined, undefined, undefined as never);

  it("binds MessageParent only for a background spawn with parent messages on", async () => {
    const coordinator = new SpawnCoordinator(owner, manager);
    expect(toolOf((await spawnWith(coordinator, true)).options)).toBeDefined();
    expect((await spawnWith(coordinator, false)).options.customTools).toBeUndefined();

    const store = owner.store!;
    vi.spyOn(store, "agent", "get").mockReturnValue({ ...store.agent, parentMessages: false });
    expect((await spawnWith(coordinator, true)).options.customTools).toBeUndefined();
  });

  it("delivers immediately to an idle parent as a triggering follow-up", async () => {
    const coordinator = new SpawnCoordinator(owner, manager);
    const { agentId, options } = await spawnWith(coordinator, true);

    await send(options, " blocked on credentials ");

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      {
        customType: "subagent-message",
        content: `[Subagent "builder" ${agentId.slice(0, 8)} message]\n\nblocked on credentials`,
        display: true,
        details: { agentId, type: "builder", description: "Investigate" },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  it("steers a running parent", async () => {
    const coordinator = new SpawnCoordinator(owner, manager);
    const { options } = await spawnWith(coordinator, true);
    parentState.idle = false;

    await send(options, "heads up");

    expect(mockPi.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("reports not delivered after dispose, for a removed record, or when sending throws", async () => {
    const notify = vi.fn();
    ctx = asExtensionContext({ ...makeMockCtx(), ui: { notify } });

    const disposed = new SpawnCoordinator(owner, manager);
    const a = await spawnWith(disposed, true);
    disposed.dispose();
    await expect(send(a.options, "x")).rejects.toThrow("Not delivered");

    const live = new SpawnCoordinator(owner, manager);
    const b = await spawnWith(live, true);
    mockPi.sendMessage.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(send(b.options, "x")).rejects.toThrow("Not delivered");
    expect(notify).not.toHaveBeenCalled();

    mockPi.sendMessage.mockReset();
    await manager.dispose();
    await expect(send(b.options, "x")).rejects.toThrow("Not delivered");
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });

  it("submits each run's Parent message before its completion notification", async () => {
    const coordinator = new SpawnCoordinator(owner, manager);
    const { agentId, record, options } = await spawnWith(coordinator, true);
    for (const sequence of [1, 2]) {
      await send(options, `progress ${sequence}`);
      record.result = `result ${sequence}`;
      const { result, binding } = manager.mockSettlement(agentId, sequence)!;
      coordinator.onAgentComplete(result, binding);
      vi.advanceTimersByTime(200);
    }
    expect(
      mockPi.sendMessage.mock.calls.map(([message]) => [message.customType, message.content.split("\n\n")[1]]),
    ).toEqual([
      ["subagent-message", "progress 1"],
      ["subagent-result", "result 1"],
      ["subagent-message", "progress 2"],
      ["subagent-result", "result 2"],
    ]);
  });
});

import { createTestOwner } from "../owner-fixtures.js";
let owner = await createTestOwner();
