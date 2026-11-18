import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Component } from "@earendil-works/pi-tui";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx, type ComponentFactory } from "../../menu-test-helpers.js";
import { makeFinishedAgent, makeRunningAgent } from "../widget-helpers.js";
import { showRunningAgentsMenu } from "../../../src/ui/menu/menu-running-agents.js";
import { getCoordinator } from "../../../src/shell.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { asAgentSession } from "../../pi-boundaries.js";
import type { AgentRecord, AgentSubmissionResult, SubagentRun, SubagentRunOutcome } from "../../../src/types.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const WIDTH = 100;

async function openMenu() {
  const manager = mockModules.mockManager;
  manager.getRecord.mockImplementation((id: string) => manager.listAgents().find((record) => record.id === id));
  let component: Component | undefined;
  let overlay: Component | undefined;
  const closed = vi.fn();
  const color = vi.fn((_color: string, text: string) => text);
  const ctx = createMockCtx([], [], [], {
    ui: {
      custom: async (factory: ComponentFactory, options?: { overlay?: boolean }) => {
        const tui = { terminal: { rows: 40 }, requestRender: vi.fn() };
        const theme = { fg: color, bg: color, bold: (text: string) => text };
        const result = await factory(tui, theme, undefined, options?.overlay ? () => (overlay = undefined) : closed);
        if (!result || typeof result !== "object" || !("render" in result) || !("handleInput" in result)) {
          throw new Error("Running agents menu did not return an interactive component");
        }
        if (options?.overlay) overlay = result as Component;
        else component = result as Component;
      },
    },
  });
  await showRunningAgentsMenu(owner, ctx);
  if (!component) throw new Error("Running agents menu did not open");
  const menu = component;
  return {
    closed,
    ctx,
    color,
    press(...keys: string[]) {
      for (const key of keys) (overlay ?? menu).handleInput!(key);
    },
    render(width = WIDTH) {
      return menu.render(width);
    },
    overlayText() {
      return overlay?.render(WIDTH).join("\n");
    },
    selection() {
      return menu
        .render(WIDTH)
        .find((line) => line.startsWith("→ "))
        ?.slice(2)
        .trim();
    },
  };
}

function setLiveAgents(records: AgentRecord[]): void {
  mockModules.mockManager.listAgents.mockReturnValue(records);
  mockModules.mockManager.getRuns.mockImplementation((id) => {
    const record = records.find((candidate) => candidate.id === id);
    return record
      ? [
          {
            ...run(1),
            agentId: id,
            phase: record.lifecycle.phase ?? (record.lifecycle.status === "running" ? "running" : "settled"),
          },
        ]
      : [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const stopped = makeFinishedAgent("agent-2", { type: "stopped-agent" });
  stopped.lifecycle.status = "stopped";
  setLiveAgents([
    makeRunningAgent("agent-1", { type: "running-agent" }),
    stopped,
    makeFinishedAgent("agent-3", { type: "completed-agent" }),
  ]);
  mockModules.mockManager.abort.mockReturnValue(true);
});

afterEach(resetConfig);

describe("running agents keyboard navigation", () => {
  it("visits every selectable row in order, skipping separators on repeated sweeps", async () => {
    const menu = await openMenu();
    const cycle = [
      "running-agent",
      "stopped-agent",
      "completed-agent",
      "Stop 1 running agent(s)",
      "Clear done",
      "Clear all",
    ];
    for (let pass = 0; pass < 3; pass++) {
      for (const label of cycle) {
        expect(menu.selection()).toContain(label);
        menu.press(DOWN);
      }
    }
    expect(menu.selection()).toContain("running-agent");
  });

  it.each([
    ["down from the last agent to the first bulk action", [DOWN, DOWN, DOWN], "Stop 1 running agent(s)"],
    ["up from the bulk actions to the last agent", [DOWN, DOWN, DOWN, UP], "completed-agent"],
    ["up from the first agent to the last bulk action", [UP], "Clear all"],
    ["down from the last bulk action to the first agent", [UP, DOWN], "running-agent"],
  ])("moves %s", async (_name, keys, expected) => {
    const menu = await openMenu();
    menu.press(...keys);
    expect(menu.selection()).toContain(expected);
  });

  it("preserves the menu after only part of a batch is accepted", async () => {
    setLiveAgents([makeRunningAgent("agent-1"), makeRunningAgent("agent-2")]);
    mockModules.mockManager.abort.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const menu = await openMenu();
    menu.press(DOWN, DOWN, ENTER);
    expect(mockModules.mockManager.abort.mock.calls).toEqual([
      ["agent-1", "user"],
      ["agent-2", "user"],
    ]);
    expect(menu.closed).not.toHaveBeenCalled();
    expect(menu.ctx.ui.notify).toHaveBeenCalledWith(
      "Stop requested for 1 of 2 agent(s). Some requests were not accepted.",
      "warning",
    );
  });

  it("keeps history available and hides mutations while stopping", async () => {
    const record = makeRunningAgent("agent-1");
    record.lifecycle.phase = "stopping";
    mockModules.mockManager.listAgents.mockReturnValue([record]);
    mockModules.mockManager.getRuns.mockReturnValue([
      run(1, { result: "old result" }),
      { ...run(2), phase: "stopping" },
    ]);
    const menu = await openMenu();
    expect(menu.selection()).toContain("stopping");
    expect(menu.render().join("\n")).not.toContain("Stop 1");
    menu.press(ENTER);
    const rendered = menu.render().join("\n");
    expect(rendered).toContain("Run history (1)");
    expect(rendered).not.toMatch(/Steer|Continue|Clear|Stop/);
  });

  it("executes the bulk action reached past a separator", async () => {
    const menu = await openMenu();
    menu.press(DOWN, DOWN, DOWN, ENTER);
    expect(mockModules.mockManager.abort.mock.calls).toEqual([["agent-1", "user"]]);
    expect(menu.closed).toHaveBeenCalledOnce();
  });
});

describe("running agents message composition", () => {
  async function openContinue() {
    const record = makeFinishedAgent("agent-1");
    record.execution.session = asAgentSession({ messages: [], state: {}, subscribe: vi.fn(() => () => {}) });
    record.lifecycle.phase = "settled";
    setLiveAgents([record]);
    const menu = await openMenu();
    menu.press(ENTER, DOWN);
    expect(menu.selection()).toBe("Continue");
    menu.press(ENTER);
    return { menu, record };
  }

  it("routes Continue from the menu's conversation viewer", async () => {
    const record = makeFinishedAgent("agent-1");
    record.execution.session = asAgentSession({ messages: [], state: {}, subscribe: vi.fn(() => () => {}) });
    setLiveAgents([record]);
    const submit = mockModules.mockManager.submitMessage;
    submit.mockResolvedValue({ accepted: false, reason: "capacity", message: "Wait for a free slot." });
    const menu = await openMenu();
    menu.press(ENTER, ENTER);
    await Promise.resolve();
    expect(menu.overlayText()).toBeDefined();
    menu.press(ENTER, " ", "a", " ", ENTER);
    await Promise.resolve();
    expect(submit).toHaveBeenCalledWith(record.id, " a ");
    expect(menu.overlayText()).toContain("Continue not accepted: Wait for a free slot.");
  });

  it("keeps the raw draft in focus while pending and after a sanitized refusal", async () => {
    let finish!: (result: AgentSubmissionResult) => void;
    const pending = new Promise<AgentSubmissionResult>((resolve) => {
      finish = resolve;
    });
    const submit = mockModules.mockManager.submitMessage;
    submit
      .mockReturnValueOnce(pending)
      .mockRejectedValueOnce(new Error("private stack"))
      .mockResolvedValueOnce({ accepted: true, agentId: "agent-1", runId: "run-2", delivery: "continuation" });
    const { menu } = await openContinue();
    const draft = "  keep writing  ";
    menu.press(" ", ENTER);
    expect(submit).not.toHaveBeenCalled();
    menu.press("\x7f", `\x1b[200~${draft}\x1b[201~`, ENTER, ENTER);
    expect(submit.mock.calls).toEqual([["agent-1", draft]]);
    expect(menu.render().join("\n")).toContain("Submitting…");
    finish({ accepted: false, reason: "capacity", message: "Full\x1b]0;secret\x07 now." });
    await pending;
    expect(menu.render().join("\n")).toContain("Continue not accepted: Full now.");
    expect(menu.render().join("\n")).not.toContain("secret");
    menu.press(ENTER);
    await Promise.resolve();
    expect(menu.render().join("\n")).toContain("Continue not accepted: The message could not be submitted. Try again.");
    expect(menu.render().join("\n")).not.toContain("private stack");
    menu.press(ENTER);
    await Promise.resolve();
    expect(submit.mock.calls).toEqual(Array.from({ length: 3 }, () => ["agent-1", draft]));
    expect(menu.selection()).toBe("Continue");
  });

  it("refuses the original Continue if the target resumes before Enter", async () => {
    const { menu, record } = await openContinue();
    record.lifecycle.phase = "running";
    record.lifecycle.status = "running";
    menu.press("d", ENTER);
    await Promise.resolve();
    expect(mockModules.mockManager.submitMessage).not.toHaveBeenCalled();
    expect(menu.render().join("\n")).toContain(
      "The run changed while you were composing. Reopen the action and try again.",
    );
    expect(menu.render().join("\n")).toContain("> d");
  });

  it("does not return to old actions when acceptance arrives after leaving the composer", async () => {
    let finish!: (result: AgentSubmissionResult) => void;
    const pending = new Promise<AgentSubmissionResult>((resolve) => {
      finish = resolve;
    });
    mockModules.mockManager.submitMessage.mockReturnValueOnce(pending);
    const { menu } = await openContinue();
    menu.press("d", ENTER, ESC, ESC);
    expect(menu.selection()).toContain("agent-1");
    finish({ accepted: true, agentId: "agent-1", runId: "run-2", delivery: "continuation" });
    await pending;
    expect(menu.selection()).toContain("agent-1");
  });
});

function run(sequence: number, outcome?: Partial<SubagentRunOutcome>): SubagentRun {
  return {
    id: `stable-id-${sequence}`,
    agentId: "agent-1",
    sequence,
    phase: outcome ? "settled" : "running",
    acceptedAt: 1_000,
    startedAt: 2_000,
    completion: Promise.resolve(),
    outcome: outcome && { status: "completed", completedAt: 14_000, ...outcome },
  };
}

function setupHistory() {
  const record = makeRunningAgent("agent-1");
  record.execution.session = undefined;
  const first = run(1, { result: "old \x1b]0;hidden\x07result" });
  const second = run(2, { status: "error", error: "old error" });
  mockModules.mockManager.listAgents.mockReturnValue([record]);
  mockModules.mockManager.getRuns.mockReturnValue([first, second, run(3)]);
  const coordinator = getCoordinator(owner)!;
  vi.mocked(coordinator.getCompletionNotification).mockReturnValue({
    status: "submitted",
    notificationId: "fixed-notice",
    canRetry: true,
  });
  return { first, second, coordinator };
}

const RISK =
  "Retrying may deliver this notification twice or wake the parent twice. Retry only if you accept this risk.";

describe("run history keyboard navigation", () => {
  it("opens retained and empty results without a session, then restores a run by ID as new runs settle", async () => {
    const { first, second, coordinator } = setupHistory();
    vi.mocked(coordinator.getCompletionNotification).mockReturnValue({ status: "not-required", canRetry: false });
    const menu = await openMenu();
    menu.press(ENTER);
    expect(menu.selection()).toBe("View result · Run 1");
    menu.press(ENTER);
    await Promise.resolve();
    expect(menu.overlayText()).toContain("old result");
    expect(menu.overlayText()).not.toContain("hidden");
    menu.press(ESC, DOWN, DOWN);
    expect(menu.selection()).toBe("Run history (2)");
    menu.press(ENTER);
    expect(menu.selection()).toBe("Run 2 · error · 12s");
    menu.press(ENTER);
    expect(menu.selection()).toBe("View result");
    expect(menu.render().join("\n")).toContain("Completion notification: Not required for this run.");
    menu.press(ENTER);
    await Promise.resolve();
    expect(menu.overlayText()).toContain("No output was produced for this run.");
    menu.press(ESC, DOWN, ENTER);
    await Promise.resolve();
    expect(menu.overlayText()).toContain("old error");
    mockModules.mockManager.getRuns.mockReturnValue([first, second, run(3, {}), run(4)]);
    menu.press(ESC, ESC);
    expect(menu.selection()).toBe("Run 2 · error · 12s");
    menu.press(UP);
    expect(menu.selection()).toBe("Run 3 · completed · 12s");
    menu.press(ESC);
    expect(menu.selection()).toBe("Run history (2)");
    menu.press(ESC);
    expect(menu.selection()).toContain("agent-1");
    menu.press(ESC);
    expect(menu.closed).toHaveBeenCalledOnce();
    expect(coordinator.retryCompletionNotification).not.toHaveBeenCalled();
  });

  it.each([40, 80, 120])("wraps the warning before styling and outside the SelectList at %s columns", async (width) => {
    const { coordinator } = setupHistory();
    const menu = await openMenu();
    menu.press(ENTER, DOWN, DOWN, ENTER, ENTER);
    menu.color.mockClear();
    const lines = menu.render(width);
    const fragments = menu.color.mock.calls.filter(([color]) => color === "warning").map(([, text]) => text);
    expect(fragments.map((text) => text.trim()).join(" ")).toBe(RISK);
    expect(fragments.every((text) => [ESC, "\r", "\n"].every((control) => !text.includes(control)))).toBe(true);
    expect(
      fragments.every((text) => lines.indexOf(`  ${text}`) < lines.findIndex((line) => line.startsWith("→ "))),
    ).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.map((line) => line.trim()).join(" ")).toContain(
      "Completion notification: Submitted — receipt unconfirmed.",
    );
    expect(menu.selection()).toBe("View result");
    expect(coordinator.retryCompletionNotification).not.toHaveBeenCalled();
  });

  it("retries only the selected run and resets repeated Enter to a read-only action", async () => {
    const { first, coordinator } = setupHistory();
    vi.mocked(coordinator.retryCompletionNotification).mockReturnValue("submitted");
    const menu = await openMenu();
    menu.press(ENTER, DOWN, DOWN, ENTER, DOWN, ENTER);
    expect(menu.selection()).toBe("View result");
    expect(menu.render().join("\n")).toContain(RISK.split(" Retry")[0]);
    menu.press(DOWN);
    expect(menu.selection()).toBe("Retry completion notification");
    menu.press(ENTER, ENTER, ENTER);
    await Promise.resolve();
    expect(coordinator.retryCompletionNotification).toHaveBeenCalledExactlyOnceWith(first.id, "fixed-notice", menu.ctx);
    expect(menu.selection()).toBe("View result");
    expect(menu.overlayText()).toBeUndefined();
    expect(menu.render().join("\n")).toContain("Retry attempted. Receipt remains unconfirmed.");
  });

  it("requires a rendered warning before accepting retry and hides it while the notice is pending", async () => {
    const { coordinator } = setupHistory();
    const receipt = vi.mocked(coordinator.getCompletionNotification);
    receipt.mockReturnValue({ status: "pending", notificationId: "fixed-notice", canRetry: false });
    const menu = await openMenu();
    menu.press(ENTER, DOWN, DOWN, ENTER, DOWN, ENTER);
    const pending = menu.render().join("\n");
    expect(pending).toContain("Completion notification: Pending — not submitted.");
    expect(pending).not.toContain("Retry completion notification");
    receipt.mockReturnValue({ status: "submitted", notificationId: "fixed-notice", canRetry: true });
    menu.press(ESC, ENTER, DOWN, ENTER);
    expect(coordinator.retryCompletionNotification).not.toHaveBeenCalled();
    expect(menu.selection()).toBe("Retry completion notification");
    menu.press(ENTER);
    expect(coordinator.retryCompletionNotification).toHaveBeenCalledOnce();
  });

  it("removes retry and explains an observed receipt after activation rechecks history", async () => {
    const { coordinator } = setupHistory();
    vi.mocked(coordinator.retryCompletionNotification).mockImplementation(() => {
      vi.mocked(coordinator.getCompletionNotification).mockReturnValue({
        status: "observed",
        notificationId: "fixed-notice",
        canRetry: false,
      });
      return "observed";
    });
    const menu = await openMenu();
    menu.press(ENTER, DOWN, DOWN, ENTER, ENTER);
    expect(menu.selection()).toBe("View result");
    menu.press(DOWN, DOWN, ENTER);
    const text = menu.render().join("\n");
    expect(text).toContain("Completion notification: Observed in parent history.");
    expect(text).toContain("This confirms history entry only.");
    expect(text).toContain("This notification is already in parent history.");
    expect(text).not.toContain("Retry completion notification");
    expect(text).not.toContain(RISK);
    expect(menu.selection()).toBe("View result");
  });
});

import { createTestOwner } from "../../owner-fixtures.js";
const owner = await createTestOwner();
