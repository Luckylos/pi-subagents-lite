/**
 * session-run-events.test.ts — subscribeToSessionEvents forwarding: usage,
 * tool activity, and compaction, driven through the typed in-memory session.
 */
import { describe, it, expect, vi } from "vite-plus/test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { subscribeToSessionEvents } from "../../src/agents/session-run.js";
import { createRunSessionHarness } from "./run-session-harness.js";

/** Events here carry only the fields the forwarder reads. */
const event = (e: Record<string, unknown>) => e as unknown as AgentSessionEvent;

const assistantEnd = (usage?: Record<string, unknown>, role = "assistant") =>
  event({ type: "message_end", message: { role, content: "Hello", ...(usage ? { usage } : {}) } });

describe("subscribeToSessionEvents — usage", () => {
  it.each([
    {
      name: "extracts u.cost?.total from assistant message_end events",
      usage: { input: 100, output: 50, cacheWrite: 10, cost: { total: 2.5 } },
      expected: { input: 100, output: 50, cacheWrite: 10, cacheRead: 0, cost: 2.5 },
    },
    {
      name: "defaults cost to 0 when message.usage has no cost field",
      usage: { input: 100, output: 50, cacheWrite: 10 },
      expected: { input: 100, output: 50, cacheWrite: 10, cacheRead: 0, cost: 0 },
    },
    {
      name: "defaults cost to 0 when cost.total is null",
      usage: { input: 100, output: 50, cacheWrite: 10, cost: { total: null } },
      expected: { input: 100, output: 50, cacheWrite: 10, cacheRead: 0, cost: 0 },
    },
    {
      name: "extracts nonzero cacheRead from usage",
      usage: { input: 100, output: 50, cacheWrite: 10, cacheRead: 200, cost: { total: 1.5 } },
      expected: { input: 100, output: 50, cacheWrite: 10, cacheRead: 200, cost: 1.5 },
    },
  ])("$name", ({ usage, expected }) => {
    const onAssistantUsage = vi.fn();
    const h = createRunSessionHarness();
    const unsub = subscribeToSessionEvents(h.session, { onAssistantUsage });
    expect(h.listenerCount()).toBe(1);

    h.emit(assistantEnd(usage));

    expect(onAssistantUsage).toHaveBeenCalledWith(expected);
    unsub();
    expect(h.listenerCount()).toBe(0);
  });

  it.each([
    {
      name: "user message_end events",
      e: assistantEnd({ input: 0, output: 0, cacheWrite: 0, cost: { total: 100 } }, "user"),
    },
    { name: "other event types", e: event({ type: "turn_end" }) },
    { name: "an assistant message without usage", e: assistantEnd() },
  ])("does not fire onAssistantUsage for $name", ({ e }) => {
    const onAssistantUsage = vi.fn();
    const h = createRunSessionHarness();
    const unsub = subscribeToSessionEvents(h.session, { onAssistantUsage });

    h.emit(e);

    expect(onAssistantUsage).not.toHaveBeenCalled();
    unsub();
  });
});

describe("subscribeToSessionEvents — tools and compaction", () => {
  it("forwards toolCallId on tool activity events", () => {
    const onToolActivity = vi.fn();
    const h = createRunSessionHarness();
    const unsub = subscribeToSessionEvents(h.session, { onToolActivity });

    h.emit(event({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: {} }));
    expect(onToolActivity).toHaveBeenCalledWith({ type: "start", toolName: "bash", toolCallId: "call_1" });
    h.emit(event({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: {}, isError: false }));
    expect(onToolActivity).toHaveBeenCalledWith({ type: "end", toolName: "bash", toolCallId: "call_1" });
    unsub();
  });

  it("forwards compaction_end events to onCompaction, skipping aborted ones", () => {
    const onCompaction = vi.fn();
    const h = createRunSessionHarness();
    const unsub = subscribeToSessionEvents(h.session, { onCompaction });

    h.emit(event({ type: "compaction_end", aborted: false, reason: "threshold", result: { tokensBefore: 150000 } }));
    expect(onCompaction).toHaveBeenCalledWith({ reason: "threshold", tokensBefore: 150000 });
    h.emit(event({ type: "compaction_end", aborted: true, reason: "threshold", result: undefined }));
    expect(onCompaction).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not subscribe when no callbacks are provided", () => {
    const h = createRunSessionHarness();
    const unsub = subscribeToSessionEvents(h.session, {});
    expect(h.listenerCount()).toBe(0);
    expect(typeof unsub).toBe("function");
  });
});
