import { describe, expect, it, vi } from "vite-plus/test";
import { ConversationViewer } from "../../src/ui/conversation-viewer.js";
import {
  renderAgentToolCall,
  renderAgentToolResult,
  renderStatusLine,
  renderSubagentMessage,
  renderSubagentResult,
} from "../../src/ui/renderer.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { buildMetadataLineParts, describeActivity } from "../../src/ui/format.js";
import { makeAgentRecord } from "../fixtures.js";
import { asAgentSession, asTui } from "../pi-boundaries.js";
import { createTestOwner } from "../owner-fixtures.js";
import { makeMockManager, renderWidgetLines } from "./widget-helpers.js";
import type { Theme } from "../../src/ui/types.js";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { asCommandContext } from "../pi-boundaries.js";
import { showConcurrencySettingsMenu } from "../../src/ui/menu/menu-concurrency.js";

vi.mock("../../src/pi-settings.js", () => ({ getHideThinkingBlock: () => false }));

const owner = await createTestOwner();
const theme: Theme = {
  fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
  bg: (_color, text) => `\x1b[44m${text}\x1b[49m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
};
const noopTheme: Theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const hostile = "A\u009b?1049hB\u001b]0;window-title\u0007C";

// Theme SGR and the real Markdown component's normal OSC8 are allowed in the raw frame.
function expectSafeFrame(frame: readonly string[]): void {
  for (const line of frame) {
    expect(line).toMatch(
      // oxlint-disable-next-line no-control-regex -- check raw frames, allowing only generated SGR and normal OSC8
      /^(?:[^\x00-\x08\x0b-\x1f\x7f-\x9f\p{Bidi_Control}\uFFF9-\uFFFB]|\x1b\[[0-9;]*m|\x1b\]8;;(?:https:\/\/example\.com)?(?:\x07|\x1b\\))*$/u,
    );
    expect(line).not.toContain("window-title");
  }
}

function viewerFor(messages: object[], display: Parameters<typeof makeAgentRecord>[0] = {}) {
  const session = asAgentSession({ messages, subscribe: vi.fn(() => () => {}) });
  const record = makeAgentRecord({ ...display, execution: { session } });
  const tui = asTui({ terminal: { rows: 150 }, requestRender: vi.fn() });
  return { viewer: new ConversationViewer(owner, tui, session, record, theme, vi.fn()), record };
}

describe("terminal display boundary with real pi-tui components", () => {
  it("sanitizes the complete concurrency description before SettingsList wraps it", async () => {
    const menuOwner = await createTestOwner();
    const provider = "A\x1b]0;hidden\nsecret\x1b\\B";
    menuOwner.store!.mutate.concurrency.setProvider(provider, 2, "session");
    const ctx = asCommandContext({
      ui: {
        custom: async (factory: (tui: TUI, theme: Theme, kb: unknown, done: () => void) => Component) => {
          const component = factory(asTui({ terminal: { rows: 40 } }), theme, null, vi.fn());
          component.handleInput?.("j");
          for (const width of [50, 160]) {
            const frame = component.render(width);
            expectSafeFrame(frame);
            expect(frame.join("\n")).not.toContain("hidden");
            expect(frame.join("\n")).not.toContain("secret");
            expect(frame.join("\n")).toContain("AB provider.");
            expect(frame.join("\n")).toContain("\x1b[1m\x1b[36mPer-provider limits");
          }
        },
      },
    });
    await showConcurrencySettingsMenu(menuOwner, ctx, []);
    expect(menuOwner.store!.sessionConcurrency.providers).toEqual({ [provider]: 2 });
  });

  it.each(["user", "text", "thinking"])(
    "sanitizes %s before wrapping or Markdown without changing messages",
    (kind) => {
      const raw = `before ${hostile}\r\nafter\rthird\u202e!`;
      const message =
        kind === "user"
          ? { role: "user", content: raw }
          : { role: "assistant", content: [{ type: kind, [kind]: raw }] };
      const { viewer } = viewerFor([message]);
      const snapshot = structuredClone(message);
      try {
        const frame = viewer.render(160);
        expectSafeFrame(frame);
        expect(frame.join("\n")).toContain("before ABC");
        expect(frame.join("\n")).toContain("after");
        expect(frame.join("\n")).toContain("third!");
        expect(message).toEqual(snapshot);
      } finally {
        viewer.dispose();
      }
    },
  );

  it.each([
    ["read", { path: hostile }, 'read("ABC")'],
    ["write", { path: hostile, content: "one\ntwo" }, 'write("ABC", 7 chars)'],
    ["edit", { path: hostile, edits: [{}] }, 'edit("ABC", 1 edits)'],
    ["bash", { command: hostile }, 'bash("ABC")'],
    ["grep", { pattern: hostile, path: hostile }, 'grep("ABC", "ABC")'],
    ["rg", { pattern: hostile, path: hostile }, 'rg("ABC", "ABC")'],
    ["uniq\u009b31mtool", { "pa\u009b?1049hth": "A\u009b?1049hB", other: "C" }, 'uniqtool {"path":"AB","other":"C"}'],
  ] as const)("sanitizes exact tool argument carriers for %s before JSON escaping", (name, args, expected) => {
    const message = { role: "assistant", content: [{ type: "toolCall", id: "t1", name, arguments: args }] };
    const snapshot = structuredClone(message);
    const { viewer } = viewerFor([message]);
    try {
      const frame = viewer.render(160);
      expectSafeFrame(frame);
      // Assert the actual label without theme codes by rendering the same public seam with a plain theme.
      const session = asAgentSession({ messages: [message], subscribe: vi.fn(() => () => {}) });
      const plain = new ConversationViewer(
        owner,
        asTui({ terminal: { rows: 150 } }),
        session,
        makeAgentRecord(),
        noopTheme,
        vi.fn(),
      );
      try {
        expect(
          plain
            .render(160)
            .find((line) => line.includes(expected))
            ?.trim(),
        ).toBe(`│  ${expected}${" ".repeat(156 - expected.length - 1)} │`);
      } finally {
        plain.dispose();
      }
      expect(message).toEqual(snapshot);
    } finally {
      viewer.dispose();
    }
  });

  it("retains theme SGR and Markdown OSC8 links in the actual frame", async () => {
    const actual = await vi.importActual<typeof import("@earendil-works/pi-tui")>("@earendil-works/pi-tui");
    const previous = { ...actual.getCapabilities() };
    actual.setCapabilities({ ...previous, hyperlinks: true });
    const { viewer } = viewerFor([
      { role: "assistant", content: [{ type: "text", text: `**bold** [link](https://example.com) ${hostile}` }] },
    ]);
    try {
      const frame = viewer.render(160);
      expectSafeFrame(frame);
      expect(frame.join("\n")).toContain("\x1b[1m");
      expect(frame.join("\n")).toContain("\x1b]8;;https://example.com\x1b\\");
      expect(new actual.Text("\x1b[?1049h", 0, 0).render(80).join("\n")).toContain("\x1b[?1049h");
    } finally {
      viewer.dispose();
      actual.setCapabilities(previous);
    }
  });

  it("sanitizes viewer and widget metadata, descriptions, activity and errors", () => {
    const display = {
      description: `desc ${hostile}`,
      worktreeLabel: hostile,
      outputFile: `/tmp/${hostile}`,
      invocation: { modelName: hostile },
    };
    const { viewer, record } = viewerFor([], { display });
    try {
      const frame = viewer.render(160);
      expectSafeFrame(frame);
      expect(frame[1]).toContain("desc ABC");
      expect(buildMetadataLineParts(record, "id")).toEqual(["@ABC", "tail -f /tmp/ABC"]);
      Object.defineProperties(record.execution.session, {
        model: { value: { id: hostile, name: hostile } },
        thinkingLevel: { value: hostile },
      });
      expect(buildMetadataLineParts(record, "id", undefined, "metadata")).toEqual([
        "ABC • ABC",
        "@ABC",
        "tail -f /tmp/ABC",
      ]);
      const widget = new AgentWidget(owner, makeMockManager([record]), () => ({
        activeTools: new Map(),
        responseText: hostile,
      }));
      try {
        const lines = renderWidgetLines(widget, { terminal: { columns: 200 } }, theme);
        expectSafeFrame(lines);
        expect(lines.join("\n")).toContain("desc ABC");
        record.lifecycle.status = "error";
        record.lifecycle.completedAt = Date.now();
        record.error = `bad ${hostile}`;
        expectSafeFrame(renderWidgetLines(widget, { terminal: { columns: 200 } }, theme));
        expect(record.error).toBe(`bad ${hostile}`);
      } finally {
        widget.dispose();
      }
    } finally {
      viewer.dispose();
    }
  });

  it("sanitizes configured display names before the viewer, tool and completion themes", () => {
    const config = { name: "builder", displayName: hostile, description: "test", systemPrompt: "" };
    const spy = vi.spyOn(owner.registry, "getAgentConfig").mockReturnValue(config);
    const { viewer } = viewerFor([]);
    try {
      const call = renderAgentToolCall(owner, { agent: "builder" }, noopTheme).render(80);
      expect(call).toEqual([`▸ ABC${" ".repeat(75)}`]);
      const frame = viewer.render(160);
      expectSafeFrame(frame);
      const card = renderSubagentResult(owner, { details: { type: "builder" } }, {}, theme, false).render(160);
      expectSafeFrame(card);
      expect(card.join("\n")).toContain("ABC");
      expect(config.displayName).toBe(hostile);
    } finally {
      viewer.dispose();
      spy.mockRestore();
    }
  });

  it("sanitizes activity on complete text before selecting the first line", () => {
    expect(describeActivity(new Map(), "before\x1b]0;hidden\nsecret\x1b\\after\rnext")).toBe("beforeafter");
    expect(describeActivity(new Map([["id", hostile]]))).toBe("ABC…");
    expect(describeActivity(new Map([["id", "constructor"]]))).toBe("constructor…");
  });

  it.each([false, true])("sanitizes all renderer carriers with stats=%s while preserving the inputs", (stats) => {
    const details = {
      type: "builder",
      description: hostile,
      modelId: hostile,
      thinkingLevel: hostile,
      outputFile: `/tmp/${hostile}`,
      worktreePath: `/wt/${hostile}`,
      ...(stats ? { turnCount: 1 } : {}),
    };
    const result = { content: [{ type: "text", text: hostile }], details };
    const message = { content: hostile, details };
    const snapshot = structuredClone({ result, message });
    const components = [
      renderAgentToolCall(owner, { agent: "builder", _modelOverride: hostile }, theme),
      renderAgentToolCall(owner, { agent: "builder", _modelOverride: hostile, run_in_background: true }, theme),
      renderAgentToolResult(result, { expanded: true }, theme, false),
      renderStatusLine(result, {}, theme),
      renderSubagentMessage(message, theme),
      renderSubagentResult(owner, message, { expanded: true }, theme, false),
    ];
    for (const component of components) {
      const frame = component.render(160);
      expectSafeFrame(frame);
      expect(frame.join("\n")).toContain("ABC");
    }
    expect({ result, message }).toEqual(snapshot);
  });
});
