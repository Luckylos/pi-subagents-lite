import { emit, finishedRun, parent, services, type ParentFixture } from "../../instance-fixtures.js";
import { expect, it, vi } from "vite-plus/test";
import type { JsonObject } from "@earendil-works/pi-ai";
import type {
  ExtensionCommandContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component, type SelectList, type TUI } from "@earendil-works/pi-tui";
import { runAgent } from "../../../src/agents/agent-runner.js";
import { executeAgentTool } from "../../../src/agents/tool-execution.js";
import { showDebugMenu } from "../../../src/ui/menu/menu-debug.js";
import { assistantMessage } from "../../agents/session-messages.js";
import { makeResolvablePromise } from "../../fixtures.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { asTui } from "../../pi-boundaries.js";

let confirmRestart: () => Promise<void>;
vi.mock("@earendil-works/pi-tui", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-tui")>();
  return {
    ...actual,
    SelectList: class extends actual.SelectList {
      constructor(...args: ConstructorParameters<typeof SelectList>) {
        super(...args);
        confirmRestart = async () => {
          const item = args[0].find(({ value }) => value === "restart-last-agents");
          if (!item || !this.onSelect) throw new Error("Restart menu item missing");
          await this.onSelect(item);
        };
      }
    },
  };
});

async function openDebug(fixture: ParentFixture, ctx: ExtensionCommandContext) {
  // Exercise a fresh SDK command context backed by the same parent session manager.
  await showDebugMenu(fixture.owner, { ...ctx });
  return confirmRestart;
}

async function startParent(...calls: JsonObject[]) {
  const fixture = parent();
  const ctx = createMockCtx();
  vi.mocked(ctx.sessionManager.getEntries).mockReturnValue([
    {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-11-18T00:00:00.000Z",
      message: assistantMessage({
        content: calls.map((args, index) => ({
          type: "toolCall",
          id: `call-${index}`,
          name: "Agent",
          arguments: args,
        })),
      }),
    },
  ]);
  await emit(fixture, "session_start", ctx);
  return { fixture, ctx };
}

function pauseNextResolution({ owner: { registry } }: ParentFixture) {
  const started = makeResolvablePromise();
  const release = makeResolvablePromise();
  vi.spyOn(registry, "resolveTypeOrDiscover").mockImplementationOnce(async (type, dir) => {
    started.resolve(undefined);
    await release.promise;
    return registry.resolveType(type, dir);
  });
  return { started: started.promise, release: () => release.resolve(undefined) };
}

function holdRunningAgents() {
  vi.mocked(runAgent).mockImplementation(
    (_owner, _ctx, _type, _prompt, options) =>
      new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(finishedRun()), { once: true });
      }),
  );
}

it("starts one replay when Debug is confirmed twice during type resolution and allows a later replay", async () => {
  const { fixture, ctx } = await startParent({ prompt: "historical work" });
  const firstResolution = pauseNextResolution(fixture);
  const secondResolution = pauseNextResolution(fixture);
  const firstConfirmation = await openDebug(fixture, ctx);
  const first = firstConfirmation();
  await firstResolution.started;
  const secondConfirmation = await openDebug(fixture, ctx);
  const second = secondConfirmation();
  firstResolution.release();
  secondResolution.release();
  await Promise.all([first, second]);

  const { manager } = services(fixture);
  expect(manager.listAgents()).toHaveLength(1);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Restart already in progress"), "info");
  await manager.listAgents()[0].execution.promise;
  await secondConfirmation();
  expect(manager.listAgents()).toHaveLength(2);
});

it.each(["running", "queued"] as const)("skips a matching independent Agent spawn admitted as %s", async (status) => {
  holdRunningAgents();
  const { fixture, ctx } = await startParent({ agent: "GENERAL-PURPOSE", prompt: "same work" });
  const { manager, store } = services(fixture);
  store.mutate.concurrency.setDefault(1, "session");
  const launch = (prompt: string) =>
    executeAgentTool(fixture.owner, prompt, { prompt, run_in_background: true }, undefined, undefined, ctx);
  if (status === "queued") await launch("fills the model slot");
  const resolution = pauseNextResolution(fixture);
  const confirm = await openDebug(fixture, ctx);
  const restarting = confirm();
  await resolution.started;
  await launch("same work");
  resolution.release();
  await restarting;

  const matching = manager.listAgents().filter(({ display }) => display.description === "same work");
  expect(matching.map(({ lifecycle }) => lifecycle.status)).toEqual([status]);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("same work (already running)"), "info");
});

it("keeps historical order and matching calls within one batch after individual failures", async () => {
  holdRunningAgents();
  const { fixture, ctx } = await startParent(
    { prompt: "fails to spawn" },
    { description: "missing prompt" },
    { prompt: "historical call one", description: "same label" },
    { prompt: "historical call two", description: "same label", agent: "GENERAL-PURPOSE" },
  );
  const { manager, store } = services(fixture);
  store.mutate.concurrency.setDefault(1, "session");
  const spawn = vi.spyOn(manager, "spawn").mockImplementationOnce(() => {
    throw new Error("launch rejected");
  });

  const confirm = await openDebug(fixture, ctx);
  await confirm();

  expect(spawn.mock.calls.map(([, , type, prompt]) => [type, prompt])).toEqual([
    ["general-purpose", "fails to spawn"],
    ["general-purpose", "historical call one"],
    ["general-purpose", "historical call two"],
  ]);
  expect(manager.listAgents().map(({ lifecycle }) => lifecycle.status)).toEqual(["running", "queued"]);
  expect(ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining(
      "Skipped 2 agent(s):\n  • general-purpose: fails to spawn (spawn failed: Error: launch rejected)\n  • Agent call #2 (invalid arguments)",
    ),
    "info",
  );
});

it("allows a replacement parent to replay while an old resolution is pending", async () => {
  const { fixture, ctx } = await startParent({ prompt: "historical work" });
  const oldManager = services(fixture).manager;
  const oldResolution = pauseNextResolution(fixture);
  const confirmOld = await openDebug(fixture, ctx);
  const oldRestart = confirmOld();
  await oldResolution.started;

  // Even when Pi reuses the same SDK context, session_start replaces its coordinator.
  await emit(fixture, "session_start", ctx);
  const newResolution = pauseNextResolution(fixture);
  const confirmNew = await openDebug(fixture, ctx);
  const newRestart = confirmNew();
  await newResolution.started;
  oldResolution.release();
  await oldRestart;
  const repeatNew = confirmNew();
  newResolution.release();
  await Promise.all([newRestart, repeatNew]);

  expect(oldManager.listAgents()).toEqual([]);
  expect(services(fixture).manager.listAgents()).toHaveLength(1);
  expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Restart already in progress"), "info");
});

async function openRestartWithKeyboard(fixture: ParentFixture, ctx: ExtensionCommandContext) {
  let component: Component | undefined;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
  const custom: ExtensionUIContext["custom"] = <T>(
    factory: (
      tui: TUI,
      theme: Theme,
      kb: KeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>,
  ) =>
    new Promise<T>((resolve, reject) => {
      Promise.resolve(
        factory(asTui({}), theme, getKeybindings() as KeybindingsManager, (result) => {
          component = undefined;
          resolve(result);
        }),
      ).then((next) => (component = next), reject);
    });
  const command = fixture.api.commands.find(({ name }) => name === "agents")!;
  const running = command.handler("", { ...ctx, ui: { ...ctx.ui, custom } });
  const press = (...keys: string[]) => {
    for (const key of keys) component?.handleInput?.(key);
  };
  const title = (name: string) => vi.waitFor(() => expect(component?.render(100)).toContain(`  ${name}`));
  await title("Agents");
  press("\x1b[A", "\r");
  await title("Debug");
  press("\x1b[A");
  expect(component?.render(100).find((line) => line.startsWith("→"))).toContain("Restart last agents");
  return {
    confirm: () => press("\r"),
    async close() {
      press("\x1b");
      await title("Agents");
      press("\x1b");
      await running;
    },
  };
}

it("reports a history failure from Enter and retries in the same Debug menu", async () => {
  const { fixture, ctx } = await startParent({ prompt: "historical work" });
  const menu = await openRestartWithKeyboard(fixture, ctx);
  vi.mocked(ctx.sessionManager.getEntries).mockImplementationOnce(() => {
    throw new Error("history unavailable");
  });

  try {
    menu.confirm();
    await vi.waitFor(() =>
      expect(ctx.ui.notify).toHaveBeenCalledWith("Failed to restart agents: history unavailable", "error"),
    );
    expect(services(fixture).manager.listAgents()).toEqual([]);

    menu.confirm();
    await vi.waitFor(() =>
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Restarted 1 agent(s)"), "info"),
    );
    expect(services(fixture).manager.listAgents()).toHaveLength(1);
    expect(ctx.sessionManager.getEntries).toHaveBeenCalledTimes(2);
  } finally {
    await menu.close();
  }
});

it("suppresses an old Debug menu's failure and blocks Enter after the parent is replaced", async () => {
  const { fixture, ctx } = await startParent({ prompt: "historical work" });
  const menu = await openRestartWithKeyboard(fixture, ctx);
  const getEntries = vi.mocked(ctx.sessionManager.getEntries);
  getEntries.mockImplementationOnce(() => {
    throw new Error("old history unavailable");
  });

  try {
    menu.confirm();
    // Replace the owner before the history rejection resumes the menu handler.
    await emit(fixture, "session_start", ctx);
    menu.confirm();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(services(fixture).manager.listAgents()).toEqual([]);
    expect(getEntries).toHaveBeenCalledTimes(1);
  } finally {
    await menu.close();
  }
});
