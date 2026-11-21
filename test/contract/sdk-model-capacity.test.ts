import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
import { DEFAULT_AGENTS } from "../../src/agents/default-agents.js";
import { executeAgentTool } from "../../src/agents/tool-execution.js";
import type { LoadedConfig } from "../../src/config/config-io.js";
import { ConfigStore } from "../../src/config/config-store.js";
import { createExtensionOwner } from "../../src/shell.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import { fakeCtx, fakePi } from "../fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup({ available = true, loadExtensions = false } = {}) {
  const cwd = mkdtempSync("/tmp/subagent-model-capacity-");
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
  vi.stubEnv("PI_OFFLINE", "1");
  const offline = fauxProvider({ provider: "offline-capacity", models: [{ id: "chosen" }, { id: "other" }] });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(offline.provider.id, async () => ({ type: "api_key", key: "test-only" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  // Keep even auth availability refreshes off built-in providers. The real SDK
  // still selects the child model and dispatches against the registered faux provider.
  vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
  runtime.registerNativeProvider(offline.provider);
  vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue(available ? offline.models : []);
  vi.spyOn(runtime, "hasConfiguredAuth").mockImplementation((provider) => provider === offline.provider.id);
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
  const streamSimple = runtime.streamSimple.bind(runtime);
  vi.spyOn(runtime, "streamSimple").mockImplementation((model, context, options) => {
    if (model.provider !== offline.provider.id) throw new Error("External provider is forbidden in this test");
    return streamSimple(model, context, options);
  });

  const pi = fakePi();
  const ctx = fakeCtx({ cwd, model: undefined, hasUI: false });
  const owner = createExtensionOwner(pi);
  owner.sessionCtx = ctx;
  owner.registry.registerAgents(new Map(DEFAULT_AGENTS));
  const config: LoadedConfig = {
    global: {
      agent: { loadExtensionsImplicitly: loadExtensions, defaultMaxTurns: 2, graceTurns: 0 },
      concurrency: { default: 1 },
    },
    project: null,
    projectStatus: "absent",
  };
  owner.store = new ConfigStore({
    load: () => config,
    updateLayer: (_target, mutate) => {
      mutate(config.global);
      return config;
    },
    saveGlobal: vi.fn(),
    saveProject: vi.fn(),
  });
  const store = owner.store;
  const manager = (owner.manager = new AgentManager(owner, undefined, store.concurrency));
  store.setDeps({ manager });
  owner.coordinator = new SpawnCoordinator(owner, manager);

  function switchOnStartup() {
    const dir = join(cwd, ".pi", "extensions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "switch-model.ts"),
      `export default function (pi) {
        pi.on("session_start", async (_event, ctx) => {
          if (!ctx.isProjectTrusted()) throw new Error("Expected trusted project");
          const model = ctx.modelRegistry.find(${JSON.stringify(offline.provider.id)}, "other");
          if (!model || !(await pi.setModel(model))) throw new Error("Startup model switch failed");
        });
      }`,
    );
  }
  const gates: Array<() => void> = [];
  function hold(answer: string) {
    const { promise, resolve } = deferred();
    gates.push(resolve);
    offline.appendResponses([
      async () => {
        await promise;
        return fauxAssistantMessage(answer);
      },
    ]);
    return resolve;
  }
  async function background(prompt: string) {
    const r = await executeAgentTool(owner, prompt, { prompt, run_in_background: true }, undefined, undefined, ctx);
    const record = manager.listAgents().find((agent) => agent.display.toolCall?.id === prompt)!;
    expect(r.details.agentId).toBe(record.id);
    return record.id;
  }
  function known(prompt: string, model = offline.getModel()) {
    return manager.spawn(pi, ctx, "general-purpose", prompt, {
      model,
      modelKey: `${model.provider}/${model.id}`,
      description: prompt,
    });
  }
  async function dispose() {
    for (const release of gates) release();
    await manager.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
  const complete = (id: string) => manager.getRuns(id).at(-1)!.completion;
  const lifecycle = (id: string) => manager.getRecord(id)!.lifecycle;
  const modelKey = `${offline.provider.id}/${offline.getModel().id}`;
  return {
    owner,
    manager,
    store,
    offline,
    runtime,
    ctx,
    modelKey,
    otherKey: `${offline.provider.id}/other`,
    switchOnStartup,
    background,
    known,
    hold,
    complete,
    lifecycle,
    dispose,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SDK-selected model capacity", () => {
  it("starts on the startup hook's model even while the SDK's initial model is full", async () => {
    const app = await setup({ loadExtensions: true });
    try {
      app.hold("active on chosen");
      app.known("chosen holder");
      await vi.waitFor(() => expect(app.offline.state.callCount).toBe(1));
      app.switchOnStartup();
      app.offline.appendResponses([fauxAssistantMessage("answer on other")]);
      const id = await app.background("switch from full chosen");
      await vi.waitFor(() => expect(app.offline.state.callCount).toBe(2));
      await app.complete(id);
      expect(app.manager.getRecord(id)?.execution.modelKey).toBe(app.otherKey);
      expect(app.manager.getInitialRun(id)?.outcome).toMatchObject({
        result: "answer on other",
        stats: { modelId: "other" },
      });
    } finally {
      await app.dispose();
    }
  });

  it.each(["sdk", "known"] as const)(
    "waits on the startup hook's full model and preserves FIFO (%s initial model)",
    async (source) => {
      const app = await setup({ loadExtensions: true });
      try {
        const release = app.hold("active on other");
        const holder = app.known("other holder", app.offline.getModel("other"));
        await vi.waitFor(() => expect(app.offline.state.callCount).toBe(1));
        app.switchOnStartup();
        app.offline.appendResponses([fauxAssistantMessage("switched first"), fauxAssistantMessage("known second")]);
        const switched =
          source === "sdk" ? await app.background("switch to full other") : app.known("switch from chosen");
        await vi.waitFor(() => expect(app.lifecycle(switched)).toMatchObject({ phase: "queued", status: "queued" }));
        expect(app.manager.getRecord(switched)?.execution.modelKey).toBe(app.otherKey);
        expect(app.manager.getRecord(switched)?.execution.session).toBeUndefined();
        expect(app.offline.state.callCount).toBe(1);
        if (source === "known") {
          const formerPool = app.known("former pool is available");
          expect(app.lifecycle(formerPool).status).toBe("running");
          app.manager.abort(formerPool, "user");
          await app.complete(formerPool);
        }
        const later = app.known("later on other", app.offline.getModel("other"));
        expect(app.lifecycle(later).status).toBe("queued");

        release();
        await Promise.all([holder, switched, later].map(app.complete));
        expect([switched, later].map((id) => app.manager.getInitialRun(id)?.outcome)).toMatchObject([
          { result: "switched first", stats: { modelId: "other" } },
          { result: "known second", stats: { modelId: "other" } },
        ]);
        expect(app.offline.state.callCount).toBe(3);
      } finally {
        await app.dispose();
      }
    },
  );

  it("keeps a provisional lease when the startup switch stays in the same provider pool", async () => {
    const app = await setup({ loadExtensions: true });
    try {
      app.store.mutate.concurrency.setProvider(app.offline.provider.id, 1, "session");
      app.switchOnStartup();
      const release = app.hold("switched first");
      const first = app.known("switch from chosen");
      const later = app.known("later on other", app.offline.getModel("other"));
      expect(app.lifecycle(later).status).toBe("queued");
      await vi.waitFor(() => expect(app.offline.state.callCount).toBe(1));
      expect(app.manager.getRecord(first)?.execution.session?.model?.id).toBe("other");
      expect(app.lifecycle(later).status).toBe("queued");

      // Splitting the pool must count the live lease against its actual model.
      app.store.mutate.concurrency.setModel(app.otherKey, 1, "session");
      expect(app.lifecycle(later).status).toBe("queued");
      app.offline.appendResponses([fauxAssistantMessage("known second")]);
      release();
      await Promise.all([first, later].map(app.complete));
      expect([first, later].map((id) => app.manager.getInitialRun(id)?.outcome?.result)).toEqual([
        "switched first",
        "known second",
      ]);
    } finally {
      await app.dispose();
    }
  });

  it("admits continuations against the model selected by the startup hook", async () => {
    const app = await setup({ loadExtensions: true });
    try {
      app.switchOnStartup();
      app.offline.appendResponses([fauxAssistantMessage("initial on other")]);
      const id = await app.background("switch before first prompt");
      await app.complete(id);
      expect(app.manager.getInitialRun(id)?.outcome).toMatchObject({ stats: { modelId: "other" } });
      const release = app.hold("active on other");
      const holder = app.known("other holder", app.offline.getModel("other"));
      await vi.waitFor(() => expect(app.offline.state.callCount).toBe(2));
      app.offline.appendResponses([fauxAssistantMessage("continued on other")]);

      expect(await app.manager.submitMessage(id, "continue")).toMatchObject({ accepted: false, reason: "capacity" });
      expect(app.manager.getRuns(id)).toHaveLength(1);
      expect(app.offline.state.callCount).toBe(2);
      release();
      await app.complete(holder);
      expect(await app.manager.submitMessage(id, "continue")).toMatchObject({
        accepted: true,
        delivery: "continuation",
      });
      await app.complete(id);
      expect(app.manager.getRuns(id)[1]?.outcome).toMatchObject({
        result: "continued on other",
        stats: { modelId: "other" },
      });
    } finally {
      await app.dispose();
    }
  });

  it("admits a model picked by the startup hook when the SDK initially finds none", async () => {
    const app = await setup({ available: false, loadExtensions: true });
    try {
      app.switchOnStartup();
      app.offline.appendResponses([fauxAssistantMessage("recovered on other")]);
      const id = await app.background("no initial model");
      await app.complete(id);
      expect(app.manager.getInitialRun(id)?.outcome).toMatchObject({
        status: "completed",
        result: "recovered on other",
        stats: { modelId: "other" },
      });
      expect(app.manager.getRecord(id)?.execution.modelKey).toBe(app.otherKey);
    } finally {
      await app.dispose();
    }
  });
  it("queues a second spawn with no configured or parent model before its first request", async () => {
    const app = await setup();
    try {
      const bind = vi.spyOn(AgentSession.prototype, "bindExtensions");
      const release = app.hold("first answer");
      const releaseSecond = app.hold("second answer");
      const first = await app.background("first");
      await vi.waitFor(() => expect(app.offline.state.callCount).toBe(1));
      const second = await app.background("second");
      await vi.waitFor(() => expect(app.lifecycle(second)).toMatchObject({ phase: "queued", status: "queued" }));
      expect(app.manager.getRecord(second)?.execution.modelKey).toBe(app.modelKey);
      expect(app.offline.state.callCount).toBe(1);
      expect(bind).toHaveBeenCalledTimes(2);
      const status = await executeAgentStatusTool(app.owner, "status", {}, undefined, undefined, app.ctx);
      expect(status.content[0].text).toContain(`${second.slice(0, 8)} (general-purpose) queued`);
      expect(app.manager.clear(second)).toBe(false);

      release();
      await app.complete(first);
      await vi.waitFor(() => expect(app.offline.state.callCount).toBe(2));
      expect(app.lifecycle(second)).toMatchObject({ phase: "running", status: "running" });
      releaseSecond();
      await app.complete(second);
      expect(app.manager.getInitialRun(second)?.outcome).toMatchObject({
        status: "completed",
        result: "second answer",
      });
    } finally {
      await app.dispose();
    }
  });

  it("reserves the actual model again when admitting a continuation", async () => {
    const app = await setup();
    try {
      app.offline.appendResponses([fauxAssistantMessage("initial answer")]);
      const first = await app.background("first");
      await app.complete(first);
      const release = app.hold("blocking answer");
      const blocking = await app.background("blocking");
      await vi.waitFor(() => expect(app.offline.state.callCount).toBe(2));
      app.offline.appendResponses([fauxAssistantMessage("continued answer")]);
      app.store.mutate.agent.setDefaultMaxTurns(8);
      expect(app.store.agent.defaultMaxTurns).toBe(8);
      expect(await app.manager.submitMessage(first, "continue")).toMatchObject({ accepted: false, reason: "capacity" });
      expect(app.manager.getRuns(first)).toHaveLength(1);
      release();
      await app.complete(blocking);
      expect(await app.manager.submitMessage(first, "continue")).toMatchObject({
        accepted: true,
        delivery: "continuation",
      });
      await app.complete(first);
      expect(app.manager.getRuns(first).map((run) => run.outcome)).toMatchObject([
        { result: "initial answer", stats: { modelId: "chosen", maxTurns: 2 } },
        { result: "continued answer", stats: { modelId: "chosen", maxTurns: 2 } },
      ]);
      expect(app.offline.state.callCount).toBe(3);
    } finally {
      await app.dispose();
    }
  });

  it("drains mixed known and SDK-selected entries in order without blocking a different pool", async () => {
    const app = await setup();
    try {
      // The provider pool allows two, but the chosen model's own limit of
      // one takes precedence. An unrelated model may still start.
      app.store.mutate.concurrency.setDefault(3, "session");
      app.store.mutate.concurrency.setProvider(app.offline.provider.id, 2, "session");
      app.store.mutate.concurrency.setModel(app.modelKey, 1, "session");
      const release = app.hold("initial");
      const first = app.known("known active");
      await vi.waitFor(() => expect(app.offline.state.callCount).toBe(1));
      const sdk = await app.background("SDK waiter");
      await vi.waitFor(() => expect(app.lifecycle(sdk).status).toBe("queued"));
      const known = app.known("known waiter");
      expect(app.lifecycle(known).status).toBe("queued");

      app.offline.appendResponses([fauxAssistantMessage("different pool")]);
      const other = app.known("other", app.offline.getModel("other")!);
      await app.complete(other);
      expect(app.manager.getInitialRun(other)?.outcome?.result).toBe("different pool");
      let reentrant: string | undefined;
      app.manager.setOnComplete(({ agentId }) => {
        if (agentId === first) reentrant = app.known("reentrant arrival");
      });
      app.offline.appendResponses(
        ["SDK first", "known second", "late third"].map((text) => fauxAssistantMessage(text)),
      );
      release();
      await app.complete(first);
      await Promise.all([sdk, known, reentrant!].map(app.complete));
      expect([sdk, known, reentrant!].map((id) => app.manager.getInitialRun(id)?.outcome?.result)).toEqual([
        "SDK first",
        "known second",
        "late third",
      ]);
    } finally {
      await app.dispose();
    }
  });

  it("shares the provider pool across different models and disposes a parked SDK session at owner shutdown", async () => {
    const app = await setup();
    try {
      app.store.mutate.concurrency.setDefault(3, "session");
      app.store.mutate.concurrency.setProvider(app.offline.provider.id, 1, "session");
      const release = app.hold("active answer");
      const first = app.known("other model", app.offline.getModel("other")!);
      await vi.waitFor(() => expect(app.offline.state.callCount).toBe(1));
      const waiter = await app.background("SDK waiter");
      await vi.waitFor(() => expect(app.lifecycle(waiter).status).toBe("queued"));
      const waiterDone = app.complete(waiter);
      const firstDone = app.complete(first);
      const dispose = vi.spyOn(AgentSession.prototype, "dispose");
      const shutdown = app.manager.dispose();
      await waiterDone;
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(app.offline.state.callCount).toBe(1);
      release();
      await Promise.all([shutdown, firstDone]);
      expect(dispose).toHaveBeenCalledTimes(2);
      expect(app.manager.listAgents()).toEqual([]);
    } finally {
      await app.dispose();
    }
  });

  it("cancels foreground capacity wait while retaining the active model lease until settlement", async () => {
    const app = await setup();
    try {
      const release = app.hold("first answer");
      const first = await app.background("running");
      await vi.waitFor(() => expect(app.offline.state.callCount).toBe(1));
      const abort = new AbortController();
      const foreground = executeAgentTool(
        app.owner,
        "foreground",
        { prompt: "cancel queued" },
        abort.signal,
        undefined,
        app.ctx,
      );
      const disposed = vi.spyOn(AgentSession.prototype, "dispose");
      await vi.waitFor(() =>
        expect(app.manager.listAgents().find((r) => r.display.toolCall?.id === "foreground")?.lifecycle.status).toBe(
          "queued",
        ),
      );
      const queued = app.manager.listAgents().find((r) => r.display.toolCall?.id === "foreground")!;
      abort.abort();
      await expect(foreground).resolves.toMatchObject({ content: [{ text: expect.stringContaining("stopping") }] });
      await app.complete(queued.id);
      expect(queued.lifecycle).toMatchObject({ status: "stopped", phase: "settled" });
      expect(disposed).toHaveBeenCalledTimes(1);
      expect(app.manager.clear(queued.id)).toBe(true);
      expect(app.offline.state.callCount).toBe(1);

      const replacement = await app.background("replacement");
      await vi.waitFor(() => expect(app.lifecycle(replacement).status).toBe("queued"));
      expect(app.manager.abort(first, "user")).toBe(true);
      expect(app.lifecycle(first).phase).toBe("stopping");
      expect(app.lifecycle(replacement).status).toBe("queued");
      app.offline.appendResponses([fauxAssistantMessage("replacement answer")]);
      release();
      await app.complete(first);
      await app.complete(replacement);
      expect(app.offline.state.callCount).toBe(2);
      expect(app.manager.getInitialRun(replacement)?.outcome?.result).toBe("replacement answer");
    } finally {
      await app.dispose();
    }
  });

  it("settles Stop during SDK model preparation and disposes the late session", async () => {
    const app = await setup();
    const entered = deferred();
    const release = deferred();
    vi.mocked(ModelRuntime.create).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return app.runtime;
    });
    const bind = vi.spyOn(AgentSession.prototype, "bindExtensions");
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    try {
      const id = await app.background("slow SDK setup");
      await entered.promise;
      const parent = app.manager.getRecord(id)!.execution.promise;
      expect(app.manager.abort(id, "user")).toBe(true);
      await expect(parent).resolves.toMatchObject({ status: "stopping" });
      expect(app.manager.clear(id)).toBe(false);
      release.resolve();
      await app.complete(id);
      expect(app.manager.getInitialRun(id)?.outcome?.status).toBe("stopped");
      expect(bind).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(app.offline.state.callCount).toBe(0);
    } finally {
      release.resolve();
      await app.dispose();
    }
  });

  it("releases a provisional known-model lease when binding fails", async () => {
    const app = await setup();
    const entered = deferred();
    const release = deferred();
    vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("binding failed locally");
    });
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    try {
      const failing = app.known("failed bind");
      await entered.promise;
      const next = await app.background("next");
      await vi.waitFor(() => expect(app.lifecycle(next).status).toBe("queued"));
      expect(app.offline.state.callCount).toBe(0);
      app.offline.appendResponses([fauxAssistantMessage("next answer")]);
      release.resolve();
      await app.complete(failing);
      await app.complete(next);
      expect(app.manager.getInitialRun(failing)?.outcome).toMatchObject({
        status: "error",
        error: "binding failed locally",
      });
      expect(app.manager.getInitialRun(next)?.outcome?.result).toBe("next answer");
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(app.offline.state.callCount).toBe(1);
    } finally {
      release.resolve();
      await app.dispose();
    }
  });

  it("preserves the SDK error when it cannot find any model", async () => {
    const app = await setup({ available: false });
    try {
      const id = await app.background("no model");
      await app.complete(id);
      expect(app.manager.getInitialRun(id)?.outcome).toMatchObject({
        status: "error",
        error: expect.stringMatching(/no api key found for the selected model/i),
      });
      expect(app.manager.getRecord(id)?.execution.modelKey).toBeUndefined();
      expect(app.offline.state.callCount).toBe(0);
      expect(app.manager.clear(id)).toBe(true);
    } finally {
      await app.dispose();
    }
  });
});
