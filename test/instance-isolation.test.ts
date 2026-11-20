import { parent, emit, services, spawn, finishedRun } from "./instance-fixtures.js";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { assistantMessage } from "./agents/session-messages.ts";
import { fakeCtx } from "./fixtures.js";
import { asCommandContext, asExtensionAPI } from "./pi-boundaries.js";
import { scanAgentFilesInDir, type AgentConfigFromMd } from "../src/agents/agent-discovery.js";
import { continueAgentSession, runAgent, type RunResult } from "../src/agents/agent-runner.js";
import { PARENT_MESSAGE_LIMIT, PARENT_MESSAGE_TOOL_NAME } from "../src/agents/parent-message.js";
import { createConfigIO } from "../src/config/config-io.js";
import { registerAgentInvalidation, invalidateAgentRow } from "../src/ui/renderer.js";
import { getDisplayName, agentColoredText } from "../src/ui/format.js";
import { executeAgentTool } from "../src/agents/tool-execution.js";
import { handleRestartLastAgents } from "../src/agents/restart-last-agents.js";
import { showSpawnAgentMenu } from "../src/ui/menu/menu-spawn-wizard.js";

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

  it("rejects a foreign same-ID Agent context before resolving a spawn target", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    const foreign = fakeCtx();
    vi.mocked(foreign.sessionManager.getSessionId).mockReturnValue(ctx.sessionManager.getSessionId());
    const resolveType = vi.spyOn(a.owner.registry, "resolveTypeOrDiscover");

    await expect(
      executeAgentTool(a.owner, "call", { agent: "late-agent", prompt: "stale work" }, undefined, undefined, foreign),
    ).rejects.toThrow();

    expect(foreign.isProjectTrusted).not.toHaveBeenCalled();
    expect(resolveType).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects a foreign same-ID Spawn wizard before reading types or opening UI", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    const custom = vi.fn();
    const foreign = fakeCtx({ ui: { custom } });
    vi.mocked(foreign.sessionManager.getSessionId).mockReturnValue(ctx.sessionManager.getSessionId());
    const readTypes = vi.spyOn(a.owner.registry, "getAvailableTypes");

    await showSpawnAgentMenu(a.owner, asCommandContext(foreign), []);

    expect(readTypes).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
    expect(a.api.api.exec).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects a foreign same-ID Restart before probing or touching the widget", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    const foreign = fakeCtx();
    vi.mocked(foreign.sessionManager.getSessionId).mockReturnValue(ctx.sessionManager.getSessionId());
    vi.mocked(foreign.sessionManager.getEntries).mockReturnValue([
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-11-18T00:00:00.000Z",
        message: assistantMessage({
          content: [{ type: "toolCall", id: "call-1", name: "Agent", arguments: { prompt: "stale work" } }],
          stopReason: "toolUse",
        }),
      },
    ]);
    const resolveType = vi.spyOn(a.owner.registry, "resolveTypeOrDiscover");
    const widget = services(a).widget;
    const setUICtx = vi.spyOn(widget, "setUICtx");
    const ensureTimer = vi.spyOn(widget, "ensureTimer");

    const result = await handleRestartLastAgents(a.owner, asCommandContext(foreign));

    expect(result.restarted).toEqual([]);
    expect(foreign.isProjectTrusted).not.toHaveBeenCalled();
    expect(resolveType).not.toHaveBeenCalled();
    expect(setUICtx).not.toHaveBeenCalled();
    expect(ensureTimer).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("discards discovery if the SDK session ID changes during its scan", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    let markStarted!: () => void;
    let resolveDiscovery!: (agents: AgentConfigFromMd[]) => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const discovery = new Promise<AgentConfigFromMd[]>((resolve) => (resolveDiscovery = resolve));
    vi.mocked(scanAgentFilesInDir).mockImplementation(async () => {
      markStarted();
      return discovery;
    });
    const tool = executeAgentTool(
      a.owner,
      "call",
      { agent: "late-agent", prompt: "stale work" },
      undefined,
      undefined,
      ctx,
    );
    await started;
    vi.mocked(ctx.sessionManager.getSessionId).mockReturnValue("different session");
    resolveDiscovery(discovered("late-agent"));

    await expect(tool).rejects.toThrow("session changed");
    expect(a.owner.registry.getAgentConfig("late-agent")).toBeUndefined();
    expect(runAgent).not.toHaveBeenCalled();
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

  it("keeps a registered menu's Spawn action bound across replacement with the same SDK context", async () => {
    const a = parent();
    let chooseAction!: (action: string) => void;
    const custom = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => (chooseAction = resolve)));
    const ctx = await emit(a, "session_start", fakeCtx({ hasUI: false, ui: { custom } }));
    const command = a.api.commands.find(({ name }) => name === "agents")!;
    const pending = command.handler("", asCommandContext(ctx));
    await emit(a, "session_start", ctx);
    const readTypes = vi.spyOn(a.owner.registry, "getAvailableTypes");
    chooseAction("spawn");
    await pending;

    expect(readTypes).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("abandons the old Spawn wizard when Git discovery outlives its parent session", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    const oldManager = services(a).manager;
    let probeStarted!: () => void;
    const gitStarted = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    let releaseProbe!: () => void;
    a.api.api.exec.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = () => resolve({ code: 1, stdout: "", stderr: "" });
          probeStarted();
        }),
    );
    const custom = vi.fn().mockResolvedValueOnce("general-purpose").mockResolvedValueOnce("old draft");
    const oldWizard = showSpawnAgentMenu(a.owner, asCommandContext({ ...ctx, ui: { ...ctx.ui, custom } }), []);
    await gitStarted;
    const replacement = await emit(a, "session_start");
    releaseProbe();
    await oldWizard;

    expect(custom).toHaveBeenCalledTimes(2);
    expect(oldManager.listAgents()).toEqual([]);
    expect(services(a).manager.listAgents()).toEqual([]);
    await spawn(a, replacement);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("rejects stale and cross-parent Spawn requests even when parents share a session ID", async () => {
    vi.mocked(runAgent).mockImplementation(
      (_owner, _ctx, _type, _prompt, options) =>
        new Promise((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(finishedRun()), { once: true }),
        ),
    );
    const a = parent();
    const b = parent();
    const ctxA = fakeCtx({ hasUI: false });
    const ctxB = fakeCtx({ hasUI: false });
    vi.mocked(ctxB.sessionManager.getSessionId).mockReturnValue("parent-b");
    await Promise.all([emit(a, "session_start", ctxA), emit(b, "session_start", ctxB)]);
    const oldA = services(a);
    const liveB = services(b);
    liveB.store.mutate.concurrency.setDefault(2, "session");
    const piA = asExtensionAPI(a.api.api);
    const piB = asExtensionAPI(b.api.api);
    const intent = {
      type: "general-purpose",
      prompt: "parallel Spawn",
      description: "parallel Spawn",
      modelKey: "test/model",
      graceTurns: 6,
      runInBackground: true,
    };
    const b1 = await liveB.coordinator.spawn(piB, ctxB, intent);
    const newCtxA = fakeCtx({ hasUI: false });
    vi.mocked(newCtxA.sessionManager.getSessionId).mockReturnValue(ctxB.sessionManager.getSessionId());
    await emit(a, "session_start", newCtxA);
    const newA = services(a);
    const results = await Promise.allSettled([
      oldA.coordinator.spawn(piA, ctxA, intent),
      newA.coordinator.spawn(piA, ctxA, intent),
      newA.coordinator.spawn(piA, ctxB, intent),
      liveB.coordinator.spawn(piB, ctxB, { ...intent, type: "Explore" }),
      newA.coordinator.spawn(piA, { ...newCtxA }, intent),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(oldA.manager.listAgents()).toEqual([]);
    expect(newA.manager.listAgents()).toHaveLength(1);
    expect(liveB.manager.listAgents()).toHaveLength(2);
    expect(b1.record.lifecycle.status).toBe("running");
  });

  it("uses each parent's MessageParent setting when restarting Subagents concurrently", async () => {
    const a = parent();
    const b = parent();
    const ctxA = await emit(a, "session_start");
    const ctxB = await emit(b, "session_start");
    const configB = vi.mocked(createConfigIO).mock.results.at(-1)!.value;
    vi.mocked(configB.load).mockReturnValue({
      global: { agent: { parentMessages: false } },
      project: null,
      projectStatus: "untrusted",
    });
    services(b).store.reload();
    const entry: SessionMessageEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-11-18T00:00:00.000Z",
      message: assistantMessage({
        content: [{ type: "toolCall", id: "call-1", name: "Agent", arguments: { prompt: "restart work" } }],
        stopReason: "toolUse",
      }),
    };
    vi.mocked(ctxA.sessionManager.getEntries).mockReturnValue([entry]);
    vi.mocked(ctxB.sessionManager.getEntries).mockReturnValue([entry]);

    const results = await Promise.all([
      handleRestartLastAgents(a.owner, asCommandContext(ctxA)),
      handleRestartLastAgents(b.owner, asCommandContext(ctxB)),
    ]);

    expect(results).toEqual([
      { restarted: ["general-purpose: restart work"], skipped: [] },
      { restarted: ["general-purpose: restart work"], skipped: [] },
    ]);
    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(2);
    const optionsA = calls.find(([owner]) => owner === a.owner)?.[4];
    const optionsB = calls.find(([owner]) => owner === b.owner)?.[4];
    expect(optionsA?.customTools?.map((tool) => tool.name)).toEqual(["MessageParent"]);
    expect(optionsB).toBeDefined();
    expect(optionsB?.customTools).toBeUndefined();
  });

  it("keeps the Parent message allowance until a continuation is accepted", async () => {
    const a = parent();
    const ctx = await emit(a, "session_start");
    const { coordinator, manager } = services(a);
    const initial = finishedRun();
    let finish!: (result: RunResult) => void;
    vi.mocked(runAgent).mockReturnValueOnce(new Promise<RunResult>((resolve) => (finish = resolve)));
    const { agentId } = await coordinator.spawn(asExtensionAPI(a.api.api), ctx, {
      type: "general-purpose",
      prompt: "first run",
      description: "Verify Parent message allowance",
      graceTurns: 6,
      runInBackground: true,
    });
    const tool = vi
      .mocked(runAgent)
      .mock.lastCall?.[4]?.customTools?.find((tool) => tool.name === PARENT_MESSAGE_TOOL_NAME);
    if (!tool) throw new Error("MessageParent was not bound");
    const toolContext = { ...ctx, tools: [], executeTool: vi.fn() };
    const send = (message: string) => tool.execute("call", { message }, undefined, undefined, toolContext);
    for (let i = 0; i < PARENT_MESSAGE_LIMIT; i++) await send(`initial ${i}`);
    const first = manager.getRuns(agentId)[0];
    finish(initial);
    await first.completion;
    await expect(send("settlement did not start another run")).rejects.toThrow("limit");

    vi.mocked(continueAgentSession).mockImplementationOnce(async () => {
      for (let i = 0; i < PARENT_MESSAGE_LIMIT; i++) await send(`continuation ${i}`);
      await expect(send("still limited in the continuation")).rejects.toThrow("limit");
      return initial;
    });
    const submission = await manager.submitMessage(agentId, "continue");
    expect(submission).toMatchObject({ accepted: true, delivery: "continuation" });
    const second = manager.getRuns(agentId)[1];
    expect(second.id).not.toBe(first.id);
    await second.completion;
    expect(manager.getRuns(agentId)[1].outcome?.status).toBe("completed");
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
