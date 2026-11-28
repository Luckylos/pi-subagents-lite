import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  type AgentSession,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { fakeCtx, fakePi } from "../fixtures.js";
import { createTestOwner } from "../owner-fixtures.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function setup(extension: (templatePath: string) => ExtensionFactory, customTools: ToolDefinition[] = []) {
  const cwd = mkdtempSync("/tmp/subagent-sdk-steering-");
  const templatePath = join(cwd, "owned-template.md");
  writeFileSync(templatePath, "Expanded $1");
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubGlobal("__subagentSteeringExtension", extension(templatePath));
  const dir = join(cwd, ".pi", "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "steering.ts"), "export default (pi) => globalThis.__subagentSteeringExtension(pi);");
  const offline = fauxProvider({ provider: "offline-steering", models: [{ id: "steering" }] });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(offline.provider.id, async () => ({ type: "api_key", key: "test-only" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(offline.provider);
  vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
  vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue(offline.models);
  vi.spyOn(runtime, "hasConfiguredAuth").mockImplementation((provider) => provider === offline.provider.id);
  const streamSimple = runtime.streamSimple.bind(runtime);
  vi.spyOn(runtime, "streamSimple").mockImplementation((model, context, options) => {
    if (model.provider !== offline.provider.id) throw new Error("External provider is forbidden in this test");
    return streamSimple(model, context, options);
  });
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
  const manager = new AgentManager(await createTestOwner(), undefined, { default: 1 });
  let session: AgentSession | undefined;
  return {
    manager,
    offline,
    get session() {
      if (!session) throw new Error("Session has not been created");
      return session;
    },
    spawn(prompt = "owned prompt", options: { maxTurns?: number; graceTurns?: number } = {}) {
      return manager.spawn(fakePi(), fakeCtx({ cwd, hasUI: false }), "general-purpose", prompt, {
        description: prompt,
        model: offline.getModel(),
        agentConfig: {
          name: "steering",
          description: "Steering test",
          systemPrompt: "",
          tools: customTools.map((tool) => tool.name),
          extensions: ["steering"],
        },
        customTools,
        onSessionCreated: (child) => {
          session = child;
        },
        ...options,
      });
    },
    async dispose() {
      await manager.dispose();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("cancels a steer awaiting input hooks before the independent prompt consumes it", async () => {
  const ownedEntered = gate();
  const releaseOwned = gate();
  const inputEntered = gate();
  const releaseInput = gate();
  const independentEntered = gate();
  const releaseIndependent = gate();
  const inputs: string[] = [];
  let submitted = false;
  const app = await setup(
    () => (pi) => {
      pi.on("input", async (event) => {
        inputs.push(event.text);
        if (event.text === "stale steer") {
          inputEntered.open();
          await releaseInput.promise;
          return { action: "transform", text: "transformed stale steer" };
        }
      });
      pi.on("agent_settled", () => {
        if (!submitted) {
          submitted = true;
          pi.sendUserMessage("independent prompt");
        }
      });
    },
    [
      {
        name: "hold",
        label: "Hold",
        description: "Pause the independent prompt",
        parameters: Type.Object({}),
        async execute() {
          independentEntered.open();
          await releaseIndependent.promise;
          return { content: [{ type: "text", text: "tool finished" }], details: undefined };
        },
      },
    ],
  );
  const providerInputs: string[][] = [];
  const independentAnswer: Parameters<typeof app.offline.setResponses>[0][number] = (context) => {
    providerInputs.push(
      context.messages.flatMap((message) => {
        if (message.role !== "user") return [];
        if (typeof message.content === "string") return [message.content];
        return [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")];
      }),
    );
    return fauxAssistantMessage("independent answer");
  };
  app.offline.setResponses([
    async () => {
      ownedEntered.open();
      await releaseOwned.promise;
      return fauxAssistantMessage("owned answer");
    },
    fauxAssistantMessage(fauxToolCall("hold", {}, { id: "independent" }), { stopReason: "toolUse" }),
    independentAnswer,
    independentAnswer, // Pi's one-at-a-time steering may expose a leak in a further request.
  ]);
  try {
    const id = app.spawn();
    const [run] = app.manager.getRuns(id);
    await ownedEntered.promise;
    const clearQueue = vi.spyOn(app.session, "clearQueue");
    let cancelledBeforeRelease = false;
    const result = app.manager.submitMessage(id, "stale steer").then((submission) => {
      cancelledBeforeRelease = true;
      return submission;
    });
    await inputEntered.promise;
    releaseOwned.open();
    await independentEntered.promise;
    expect(app.session.isStreaming).toBe(true);
    await expect(app.session.steer("independent steer")).resolves.toBe("queued");
    expect.soft(cancelledBeforeRelease).toBe(true);
    releaseInput.open();
    expect(await result).toMatchObject({ accepted: false, reason: "settling" });
    expect.soft(app.session.getSteeringMessages()).toEqual(["independent steer"]);
    releaseIndependent.open();
    await run.completion;
    expect(clearQueue).toHaveBeenCalledTimes(1);
    expect(providerInputs).toEqual([["owned prompt", "independent prompt", "independent steer"]]);
    expect(inputs).toEqual(["owned prompt", "stale steer", "independent prompt", "independent steer"]);
  } finally {
    releaseOwned.open();
    releaseInput.open();
  }
});

it("delivers a follow-up queued by agent_settled to the deferred independent prompt", async () => {
  let submitted = false;
  let followUp: Awaited<ReturnType<AgentSession["followUp"]>> | undefined;
  const app = await setup(() => (pi) => {
    pi.on("agent_settled", async () => {
      if (submitted) return;
      submitted = true;
      pi.sendUserMessage("independent prompt");
      followUp = await app.session.followUp("independent follow-up");
    });
  });
  const requests: unknown[] = [];
  const respond: Parameters<typeof app.offline.setResponses>[0][number] = (context) => {
    requests.push(context.messages.filter((message) => message.role === "user").at(-1)?.content);
    return fauxAssistantMessage("answer");
  };
  app.offline.setResponses([respond, respond, respond]);
  try {
    const id = app.spawn();
    await app.manager.getRuns(id)[0].completion;
    expect(followUp).toBe("queued");
    expect(requests).toEqual([
      [{ type: "text", text: "owned prompt" }],
      [{ type: "text", text: "independent prompt" }],
      [{ type: "text", text: "independent follow-up" }],
    ]);
  } finally {
    await app.dispose();
  }
});

it("rejects a steer that crosses into idle between SDK preflight and the queue writes", async () => {
  const ownedEntered = gate();
  const releaseOwned = gate();
  const settling = gate();
  const releaseSettlement = gate();
  const app = await setup(() => (pi) => {
    pi.on("agent_before_settle", () => {});
    pi.on("agent_settled", async () => {
      settling.open();
      await releaseSettlement.promise;
    });
  });
  app.offline.setResponses([
    async () => {
      ownedEntered.open();
      await releaseOwned.promise;
      return fauxAssistantMessage("owned answer");
    },
  ]);
  try {
    const id = app.spawn();
    const [run] = app.manager.getRuns(id);
    await ownedEntered.promise;
    const queued: ReadonlyArray<string>[] = [];
    const detach = app.session.subscribe((event) => {
      if (event.type === "queue_update") queued.push(event.steering);
    });
    const runner = app.session.extensionRunner;
    const emitBoundary = runner.emitBoundary.bind(runner);
    let streamingAtSubmission: boolean | undefined;
    let result: ReturnType<AgentManager["submitMessage"]> | undefined;
    vi.spyOn(runner, "emitBoundary").mockImplementation(async (...args) => {
      const boundary = await emitBoundary(...args);
      if (args[0].type === "agent_before_settle") {
        // The inner microtask lands after the SDK decides to stop, just
        // before it flips isStreaming. There are no input handlers to await.
        queueMicrotask(() =>
          queueMicrotask(() => {
            streamingAtSubmission = app.session.isStreaming;
            result = app.manager.submitMessage(id, "late steer");
          }),
        );
      }
      return boundary;
    });
    releaseOwned.open();
    await settling.promise;
    expect(streamingAtSubmission).toBe(true);
    expect(app.session.isStreaming).toBe(false);
    expect(app.manager.getRuns(id)[0].phase).toBe("running");
    expect(await result).toMatchObject({ accepted: false, reason: "settling" });
    expect(queued).toEqual([]);
    detach();
    releaseSettlement.open();
    await run.completion;
  } finally {
    releaseOwned.open();
    releaseSettlement.open();
    await app.dispose();
  }
});

it("keeps SDK input transforms, handled short-circuiting, template expansion and steering order", async () => {
  const ownedEntered = gate();
  const releaseOwned = gate();
  const inputs: Array<[string, string | undefined]> = [];
  const app = await setup((templatePath) => (pi) => {
    pi.on("resources_discover", () => ({ promptPaths: [templatePath] }));
    pi.on("input", async (event) => {
      if (event.text === "first") return { action: "transform", text: "/owned-template alpha" };
      if (event.text === "handled") return { action: "handled" };
    });
    pi.on("input", (event) => {
      inputs.push([event.text, event.streamingBehavior]);
      if (event.text === "second") return { action: "transform", text: "second transformed" };
    });
  });
  app.offline.setResponses([
    async () => {
      ownedEntered.open();
      await releaseOwned.promise;
      return fauxAssistantMessage("first answer");
    },
    fauxAssistantMessage("second answer"),
  ]);
  try {
    const id = app.spawn();
    await ownedEntered.promise;
    app.session.setSteeringMode("all");
    const results = await Promise.all(
      ["first", "handled", "second"].map((message) => app.manager.submitMessage(id, message)),
    );
    expect(results).toEqual(
      Array.from({ length: 3 }, () => ({
        accepted: true,
        agentId: id,
        runId: app.manager.getRuns(id)[0].id,
        delivery: "steer",
      })),
    );
    expect(inputs).toEqual([
      ["owned prompt", undefined],
      ["/owned-template alpha", "steer"],
      ["second", "steer"],
    ]);
    expect(app.session.getSteeringMessages()).toEqual(["Expanded alpha", "second transformed"]);
    releaseOwned.open();
    await app.manager.getRuns(id)[0].completion;
    expect(app.session.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(
      [
        [{ type: "text", text: "owned prompt" }],
        [{ type: "text", text: "Expanded alpha" }],
        [{ type: "text", text: "second transformed" }],
      ],
    );
  } finally {
    releaseOwned.open();
    await app.dispose();
  }
});

it("Stop retires a pending input and releases the queued run once the SDK prompt ends", async () => {
  const ownedEntered = gate();
  const releaseOwned = gate();
  const inputEntered = gate();
  const releaseInput = gate();
  const app = await setup(() => (pi) => {
    pi.on("input", async (event) => {
      if (event.text === "old steer") {
        inputEntered.open();
        await releaseInput.promise;
      }
    });
  });
  app.offline.setResponses([
    async () => {
      ownedEntered.open();
      await releaseOwned.promise;
      return fauxAssistantMessage("owned answer");
    },
    fauxAssistantMessage("replacement answer"),
  ]);
  try {
    const id = app.spawn();
    const [run] = app.manager.getRuns(id);
    await ownedEntered.promise;
    const result = app.manager.submitMessage(id, "old steer");
    await inputEntered.promise;
    const replacement = app.spawn("replacement");
    const [next] = app.manager.getRuns(replacement);
    expect(next.phase).toBe("queued");
    expect(app.manager.abort(id)).toBe(true);
    expect(await result).toMatchObject({ accepted: false, reason: "stopping" });
    expect(app.manager.getRuns(replacement)[0].phase).toBe("queued");
    releaseOwned.open();
    await run.completion;
    await next.completion;
    expect(app.manager.getRuns(id)[0].outcome?.status).toBe("stopped");
    expect(app.manager.getRuns(replacement)[0].outcome?.result).toBe("replacement answer");
  } finally {
    releaseOwned.open();
    releaseInput.open();
    await app.dispose();
  }
});
