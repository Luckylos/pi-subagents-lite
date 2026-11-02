import { parent, emit, services, spawn, finishedRun } from "./instance-fixtures.js";
import { describe, expect, it, vi } from "vite-plus/test";
import { fakeCtx } from "./fixtures.js";
import { asExtensionAPI } from "./pi-boundaries.js";
import { scanAgentFilesInDir, type AgentConfigFromMd } from "../src/agents/agent-discovery.js";
import { runAgent, type RunResult } from "../src/agents/agent-runner.js";
import { createConfigIO } from "../src/config/config-io.js";
import { registerAgentInvalidation, invalidateAgentRow } from "../src/ui/renderer.js";
import { getDisplayName, agentColoredText } from "../src/ui/format.js";
import { executeAgentTool } from "../src/agents/tool-execution.js";

function discovered(name: string): AgentConfigFromMd[] {
  return [{ name, display_name: name, description: name, source: "project" }];
}

describe("factory instance isolation", () => {
  it("gives started parents independent managers and session config", async () => {
    const a = parent();
    await emit(a, "session_start");
    const servicesA = services(a);
    servicesA.store.mutate.session.setShowCost(true);

    const b = parent();
    await emit(b, "session_start");
    const servicesB = services(b);

    expect(servicesB.manager).not.toBe(servicesA.manager);
    expect(servicesB.coordinator).not.toBe(servicesA.coordinator);
    expect(servicesB.store).not.toBe(servicesA.store);
    expect(servicesB.widget).not.toBe(servicesA.widget);
    expect(servicesA.store.agent.showCost).toBe(true);
    expect(servicesB.store.agent.showCost).toBe(false);
  });

  it("delivers A's real coordinator timer only through A after B starts", async () => {
    const a = parent();
    const ctxA = await emit(a, "session_start", fakeCtx({ hasUI: false, isIdle: () => true }));
    await spawn(a, ctxA);
    const b = parent();
    await emit(b, "session_start", fakeCtx({ hasUI: false, isIdle: () => false }));
    await vi.advanceTimersByTimeAsync(200);

    expect(a.api.api.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ customType: "subagent-result", content: expect.stringContaining("A finished work") }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(b.api.api.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps an unstarted factory and its turn/shutdown callbacks free of session resources", async () => {
    const a = parent();
    await emit(a, "session_start");
    const initial = services(a);
    const timers = vi.getTimerCount();
    const scans = vi.mocked(scanAgentFilesInDir).mock.calls.length;
    const configIOs = vi.mocked(createConfigIO).mock.calls.length;
    const b = parent();
    await emit(b, "turn_start");
    await emit(b, "session_shutdown");

    expect(b.owner.manager).toBeNull();
    expect(b.owner.coordinator).toBeNull();
    expect(b.owner.widget).toBeNull();
    expect(b.owner.store).toBeNull();
    expect(b.owner.registry.getAllTypes()).toEqual([]);
    expect(vi.mocked(scanAgentFilesInDir).mock.calls).toHaveLength(scans);
    expect(vi.mocked(createConfigIO).mock.calls).toHaveLength(configIOs);
    expect(vi.getTimerCount()).toBe(timers);
    expect(services(a)).toEqual(initial);
  });

  it("keeps scan directories, display names, colors and equal-ID invalidations with their owner", async () => {
    vi.mocked(scanAgentFilesInDir).mockImplementation(async (dir) =>
      dir === "/a/.pi/agents" ? discovered("A-only") : dir === "/b/.pi/agents" ? discovered("B-only") : [],
    );
    const a = parent();
    const b = parent();
    await emit(a, "session_start", fakeCtx({ cwd: "/a", hasUI: false }));
    await emit(b, "session_start", fakeCtx({ cwd: "/b", hasUI: false }));
    expect(a.owner.registry.getAgentConfig("A-only")?.name).toBe("A-only");
    expect(a.owner.registry.getAgentConfig("B-only")).toBeUndefined();
    expect(b.owner.registry.getAgentConfig("B-only")?.name).toBe("B-only");
    expect(b.owner.registry.getAgentConfig("A-only")).toBeUndefined();
    a.owner.registry.registerAgents(
      new Map([["same", { name: "same", displayName: "A name", description: "", systemPrompt: "", color: "red" }]]),
    );
    b.owner.registry.registerAgents(
      new Map([["same", { name: "same", displayName: "B name", description: "", systemPrompt: "", color: "blue" }]]),
    );
    expect(getDisplayName(a.owner, "same")).toBe("A name");
    expect(getDisplayName(b.owner, "same")).toBe("B name");
    expect(agentColoredText(a.owner, "text", "same")).toBe("\u001b[38;2;220;38;38mtext\u001b[39m");
    expect(agentColoredText(b.owner, "text", "same")).toBe("\u001b[38;2;106;155;204mtext\u001b[39m");
    const renderA = vi.fn();
    const renderB = vi.fn();
    registerAgentInvalidation(a.owner, "same-id", renderA);
    registerAgentInvalidation(b.owner, "same-id", renderB);
    invalidateAgentRow(a.owner, "same-id");
    expect(renderA).toHaveBeenCalledTimes(1);
    expect(renderB).not.toHaveBeenCalled();
    await emit(a, "session_shutdown");
    invalidateAgentRow(b.owner, "same-id");
    expect(renderB).toHaveBeenCalledTimes(1);
    vi.mocked(scanAgentFilesInDir).mockClear();
    await b.owner.registry.discoverNewAgents();
    expect(vi.mocked(scanAgentFilesInDir).mock.calls.map(([dir]) => dir)).toEqual([
      "/test/instance-isolation/agent/agents",
      "/b/.agents/agents",
      "/b/.pi/agents",
    ]);
  });

  it("unregisters only A's terminal listener on new and shutdown", async () => {
    const a = parent();
    const b = parent();
    const offA = vi.fn();
    const offB = vi.fn();
    const inputA = vi.fn(() => offA);
    const inputB = vi.fn(() => offB);
    const ctxA = fakeCtx({ ui: { onTerminalInput: inputA } });
    const ctxB = fakeCtx({ ui: { onTerminalInput: inputB } });
    await emit(a, "session_start", ctxA);
    await emit(b, "session_start", ctxB);
    const managerB = services(b).manager;
    await emit(a, "session_start", ctxA);
    expect(offA).toHaveBeenCalledTimes(1);
    expect(offB).not.toHaveBeenCalled();
    expect(inputA).toHaveBeenCalledTimes(2);
    await emit(a, "session_shutdown", ctxA);
    expect(offA).toHaveBeenCalledTimes(2);
    expect(offB).not.toHaveBeenCalled();
    expect(services(b).manager).toBe(managerB);
    await spawn(b, ctxB);
    await vi.advanceTimersByTimeAsync(200);
    expect(b.api.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(a.api.api.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["shutdown", "new"] as const)("rejects a late A1 scan after %s and A2 startup", async (replacement) => {
    const a = parent();
    const b = parent();
    await emit(b, "session_start");
    let release!: (agents: AgentConfigFromMd[]) => void;
    const pending = new Promise<AgentConfigFromMd[]>((resolve) => {
      release = resolve;
    });
    vi.mocked(scanAgentFilesInDir).mockImplementation(async (dir) => {
      if (dir === "/a1/.pi/agents") return pending;
      return dir === "/a2/.pi/agents" ? discovered("A2-only") : [];
    });
    const offA1 = vi.fn();
    const inputA1 = vi.fn(() => offA1);
    const startingA1 = emit(a, "session_start", fakeCtx({ cwd: "/a1", ui: { onTerminalInput: inputA1 } }));
    await Promise.resolve();
    await Promise.resolve();
    if (replacement === "shutdown") await emit(a, "session_shutdown");
    await emit(a, "session_start", fakeCtx({ cwd: "/a2", hasUI: false }));
    const a2 = services(a);
    a2.store.mutate.session.setShowCost(true);
    release(discovered("A1-late"));
    await startingA1;

    expect(services(a)).toEqual(a2);
    expect(a.owner.registry.getAgentConfig("A1-late")).toBeUndefined();
    expect(a.owner.registry.getAgentConfig("A2-only")?.name).toBe("A2-only");
    expect(a2.store.agent.showCost).toBe(true);
    expect(inputA1).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
    await spawn(b);
    await vi.advanceTimersByTimeAsync(200);
    expect(b.api.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(a.api.api.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an on-demand A1 discovery after A2 replaces its registry contents", async () => {
    const a = parent();
    await emit(a, "session_start", fakeCtx({ cwd: "/a1", hasUI: false }));
    let release!: (agents: AgentConfigFromMd[]) => void;
    vi.mocked(scanAgentFilesInDir).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const discovering = a.owner.registry.discoverNewAgents();
    await emit(a, "session_start", fakeCtx({ cwd: "/a2", hasUI: false }));
    a.owner.registry.registerAgents(new Map([["A2-only", { name: "A2-only", description: "A2", systemPrompt: "" }]]));
    release(discovered("A1-late"));
    expect(await discovering).toBe(0);
    expect(a.owner.registry.getAgentConfig("A1-late")).toBeUndefined();
    expect(a.owner.registry.getAgentConfig("A2-only")?.description).toBe("A2");
  });

  it("ignores A1's late completion after A2 starts while B continues to deliver", async () => {
    const a = parent();
    const b = parent();
    const ctxA = await emit(a, "session_start");
    await emit(b, "session_start");
    let release!: (result: RunResult) => void;
    vi.mocked(runAgent).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const old = services(a);
    const first = await old.coordinator.spawn(asExtensionAPI(a.api.api), ctxA, {
      type: "general-purpose",
      prompt: "A1",
      description: "A1",
      graceTurns: 6,
      runInBackground: true,
    });
    const closing = emit(a, "session_shutdown");
    await emit(a, "session_start");
    expect(services(a).manager).not.toBe(old.manager);
    await spawn(b);
    release({ ...finishedRun(), responseText: "A1 late result" });
    await closing;
    await first.record.execution.promise;
    await vi.advanceTimersByTimeAsync(200);
    expect(a.api.api.sendMessage).not.toHaveBeenCalled();
    expect(b.api.api.sendMessage).toHaveBeenCalledTimes(1);
    await spawn(a);
    await vi.advanceTimersByTimeAsync(200);
    expect(a.api.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(a.api.api.sendMessage.mock.calls[0]?.[0].content).not.toContain("A1 late result");
  });

  it("rejects delayed tool discovery after its owner starts a replacement session", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    let discoveryStarted = false;
    let releaseDiscovery!: () => void;
    const discovery = new Promise<AgentConfigFromMd[]>((resolve) => {
      releaseDiscovery = () => resolve([]);
    });
    vi.mocked(scanAgentFilesInDir).mockImplementation(async () => {
      discoveryStarted = true;
      return discovery;
    });

    const pendingTool = executeAgentTool(
      a.owner,
      "tool-call",
      { agent: "late-agent", prompt: "run after discovery", run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(discoveryStarted).toBe(true));

    const replacement = emit(a, "session_start");
    releaseDiscovery();
    await expect(pendingTool).rejects.toThrow("session changed");
    await replacement;
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("gives each parent its own concurrency queue and stops only A's work", async () => {
    const pending: Array<{ owner: ReturnType<typeof parent>["owner"]; finish: () => void }> = [];
    vi.mocked(runAgent).mockImplementation(
      (owner, _ctx, _type, _prompt, options) =>
        new Promise((resolve) => {
          const finish = () => resolve(finishedRun());
          pending.push({ owner, finish });
          options.signal?.addEventListener("abort", finish, { once: true });
        }),
    );
    const a = parent();
    const b = parent();
    const ctxA = await emit(a, "session_start");
    const ctxB = await emit(b, "session_start");
    services(a).store.mutate.concurrency.setDefault(1, "session");
    services(b).store.mutate.concurrency.setDefault(1, "session");
    const intent = {
      type: "general-purpose",
      prompt: "queue",
      description: "queue",
      modelKey: "test/model",
      graceTurns: 6,
      runInBackground: true,
    };
    const a1 = await services(a).coordinator.spawn(asExtensionAPI(a.api.api), ctxA, intent);
    const a2 = await services(a).coordinator.spawn(asExtensionAPI(a.api.api), ctxA, intent);
    const b1 = await services(b).coordinator.spawn(asExtensionAPI(b.api.api), ctxB, intent);
    const b2 = await services(b).coordinator.spawn(asExtensionAPI(b.api.api), ctxB, intent);
    expect([
      a1.record.lifecycle.status,
      a2.record.lifecycle.status,
      b1.record.lifecycle.status,
      b2.record.lifecycle.status,
    ]).toEqual(["running", "queued", "running", "queued"]);
    expect(pending.map((run) => run.owner)).toEqual([a.owner, b.owner]);
    await emit(a, "session_shutdown");
    expect(a2.record.lifecycle.status).toBe("error");
    expect(b1.record.lifecycle.status).toBe("running");
    expect(b2.record.lifecycle.status).toBe("queued");
    pending.find((run) => run.owner === b.owner)?.finish();
    await b1.record.execution.promise;
    expect(b2.record.lifecycle.status).toBe("running");
    expect(pending.map((run) => run.owner)).toEqual([a.owner, b.owner, b.owner]);
  });
});
