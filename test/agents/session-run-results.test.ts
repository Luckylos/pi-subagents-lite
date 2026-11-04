/**
 * session-run-results.test.ts — What a run reports when its prompt settles:
 * response text, the final model error, and parent abort forwarding.
 *
 * Drives runSessionPrompt() against the typed in-memory session from
 * run-session-harness.ts; no SDK module mocks are installed.
 */
import { describe, it, expect } from "vite-plus/test";
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
  messages.push(...added);
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

  it("prefers the streamed text over the message fallback", async () => {
    const messages = [...priorRun];
    const h = createRunSessionHarness(messages);
    const run = runSessionPrompt(h.session, "keep going", {});
    await h.promptStarted;
    h.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " streamed " },
    } as unknown as Parameters<typeof h.emit>[0]);
    messages.push(assistantMessage({ content: [{ type: "text", text: "stored" }] }));
    h.finishPrompt();
    expect((await run).responseText).toBe("streamed");
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
