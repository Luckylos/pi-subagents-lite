import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Type } from "typebox";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runSessionPrompt } from "../../src/agents/session-run.js";
import * as runner from "../../src/agents/agent-runner.js";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { MessageComposer } from "../../src/ui/message-composer.js";
import { assistantMessage } from "./session-messages.js";
import { fakeCtx, fakePi, tempDirFixture } from "../fixtures.js";
import { createTestOwner } from "../owner-fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fixture = tempDirFixture();
const sessions: AgentSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  fixture.teardown();
  vi.restoreAllMocks();
});

async function sdkSession(extension?: ExtensionFactory, customTools: ToolDefinition[] = []) {
  const cwd = extension ? fixture.setup() : process.cwd();
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: extension ? [extension] : [],
  });
  if (extension) await resourceLoader.reload();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-only" }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const model = {
    id: "test-model",
    name: "test",
    provider: "anthropic",
    api: "anthropic-messages" as const,
    baseUrl: "http://unused.invalid",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
  const provider = vi.spyOn(modelRuntime.getProvider("anthropic")!, "streamSimple").mockImplementation(() => {
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage({ content: [{ type: "text", text: "unexpected provider call" }] });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    resourceLoader,
    modelRuntime,
    model,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    customTools,
    tools: customTools.map((tool) => tool.name),
  });
  await session.bindExtensions({});
  sessions.push(session);
  return { session, provider, modelRuntime };
}

describe("runSessionPrompt — real SDK cancellation contract", () => {
  it.each(["input", "auth"] as const)(
    "retains Stop across deferred %s preflight without invoking the provider or tools",
    async (stage) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const tool = vi.fn();
      const { session, provider, modelRuntime } = await sdkSession((pi) => {
        if (stage === "input")
          pi.on("input", async () => {
            entered.resolve();
            await release.promise;
            return { action: "continue" };
          });
        pi.on("tool_call", tool);
      });
      vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(stage === "input");
      if (stage === "auth")
        vi.spyOn(modelRuntime, "checkAuth").mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          return { type: "api_key" };
        });
      const controller = new AbortController();
      const run = runSessionPrompt(session, "task", { signal: controller.signal });
      await entered.promise;
      controller.abort();
      release.resolve();
      await run;
      expect(provider).not.toHaveBeenCalled();
      expect(tool).not.toHaveBeenCalled();
    },
  );

  it("keeps the real SDK prompt and subscriptions alive while an executing tool ignores abort", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const execute = vi.fn<ToolDefinition["execute"]>(async () => {
      entered.resolve();
      await release.promise;
      return { content: [{ type: "text", text: "tool finished" }], details: undefined };
    });
    const { session, provider, modelRuntime } = await sdkSession(undefined, [
      {
        name: "hold",
        label: "hold",
        description: "Deferred tool",
        parameters: Type.Object({}),
        execute,
      },
    ]);
    vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    provider.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call", name: "hold", arguments: {} }],
      });
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end(message);
      return stream;
    });
    const subscribe = session.subscribe.bind(session);
    const unsubscribe = vi.fn();
    const subscription = vi.spyOn(session, "subscribe").mockImplementation((listener) => {
      const detach = subscribe(listener);
      return () => {
        unsubscribe();
        detach();
      };
    });
    const controller = new AbortController();
    const activity = vi.fn();
    let settled = false;
    const run = runSessionPrompt(session, "task", { signal: controller.signal, onToolActivity: activity });
    void run.then(() => {
      settled = true;
    });
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(session.isIdle).toBe(false);
    expect(unsubscribe).not.toHaveBeenCalled();
    release.resolve();
    expect((await run).aborted).toBe(true);
    expect(activity.mock.calls.map(([event]) => event.type)).toEqual(["start", "end"]);
    expect(unsubscribe).toHaveBeenCalledTimes(subscription.mock.calls.length);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(session.isIdle).toBe(true);
  });

  it("keeps an accepted steer from a stopped SDK run out of Continue", async () => {
    const streaming = deferred<void>();
    const releaseResponse = deferred<void>();
    const { session, modelRuntime, provider } = await sdkSession();
    vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    const firstAnswer = assistantMessage({ content: [{ type: "text", text: "first answer" }] });
    provider.mockImplementationOnce((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: assistantMessage() });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "first answer", partial: firstAnswer });
      void releaseResponse.promise.then(() => {
        // Honor the abort, but only after the test releases the underlying stream.
        const message = options?.signal?.aborted
          ? assistantMessage({ ...firstAnswer, stopReason: "aborted" })
          : firstAnswer;
        if (message.stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
        else stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    });
    vi.spyOn(runner, "runAgent").mockImplementation(async (_owner, _ctx, _type, prompt, options) => {
      options.onSessionCreated?.(session);
      return runSessionPrompt(session, prompt, options);
    });
    const completed = vi.fn(() => ({
      steering: [...session.getSteeringMessages()],
      followUp: [...session.getFollowUpMessages()],
    }));
    const manager = new AgentManager(await createTestOwner(), completed, { default: 1 });
    const spawn = (prompt: string) =>
      manager.spawn(fakePi(), fakeCtx(), "general-purpose", prompt, {
        description: prompt,
        modelKey: "test/model",
        onTextDelta: () => streaming.resolve(),
      });
    try {
      const id = spawn("first prompt");
      const run = manager.getRuns(id)[0];
      const parentWait = manager.getRecord(id)!.execution.promise;
      await streaming.promise;
      expect(session.isStreaming).toBe(true);
      expect(await manager.submitMessage(id, "old steer")).toMatchObject({ accepted: true, delivery: "steer" });
      expect(session.getSteeringMessages()).toEqual(["old steer"]);
      await expect(session.followUp("old follow-up")).resolves.toBe("queued");
      expect(session.getFollowUpMessages()).toEqual(["old follow-up"]);
      expect(manager.abort(id, "user")).toBe(true);
      expect(await parentWait).toBe("");
      expect(manager.getRuns(id)[0]).toMatchObject({ phase: "stopping", outcome: undefined });
      expect(completed).not.toHaveBeenCalled();
      expect(await manager.submitMessage(id, "too soon")).toMatchObject({ accepted: false, reason: "stopping" });
      const replacement = spawn("replacement");
      expect(manager.getRuns(replacement)[0].phase).toBe("queued");
      expect(manager.abort(replacement)).toBe(true);

      releaseResponse.resolve();
      await run.completion;
      expect(manager.getRuns(id)[0].outcome).toMatchObject({ status: "stopped", result: "first answer" });
      expect(provider).toHaveBeenCalledTimes(1);
      expect(session.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
        [{ type: "text", text: "first prompt" }],
      ]);
      expect.soft(completed.mock.results.at(-1)?.value).toEqual({ steering: [], followUp: [] });
      expect.soft(session.pendingMessageCount).toBe(0);
      expect(await manager.submitMessage(id, "second prompt")).toMatchObject({
        accepted: true,
        delivery: "continuation",
      });
      await manager.getRuns(id)[1].completion;
      const userContents = session.messages.flatMap((message) => (message.role === "user" ? [message.content] : []));
      expect(userContents).toEqual([
        [{ type: "text", text: "first prompt" }],
        [{ type: "text", text: "second prompt" }],
      ]);
      expect(provider).toHaveBeenCalledTimes(2);
    } finally {
      releaseResponse.resolve();
      await manager.dispose();
    }
  });

  it("waits for a deferred turn-limit steer and drops it before the next run", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const wrapUp = "You have reached your turn limit. Wrap up immediately";
    const { session, modelRuntime } = await sdkSession((pi) => {
      pi.on("input", async (event) => {
        if (event.text.startsWith(wrapUp)) {
          entered.resolve();
          await release.promise;
        }
        return { action: "continue" };
      });
    });
    vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    const prompt = vi.spyOn(session, "prompt");
    const clearQueue = vi.spyOn(session, "clearQueue");
    vi.spyOn(runner, "runAgent").mockImplementation(async (_owner, _ctx, _type, prompt, options) => {
      options.onSessionCreated?.(session);
      return runSessionPrompt(session, prompt, options);
    });
    const manager = new AgentManager(await createTestOwner());
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first run", {
      description: "first run",
      maxTurns: 1,
    });
    try {
      await entered.promise;
      await prompt.mock.results[0]?.value;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(manager.getRuns(id)[0].outcome).toBeUndefined();
      expect(clearQueue).not.toHaveBeenCalled();
      release.resolve();
      await manager.getRuns(id)[0].completion;
      expect(manager.getRuns(id)[0].outcome?.status).toBe("turn_limited");
      expect(clearQueue).toHaveReturnedWith({ steering: [expect.stringContaining(wrapUp)], followUp: [] });
      expect(clearQueue).toHaveBeenCalledTimes(1);
      expect(session.getSteeringMessages()).toEqual([]);
    } finally {
      release.resolve();
      await manager.dispose();
    }
  });

  it.each(["after settlement", "during a paused tool"] as const)(
    "preserves the composer draft when a steer cannot be consumed (%s)",
    async (when) => {
      const wrapUpEntered = deferred<void>();
      const releaseWrapUp = deferred<void>();
      const toolEntered = deferred<void>();
      const releaseTool = deferred<void>();
      const steerEntered = deferred<void>();
      const releaseSteer = deferred<void>();
      const sdkSettled = deferred<void>();
      const bind = deferred<void>();
      const draft = "  keep this exact draft  ";
      const wrapUp = "You have reached your turn limit. Wrap up immediately";
      const { session, modelRuntime, provider } = await sdkSession(undefined, [
        {
          name: "hold",
          label: "hold",
          description: "Deferred tool",
          parameters: Type.Object({}),
          execute: async () => {
            toolEntered.resolve();
            await releaseTool.promise;
            return { content: [{ type: "text", text: "tool finished" }], details: undefined };
          },
        },
      ]);
      vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
      vi.spyOn(session.extensionRunner, "hasHandlers").mockImplementation((event) => event === "input");
      const input = vi.spyOn(session.extensionRunner, "emitInput").mockImplementation(async (text) => {
        if (text.startsWith(wrapUp)) {
          wrapUpEntered.resolve();
          await releaseWrapUp.promise;
        }
        if (when === "during a paused tool" && text === draft) {
          steerEntered.resolve();
          await releaseSteer.promise;
        }
        return { action: "continue" };
      });
      if (when === "during a paused tool") {
        provider.mockImplementationOnce(() => {
          const stream = createAssistantMessageEventStream();
          const message = assistantMessage({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "call", name: "hold", arguments: {} }],
          });
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end(message);
          return stream;
        });
      }
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_settled") sdkSettled.resolve();
      });
      vi.spyOn(runner, "runAgent").mockImplementation(async (_owner, _ctx, _type, prompt, options) => {
        await bind.promise;
        options.onSessionCreated?.(session);
        return runSessionPrompt(session, prompt, options);
      });
      const manager = new AgentManager(await createTestOwner(), undefined, { default: 1 });
      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first run", {
        description: "first run",
        modelKey: "test/model",
        maxTurns: when === "after settlement" ? 1 : 2,
      });
      const run = manager.getRuns(id)[0];
      const submitted = deferred<Awaited<ReturnType<AgentManager["submitMessage"]>>>();
      const composer = new MessageComposer(
        "steer",
        async (message) => {
          const outcome = await manager.submitMessage(id, message);
          submitted.resolve(outcome);
          return outcome;
        },
        () => {},
        () => {},
      );
      const send = () => {
        composer.open();
        composer.input.setValue(draft);
        composer.handleInput("\r");
      };
      try {
        expect(await manager.submitMessage(id, "early")).toMatchObject({ accepted: true, delivery: "pending_steer" });
        bind.resolve();
        if (when === "during a paused tool") {
          await toolEntered.promise;
          expect(session.isStreaming).toBe(true);
          expect(await manager.submitMessage(id, "while tool is paused")).toMatchObject({
            accepted: true,
            delivery: "steer",
          });
          send();
          await steerEntered.promise;
          releaseTool.resolve();
        }
        await wrapUpEntered.promise;
        await sdkSettled.promise;
        expect(session.isStreaming).toBe(false);
        expect(manager.getRuns(id)[0].outcome).toBeUndefined();
        if (when === "after settlement") send();
        else releaseSteer.resolve();
        const outcome = await submitted.promise;
        await Promise.resolve(); // Let the composer's submit handler apply that outcome.
        expect.soft(outcome).toMatchObject({ accepted: false, reason: "settling" });
        expect.soft(composer.input.getValue()).toBe(draft);
        expect.soft(composer.feedback ?? "").toContain("Message not accepted:");
        if (when === "after settlement") expect.soft(input.mock.calls.some(([text]) => text === draft)).toBe(false);
        expect.soft(session.getSteeringMessages()).toEqual(when === "during a paused tool" ? [draft] : []);
        releaseWrapUp.resolve();
        await run.completion;
        expect(session.getSteeringMessages()).toEqual([]);
        expect(await manager.submitMessage(id, "next run")).toMatchObject({ accepted: true, delivery: "continuation" });
        await manager.getRuns(id)[1].completion;
        const userContents = session.messages.flatMap((message) => (message.role === "user" ? [message.content] : []));
        expect(userContents).toEqual(
          expect.arrayContaining([[{ type: "text", text: "early" }], [{ type: "text", text: "next run" }]]),
        );
        expect(userContents).not.toContainEqual([{ type: "text", text: draft }]);
      } finally {
        bind.resolve();
        releaseTool.resolve();
        releaseSteer.resolve();
        releaseWrapUp.resolve();
        unsubscribe();
        await manager.dispose();
      }
    },
  );

  it("pins the low-level SDK contract: agent_start listeners are awaited before request dispatch", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const streamFn = vi.fn<NonNullable<ConstructorParameters<typeof Agent>[0]>["streamFn"]>(() => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage();
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    });
    const agent = new Agent({ streamFn });
    agent.subscribe(async (event) => {
      if (event.type === "agent_start") {
        entered.resolve();
        await release.promise;
      }
    });
    const run = agent.prompt("task");
    await entered.promise;
    expect(streamFn).not.toHaveBeenCalled();
    expect(agent.state.isStreaming).toBe(true);
    release.resolve();
    await run;
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it("pins the SDK's asynchronous rejection when a registered extension command cannot be steered", async () => {
    const { session } = await sdkSession((pi) => {
      pi.registerCommand("blocked", { description: "Test command", handler: async () => {} });
    });
    await expect(session.steer("/blocked")).rejects.toThrow(/command/i);
    expect(session.getSteeringMessages()).toEqual([]);
  });

  it("does not prompt an already-aborted run", async () => {
    const { session, provider, modelRuntime } = await sdkSession();
    vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    const prompt = vi.spyOn(session, "prompt");
    const controller = new AbortController();
    controller.abort();
    const result = await runSessionPrompt(session, "task", { signal: controller.signal });
    expect(prompt).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(result.aborted).toBe(true);
  });

  it("replays abort at agent_start without awaiting the same loop's idle", async () => {
    const controller = new AbortController();
    const { session, provider, modelRuntime } = await sdkSession((pi) => {
      pi.on("before_agent_start", async () => {
        controller.abort();
      });
    });
    vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    const abort = vi.spyOn(session, "abort");
    await runSessionPrompt(session, "task", { signal: controller.signal });
    expect(abort).toHaveBeenCalledTimes(2);
    expect(provider).not.toHaveBeenCalled();
    expect(session.isIdle).toBe(true);
  });
});
