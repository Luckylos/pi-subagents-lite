/**
 * session-run-results.test.ts — What a run reports when its prompt settles:
 * response text, the final model error, and parent abort forwarding.
 *
 * Drives runSessionPrompt() against the typed in-memory session from
 * run-session-harness.ts; no SDK module mocks are installed.
 */
import { describe, it, expect, vi } from "vite-plus/test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { runSessionPrompt, type SessionPromptOptions } from "../../src/agents/session-run.js";
import { createRunSessionHarness } from "./run-session-harness.js";
import { assistantMessage, userMessage } from "./session-messages.js";

type Messages = AgentSession["messages"];

/** Run one prompt: `before` is the session history, `added` lands during the prompt. */
async function runPrompt(before: Messages, added: Messages, options: SessionPromptOptions = {}) {
  const messages = [...before];
  const h = createRunSessionHarness(messages);
  const run = runSessionPrompt(h.session, "keep going", options);
  await h.promptStarted;
  for (const message of added) {
    messages.push(message);
    h.emit({ type: "message_end", message });
  }
  h.finishPrompt();
  return { result: await run, h };
}

describe("runSessionPrompt — final model error", () => {
  it.each([
    {
      name: "returns the provider error when the final assistant message has stopReason 'error'",
      added: [assistantMessage({ stopReason: "error", errorMessage: "model failed to load into memory" })],
      expected: "model failed to load into memory",
    },
    {
      name: "leaves modelError undefined when the final assistant message completed normally",
      added: [assistantMessage({ content: [{ type: "text", text: "done" }] })],
      expected: undefined,
    },
    {
      name: "does not fail the run when an earlier error was followed by a successful turn",
      added: [
        assistantMessage({ stopReason: "error", errorMessage: "transient" }),
        assistantMessage({ content: [{ type: "text", text: "recovered" }] }),
      ],
      expected: undefined,
    },
    {
      name: "does not treat an aborted final message as a model error",
      added: [assistantMessage({ stopReason: "aborted" })],
      expected: undefined,
    },
    {
      name: "ignores an error stop without a message",
      added: [assistantMessage({ stopReason: "error", errorMessage: "   " })],
      expected: undefined,
    },
  ])("$name", async ({ added, expected }) => {
    const { result } = await runPrompt([userMessage("task")], added);
    expect(result.modelError).toBe(expected);
  });
});

describe("runSessionPrompt — response text scoped to this prompt", () => {
  const priorRun = [
    userMessage("first task"),
    assistantMessage({ content: [{ type: "text", text: "first run answer" }] }),
  ];

  it("does not surface the prior run's text when this prompt ends in a model error", async () => {
    const { result } = await runPrompt(priorRun, [
      userMessage("keep going"),
      assistantMessage({ stopReason: "error", errorMessage: "provider boom" }),
    ]);
    expect(result.responseText).toBe("");
    expect(result.modelError).toBe("provider boom");
  });

  it("does not surface the prior run's text when this prompt is aborted without text", async () => {
    const { result } = await runPrompt(priorRun, [
      userMessage("keep going"),
      assistantMessage({ stopReason: "aborted" }),
    ]);
    expect(result.responseText).toBe("");
    expect(result.modelError).toBeUndefined();
  });

  it("falls back to this prompt's own assistant text when no delta was streamed", async () => {
    const { result } = await runPrompt(priorRun, [
      userMessage("keep going"),
      assistantMessage({ content: [{ type: "text", text: "continued answer" }] }),
    ]);
    expect(result.responseText).toBe("continued answer");
  });

  it.each([
    {
      message: assistantMessage({ content: [{ type: "text", text: " current output " }] }),
      responseText: "current output",
      modelError: undefined,
    },
    {
      message: assistantMessage({ stopReason: "error", errorMessage: "current provider failure" }),
      responseText: "",
      modelError: "current provider failure",
    },
  ])("collects the current result after the message list shrinks ($message.stopReason)", async (c) => {
    const messages = [...priorRun, userMessage("another old request")];
    const h = createRunSessionHarness(messages);
    const run = runSessionPrompt(h.session, "keep going", {});
    await h.promptStarted;
    messages.splice(0, messages.length, c.message);
    h.emit({ type: "message_end", message: c.message });
    h.finishPrompt();
    expect(await run).toMatchObject({ responseText: c.responseText, modelError: c.modelError });
  });

  it("prefers the whole streamed response and ignores non-assistant messages", async () => {
    const messages = [...priorRun];
    const h = createRunSessionHarness(messages);
    const onTextDelta = vi.fn();
    const run = runSessionPrompt(h.session, "keep going", { onTextDelta });
    const message = assistantMessage({ content: [{ type: "text", text: "stored" }] });
    const trailing = userMessage("not assistant output");
    await h.promptStarted;
    h.emit({ type: "message_start", message });
    h.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " streamed", partial: message },
    });
    h.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " answer ", partial: message },
    });
    h.emit({ type: "message_end", message });
    h.emit({ type: "message_start", message: trailing });
    h.emit({ type: "message_end", message: trailing });
    messages.push(message, trailing);
    h.finishPrompt();
    expect(onTextDelta.mock.calls).toEqual([
      [" streamed", " streamed"],
      [" answer ", " streamed answer "],
    ]);
    expect((await run).responseText).toBe("streamed answer");
  });

  it.each([
    assistantMessage({
      stopReason: "error",
      errorMessage: "transient",
      content: [{ type: "text", text: "partial answer" }],
    }),
    assistantMessage({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "partial answer" },
        { type: "toolCall", id: "call", name: "read", arguments: {} },
      ],
    }),
  ])("uses the last textful assistant message ($stopReason) when the final output is non-text", async (message) => {
    const { result } = await runPrompt(priorRun, [
      message,
      assistantMessage({ content: [{ type: "thinking", thinking: "private reasoning" }] }),
    ]);
    expect(result).toMatchObject({ responseText: "partial answer", modelError: undefined });
  });

  it("returns no old result when the prompt emits no assistant message", async () => {
    const { result } = await runPrompt(
      [...priorRun, assistantMessage({ stopReason: "error", errorMessage: "old error" })],
      [userMessage("new request")],
    );
    expect(result).toMatchObject({ responseText: "", modelError: undefined });
  });
});

describe("runSessionPrompt — parent abort", () => {
  it("forwards an abort signal to the session while the prompt runs", async () => {
    const controller = new AbortController();
    const h = createRunSessionHarness();
    const run = runSessionPrompt(h.session, "task", { signal: controller.signal });
    await h.promptStarted;
    controller.abort();
    expect(h.abort).toHaveBeenCalledTimes(1);
    h.finishPrompt();
    await run;
  });

  it("stops forwarding once the prompt settled", async () => {
    const controller = new AbortController();
    const { h } = await runPrompt([], [], { signal: controller.signal });
    controller.abort();
    expect(h.abort).not.toHaveBeenCalled();
  });
});
