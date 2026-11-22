/** Real SettingsList/wrapper public input with exclusive-create regression coverage. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Component, SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { SettingsListWrapper, type SettingsListWrapperOptions } from "../../../src/ui/menu/wrappers/settings-list.js";
import type { SystemPromptMode } from "../../../src/agents/types.js";
import { ConfigStore } from "../../../src/config/config-store.js";
import { memIO } from "../../config/config-store-helpers.js";
import { createMockCtx, type ComponentFactory } from "../../menu-test-helpers.js";
import { createTestOwner } from "../../owner-fixtures.js";
import { showSystemPromptMenu } from "../../../src/ui/menu/menu-system-prompt.js";
import { SEPARATOR_ID } from "../../../src/ui/menu/helpers.js";

interface CreationFailure {
  stage: "mkdir" | "write";
  value: unknown;
}
interface FailureState {
  current: CreationFailure | undefined;
}
interface ListCapture {
  list: SettingsList;
  onChange: (id: string, newValue: string) => void;
}

const harness = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const root = execFileSync("mktemp", ["-d", "/tmp/pi-f1-inplace.XXXXXX"], { encoding: "utf-8" }).trim();
  fs.chmodSync(root, 0o700);
  const directory = `${root}/prompt`;
  const promptPath = `${directory}/subagents-lite-prompt.md`;
  const captures: ListCapture[] = [];
  const itemArrays: SettingItem[][] = [];
  const failure: FailureState = { current: undefined };
  return { fs, root, directory, promptPath, captures, itemArrays, failure };
});

vi.mock("../../../src/shell.js", async () => (await import("../../owner-fixtures.js")).ownerShellMock({}));
vi.mock("../../../src/config/config-io.js", async () => ({
  ...(await vi.importActual<typeof import("../../../src/config/config-io.js")>("../../../src/config/config-io.js")),
  CUSTOM_PROMPT_PATH: harness.promptPath,
}));

// Partial builtin mock: the menu's actual mkdir/write can only touch our owned paths.
// All other exports retain their real signatures; no spyOn on an ESM namespace.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const existsSync: typeof actual.existsSync = (target) => {
    if (target !== harness.promptPath) throw new Error("Unexpected prompt existence target");
    return harness.fs.existsSync(target);
  };
  const mkdirSync: typeof actual.mkdirSync = (target, options) => {
    if (target !== harness.directory) throw new Error("Unexpected prompt directory target");
    if (harness.failure.current?.stage === "mkdir") throw harness.failure.current.value;
    return harness.fs.mkdirSync(target, options);
  };
  const writeFileSync: typeof actual.writeFileSync = (target, data, options) => {
    if (target !== harness.promptPath) throw new Error("Unexpected prompt write target");
    if (harness.failure.current?.stage === "write") throw harness.failure.current.value;
    return harness.fs.writeFileSync(target, data, options);
  };
  return { ...actual, default: { ...actual, existsSync, mkdirSync, writeFileSync } };
});

// Constructor instrumentation delegates to the real library, never its private methods.
vi.mock("@earendil-works/pi-tui", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-tui")>("@earendil-works/pi-tui");
  return {
    ...actual,
    SettingsList: class RecordedSettingsList extends actual.SettingsList {
      constructor(...args: ConstructorParameters<typeof actual.SettingsList>) {
        super(...args);
        harness.captures.push({ list: this, onChange: args[3] });
        harness.itemArrays.push(structuredClone(args[0]));
      }
    },
  };
});
vi.mock("../../../src/ui/menu/wrappers/settings-list.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/ui/menu/wrappers/settings-list.js")>(
    "../../../src/ui/menu/wrappers/settings-list.js",
  );
  return {
    ...actual,
    SettingsListWrapper: class RecordedWrapper extends actual.SettingsListWrapper {
      constructor(list: Component, options: SettingsListWrapperOptions) {
        super(list, {
          ...options,
          onRebuild: (rebuild) => {
            options.onRebuild?.((items: SettingItem[]) => {
              harness.itemArrays.push(structuredClone(items));
              rebuild(items);
            });
          },
        });
      }
    },
  };
});

const template =
  "You are a Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously";

function expectedItems(mode: SystemPromptMode, create: boolean): SettingItem[] {
  const items: SettingItem[] = [
    {
      id: "systemPromptMode",
      label: "System prompt mode",
      currentValue: mode,
      values: ["replace", "inherit", "custom"],
      description: "How the subagent system prompt is built: replace, inherit, or custom.",
    },
  ];
  if (create) {
    items.push({
      id: "createPromptFile",
      label: "Create prompt file",
      currentValue: harness.promptPath,
      values: ["Create"],
      description: `Create ${harness.promptPath} with a starter template for custom mode.`,
    });
  }
  items.push(
    {
      id: "includeContextFiles",
      label: "Include AGENTS.md",
      currentValue: "OFF",
      values: ["ON", "OFF"],
      description: "Load project and ~/.pi/agent AGENTS.md as shared <project_context>.",
    },
    {
      id: "loadSkillsImplicitly",
      label: "Load skills implicitly",
      currentValue: "ON",
      values: ["ON", "OFF"],
      description: "Give new agents all skills when frontmatter omits the field.",
    },
    {
      id: "loadExtensionsImplicitly",
      label: "Load extensions implicitly",
      currentValue: "OFF",
      values: ["ON", "OFF"],
      description: "Give new agents all extensions when frontmatter omits the field.",
    },
    {
      id: "loadToolsImplicitly",
      label: "Load tools implicitly",
      currentValue: "ON",
      values: ["ON", "OFF"],
      description:
        "ON: pi applies its defaultTools setting to new agents. OFF: new agents start with no tools when frontmatter omits tool fields.",
    },
  );
  return items;
}

beforeEach(() => {
  harness.fs.rmSync(harness.directory, { recursive: true, force: true });
  harness.captures.length = 0;
  harness.itemArrays.length = 0;
  harness.failure.current = undefined;
});
afterAll(() => harness.fs.rmSync(harness.root, { recursive: true, force: true }));

async function open(mode: SystemPromptMode = "custom") {
  const memory = memIO({
    global: {
      agent: {
        systemPromptMode: mode,
        includeContextFiles: false,
        loadSkillsImplicitly: true,
        loadExtensionsImplicitly: false,
        loadToolsImplicitly: true,
      },
    },
  });
  const store = new ConfigStore(memory.io);
  const snapshot = structuredClone(store.agent);
  const owner = await createTestOwner();
  owner.store = store;
  let component: Component | undefined;
  const done = vi.fn<(result: unknown) => void>();
  const ctx = createMockCtx([], [], [], {
    ui: {
      notify: vi.fn(),
      custom: vi.fn(async (factory: ComponentFactory) => {
        const result = await factory(
          { terminal: { rows: 40 } },
          { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text },
          undefined,
          done,
        );
        if (!(result instanceof SettingsListWrapper)) {
          throw new Error("System prompt menu did not return a real wrapper");
        }
        component = result;
      }),
    },
  });
  await showSystemPromptMenu(owner, ctx);
  if (!component) throw new Error("System prompt menu did not open");
  const menu = component;
  const text = () => menu.render(180);
  const press = (...keys: string[]) => keys.forEach((key) => menu.handleInput?.(key));
  const select = (label: string) => {
    for (let i = 0; i < 7; i++) {
      if (text().some((line) => line.startsWith(`→ ${label} `))) return;
      press("j");
    }
    throw new Error(`Could not select ${label}`);
  };
  const assertItems = (expected: SettingItem[]) => {
    const items = harness.itemArrays.at(-1);
    expect(items).toEqual(expected);
    expect(items?.filter((item) => item.id === SEPARATOR_ID)).toHaveLength(0);
    const frame = text();
    expect(frame.filter((line) => line === "─".repeat(180))).toHaveLength(2);
    const rows = frame.slice(4, 4 + expected.length);
    expect(rows.filter((line) => line.startsWith("→ "))).toHaveLength(1);
    const width = Math.max(...expected.map((item) => item.label.length));
    expect(rows.map((line) => line.slice(2))).toEqual(
      expected.map((item) => `${item.label.padEnd(width)}  ${item.currentValue}`),
    );
  };
  const assertNoMutation = () => {
    expect(store.agent).toEqual(snapshot);
    expect(memory.saves).toEqual([]);
    expect(done).not.toHaveBeenCalled();
  };
  const created = () =>
    vi.mocked(ctx.ui.notify).mock.calls.filter(([message]) => message.startsWith("Created prompt file:"));
  return { ctx, done, store, press, select, text, assertItems, assertNoMutation, created };
}

function externalWrite(content: string) {
  harness.fs.mkdirSync(harness.directory, { recursive: true });
  harness.fs.writeFileSync(harness.promptPath, content, { encoding: "utf-8", mode: 0o640 });
}

function readPrompt() {
  return harness.fs.readFileSync(harness.promptPath, "utf-8");
}

describe("System prompt create safety through real SettingsList/wrapper", () => {
  it("preserves file bytes and permissions when another actor creates after menu opens", async () => {
    const app = await open();
    app.select("Create prompt file");
    externalWrite("USER-EXTERNAL-CONTENT");
    const permissions = harness.fs.statSync(harness.promptPath).mode;
    app.press("\r");
    expect(readPrompt()).toBe("USER-EXTERNAL-CONTENT");
    expect(harness.fs.statSync(harness.promptPath).mode).toBe(permissions);
    expect(app.created()).toHaveLength(0);
    expect(app.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to create prompt file:"), "error");
    app.assertNoMutation();
  });

  it("refreshes the complete current list after an existing-file create attempt", async () => {
    const app = await open();
    externalWrite("USER-EXTERNAL-CONTENT");
    app.select("Create prompt file");
    app.press("\r");
    app.assertItems(expectedItems("custom", false));
    expect(app.text()[4].startsWith("→ System prompt mode ")).toBe(true);
    app.assertNoMutation();
  });

  it("preserves edits after successful creation and later public Enter input", async () => {
    const app = await open();
    app.select("Create prompt file");
    app.press("\r");
    app.assertNoMutation();
    externalWrite("USER-EDIT-AFTER-CREATE");
    app.press("\r");
    expect(readPrompt()).toBe("USER-EDIT-AFTER-CREATE");
    expect(app.created()).toHaveLength(1);
    expect(app.done).not.toHaveBeenCalled();
  });

  it("preserves edited bytes when a previously captured Create action re-enters", async () => {
    const app = await open();
    const staleAction = harness.captures[0].onChange;
    app.select("Create prompt file");
    app.press("\r");
    externalWrite("USER-EDIT-AFTER-CREATE");
    staleAction("createPromptFile", "Create");
    expect(readPrompt()).toBe("USER-EDIT-AFTER-CREATE");
    expect(app.created()).toHaveLength(1);
    app.assertItems(expectedItems("custom", false));
    app.assertNoMutation();
  });

  it.each(["mkdir", "write"] as const)(
    "keeps retry available after %s failure without closing or mutating Store",
    async (stage) => {
      const app = await open();
      harness.failure.current = { stage, value: new Error("disk unavailable") };
      app.select("Create prompt file");
      app.press("\r");
      expect(app.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
        "Failed to create prompt file: disk unavailable",
        "error",
      );
      expect(app.created()).toHaveLength(0);
      expect(harness.fs.existsSync(harness.promptPath)).toBe(false);
      app.assertItems(expectedItems("custom", true));
      app.assertNoMutation();
      harness.failure.current = undefined;
      app.select("Create prompt file");
      app.press("\r");
      expect(readPrompt()).toBe(template);
      expect(app.created()).toHaveLength(1);
      app.assertItems(expectedItems("custom", false));
      app.assertNoMutation();
    },
  );

  it.each([
    { value: "write blocked", message: "write blocked" },
    { value: null, message: "null" },
    { value: new Error("write\nblocked\rnow"), message: "write blocked now" },
  ])("formats unknown creation errors safely: $message", async ({ value, message }) => {
    const app = await open();
    harness.failure.current = { stage: "write", value };
    app.select("Create prompt file");
    expect(() => app.press("\r")).not.toThrow();
    expect(app.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(`Failed to create prompt file: ${message}`, "error");
    expect(app.created()).toHaveLength(0);
    app.assertItems(expectedItems("custom", true));
    app.assertNoMutation();
  });

  it("writes exact starter bytes without a trailing newline and refreshes the full list", async () => {
    const app = await open();
    app.assertItems(expectedItems("custom", true));
    app.select("Create prompt file");
    app.press("\r");
    expect(harness.fs.readFileSync(harness.promptPath)).toEqual(Buffer.from(template, "utf-8"));
    expect(app.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(`Created prompt file: ${harness.promptPath}`, "info");
    app.assertItems(expectedItems("custom", false));
    app.assertNoMutation();
  });

  it.each(["replace", "inherit"] as const)("keeps the complete %s-mode list without a Create action", async (mode) => {
    const app = await open(mode);
    app.assertItems(expectedItems(mode, false));
    expect(harness.fs.existsSync(harness.promptPath)).toBe(false);
    app.assertNoMutation();
  });

  it("does not offer Create for a custom file that exists before opening", async () => {
    externalWrite("EXISTING-CUSTOM-PROMPT");
    const app = await open();
    app.assertItems(expectedItems("custom", false));
    expect(readPrompt()).toBe("EXISTING-CUSTOM-PROMPT");
    app.assertNoMutation();
  });
});
