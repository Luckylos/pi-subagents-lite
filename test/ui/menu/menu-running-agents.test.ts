/**
 * menu-running-agents.test.ts — Tests for showRunningAgentsMenu using SelectList.
 *
 * Uses ctx.ui.custom (not ctx.ui.select/runMenuLoop).
 * The running agents menu is a SelectList with dynamic agent entries.
 * Selecting an agent opens an actions submenu (also SelectList).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import assert from "node:assert/strict";
import { createMockCtx, type ComponentFactory } from "../../menu-test-helpers.js";
import { asAgentSession, selectListView } from "../../pi-boundaries.js";
import type {
  AgentRecord,
  AgentDisplayInfo,
  AgentExecutionState,
  AgentLifecycle,
  SubagentRun,
} from "../../../src/types.js";
import type { Theme } from "../../../src/ui/types.js";
import { captureResultStats } from "../../../src/agents/agent-result.js";
import type { Component, SelectItem, SelectListTheme } from "@earendil-works/pi-tui";

/** The mocked SelectList surface the tests drive: the items the menu built
 * plus the selection state the navigation tests step by hand. */
interface SelectListCapture {
  items: SelectItem[];
  maxVisible: number;
  selectedIndex: number;
  onSelect?: (item: SelectItem) => void | Promise<void>;
  onCancel?: () => void;
}

// Capture SelectList constructor calls
let selectListCalls: SelectListCapture[] = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    constructor() {}
  },
  SelectList: class MockSelectList {
    items: SelectItem[];
    maxVisible: number;
    selectedIndex = 0;
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
    constructor(items: SelectItem[], maxVisible: number, _theme: SelectListTheme) {
      this.items = items;
      this.maxVisible = maxVisible;
      selectListCalls.push(this);
    }
    setSelectedIndex(index: number) {
      this.selectedIndex = index;
    }
    render() {
      return [];
    }
    handleInput(data: string) {
      if (data === "\r") this.onSelect?.(this.items[this.selectedIndex]);
      else if (data === "\x1b") this.onCancel?.();
    }
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (v: string) => void;
    onEscape?: () => void;
    setValue(v: string) {
      this.value = v;
    }
    handleInput(data: string) {
      if (data === "\r") this.onSubmit?.(this.value);
      else if (data === "\x1b") this.onEscape?.();
      else this.value += data;
    }
    render() {
      return [`> ${this.value}`];
    }
  },
  matchesKey: vi.fn((data: string, key: string) => {
    const map: Record<string, string[]> = {
      up: ["\x1b[A", "k"],
      down: ["\x1b[B", "j"],
      pageUp: ["\x1b[5~"],
      pageDown: ["\x1b[6~"],
      home: ["\x1b[H"],
      enter: ["\r"],
      escape: ["\x1b"],
      q: ["q"],
      s: ["s"],
    };
    return (map[key] ?? [key]).includes(data);
  }),
  truncateToWidth: vi.fn((s: string, w: number) => (s.length > w ? s.slice(0, w - 3) + "..." : s)),
  visibleWidth: vi.fn((s: string) => s.length),
}));

// Import AFTER mock setup
import { showRunningAgentsMenu, buildAgentActionsList } from "../../../src/ui/menu/menu-running-agents.js";
import { ConversationViewer } from "../../../src/ui/conversation-viewer.js";
import { getCoordinator } from "../../../src/shell.js";

/** Nested-partial overrides the record factory merges over its base record. */
interface RecordOverrides {
  id?: string;
  display?: Partial<AgentDisplayInfo>;
  lifecycle?: Partial<AgentLifecycle>;
  execution?: Partial<AgentExecutionState>;
  result?: string;
  error?: string;
}

/** A minimal session handle for menu action availability tests. */
function makeMockSession(messages: { role: string; content: string }[]) {
  return asAgentSession({ messages, subscribe: vi.fn(() => () => {}) });
}

function makeRecord(overrides: RecordOverrides = {}): AgentRecord {
  const base: AgentRecord = {
    id: "test-id-123",
    display: { type: "general-purpose", description: "Test agent" },
    lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000, started: true },
    execution: {},
    result: "some result",
    error: "",
    stats: {
      lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
      toolUses: 10,
      turnCount: 15,
      compactionCount: 0,
    },
  };
  const record = {
    ...base,
    ...overrides,
    display: { ...base.display, ...overrides.display },
    lifecycle: { ...base.lifecycle, ...overrides.lifecycle },
    execution: { ...base.execution, ...overrides.execution },
  };
  const { status, startedAt, completedAt } = record.lifecycle;
  if (status !== "running" && status !== "queued") {
    const run: SubagentRun = {
      id: `${record.id}-run-1`,
      agentId: record.id,
      sequence: 1,
      phase: "settled",
      acceptedAt: startedAt,
      startedAt,
      completion: Promise.resolve(),
      outcome: {
        runId: `${record.id}-run-1`,
        agentId: record.id,
        sequence: 1,
        type: record.display.type,
        description: record.display.description,
        started: true,
        status,
        completedAt: completedAt ?? startedAt,
        elapsedMs: (completedAt ?? startedAt) - startedAt,
        result: record.result,
        error: record.error,
        stats: captureResultStats(record),
      },
    };
    mockModules.mockManager.getRuns.mockReturnValue([run]);
  }
  return record;
}
const noopTheme: Theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };

/** The factory's unknown return narrowed at the render boundary: the real
 * showTextViewer builds a plain Component the tests render and feed keys to. */
function asComponent(component: unknown): Component {
  return component as Component;
}

function registerTargets(...records: AgentRecord[]): void {
  const existing = new Map(records.map((record) => [record.id, record]));
  mockModules.mockManager.getRecord.mockImplementation((id: string) => existing.get(id));
  mockModules.mockManager.getRuns.mockImplementation((id) => {
    const record = existing.get(id);
    if (!record) return [];
    return [
      {
        id: `${id}-run-1`,
        agentId: id,
        sequence: 1,
        acceptedAt: record.lifecycle.startedAt,
        completion: Promise.resolve(),
        phase:
          record.lifecycle.phase ??
          (record.lifecycle.status === "queued"
            ? "queued"
            : record.lifecycle.status === "running"
              ? "running"
              : "settled"),
      },
    ];
  });
}

afterEach(() => resetConfig());

describe("showRunningAgentsMenu", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
    mockModules.mockManager.listAgents.mockReset().mockReturnValue([]);
  });

  it("uses ctx.ui.custom (not ctx.ui.select/runMenuLoop)", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([makeRecord()]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("shows notification when no agents exist", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No agents have been spawned this session"),
      "info",
    );
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("creates a SelectList with agent entries", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1", display: { type: "general-purpose", description: "First" } }),
      makeRecord({ id: "agent-2", display: { type: "Explore", description: "Second" } }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);
    expect(selectListCalls.length).toBe(1);
    // Bulk rows (separator, Clear all / Clear done) follow the agent entries
    const agentItems = selectListCalls[0].items.filter((i) => i.value.startsWith("agent-"));
    expect(agentItems.map((i) => i.value)).toEqual(["agent-1", "agent-2"]);
  });

  it("sanitizes agent labels without altering selection values", async () => {
    const type = "A\u009b?1049hB\x1b]0;hidden\x07C";
    const record = makeRecord({ display: { type, description: type } });
    mockModules.mockManager.listAgents.mockReturnValue([record]);
    await showRunningAgentsMenu(owner, createMockCtx());
    const item = selectListCalls[0].items[0];
    expect(item.value).toBe(record.id);
    expect(item.label).toContain("ABC");
    expect(item.label).not.toContain("\x1b");
    expect(item.label).not.toContain("\u009b");
    expect(item.label).not.toContain("hidden");
    expect(record.display.type).toBe(type);
  });

  it("includes agent type in label", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1", display: { type: "general-purpose", description: "Test" } }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);
    expect(selectListCalls[0].items[0].label).toContain("general-purpose");
  });

  it("keeps the action list available after opening the conversation fails", async () => {
    const record = makeRecord({ execution: { session: asAgentSession({ messages: [] }) } });
    mockModules.mockManager.listAgents.mockReturnValue([record]);
    registerTargets(record);

    let menu: Component | undefined;
    const close = vi.fn();
    const custom = vi.fn((factory: ComponentFactory, options?: { overlay?: boolean }) => {
      if (options?.overlay) return Promise.resolve();
      const tui = { terminal: { rows: 40 }, requestRender: vi.fn() };
      menu = asComponent(factory(tui, noopTheme, undefined, close));
      return Promise.resolve();
    });
    const ctx = createMockCtx([], [], [], { ui: { custom } });
    await showRunningAgentsMenu(owner, ctx);
    assert(menu?.handleInput);
    menu.handleInput("\r");
    const actions = selectListCalls.at(-1);
    const view = actions?.items[0];
    assert(actions?.onSelect && view);

    custom.mockRejectedValueOnce(new Error("terminal mount failed"));
    await actions.onSelect(view);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Failed to open agent viewer: Error: terminal mount failed", "error");
    expect(close).not.toHaveBeenCalled();

    menu.handleInput("\r");
    expect(custom).toHaveBeenCalledTimes(3);
    expect(custom).toHaveBeenNthCalledWith(3, expect.any(Function), { overlay: true });
  });

  it.each(["Continue", "Stop"] as const)(
    "opens an overlay from Running agents, routes %s and returns to the actions list on close",
    async (action) => {
      const running = action === "Stop";
      const unsubscribe = vi.fn();
      const session = asAgentSession({
        messages: [],
        state: {},
        model: { name: "Display model", id: "model-id" },
        subscribe: vi.fn(() => unsubscribe),
      });
      const record = makeRecord({
        lifecycle: running ? { status: "running", phase: "running" } : { status: "completed", phase: "settled" },
        execution: { session },
      });
      const manager = mockModules.mockManager;
      manager.listAgents.mockReturnValue([record]);
      registerTargets(record);
      manager.abort.mockReturnValue(false);
      manager.submitMessage.mockResolvedValue({ accepted: false, reason: "capacity", message: "Full." });
      mockModules.mockConfig.agent.modelDisplayStyle = "name";

      let menu: Component | undefined;
      let viewer: ConversationViewer | undefined;
      const menuClosed = vi.fn();
      const custom = vi.fn((factory: ComponentFactory, options?: { overlay?: boolean }) => {
        const tui = { terminal: { rows: 40 }, requestRender: vi.fn() };
        if (!options?.overlay) {
          menu = asComponent(factory(tui, noopTheme, undefined, menuClosed));
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          const view = factory(tui, noopTheme, undefined, () => {
            viewer?.dispose();
            resolve();
          });
          if (!(view instanceof ConversationViewer)) throw new Error("Expected a conversation viewer");
          viewer = view;
        });
      });
      const ctx = createMockCtx([], [], [], { ui: { custom } });
      await showRunningAgentsMenu(owner, ctx);
      assert(menu?.handleInput);
      menu.handleInput("\r");
      menu.handleInput("\r");
      expect(custom).toHaveBeenCalledTimes(2);
      expect(custom).toHaveBeenNthCalledWith(2, expect.any(Function), { overlay: true });
      assert(viewer);
      expect(viewer.render(120).join("\n")).toContain("Display model");

      if (running) {
        viewer.handleInput("s");
        expect(manager.abort).not.toHaveBeenCalled();
        viewer.handleInput("s");
        expect(manager.abort).toHaveBeenCalledExactlyOnceWith(record.id, "user");
        expect(viewer.render(120).join("\n")).toContain("The manager refused the request.");
      } else {
        for (const key of ["\r", " ", "a", " ", "\r"]) viewer.handleInput(key);
        expect(manager.submitMessage).toHaveBeenCalledExactlyOnceWith(record.id, " a ");
        await Promise.resolve();
        expect(viewer.render(120).join("\n")).toContain("Continue not accepted: Full.");
        viewer.handleInput("\x1b");
      }
      viewer.handleInput("q");
      expect(unsubscribe).toHaveBeenCalledOnce();
      await custom.mock.results[1].value;

      menu.handleInput("\x1b");
      expect(menuClosed).not.toHaveBeenCalled();
      menu.handleInput("\x1b");
      expect(menuClosed).toHaveBeenCalledOnce();
    },
  );
});

describe("buildAgentActionsList — actions submenu", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  it("builds the complete result, history, and run action item arrays without separators", async () => {
    const record = makeRecord();
    const first = mockModules.mockManager.getRuns(record.id)[0];
    const second: SubagentRun = {
      ...first,
      id: "separate-run-id",
      sequence: 2,
      outcome: {
        ...first.outcome!,
        runId: "separate-run-id",
        sequence: 2,
        status: "error",
        completedAt: first.startedAt! + 12_000,
        elapsedMs: 12_000,
        result: undefined,
        error: "error",
      },
    };
    mockModules.mockManager.getRuns.mockReturnValue([first, second]);
    const coordinator = getCoordinator(owner)!;
    vi.mocked(coordinator.getCompletionNotification).mockReturnValue({
      status: "submitted",
      canRetry: true,
      notificationId: "tracked",
    });
    const ctx = createMockCtx();
    const actions = buildAgentActionsList(
      owner,
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const items = selectListView(actions).items;
    expect(items).toEqual([
      { value: "view-result", label: "View result · Run 1" },
      { value: "view-error", label: "View error · Run 2" },
      { value: "run-history", label: "Run history (2)" },
      { value: "clear", label: "Clear" },
    ]);
    await actions.onSelect!(items[2]);
    const history = selectListCalls.at(-1)!;
    expect(history.items).toEqual([
      { value: second.id, label: "Run 2 · error · 12s" },
      { value: first.id, label: "Run 1 · completed · 40s" },
    ]);
    await history.onSelect!(history.items[0]);
    expect(selectListCalls.at(-1)?.items).toEqual([
      { value: "view-result", label: "View result" },
      { value: "view-error", label: "View error" },
      { value: "retry", label: "Retry completion notification" },
    ]);
    expect(selectListCalls.flatMap((call) => call.items).filter(({ value }) => value === "__sep__")).toHaveLength(0);
  });

  it("shows View result action for completed agent with result", () => {
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      makeRecord(),
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-result");
  });

  it("shows View error action for agent with error", () => {
    const record = makeRecord({
      lifecycle: { status: "error", startedAt: Date.now() - 30000 },
      result: "",
      error: "something went wrong",
    });
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-error");
  });

  it("shows View snapshot action for running agent with session", () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "",
    });
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-snapshot");
  });

  it("shows Steer and Stop actions for running agent", () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([]) },
      result: "",
    });
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("steer");
    expect(values).toContain("stop");
  });

  it("does not show Steer/Stop for completed agent", () => {
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      makeRecord(),
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).not.toContain("steer");
    expect(values).not.toContain("stop");
  });
});

describe("showTextViewer (via buildAgentActionsList)", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  it("opens text viewer when selecting view-result", async () => {
    let capturedFactory: ComponentFactory | null = null;
    const record = makeRecord({ result: "hello world\nline 2" });
    const ctx = createMockCtx([], [], [], {
      ui: {
        custom: vi.fn(async (factory) => {
          capturedFactory = factory;
          return undefined;
        }),
      },
    });

    const list = buildAgentActionsList(
      owner,
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    await list.onSelect!({ value: "view-result", label: "View result" });

    expect(capturedFactory).toBeDefined();
  });

  it("opens text viewer when selecting view-error", async () => {
    let capturedFactory: ComponentFactory | null = null;
    const record = makeRecord({
      lifecycle: { status: "error", startedAt: Date.now() - 30000 },
      result: "",
      error: "something went wrong",
    });
    const ctx = createMockCtx([], [], [], {
      ui: {
        custom: vi.fn(async (factory) => {
          capturedFactory = factory;
          return undefined;
        }),
      },
    });

    const list = buildAgentActionsList(
      owner,
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    await list.onSelect!({ value: "view-error", label: "View error" });

    expect(capturedFactory).toBeDefined();
  });

  it("opens ConversationViewer when selecting view-snapshot", async () => {
    let capturedFactory: ComponentFactory | null = null;
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "",
    });
    const ctx = createMockCtx([], [], [], {
      ui: {
        custom: vi.fn(async (factory) => {
          capturedFactory = factory;
          return undefined;
        }),
      },
    });

    const list = buildAgentActionsList(
      owner,
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    await list.onSelect!({ value: "view-snapshot", label: "View snapshot" });

    expect(capturedFactory).toBeDefined();
  });
});

describe("showTextViewer — component behavior", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  async function getComponent(record: AgentRecord, kind: "result" | "error", _text: string) {
    let factory: ComponentFactory | null = null;
    const ctx = createMockCtx([], [], [], {
      ui: {
        custom: vi.fn(async (f) => {
          factory = f;
          return undefined;
        }),
      },
    });
    const list = buildAgentActionsList(
      owner,
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    await list.onSelect!({
      value: kind === "result" ? "view-result" : "view-error",
      label: kind === "result" ? "View result" : "View error",
    });
    // Invoke the factory to get the component
    const doneFn = vi.fn();
    const component = asComponent(
      factory!({ terminal: { rows: 40 } }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, null, doneFn),
    );
    return { component, done: doneFn };
  }

  it.each(["result", "error"] as const)(
    "sanitizes the whole %s before splitting lines and preserves record data",
    async (kind) => {
      const raw = "before\x1b]0;hidden\nsecret\x1b\\after\r\nsecond\rthird\x1b[?1049h\u202e";
      const record = makeRecord({ [kind]: raw });
      const { component } = await getComponent(record, kind, raw);
      const lines = component.render(100);
      expect(lines.join("\n")).not.toContain("\x1b");
      expect(lines.join("\n")).not.toContain("\r");
      expect(lines.join("\n")).not.toContain("\u202e");
      expect(lines.join("\n")).not.toContain("hidden");
      expect(lines.join("\n")).not.toContain("secret");
      expect(lines[3]).toContain("beforeafter");
      expect(lines[4]).toContain("second");
      expect(lines[5]).toContain("third");
      expect(record[kind]).toBe(raw);
    },
  );

  it("renders border frame with title", async () => {
    const record = makeRecord({ result: "hello world\nline 2" });
    const { component } = await getComponent(record, "result", "hello world\nline 2");
    const lines = component.render(80);

    expect(lines[0].startsWith("\u256d")).toBe(true); // ╭ top-left corner
    const bottom = lines[lines.length - 1];
    expect(bottom.startsWith("\u2570")).toBe(true); // ╰ bottom-left corner
    expect(bottom.endsWith("\u256f")).toBe(true); // ╯ bottom-right corner
    expect(lines[1]).toContain("general-purpose"); // title contains agent type
    expect(lines[1]).toContain("test-id"); // title contains short id
  });

  it("renders content lines", async () => {
    const record = makeRecord({ result: "line one\nline two\nline three" });
    const { component } = await getComponent(record, "result", "line one\nline two\nline three");
    const lines = component.render(80);
    const text = lines.join("\n");

    expect(text).toContain("line one");
    expect(text).toContain("line two");
    expect(text).toContain("line three");
  });

  it("renders error viewer with Error suffix", async () => {
    const record = makeRecord({
      lifecycle: { status: "error", startedAt: Date.now() - 30000 },
      result: "",
      error: "something went wrong",
    });
    const { component } = await getComponent(record, "error", "something went wrong");
    const lines = component.render(80);
    const text = lines.join("\n");

    expect(text).toContain("Error");
    expect(text).toContain("something went wrong");
  });

  it("closes on q key", async () => {
    const record = makeRecord({ result: "test" });
    const { component, done } = await getComponent(record, "result", "test");

    component.handleInput!("q");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", async () => {
    const record = makeRecord({ result: "test" });
    const { component, done } = await getComponent(record, "result", "test");

    component.handleInput!("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("scrolls through content with up/down", async () => {
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const record = makeRecord({ result: longText });
    const { component } = await getComponent(record, "result", longText);

    // Initial render auto-scrolls to the bottom of the content
    const initial = component.render(80).join("\n");
    expect(initial).toContain("line 49");

    // Up scrolls the visible window toward the top
    component.handleInput!("\x1b[A"); // up
    component.handleInput!("\x1b[A"); // up again
    const scrolledUp = component.render(80).join("\n");
    expect(scrolledUp).toContain("line 25");
    expect(scrolledUp).not.toContain("line 49");

    // Down scrolls back toward the bottom
    component.handleInput!("\x1b[B"); // down
    const scrolledDown = component.render(80).join("\n");
    expect(scrolledDown).toContain("line 48");
    expect(scrolledDown).not.toContain("line 25");
  });

  it("jumps to top on g", async () => {
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const record = makeRecord({ result: longText });
    const { component } = await getComponent(record, "result", longText);

    component.render(80); // auto-scrolls to bottom
    component.handleInput!("G"); // jump to bottom
    // Last content line stays visible after G
    expect(component.render(80).join("\n")).toContain("line 49");

    component.handleInput!("g"); // jump to top
    const text = component.render(80).join("\n");
    expect(text).toContain("line 0");
    expect(text).not.toContain("line 49");
  });

  it("handles single-line text gracefully", async () => {
    const record = makeRecord({ result: "single line" });
    const { component } = await getComponent(record, "result", "single line");
    const lines = component.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("single line");
  });
});

describe("buildAgentActionsList — stop/steer callback routing", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  function setup() {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([]) },
      result: "",
    });
    registerTargets(record);
    const ctx = createMockCtx();
    const onClose = vi.fn();
    const setActive = vi.fn<(c: Component) => void>();
    const list = buildAgentActionsList(owner, ctx, record, noopTheme, () => {}, setActive, onClose);
    return { record, ctx, list, onClose, setActive };
  }

  it("calls manager.abort on stop selection and closes on acceptance", async () => {
    const { record, ctx, list, onClose } = setup();
    mockModules.mockManager.abort.mockImplementation(() => {
      record.lifecycle.phase = "stopping";
      return true;
    });
    await list.onSelect!({ value: "stop", label: "Stop" });
    expect(mockModules.mockManager.abort).toHaveBeenCalledWith(record.id, "user");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Stop requested for test-id- — stopping.", "info");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the operation open when Stop is refused", async () => {
    const { ctx, list, onClose } = setup();
    mockModules.mockManager.abort.mockReturnValue(false);
    await list.onSelect!({ value: "stop", label: "Stop" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Stop not accepted: The manager refused the request.", "warning");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens the inline composer and returns to actions on acceptance", async () => {
    const { record, list, setActive } = setup();
    mockModules.mockManager.submitMessage.mockResolvedValue({
      accepted: true,
      agentId: record.id,
      runId: `${record.id}-run-1`,
      delivery: "steer",
    });
    await list.onSelect!({ value: "steer", label: "Steer" });
    const composer = setActive.mock.calls[0][0];
    expect(composer.render(80)).toEqual(["> "]);
    composer.handleInput!("please do this");
    composer.handleInput!("\r");
    await Promise.resolve();
    expect(mockModules.mockManager.submitMessage).toHaveBeenCalledWith(record.id, "please do this");
    expect(setActive).toHaveBeenLastCalledWith(list);
  });

  it("cancels steer on Escape and restores the draft in the same run", async () => {
    const { list, setActive } = setup();
    await list.onSelect!({ value: "steer", label: "Steer" });
    const composer = setActive.mock.calls[0][0];
    composer.handleInput!("  unfinished  ");
    composer.handleInput!("\x1b");
    expect(setActive).toHaveBeenLastCalledWith(list);
    await list.onSelect!({ value: "steer", label: "Steer" });
    expect(setActive.mock.lastCall?.[0].render(80)).toEqual([">   unfinished  "]);
  });
});

describe("buildAgentActionsList — completed agent with session", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  it("shows View conversation action for completed agent with session", () => {
    const record = makeRecord({
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "done",
    });
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-conversation");
  });

  it("shows View conversation for completed agent without result", () => {
    const record = makeRecord({
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "",
    });
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-conversation");
  });

  it("does not show View conversation for completed agent without session", () => {
    const record = makeRecord({
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: {},
      result: "done",
    });
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).not.toContain("view-conversation");
  });

  it("does not show View conversation for running agent (still View snapshot)", () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "",
    });
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).not.toContain("view-conversation");
    expect(values).toContain("view-snapshot");
  });

  it("opens ConversationViewer when selecting view-conversation", async () => {
    let capturedFactory: ComponentFactory | null = null;
    const record = makeRecord({
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "done",
    });
    const ctx = createMockCtx([], [], [], {
      ui: {
        custom: vi.fn(async (factory) => {
          capturedFactory = factory;
          return undefined;
        }),
      },
    });

    const list = buildAgentActionsList(
      owner,
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    await list.onSelect!({ value: "view-conversation", label: "View conversation" });

    expect(capturedFactory).toBeDefined();
    expect(ctx.ui.custom).toHaveBeenCalledWith(expect.any(Function), { overlay: true });
  });

  it("shows both View conversation and View result for completed agent with session and result", () => {
    const record = makeRecord({
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "done",
    });
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-conversation");
    expect(values).toContain("view-result");
  });
});

describe("showRunningAgentsMenu — duration display", () => {
  const NOW = new Date("2025-01-01T00:00:00.000Z").getTime();

  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
    mockModules.mockManager.listAgents.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Open the menu and return the agent-row labels (bulk rows excluded). */
  async function openAgentLabels(records: AgentRecord[]): Promise<string[]> {
    mockModules.mockManager.listAgents.mockReturnValue(records);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);
    return selectListCalls[0].items.filter((i) => !i.value.startsWith("__")).map((i) => i.label);
  }

  function runningRecord(startedAgoMs: number, description = "my task"): AgentRecord {
    return makeRecord({
      id: "agent-1",
      display: { type: "general-purpose", description },
      lifecycle: { status: "running", startedAt: NOW - startedAgoMs },
      result: "",
    });
  }

  it("shows a formatted run duration on running rows with no ago suffix", async () => {
    const labels = await openAgentLabels([runningRecord(337_000)]);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("5m 37s");
    expect(labels[0]).not.toContain("337s");
    expect(labels[0]).not.toContain("ago");
  });

  it("shows a frozen run duration plus ago at the end of finished rows", async () => {
    const record = makeRecord({
      id: "agent-1",
      display: { type: "general-purpose", description: "my task" },
      lifecycle: { status: "completed", startedAt: NOW - 400_000, completedAt: NOW - 120_000 },
    });
    const labels = await openAgentLabels([record]);
    expect(labels[0]).toContain("4m 40s");
    expect(labels[0]).not.toContain("6m 40s");
    expect(labels[0].endsWith("\u2014 my task 2m ago")).toBe(true);
  });

  it("shows queued duration on the same path with no ago suffix", async () => {
    const record = makeRecord({
      id: "agent-1",
      display: { type: "general-purpose", description: "queued task" },
      lifecycle: { status: "queued", startedAt: NOW - 500 },
      result: "",
    });
    const labels = await openAgentLabels([record]);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("<1s");
    expect(labels[0]).not.toContain("ago");
  });

  it("falls back to now for duration and ago when completedAt is missing", async () => {
    const record = makeRecord({
      id: "agent-1",
      display: { type: "general-purpose", description: "my task" },
      lifecycle: { status: "completed", startedAt: NOW - 65_000, completedAt: NOW - 10_000 },
      result: "done",
    });
    delete record.lifecycle.completedAt;
    const labels = await openAgentLabels([record]);
    expect(labels[0]).toContain("1m 5s");
    expect(labels[0].endsWith("<1s ago")).toBe(true);
  });

  it("formats long runs with hours", async () => {
    const labels = await openAgentLabels([runningRecord(3_661_000)]);
    expect(labels[0]).toContain("1h 1m 1s");
    expect(labels[0]).not.toContain("ago");
  });

  it.each(["completed", "error", "stopped", "aborted", "turn_limited"] as const)(
    "appends ago for %s rows",
    async (status) => {
      const record = makeRecord({
        id: "agent-1",
        display: { type: "general-purpose", description: "my task" },
        lifecycle: { status, startedAt: NOW - 200_000, completedAt: NOW - 60_000 },
        result: "",
      });
      const labels = await openAgentLabels([record]);
      expect(labels[0]).toContain("2m 20s");
      expect(labels[0].endsWith("1m ago")).toBe(true);
    },
  );

  it("ends finished rows without a headline in the ago stamp", async () => {
    const record = makeRecord({
      id: "agent-1",
      display: { type: "general-purpose", description: "" },
      lifecycle: { status: "error", startedAt: NOW - 200_000, completedAt: NOW - 60_000 },
      result: "",
      error: "boom",
    });
    const labels = await openAgentLabels([record]);
    expect(labels[0]).toContain("2m 20s");
    expect(labels[0].endsWith("1m ago")).toBe(true);
    expect(labels[0]).not.toContain("\u2014");
  });
});

describe("clear actions for finished agents", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
    mockModules.mockManager.listAgents.mockReset().mockReturnValue([]);
    mockModules.mockManager.clear.mockReset().mockReturnValue(true);
    mockModules.mockManager.abort.mockReset();
  });

  it("shows a Clear action for finished records", () => {
    const list = buildAgentActionsList(
      owner,
      createMockCtx(),
      makeRecord(),
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("clear");
  });

  it("does not show a Clear action for running or queued records", () => {
    for (const status of ["running", "queued"] as const) {
      const list = buildAgentActionsList(
        owner,
        createMockCtx(),
        makeRecord({
          lifecycle: { status, startedAt: Date.now() - 20000 },
          execution: { session: makeMockSession([]) },
          result: "",
        }),
        noopTheme,
        () => {},
        () => {},
        () => {},
      );
      const values = selectListView(list).items.map((i) => i.value);
      expect(values).not.toContain("clear");
      expect(values).toContain("stop");
    }
  });

  it("clears the record through the manager when Clear is selected", async () => {
    const ctx = createMockCtx();
    const onClose = vi.fn();
    const record = makeRecord();
    registerTargets(record);
    const list = buildAgentActionsList(
      owner,
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      onClose,
    );
    await list.onSelect!({ value: "clear", label: "Clear" });
    expect(mockModules.mockManager.clear).toHaveBeenCalledWith("test-id-123");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a Clear all row when finished records exist", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1" }),
      makeRecord({ id: "agent-2", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);
    const labels = selectListCalls[0].items.map((i) => i.label);
    expect(labels).toContain("Clear all");
  });

  it("hides both bulk clear rows when only active records exist", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-2", lifecycle: { status: "queued", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);
    const labels = selectListCalls[0].items.map((i) => i.label);
    expect(labels).not.toContain("Clear all");
    expect(labels).not.toContain("Clear done");
  });

  it("Clear all removes every terminal record and leaves active ones", async () => {
    const agents = [
      makeRecord({ id: "agent-1" }), // completed
      makeRecord({ id: "agent-2", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-3", lifecycle: { status: "error", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-4", lifecycle: { status: "turn_limited", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-5", lifecycle: { status: "aborted", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-6", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
    ];
    registerTargets(...agents);
    mockModules.mockManager.listAgents.mockReturnValue(agents);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);

    const row = selectListCalls[0].items.find((i) => i.label === "Clear all")!;
    expect(row).toBeDefined();

    const list = selectListCalls[0];
    await list.onSelect!(row);
    for (const id of ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"]) {
      expect(mockModules.mockManager.clear).toHaveBeenCalledWith(id);
    }
    expect(mockModules.mockManager.clear).not.toHaveBeenCalledWith("agent-6");
  });

  it("shows a Clear done row when a completed record exists", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1" }), // completed
      makeRecord({ id: "agent-2", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);
    const labels = selectListCalls[0].items.map((i) => i.label);
    expect(labels).toContain("Clear all");
    expect(labels).toContain("Clear done");
  });

  it("hides Clear done when no completed record exists", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-2", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);
    const labels = selectListCalls[0].items.map((i) => i.label);
    expect(labels).toContain("Clear all");
    expect(labels).not.toContain("Clear done");
  });

  it("Clear done removes only completed records", async () => {
    const agents = [
      makeRecord({ id: "agent-1" }), // completed
      makeRecord({ id: "agent-2", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-3", lifecycle: { status: "error", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-4", lifecycle: { status: "turn_limited", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-5", lifecycle: { status: "aborted", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-6", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
    ];
    registerTargets(...agents);
    mockModules.mockManager.listAgents.mockReturnValue(agents);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);

    const row = selectListCalls[0].items.find((i) => i.label === "Clear done")!;
    expect(row).toBeDefined();

    const list = selectListCalls[0];
    await list.onSelect!(row);
    expect(mockModules.mockManager.clear).toHaveBeenCalledWith("agent-1");
    for (const id of ["agent-2", "agent-3", "agent-4", "agent-5", "agent-6"]) {
      expect(mockModules.mockManager.clear).not.toHaveBeenCalledWith(id);
    }
  });

  it("Stop all running row stops active records and leaves terminal ones", async () => {
    const agents = [
      makeRecord({ id: "agent-1" }), // completed
      makeRecord({ id: "agent-2", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-3", lifecycle: { status: "queued", startedAt: Date.now() - 20000 }, result: "" }),
    ];
    registerTargets(...agents);
    mockModules.mockManager.abort.mockReturnValue(true);
    mockModules.mockManager.listAgents.mockReturnValue(agents);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(owner, ctx);

    const row = selectListCalls[0].items.find((i) => i.label === "Stop 2 running agent(s)")!;
    expect(row).toBeDefined();

    const list = selectListCalls[0];
    await list.onSelect!(row);
    expect(mockModules.mockManager.abort).toHaveBeenCalledWith("agent-2", "user");
    expect(mockModules.mockManager.abort).toHaveBeenCalledWith("agent-3", "user");
    expect(mockModules.mockManager.abort).not.toHaveBeenCalledWith("agent-1", "user");
  });

  describe("bulk action row ordering", () => {
    beforeEach(() => {
      selectListCalls = [];
      vi.clearAllMocks();
      mockModules.mockManager.listAgents.mockReset().mockReturnValue([]);
      mockModules.mockManager.clear.mockReset();
      mockModules.mockManager.abort.mockReset();
    });

    it("orders bulk rows: stop group, then clear group with Clear done before Clear all", async () => {
      mockModules.mockManager.listAgents.mockReturnValue([
        makeRecord({ id: "agent-1" }), // completed
        makeRecord({ id: "agent-2", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
        makeRecord({ id: "agent-3", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
      ]);
      const ctx = createMockCtx();
      await showRunningAgentsMenu(owner, ctx);
      const values = selectListCalls[0].items.map((i) => i.value);
      expect(values).toEqual([
        "agent-1",
        "agent-2",
        "agent-3",
        "__sep__",
        "__stop-all",
        "__sep__",
        "__clear-done",
        "__clear-all",
      ]);
    });

    it("shows only Clear all in the clear group when no completed agents exist", async () => {
      mockModules.mockManager.listAgents.mockReturnValue([
        makeRecord({ id: "agent-1", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
        makeRecord({ id: "agent-2", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
      ]);
      const ctx = createMockCtx();
      await showRunningAgentsMenu(owner, ctx);
      const values = selectListCalls[0].items.map((i) => i.value);
      expect(values).toEqual(["agent-1", "agent-2", "__sep__", "__stop-all", "__sep__", "__clear-all"]);
    });
  });
});

import { createTestOwner } from "../../owner-fixtures.js";
const owner = await createTestOwner();
