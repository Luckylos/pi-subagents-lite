import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Type } from "typebox";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
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
import { DEFAULT_GRACE_TURNS } from "../../src/config/agent-settings.js";
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

function stopStream(message = assistantMessage({ content: [{ type: "text", text: "final answer" }] })) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}

function errorStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: message });
  stream.end(message);
  return stream;
}

function settlementEntries(session: AgentSession) {
  return session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "settle");
}

const settledEntry = { type: "custom", customType: "settle", data: { saved: true } } as const;

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

describe("runSessionPrompt — real SDK turn limits", () => {
  it.each([0, 2, undefined])(
    "caps provider and tool turns across initial and Continue with %s grace turns",
    async (graceTurns) => {
      const maxTurns = 1;
      const budget = maxTurns + (graceTurns ?? DEFAULT_GRACE_TURNS);
      const execute = vi.fn<ToolDefinition["execute"]>(async () => ({
        content: [{ type: "text", text: "tool finished" }],
        details: undefined,
      }));
      const { session, provider, modelRuntime } = await sdkSession(undefined, [
        { name: "hold", label: "Hold", description: "Needs a model response", parameters: Type.Object({}), execute },
      ]);
      vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
      provider.mockImplementation(() => {
        const stream = createAssistantMessageEventStream();
        const message = assistantMessage({
          stopReason: "toolUse",
          content: [
            { type: "text", text: `partial answer ${provider.mock.calls.length}` },
            { type: "toolCall", id: `call-${provider.mock.calls.length}`, name: "hold", arguments: {} },
          ],
        });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end(message);
        return stream;
      });
      const steer = vi.spyOn(session, "steer");
      const abort = vi.spyOn(session, "abort");
      const originalFinishTurn = session.agent.finishTurn;
      const turns = vi.fn();
      vi.spyOn(runner, "runAgent").mockImplementation(async (_owner, _ctx, _type, prompt, options) => {
        options.onSessionCreated?.(session);
        return runSessionPrompt(session, prompt, options);
      });
      const manager = new AgentManager(await createTestOwner());
      try {
        const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "initial", {
          description: "initial",
          maxTurns,
          graceTurns,
          onTurnEnd: turns,
        });
        await manager.getRuns(id)[0].completion;
        const first = manager.getRuns(id)[0].outcome;
        expect.soft(provider).toHaveBeenCalledTimes(budget);
        expect.soft(execute).toHaveBeenCalledTimes(budget);
        expect.soft(steer).toHaveBeenCalledTimes(graceTurns === 0 ? 0 : 1);
        expect.soft(abort).toHaveBeenCalledTimes(1);
        expect.soft(first).toMatchObject({
          status: "aborted",
          result: `partial answer ${budget}`,
          stats: { turnCount: budget, runTurnCount: budget },
        });
        expect.soft(session.pendingMessageCount).toBe(0);
        expect.soft(session.agent.finishTurn).toBe(originalFinishTurn);
        expect.soft(session.isIdle).toBe(true);

        expect(await manager.submitMessage(id, "continued")).toMatchObject({
          accepted: true,
          delivery: "continuation",
        });
        await manager.getRuns(id)[1].completion;
        const [retainedFirst, second] = manager.getRuns(id);
        expect.soft(provider).toHaveBeenCalledTimes(2 * budget);
        expect.soft(execute).toHaveBeenCalledTimes(2 * budget);
        expect.soft(steer).toHaveBeenCalledTimes(graceTurns === 0 ? 0 : 2);
        expect.soft(abort).toHaveBeenCalledTimes(2);
        expect.soft(retainedFirst.outcome).toBe(first);
        expect.soft(second.outcome).toMatchObject({
          status: "aborted",
          result: `partial answer ${2 * budget}`,
          stats: { turnCount: 2 * budget, runTurnCount: budget },
        });
        expect.soft(turns.mock.calls).toEqual(Array.from({ length: budget }, (_, index) => [index + 1]));
        expect.soft(session.pendingMessageCount).toBe(0);
        expect.soft(session.agent.finishTurn).toBe(originalFinishTurn);
        expect.soft(session.isIdle).toBe(true);
        const userMessages = session.messages.flatMap((message) => (message.role === "user" ? [message.content] : []));
        const wrapUp = [{ type: "text", text: expect.stringContaining("You have reached your turn limit.") }];
        expect(userMessages).toEqual([
          [{ type: "text", text: "initial" }],
          ...(graceTurns === 0 ? [] : [wrapUp]),
          [{ type: "text", text: "continued" }],
          ...(graceTurns === 0 ? [] : [wrapUp]),
        ]);
      } finally {
        await manager.dispose();
      }
    },
  );

  it.each([
    { maxTurns: 1, graceTurns: 0, requests: 1, turnLimited: false },
    { maxTurns: 1, graceTurns: 1, requests: 2, turnLimited: true },
    { maxTurns: 2, graceTurns: 0, requests: 1, turnLimited: false },
    { maxTurns: 0, graceTurns: 0, requests: 1, turnLimited: false },
    { maxTurns: undefined, graceTurns: 0, requests: 1, turnLimited: false },
  ])(
    "keeps final answers with maxTurns=$maxTurns, graceTurns=$graceTurns",
    async ({ maxTurns, graceTurns, requests, turnLimited }) => {
      const beforeSettle = vi.fn(() => ({ entries: [settledEntry] }));
      const { session, provider, modelRuntime } = await sdkSession((pi) => {
        pi.on("agent_before_settle", beforeSettle);
      });
      vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
      const steer = vi.spyOn(session, "steer");
      const turns = vi.fn();
      provider.mockImplementation(() =>
        stopStream(assistantMessage({ content: [{ type: "text", text: `answer ${provider.mock.calls.length}` }] })),
      );
      const result = await runSessionPrompt(session, "task", { maxTurns, graceTurns, onTurnEnd: turns });
      expect.soft(provider).toHaveBeenCalledTimes(requests);
      expect.soft(turns).toHaveBeenCalledTimes(requests);
      expect.soft(steer).toHaveBeenCalledTimes(requests - 1);
      expect.soft(session.pendingMessageCount).toBe(0);
      expect.soft(result).toMatchObject({ responseText: `answer ${requests}`, aborted: false, turnLimited });
      expect
        .soft(beforeSettle)
        .toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }), expect.anything());
      expect(settlementEntries(session)).toMatchObject([settledEntry]);
    },
  );

  it("preserves a provider error at the cap and blocks SDK retries", async () => {
    const { session, provider, modelRuntime } = await sdkSession();
    vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    session.settingsManager.setRetryEnabled(true);
    provider.mockImplementationOnce(() => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage({ stopReason: "error", errorMessage: "429 rate limit exceeded" });
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
      return stream;
    });
    const steer = vi.spyOn(session, "steer");
    const turns = vi.fn();
    const result = await runSessionPrompt(session, "task", { maxTurns: 1, graceTurns: 0, onTurnEnd: turns });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(turns.mock.calls).toEqual([[1]]);
    expect(steer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ responseText: "", aborted: false, modelError: "429 rate limit exceeded" });
  });

  it("retains a naturally terminating tool batch at the cap", async () => {
    const execute = vi.fn<ToolDefinition["execute"]>();
    const { session, provider, modelRuntime } = await sdkSession(
      (pi) => {
        pi.on("tool_call", () => ({ block: true, reason: "Finish here", terminate: true }));
        pi.on("agent_before_settle", () => ({ entries: [settledEntry] }));
      },
      [{ name: "hold", label: "Hold", description: "Blocked by the extension", parameters: Type.Object({}), execute }],
    );
    vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
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
    const result = await runSessionPrompt(session, "task", { maxTurns: 1, graceTurns: 0 });
    expect(execute).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ aborted: false, turnLimited: false });
    expect(settlementEntries(session)).toMatchObject([settledEntry]);
  });

  it("reports truncation when agent_end queues a follow-up after an await", async () => {
    let child: AgentSession;
    const queued = vi.fn();
    const { session, provider } = await sdkSession((pi) => {
      pi.on("agent_end", async () => queued(await child.followUp("late follow-up")));
    });
    child = session;
    provider.mockImplementation(() => stopStream());
    const turns = vi.fn();
    vi.spyOn(runner, "runAgent").mockImplementation(async (_owner, _ctx, _type, prompt, options) => {
      options.onSessionCreated?.(session);
      return runSessionPrompt(session, prompt, options);
    });
    const manager = new AgentManager(await createTestOwner());
    try {
      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        maxTurns: 1,
        graceTurns: 0,
        onTurnEnd: turns,
      });
      const [run] = manager.getRuns(id);
      await run.completion;
      expect(queued.mock.calls).toEqual([["queued"]]);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(turns.mock.calls).toEqual([[1]]);
      expect(session.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
        [{ type: "text", text: "task" }],
      ]);
      expect(session.pendingMessageCount).toBe(0);
      expect(manager.getRuns(id)[0].outcome).toMatchObject({ result: "final answer", status: "aborted" });
    } finally {
      await manager.dispose();
    }
  });

  it.each([true, false])(
    "persists settlement entries and gates a continuation with runnable context = %s",
    async (runnable) => {
      const settled = vi.fn();
      const beforeSettle = vi.fn(() => ({
        continue: true,
        entries: [
          settledEntry,
          ...(runnable
            ? [{ type: "custom_message" as const, customType: "settle-context", content: "continue", display: false }]
            : []),
        ],
      }));
      const { session, provider } = await sdkSession((pi) => {
        pi.on("agent_before_settle", beforeSettle);
        pi.on("agent_settled", settled);
      });
      provider.mockImplementation(() => stopStream());
      const turns = vi.fn();
      const continueAgent = session.agent.continue;
      const result = await runSessionPrompt(session, "task", { maxTurns: 1, graceTurns: 0, onTurnEnd: turns });
      expect.soft(beforeSettle).toHaveBeenCalledTimes(1);
      expect.soft(settled).toHaveBeenCalledTimes(1);
      expect.soft(settlementEntries(session)).toMatchObject([settledEntry]);
      expect.soft(provider).toHaveBeenCalledTimes(1);
      expect.soft(turns.mock.calls).toEqual([[1]]);
      expect.soft(session.agent.continue).toBe(continueAgent);
      expect(session.messages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        ...(runnable ? ["custom"] : []),
      ]);
      expect(result).toMatchObject({ responseText: "final answer", aborted: runnable, turnLimited: runnable });
    },
  );

  it("runs a settlement continuation when turns remain", async () => {
    const beforeSettle = vi.fn(() => ({ entries: [settledEntry] }));
    const { session, provider } = await sdkSession((pi) => {
      pi.on("agent_before_settle", async () => {
        if (beforeSettle.mock.calls.length === 0) await session.followUp("finish the task");
        return beforeSettle();
      });
    });
    provider.mockImplementation(() =>
      stopStream(assistantMessage({ content: [{ type: "text", text: `answer ${provider.mock.calls.length}` }] })),
    );
    const turns = vi.fn();
    const result = await runSessionPrompt(session, "task", { maxTurns: 2, graceTurns: 0, onTurnEnd: turns });
    expect(beforeSettle).toHaveBeenCalledTimes(2);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(turns.mock.calls).toEqual([[1], [2]]);
    expect(settlementEntries(session)).toMatchObject([settledEntry, settledEntry]);
    expect(result).toMatchObject({ responseText: "answer 2", aborted: false, turnLimited: false });
  });

  it("honors Stop during an awaited settlement hook and preserves its entries", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const { session, provider } = await sdkSession((pi) => {
      pi.on("agent_before_settle", async () => {
        entered.resolve();
        await release.promise;
        return {
          entries: [
            settledEntry,
            { type: "custom_message", customType: "settle-context", content: "continue", display: false },
          ],
          continue: true,
        };
      });
    });
    provider.mockImplementation(() => stopStream());
    const run = runSessionPrompt(session, "task", { maxTurns: 1, graceTurns: 0, signal: controller.signal });
    await Promise.race([
      entered.promise,
      run.then(() => {
        throw new Error("The prompt settled before its boundary hook ran");
      }),
    ]);
    controller.abort();
    release.resolve();
    expect(await run).toMatchObject({ responseText: "final answer", aborted: true, turnLimited: false });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(settlementEntries(session)).toMatchObject([settledEntry]);
  });

  it("blocks post-run automatic compaction at the cap and still settles", async () => {
    const beforeSettle = vi.fn(() => ({ entries: [settledEntry] }));
    const { session, provider } = await sdkSession((pi) => {
      pi.on("agent_before_settle", beforeSettle);
    });
    provider.mockImplementation(() => stopStream());
    await runSessionPrompt(session, "preceding task", {});
    beforeSettle.mockClear();
    const compaction = vi.fn();
    session.subscribe((event) => {
      if (event.type === "compaction_end") compaction(event);
      if (event.type === "agent_end") session.settingsManager.setCompactionEnabled(true);
    });
    const settings = session.settingsManager;
    const getCompactionSettings = settings.getCompactionSettings.bind(settings);
    vi.spyOn(settings, "getCompactionSettings").mockImplementation((model) => ({
      ...getCompactionSettings(model),
      keepRecentTokens: 1,
    }));
    const usage: AssistantMessage["usage"] = { ...assistantMessage().usage, input: 190_000, totalTokens: 190_000 };
    provider.mockImplementationOnce(() =>
      stopStream(assistantMessage({ usage, content: [{ type: "text", text: "final answer" }] })),
    );
    const result = await runSessionPrompt(session, "task", { maxTurns: 1, graceTurns: 0 });
    expect.soft(provider).toHaveBeenCalledTimes(2);
    expect
      .soft(compaction)
      .toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "threshold", aborted: true }));
    expect.soft(beforeSettle).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ responseText: "final answer", aborted: false, turnLimited: false });
  });

  it("cuts off an extension's queued continuation before the SDK inserts it into history", async () => {
    const { session, provider, modelRuntime } = await sdkSession();
    vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    const previous = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      await previous?.(turn, signal);
      await session.followUp("queued by the completed turn");
      return { action: "continue" };
    };
    const finishTurn = session.agent.finishTurn;
    const result = await runSessionPrompt(session, "task", { maxTurns: 1, graceTurns: 0 });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ aborted: true, turnLimited: true });
    expect(session.agent.finishTurn).toBe(finishTurn);
    expect(session.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      [{ type: "text", text: "task" }],
    ]);
  });

  it("restores SDK hooks and propagates a rejected prompt", async () => {
    const { session, provider } = await sdkSession();
    const originalFinishTurn = session.agent.finishTurn;
    const originalContinue = session.agent.continue;
    const hadOwnContinue = Object.hasOwn(session.agent, "continue");
    vi.spyOn(session, "prompt").mockRejectedValueOnce(new Error("prompt failed"));
    const onPromptStateChange = vi.fn();
    await expect(
      runSessionPrompt(session, "task", { maxTurns: 1, graceTurns: 0, onPromptStateChange }),
    ).rejects.toThrow("prompt failed");
    expect(provider).not.toHaveBeenCalled();
    expect(session.agent.finishTurn).toBe(originalFinishTurn);
    expect(session.agent.continue).toBe(originalContinue);
    expect(Object.hasOwn(session.agent, "continue")).toBe(hadOwnContinue);
    expect(onPromptStateChange.mock.calls).toEqual([["finished"]]);
  });
});

describe("runSessionPrompt — real SDK result ownership", () => {
  it.each(["stop", "error"] as const)("keeps the current %s result after preflight compaction", async (stopReason) => {
    const compact = vi.fn<() => void>();
    const { session, provider } = await sdkSession((pi) => {
      pi.on("session_before_compact", ({ preparation, reason }) => {
        expect(reason).toBe("threshold");
        compact();
        return {
          compaction: {
            summary: "Earlier prompts summarized locally",
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
          },
        };
      });
    });
    const usage = { ...assistantMessage().usage, input: 190_000, totalTokens: 190_000 };
    provider.mockImplementation(() =>
      stopStream(assistantMessage({ usage, content: [{ type: "text", text: "old answer" }] })),
    );
    for (let i = 0; i < 3; i++) await session.prompt(`prior task ${i}`);
    const before = session.messages.length;
    const settings = session.settingsManager;
    settings.setCompactionEnabled(true);
    const getCompactionSettings = settings.getCompactionSettings.bind(settings);
    vi.spyOn(settings, "getCompactionSettings").mockImplementation((model) => ({
      ...getCompactionSettings(model),
      keepRecentTokens: 1,
    }));
    const current = assistantMessage({
      stopReason,
      content: stopReason === "stop" ? [{ type: "text", text: "current answer" }] : [],
      errorMessage: stopReason === "error" ? "current provider failure" : undefined,
    });
    provider.mockImplementationOnce(() => (stopReason === "stop" ? stopStream(current) : errorStream(current)));
    const onTextDelta = vi.fn();
    const result = await runSessionPrompt(session, "task after compaction", { onTextDelta });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(session.messages.at(-1)).toBe(current);
    expect(session.messages.length).toBeLessThan(before);
    expect(provider).toHaveBeenCalledTimes(4);
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      responseText: stopReason === "stop" ? "current answer" : "",
      modelError: current.errorMessage,
      aborted: false,
    });
  });

  it("keeps the finalized answer after a settlement compaction removes it from context", async () => {
    const { session, provider } = await sdkSession((pi) => {
      pi.on("agent_before_settle", () => ({
        entries: [{ type: "compaction", summary: "Summarized the completed activity", firstKeptEntryId: null }],
      }));
    });
    provider.mockImplementationOnce(() => stopStream());
    const result = await runSessionPrompt(session, "task", {});

    expect(session.messages.some((message) => message.role === "assistant")).toBe(false);
    expect(session.messages.some((message) => message.role === "compactionSummary")).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ responseText: "final answer", modelError: undefined, aborted: false });
  });

  it("drops the response Pi discards before retrying a context overflow", async () => {
    const { session, provider } = await sdkSession((pi) => {
      pi.on("session_before_compact", ({ preparation }) => ({
        compaction: {
          summary: "Earlier prompts summarized locally",
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      }));
    });
    const usage = { ...assistantMessage().usage, input: 1000, totalTokens: 1000 };
    provider.mockImplementation(() =>
      stopStream(assistantMessage({ usage, content: [{ type: "text", text: "old answer" }] })),
    );
    for (let i = 0; i < 3; i++) await session.prompt("prior task " + i);
    const settings = session.settingsManager;
    settings.setCompactionEnabled(true);
    const getCompactionSettings = settings.getCompactionSettings.bind(settings);
    vi.spyOn(settings, "getCompactionSettings").mockImplementation((model) => ({
      ...getCompactionSettings(model),
      keepRecentTokens: 1,
    }));
    const failed = assistantMessage({
      timestamp: Date.now(),
      usage,
      stopReason: "error",
      errorMessage: "prompt is too long: maximum context length exceeded",
      content: [{ type: "text", text: "discarded overflow text" }],
    });
    const recovered = assistantMessage({ content: [{ type: "thinking", thinking: "no answer text" }] });
    provider.mockImplementationOnce(() => errorStream(failed)).mockImplementationOnce(() => stopStream(recovered));
    const overflowRetry = vi.fn();
    session.subscribe((event) => {
      if (event.type === "compaction_end" && event.reason === "overflow" && event.willRetry) overflowRetry();
    });

    const result = await runSessionPrompt(session, "task triggering overflow", {});

    expect(overflowRetry).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(5);
    expect(session.messages).not.toContain(failed);
    expect(session.messages.at(-1)).toBe(recovered);
    expect(result).toMatchObject({ responseText: "", modelError: undefined, aborted: false });
  });

  it.each(["stop", "error"] as const)(
    "drops a retried attempt's text when the next attempt ends in %s",
    async (stopReason) => {
      const { session, provider } = await sdkSession();
      const retrySettings = session.settingsManager.getRetrySettings();
      vi.spyOn(session.settingsManager, "getRetrySettings").mockReturnValue({
        ...retrySettings,
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 1,
      });
      const failed = assistantMessage({
        stopReason: "error",
        errorMessage: "429 rate limit exceeded",
        content: [{ type: "text", text: "discarded attempt" }],
      });
      const final = assistantMessage({
        stopReason,
        errorMessage: stopReason === "error" ? "429 still rate limited" : undefined,
        content: [{ type: "thinking", thinking: "no answer text" }],
      });
      provider
        .mockImplementationOnce(() => errorStream(failed))
        .mockImplementationOnce(() => (stopReason === "error" ? errorStream(final) : stopStream(final)));
      const retryEvents: string[] = [];
      session.subscribe((event) => {
        if (event.type === "auto_retry_start" || event.type === "auto_retry_end") retryEvents.push(event.type);
      });

      const result = await runSessionPrompt(session, "task", {});

      expect(retryEvents).toEqual(["auto_retry_start", "auto_retry_end"]);
      expect(provider).toHaveBeenCalledTimes(2);
      expect(session.messages).not.toContain(failed);
      expect(session.messages.at(-1)).toBe(final);
      expect(result).toMatchObject({ responseText: "", modelError: final.errorMessage, aborted: false });
    },
  );

  it.each([false, true])("owns SDK retry attempts when cancelled during backoff = %s", async (cancel) => {
    const { session, provider } = await sdkSession();
    const retry = deferred<void>();
    session.settingsManager.setRetryEnabled(true);
    const getRetrySettings = session.settingsManager.getRetrySettings.bind(session.settingsManager);
    vi.spyOn(session.settingsManager, "getRetrySettings").mockImplementation(() => ({
      ...getRetrySettings(),
      baseDelayMs: cancel ? 60_000 : 1,
    }));
    const failed = assistantMessage({
      stopReason: "error",
      errorMessage: "429 rate limit exceeded",
      content: [{ type: "text", text: "discarded attempt" }],
    });
    provider.mockImplementationOnce(() => errorStream(failed)).mockImplementationOnce(() => stopStream());
    session.subscribe((event) => {
      if (event.type === "auto_retry_start") retry.resolve();
    });
    const controller = new AbortController();
    const onTurnEnd = vi.fn();
    const run = runSessionPrompt(session, "task", { signal: controller.signal, onTurnEnd });
    if (cancel) {
      try {
        await Promise.race([retry.promise, run]);
        expect(session.isRetrying).toBe(true);
      } finally {
        controller.abort();
        await run;
      }
    }
    const result = await run;
    expect(session.messages).not.toContain(failed);
    expect(provider).toHaveBeenCalledTimes(cancel ? 1 : 2);
    expect(onTurnEnd).toHaveBeenCalledTimes(cancel ? 1 : 2);
    expect(result).toMatchObject({
      responseText: cancel ? "" : "final answer",
      modelError: undefined,
      aborted: cancel,
    });
  });

  it("excludes the explicit prompt deferred by an agent_settled handler", async () => {
    let submitted = false;
    const { session, provider } = await sdkSession((pi) => {
      pi.on("agent_settled", () => {
        if (!submitted) {
          submitted = true;
          pi.sendUserMessage("independent activity");
        }
      });
    });
    const extra = assistantMessage({
      content: [{ type: "text", text: "independent response" }],
      stopReason: "error",
      errorMessage: "independent provider error",
    });
    provider
      .mockImplementationOnce(() => stopStream())
      .mockImplementationOnce(() => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: assistantMessage() });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "independent response", partial: extra });
        stream.push({ type: "error", reason: "error", error: extra });
        stream.end(extra);
        return stream;
      });
    const onTextDelta = vi.fn();
    const result = await runSessionPrompt(session, "owned activity", { onTextDelta });

    expect(provider).toHaveBeenCalledTimes(2);
    expect(session.messages.at(-1)).toBe(extra);
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(result).toMatchObject({ responseText: "final answer", modelError: undefined, aborted: false });
  });
});

describe("runSessionPrompt — real SDK cancellation contract", () => {
  it("allows independent activity after agent_settled without charging it to the preceding run's turn cap", async () => {
    const toolEntered = deferred<void>();
    const releaseTool = deferred<void>();
    let submitted = false;
    const execute = vi.fn<ToolDefinition["execute"]>(async () => {
      toolEntered.resolve();
      await releaseTool.promise;
      return { content: [{ type: "text", text: "tool finished" }], details: undefined };
    });
    const { session, provider } = await sdkSession(
      (pi) => {
        pi.on("agent_settled", () => {
          if (!submitted) {
            submitted = true;
            pi.sendUserMessage("independent activity");
          }
        });
      },
      [{ name: "hold", label: "Hold", description: "Deferred tool", parameters: Type.Object({}), execute }],
    );
    const toolCall = assistantMessage({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "independent-call", name: "hold", arguments: {} }],
    });
    const extra = assistantMessage({
      content: [{ type: "text", text: "independent response" }],
      usage: { ...assistantMessage().usage, input: 3, totalTokens: 3 },
    });
    provider
      .mockImplementationOnce(() => stopStream())
      .mockImplementationOnce(() => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "toolUse", message: toolCall });
        stream.end(toolCall);
        return stream;
      })
      .mockImplementationOnce(() => stopStream(extra));
    const originalFinishTurn = session.agent.finishTurn;
    const originalContinue = session.agent.continue;
    const abort = vi.spyOn(session, "abort");
    const dispose = vi.spyOn(session, "dispose");
    const onTurnEnd = vi.fn();
    const onToolActivity = vi.fn();
    const prompt = vi.spyOn(runner, "runAgent").mockImplementation(async (_owner, _ctx, _type, prompt, options) => {
      options.onSessionCreated?.(session);
      const result = await runSessionPrompt(session, prompt, options);
      expect.soft(result).toMatchObject({ responseText: "final answer", aborted: false, turnLimited: false });
      return result;
    });
    const manager = new AgentManager(await createTestOwner(), undefined, { default: 1 });
    const spawn = (text: string) =>
      manager.spawn(fakePi(), fakeCtx(), "general-purpose", text, {
        description: text,
        modelKey: "test/model",
        maxTurns: 2,
        graceTurns: 0,
        onTurnEnd,
        onToolActivity,
      });
    const id = spawn("owned activity");
    const [run] = manager.getRuns(id);
    try {
      await toolEntered.promise;
      expect(session.isStreaming).toBe(true);
      expect(manager.getRuns(id)[0].outcome).toBeUndefined();
      expect(manager.clear(id)).toBe(false);
      expect(dispose).not.toHaveBeenCalled();
      expect.soft(await manager.submitMessage(id, "too early")).toMatchObject({ accepted: false, reason: "settling" });
      const replacement = spawn("replacement");
      expect(manager.getRuns(replacement)[0].phase).toBe("queued");
      expect(manager.abort(replacement)).toBe(true);
      expect(prompt).toHaveBeenCalledTimes(1);

      releaseTool.resolve();
      await run.completion;
      expect.soft(manager.getRuns(id)[0].outcome).toMatchObject({
        status: "completed",
        result: "final answer",
        stats: { turnCount: 1, runTurnCount: 1, toolUses: 1, lifetimeUsage: { input: 3 } },
      });
      expect.soft(onTurnEnd.mock.calls).toEqual([[1]]);
      expect.soft(onToolActivity).not.toHaveBeenCalled();
      expect.soft(abort).not.toHaveBeenCalled();
      expect.soft(provider).toHaveBeenCalledTimes(3);
      expect.soft(session.messages.at(-1)).toBe(extra);
      expect(session.agent.finishTurn).toBe(originalFinishTurn);
      expect(session.agent.continue).toBe(originalContinue);
      expect(session.isIdle).toBe(true);
    } finally {
      releaseTool.resolve();
      await manager.dispose();
    }
  });
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
      expect(await parentWait).toMatchObject({ status: "stopping" });
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
