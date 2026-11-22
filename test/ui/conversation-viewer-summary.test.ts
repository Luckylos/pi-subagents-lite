import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AgentSession, CompactionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../../src/types.js";
import type { Theme } from "../../src/ui/types.js";
import { assistantMessage, userMessage } from "../agents/session-messages.js";
import { createTestOwner } from "../owner-fixtures.js";
import { asAgentSession, asTui } from "../pi-boundaries.js";

vi.mock("../../src/pi-settings.js", () => ({
  getHideThinkingBlock: vi.fn(() => false),
}));

import { getHideThinkingBlock } from "../../src/pi-settings.js";
import { ConversationViewer } from "../../src/ui/conversation-viewer.js";

// Pin the public SDK contract; use real context projection and real TUI text wrapping.
const sdk = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
const owner = await createTestOwner();
const timestamp = "2026-11-21T00:00:00.000Z";
const theme: Theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
};
const viewers: ConversationViewer[] = [];

function compaction(summary: string): CompactionEntry {
  return {
    type: "compaction",
    id: "compact",
    parentId: "kept-answer",
    timestamp,
    firstKeptEntryId: "kept-question",
    summary,
    tokensBefore: 4200,
  };
}

function entry(id: string, parentId: string | null, message: AgentSession["messages"][number]): SessionMessageEntry {
  return { type: "message", id, parentId, timestamp, message };
}

function setup(initial: AgentSession["messages"]) {
  let messages = initial;
  const session = asAgentSession({
    get messages() {
      return messages;
    },
    subscribe: vi.fn<AgentSession["subscribe"]>(() => () => {}),
    getContextUsage: () => undefined,
  });
  const record: AgentRecord = {
    id: "summary-viewer",
    lifecycle: { status: "completed", startedAt: 0, completedAt: 1, started: true },
    display: { type: "builder", description: "summary fixture" },
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      toolUses: 0,
      turnCount: 0,
      compactionCount: 1,
    },
    execution: { session },
  };
  const tui = asTui({ terminal: { rows: 100 }, requestRender: vi.fn() });
  const viewer = new ConversationViewer(owner, tui, session, record, theme, vi.fn());
  viewers.push(viewer);
  return {
    viewer,
    session,
    replace(next: AgentSession["messages"]) {
      messages = next;
    },
  };
}

function content(viewer: ConversationViewer, width = 80): string[] {
  const lines = viewer.render(width);
  expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  expect(lines.filter((line) => /^│ ─+ │$/.test(line))).toHaveLength(2);
  return lines.slice(4, -3).map((line) => line.slice(2, -2).trim());
}

beforeEach(() => {
  vi.mocked(getHideThinkingBlock).mockReturnValue(false);
});
afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.dispose();
});

describe("ConversationViewer SDK compaction summaries", () => {
  it("projects the real compaction entry through the SDK public root", () => {
    const source = compaction("SDK summary");
    expect(sdk).not.toHaveProperty("createCompactionSummaryMessage");
    expect(sdk.sessionEntryToContextMessages(source)).toEqual([
      {
        role: "compactionSummary",
        summary: source.summary,
        tokensBefore: 4200,
        timestamp: Date.parse(timestamp),
      },
    ]);
  });

  it("replaces cached history with one real summary and keeps context order, including same-length replacements", () => {
    const history = [
      entry("old-question", null, userMessage("old question")),
      entry("old-answer", "old-question", assistantMessage({ content: [{ type: "text", text: "old answer" }] })),
      entry("kept-question", "old-answer", userMessage("kept question")),
      entry("kept-answer", "kept-question", assistantMessage({ content: [{ type: "text", text: "kept answer" }] })),
    ];
    const { viewer, session, replace } = setup(sdk.buildSessionContext(history).messages);
    expect(content(viewer).filter(Boolean)).toEqual(["old question", "old answer", "kept question", "kept answer"]);

    const boundary = compaction("history summary");
    const messages = sdk.buildSessionContext([...history, boundary]).messages;
    expect(messages.map((message) => message.role)).toEqual(["compactionSummary", "user", "assistant"]);
    replace(messages);
    const expected = ["Compaction summary", "history summary", "kept question", "kept answer"];
    expect(content(viewer).filter(Boolean)).toEqual(expected);
    expect(content(viewer).filter(Boolean)).toEqual(expected);
    expect(session.messages).toBe(messages);

    const refreshed = sdk.buildSessionContext([...history, { ...boundary, summary: "refreshed summary" }]).messages;
    expect(refreshed).toHaveLength(messages.length);
    replace(refreshed);
    expect(content(viewer).filter(Boolean)).toEqual([
      "Compaction summary",
      "refreshed summary",
      "kept question",
      "kept answer",
    ]);

    const followup = entry("followup", "compact", userMessage("after compaction"));
    replace(sdk.buildSessionContext([...history, boundary, followup]).messages);
    expect(content(viewer).filter(Boolean)).toEqual([...expected, "after compaction"]);
  });

  it("wraps and sanitizes the display copy across width changes while preserving raw summary and newlines", () => {
    const raw = `${"a".repeat(60)}\r\n\r\nsecond\x1b]0;hidden-title\x07 line\x1b[31m!\x1b[0m\x00\x08\u202e\u009dhidden-c1\u009c`;
    const source = compaction(raw);
    const messages = sdk.sessionEntryToContextMessages(source);
    const original = structuredClone(messages);
    const { viewer, session } = setup(messages);
    for (const width of [32, 80, 32]) {
      const chunks = raw.slice(0, 60).match(new RegExp(`.{1,${width - 4}}`, "g")) ?? [];
      const rows = content(viewer, width);
      const expected = ["Compaction summary", ...chunks, "", "second line!"];
      expect(rows.slice(0, expected.length)).toEqual(expected);
      expect(rows.slice(expected.length).every((line) => line === "")).toBe(true);
      expect(rows.join("\n")).not.toMatch(/hidden-title|hidden-c1/);
      for (const control of ["\x1b", "\x00", "\x08", "\u202e", "\u009d", "\u009c", "\r"]) {
        expect(rows.join("\n")).not.toContain(control);
      }
    }
    expect(source.summary).toBe(raw);
    expect(session.messages).toBe(messages);
    expect(messages).toEqual(original);
  });

  it("keeps the summary visible when thinking starts hidden and after local toggles", () => {
    vi.mocked(getHideThinkingBlock).mockReturnValue(true);
    const messages = [
      ...sdk.sessionEntryToContextMessages(compaction("always visible summary")),
      assistantMessage({
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "answer" },
        ],
      }),
    ];
    const { viewer } = setup(messages);
    const hidden = ["Compaction summary", "always visible summary", "Thinking...", "answer"];
    expect(content(viewer).filter(Boolean)).toEqual(hidden);
    viewer.handleInput("\x14");
    expect(content(viewer).filter(Boolean)).toEqual([
      "Compaction summary",
      "always visible summary",
      "private reasoning",
      "answer",
    ]);
    viewer.handleInput("\x14");
    expect(content(viewer).filter(Boolean)).toEqual(hidden);
  });

  it("scrolls from the start to the end of a large summary through a narrow viewport", () => {
    const message = compaction("summary start\n" + "x\n".repeat(160_000) + "summary end");
    const { viewer } = setup([...sdk.sessionEntryToContextMessages(message), userMessage("retained question")]);
    content(viewer, 30);
    viewer.handleInput("g");
    expect(content(viewer, 30)).toContain("summary start");
    viewer.handleInput("G");
    const tail = content(viewer, 30);
    expect(tail).toContain("summary end");
    expect(tail.join("\n")).toContain("retained question");
    expect(content(viewer, 30)).toEqual(tail);
  });

  it("leaves branchSummary outside the viewer rendering scope", () => {
    const messages = sdk.sessionEntryToContextMessages({
      type: "branch_summary",
      id: "branch",
      parentId: null,
      timestamp,
      fromId: "other-branch",
      summary: "branch stays hidden",
    });
    expect(messages[0]?.role).toBe("branchSummary");
    expect(content(setup(messages).viewer).filter(Boolean)).toEqual([]);
  });
});
