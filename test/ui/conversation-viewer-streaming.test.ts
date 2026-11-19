/** Streaming lifecycle with the SDK's separate in-flight assistant state. */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { TUI } from "@earendil-works/pi-tui";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { assistantMessage } from "../agents/session-messages.js";
import type { AgentRecord } from "../../src/types.js";
import type { Theme } from "../../src/ui/types.js";
import { asAgentSession } from "../pi-boundaries.js";

const mockSubscribe = vi.fn<(listener: (event?: unknown) => void) => () => void>(() => () => {});
const mockRequestRender = vi.fn();

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: vi.fn(() => false),
  Input: class {
    focused = false;
    handleInput(_data: string) {}
    render(_w: number): string[] {
      return [""];
    }
  },
  Markdown: class {
    _text = "";
    constructor(text: string) {
      this._text = text;
    }
    setText(text: string) {
      this._text = text;
    }
    render(_width: number): string[] {
      return this._text.split("\n");
    }
  },
  truncateToWidth: vi.fn((s: string, w: number) => (s.length > w ? s.slice(0, w - 3) + "..." : s)),
  visibleWidth: vi.fn((s: string) => s.length),
  wrapTextWithAnsi: vi.fn((text: string) => text.split("\n")),
}));
vi.mock("../../src/pi-settings.js", () => ({
  getHideThinkingBlock: vi.fn(() => false),
  readPiSettings: vi.fn(),
}));

import { ConversationViewer } from "../../src/ui/conversation-viewer.js";

const noopTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
interface Msg {
  role: string;
  content: string | Block[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
}

/** An assistant partial carrying exactly these content blocks. */
function msgWith(...blocks: Block[]): Msg {
  return { role: "assistant", content: blocks };
}

function makeRecord(session: unknown): AgentRecord {
  return {
    id: "abc12345",
    lifecycle: { status: "running", startedAt: Date.now() - 30000, completedAt: undefined, started: true },
    display: { type: "builder", description: "test agent", invocation: { modelName: "sonnet" } },
    stats: {
      lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
      toolUses: 5,
      turnCount: 10,
      compactionCount: 0,
    },
    execution: { session },
  } as AgentRecord;
}

function makeTui(): TUI {
  return {
    terminal: { rows: 40, cols: 120 },
    requestRender: mockRequestRender,
  } as unknown as TUI;
}

/** pi-agent-core 1.5.2 appends the assistant only at message_end. */
class FakeStream {
  subscriber: (event?: unknown) => void = () => {};
  state: { streamingMessage?: Msg } = {};
  constructor(public messages: Msg[]) {}
  start(): void {
    const empty = msgWith();
    this.state.streamingMessage = empty;
    this.subscriber({ type: "message_start", message: empty });
  }
  event(meType: string, partial: Msg, delta?: string): void {
    this.state.streamingMessage = partial;
    this.subscriber({ type: "message_update", assistantMessageEvent: { type: meType, delta }, message: partial });
  }
  end(final: Msg): void {
    this.state.streamingMessage = undefined;
    this.messages.push(final);
    this.subscriber({ type: "message_end", message: final });
  }
  toolEnd(toolCallId: string, isError: boolean): void {
    this.subscriber({ type: "tool_execution_end", toolCallId, isError });
  }
  toolResult(toolCallId: string, isError: boolean): void {
    const message: Msg = { role: "toolResult", toolCallId, isError, content: [] };
    this.messages.push(message);
    this.subscriber({ type: "message_end", message });
  }
}

const THINKING = "STEP-ONE-THOUGHT";
const TEXT = "PART-ONE-TEXT";

function setup(partial?: Msg): { stream: FakeStream; render: () => string } {
  const messages: Msg[] = [{ role: "user", content: "do the thing" }];
  const stream = new FakeStream(messages);
  stream.state.streamingMessage = partial;
  mockSubscribe.mockImplementation((cb) => {
    stream.subscriber = cb;
    return () => {};
  });
  const session = asAgentSession({ messages, state: stream.state, subscribe: mockSubscribe });
  const theme = { ...noopTheme, bg: (color: string, text: string) => (text.trim() ? `${color}:${text}` : text) };
  const viewer = new ConversationViewer(owner, makeTui(), session, makeRecord(session), theme, vi.fn());
  return { stream, render: () => viewer.render(120).join("\n") };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("ConversationViewer streaming", () => {
  it("reads the real SDK partial at text_end and the completed transcript only at message_end", async () => {
    const stream = createAssistantMessageEventStream();
    const agent = new Agent({ streamFn: () => stream });
    const session = asAgentSession({
      state: agent.state,
      get messages() {
        return agent.state.messages;
      },
      subscribe: agent.subscribe.bind(agent),
    });
    let viewer: ConversationViewer | undefined;
    const visible: Array<{ completed: number; partial: boolean; occurrences: number }> = [];
    const part = assistantMessage({ content: [{ type: "text", text: TEXT }] });
    agent.subscribe((event) => {
      const blockEnd = event.type === "message_update" && event.assistantMessageEvent.type === "text_end";
      const messageEnd = event.type === "message_end" && event.message.role === "assistant";
      if (!blockEnd && !messageEnd) return;
      // Open after the SDK has already processed earlier streaming events.
      viewer ??= new ConversationViewer(owner, makeTui(), session, makeRecord(session), noopTheme, vi.fn());
      visible.push({
        completed: agent.state.messages.filter((message) => message.role === "assistant").length,
        partial: !!agent.state.streamingMessage,
        occurrences: count(viewer.render(120).join("\n"), TEXT),
      });
    });
    const run = agent.prompt("local stub task");
    stream.push({ type: "start", partial: assistantMessage() });
    stream.push({ type: "text_delta", contentIndex: 0, delta: TEXT, partial: part });
    stream.push({ type: "text_end", contentIndex: 0, content: TEXT, partial: part });
    stream.push({ type: "done", reason: "stop", message: part });
    stream.end(part);
    await run;
    viewer?.dispose();
    expect(visible).toEqual([
      { completed: 0, partial: true, occurrences: 1 },
      { completed: 1, partial: false, occurrences: 1 },
    ]);
  });
  it.each(["aborted", "error"])("opens mid-stream and finalizes %s text once", (stopReason) => {
    const partial = msgWith({ type: "text", text: TEXT });
    const { stream, render } = setup(partial);
    expect(render()).toContain("do the thing");
    expect(count(render(), TEXT)).toBe(1);
    stream.event("text_delta", msgWith({ type: "text", text: `${TEXT}-tail` }), "-tail");
    expect(count(render(), `${TEXT}-tail`)).toBe(1);
    stream.end({ ...msgWith({ type: "text", text: `${TEXT}-tail` }), stopReason });
    expect(count(render(), `${TEXT}-tail`)).toBe(1);
    expect(count(render(), TEXT)).toBe(1);
  });

  it("projects parallel tool endings by id before reconciling transcript results", () => {
    const { stream, render } = setup();
    stream.start();
    stream.end(
      msgWith({ type: "toolCall", id: "a", name: "tool-alpha" }, { type: "toolCall", id: "b", name: "tool-beta" }),
    );
    const status = (name: string) =>
      render()
        .split("\n")
        .find((line) => line.includes(name));
    expect(status("tool-alpha")).toContain("toolPendingBg");
    stream.toolEnd("b", true);
    expect(status("tool-alpha")).toContain("toolPendingBg");
    expect(status("tool-beta")).toContain("toolErrorBg");
    stream.toolEnd("a", false);
    expect(status("tool-alpha")).toContain("toolSuccessBg");
    stream.toolResult("a", false);
    stream.toolResult("b", true);
    expect(status("tool-alpha")).toContain("toolSuccessBg");
    expect(status("tool-beta")).toContain("toolErrorBg");
    expect(count(render(), "tool-alpha")).toBe(1);
    expect(count(render(), "tool-beta")).toBe(1);
  });
  it.each([
    ["text", "\x1b]0;hidden\nsecret", "\x1b\\"],
    ["thinking", "\x1b]0;hidden\nsecret", "\x1b\\"],
    ["text", "\u009fhidden\nsecret", "\u009c"],
    ["thinking", "\u009fhidden\nsecret", "\u009c"],
    ["text", "\x1b[?1049", "h"],
    ["thinking", "\u009b?1049", "h"],
  ])("hides unfinished %s controls %j across deltas and rebuilds from raw history", (kind, sequence, terminator) => {
    const { stream, render } = setup();
    stream.start();
    render();
    const prefix = `safe${sequence}`;
    const partial = (raw: string) =>
      msgWith(kind === "text" ? { type: "text", text: raw } : { type: "thinking", thinking: raw });
    stream.event(`${kind}_delta`, partial(prefix), prefix);
    const pending = render();
    expect(pending).toContain("safe");
    expect(pending).not.toContain("hidden");
    expect(pending).not.toContain("secret");
    expect(pending).not.toContain("?1049");
    expect(pending).not.toContain("\x1b");
    const raw = `${prefix}${terminator}rest\r\nlast\rline`;
    stream.event(`${kind}_delta`, partial(raw), `${terminator}rest\r\nlast\rline`);
    expect(render()).toContain("saferest");
    stream.event(`${kind}_end`, partial(raw));
    stream.end(partial(raw));
    const finished = render();
    expect(finished).toContain("saferest");
    expect(finished).toContain("last");
    expect(finished).toContain("line");
    expect(finished).not.toContain("\x1b");
    expect(finished).not.toContain("\r");
    expect(stream.messages.at(-1)).toEqual(partial(raw));
  });
  it("control: streamed blocks stay visible while deltas arrive", () => {
    const { stream, render } = setup();
    stream.start();
    render(); // a render lands on the empty partial before content arrives
    stream.event("thinking_delta", msgWith({ type: "thinking", thinking: THINKING }), THINKING);
    expect(render()).toContain(THINKING);

    stream.event("text_delta", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }), TEXT);
    const text = render();
    expect(text).toContain(TEXT);
    expect(text).toContain(THINKING);
  });

  it("keeps completed thinking visible when the text block starts", () => {
    const { stream, render } = setup();
    stream.start();
    // First render (debounce) lands before content arrives — cache warms empty.
    render();
    stream.event("thinking_start", msgWith());
    stream.event("thinking_delta", msgWith({ type: "thinking", thinking: THINKING }), THINKING);
    expect(render()).toContain(THINKING); // visible while streaming

    stream.event("thinking_end", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_start", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_delta", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }), TEXT);
    const text = render();
    expect(text).toContain(TEXT);

    // The completed thinking lives in session.messages — it must stay visible.
    expect(text).toContain(THINKING);
    expect(count(text, THINKING)).toBe(1); // transcript copy, not duplicated
  });

  it("keeps completed text visible at text_end immediately, straight from the transcript", () => {
    const { stream, render } = setup();
    stream.start();
    stream.event("thinking_start", msgWith());
    stream.event("thinking_delta", msgWith({ type: "thinking", thinking: THINKING }), THINKING);
    render(); // TUI renders during streaming
    stream.event("thinking_end", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_start", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_delta", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }), TEXT);
    expect(render()).toContain(TEXT); // visible while streaming

    stream.event("text_end", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }));
    const text = render(); // TUI renders on the clear

    // The completed text lives in session.messages — it must remain visible
    // with no tool result or turn progression required.
    expect(text).toContain(TEXT);
    expect(text).toContain(THINKING);
    expect(count(text, TEXT)).toBe(1); // exactly the transcript copy
  });

  it("message_end for the streamed message leaves its completed text visible", () => {
    const { stream, render } = setup();
    // The TUI renders continuously — one render per event batch, so the
    // per-index cache warms mid-stream exactly as in production.
    stream.start();
    render(); // lands on the empty partial
    stream.event("thinking_start", msgWith());
    stream.event("thinking_delta", msgWith({ type: "thinking", thinking: THINKING }), THINKING);
    render();
    stream.event("thinking_end", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_start", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_delta", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }), TEXT);
    render();
    stream.event("text_end", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }));
    render();

    // done: pi swaps the final message object into the last slot and emits
    // the session-level message_end — the swap must not hide the content.
    stream.end(msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }));
    const text = render();
    expect(text).toContain(TEXT);
    expect(text).toContain(THINKING);
  });

  it("keeps completed text visible through the next message and its tool result", () => {
    const { stream, render } = setup();
    const doneBlocks: Block[] = [
      { type: "thinking", thinking: THINKING },
      { type: "text", text: TEXT },
    ];
    const callBlocks: Block[] = [...doneBlocks, { type: "toolCall", id: "t1", name: "bash", arguments: {} }];
    stream.start();
    stream.event("thinking_start", msgWith());
    stream.event("thinking_delta", msgWith({ type: "thinking", thinking: THINKING }), THINKING);
    stream.event("thinking_end", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_start", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_delta", msgWith(...doneBlocks), TEXT);
    stream.event("text_end", msgWith(...doneBlocks));
    // Tool call streams after the text block completes; done finalizes.
    stream.event("toolcall_start", msgWith(...callBlocks));
    stream.event("toolcall_end", msgWith(...callBlocks));
    stream.end(msgWith(...callBlocks));
    const atCompletion = render();
    // Inverted from the bug state: the completed text is on screen at
    // completion, not lost until the tool result lands.
    expect(atCompletion).toContain(TEXT);

    // Next LLM call starts (run progresses) — previous stream stays visible.
    stream.start();
    render(); // a render lands on the new empty partial
    stream.event("text_start", msgWith());
    stream.event("text_delta", msgWith({ type: "text", text: "PART-TWO-TEXT" }), "PART-TWO-TEXT");
    render(); // visible while the second stream is in flight
    stream.event("text_end", msgWith({ type: "text", text: "PART-TWO-TEXT" }));
    const duringTurn = render();
    expect(duringTurn).toContain("PART-TWO-TEXT"); // new stream visible
    expect(duringTurn).toContain(TEXT); // previous message's text still visible
    expect(count(duringTurn, TEXT)).toBe(1); // shown once — no duplication

    // Tool result for the FIRST message's call arrives → its cache entry is
    // invalidated → the call line re-renders from the transcript with its
    // settled status color. Result content itself never renders, and the
    // on-screen content of the earlier message must not otherwise change.
    stream.messages.push({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "RESULT-ONE" }],
    });
    const recovered = render();
    expect(recovered).toContain(TEXT);
    expect(recovered).toContain(THINKING);
    expect(recovered).toContain("PART-TWO-TEXT");
    expect(count(recovered, TEXT)).toBe(count(atCompletion, TEXT)); // no retroactive change
    expect(count(recovered, "RESULT-ONE")).toBe(0); // results are never rendered
  });
});

/** Occurrences of `needle` in `haystack` — pins "shown once" without layout assumptions. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
