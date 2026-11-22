/** Real SettingsList + wrapper, driven through public input for in-place Clear/rebuild. */
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Component, SettingItem } from "@earendil-works/pi-tui";
import { createConfigIO } from "../../../src/config/config-io.js";
import { ConfigStore, type ConfigIO } from "../../../src/config/config-store.js";
import { memIO } from "../../config/config-store-helpers.js";
import { createMockCtx, type ComponentFactory } from "../../menu-test-helpers.js";
import { createTestOwner } from "../../owner-fixtures.js";
import { settingsListWrapperView } from "../../pi-boundaries.js";
import { defaultModel, defaultModelRegistry } from "../../mock-utils.js";
import { showModelSettingsMenu } from "../../../src/ui/menu/menu-model-settings.js";
import { SEPARATOR_ID } from "../../../src/ui/menu/helpers.js";

const disk = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const root = mkdtempSync("/tmp/pi-f5-menu-io-");
  return { root, failPath: "" };
});
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => `${disk.root}/global`,
  // No interactive Pi theme in the fixture. The picker itself handles real input/rendering.
  DynamicBorder: class {
    render() {
      return [""];
    }
    invalidate() {}
  },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (args[1] === disk.failPath) throw new Error("config rename failed");
      return actual.renameSync(...args);
    },
  };
});
afterAll(() => rmSync(disk.root, { recursive: true, force: true }));

vi.mock("../../../src/pi-settings.js", () => ({
  getPiDefaultThinkingLevel: () => undefined,
  getPiModelThinkingLevels: () => ({}),
}));
afterEach(() => {
  disk.failPath = "";
});

const blank = [SEPARATOR_ID, " ", ""];
const rule = [SEPARATOR_ID, "─────────────────────────", "────────"];
const override = ["overrideType", "Override another type...", ""];
const clearAll = ["clearAll", "Clear all model overrides...", ""];
const header = (id: string) => [SEPARATOR_ID, id, ""];
const itemData = (items: readonly SettingItem[]) =>
  items.map(({ id, label, currentValue }) => [id, label, currentValue]);

async function open(store: ConfigStore, types = ["Scout", "NullType", "Plain"]) {
  const owner = await createTestOwner();
  owner.store = store;
  owner.registry.registerAgents(new Map(types.map((name) => [name, { name, description: name, systemPrompt: "" }])), {
    disableDefaultAgents: true,
  });
  const models = ["default", "project", "scout"].map((id) => ({ ...defaultModel()!, id, reasoning: false }));
  let component: Component | undefined;
  const ctx = createMockCtx([], [], [], {
    modelRegistry: defaultModelRegistry({
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => models,
    }),
    ui: {
      notify: vi.fn(),
      custom: vi.fn(async (factory: ComponentFactory) => {
        const result = await factory(
          { terminal: { rows: 40 } },
          {
            fg: (_color, text) => text,
            bold: (text) => text,
            italic: (text) => text,
          },
          undefined,
          () => {},
        );
        if (!result || typeof result !== "object" || !("render" in result) || !("handleInput" in result)) {
          throw new Error("Model menu did not return a component");
        }
        component = result as Component;
      }),
    },
  });
  await showModelSettingsMenu(
    owner,
    ctx,
    models.map((model) => `${model.provider}/${model.id}`),
  );
  if (!component) throw new Error("Model menu did not open");
  const menu = component;
  const items = () => settingsListWrapperView(menu).settingsList.items;
  const text = () => menu.render(180).join("\n");
  const press = (...keys: string[]) => keys.forEach((key) => menu.handleInput!(key));
  const select = (label: string) => {
    for (let i = 0; i < 20; i++) {
      if (
        text()
          .split("\n")
          .some((line) => line.startsWith(`→ ${label} `))
      )
        return;
      press("j");
    }
    throw new Error(`Could not select ${label}`);
  };
  const openClear = (label: string) => {
    select(label);
    press("\r");
    if (label !== "Clear all model overrides...") {
      select("Clear...");
      press("\r");
    }
  };
  const assertLevels = (expected: string[]) => {
    // Read the entire rendered picker body, before the selected row's description.
    const body = menu.render(180).slice(4);
    const end = body.findIndex((line) => line.trim() === "");
    expect(body.slice(0, end).map((line) => line.replace(/^→ /, "").trim())).toEqual(expected);
  };
  const pickClear = (label: string, target: string) => {
    select(target);
    press("\r");
    if (label === "Clear all model overrides...") {
      select("Yes");
      press("\r");
    }
  };
  const clear = (label: string, target: string) => {
    openClear(label);
    pickClear(label, target);
  };
  const assertItems = (expected: string[][]) => {
    expect(itemData(items())).toEqual(expected);
    expect(items().filter((item) => item.id === SEPARATOR_ID)).toHaveLength(
      expected.filter(([id]) => id === SEPARATOR_ID).length,
    );
  };
  return { ctx, menu, owner, items, text, press, select, clear, openClear, pickClear, assertLevels, assertItems };
}

async function fileMenu(globalText: string, projectText: string, types?: string[]) {
  const globalDir = join(disk.root, "global");
  const projectDir = join(disk.root, "project");
  mkdirSync(globalDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const globalPath = join(globalDir, "subagents-lite.json");
  const projectPath = join(projectDir, "subagents-lite.json");
  writeFileSync(globalPath, globalText);
  writeFileSync(projectPath, projectText);
  const store = new ConfigStore(createConfigIO(projectDir));
  return { app: await open(store, types), store, globalDir, projectDir, globalPath, projectPath };
}

describe("Model menu configuration read ownership and real rebuild", () => {
  it("offers only session operations for a type sharing a behavior key and keeps default dedicated", async () => {
    const globalText =
      '{ "agent": { "Scout": "test/scout", "systemPromptMode": "custom", "default": "test/default", "showCost": true } }\n';
    const { app, globalPath, projectPath } = await fileMenu(globalText, "{}", ["systemPromptMode", "default", "Scout"]);
    expect(app.owner.registry.resolveType("default")).toEqual({ kind: "resolved", key: "default" });
    expect(app.text()).toMatch(/before.*frontmatter/i);
    expect(app.items().map(({ id }) => id)).not.toContain("type:default");
    expect(app.items().map(({ id }) => id)).not.toContain("type:systemPromptMode");
    app.select("Override another type...");
    app.press("\r");
    expect(app.text()).not.toMatch(/→ default|  default /);
    app.press("\r");
    app.assertLevels(["Session"]);
    app.press("\r", "scout", "\r");
    app.openClear("systemPromptMode");
    app.assertLevels(["Session"]);
    app.pickClear("systemPromptMode", "Session");
    expect(readFileSync(globalPath, "utf8")).toBe(globalText);
    expect(readFileSync(projectPath, "utf8")).toBe("{}");
    expect(app.items().map(({ id }) => id)).not.toContain("type:systemPromptMode");
    app.clear("Global default model", "Global");
    expect(JSON.parse(readFileSync(globalPath, "utf8")).agent).toEqual({
      Scout: "test/scout",
      systemPromptMode: "custom",
      showCost: true,
    });
  });

  it.each(["Scout", "Clear all model overrides..."])(
    "reports a newly malformed project during %s Clear and retries after repair in place",
    async (label) => {
      const projectText = '{ "agent": { "Scout": "test/project" } }\n';
      const { app, store, globalPath, projectPath } = await fileMenu(
        '{"agent":{"Scout":"test/scout","showCost":true}}',
        projectText,
      );
      app.openClear(label);
      app.select("All levels");
      if (label !== "Scout") {
        app.press("\r");
        app.select("Yes");
      }
      writeFileSync(projectPath, "{broken");
      app.press("\r");
      expect(app.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/global.*cleared.*project.*malformed/i),
        "error",
      );
      expect(readFileSync(projectPath, "utf8")).toBe("{broken");
      expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ agent: { showCost: true } });
      expect(app.items().map(({ id }) => id)).not.toContain("type:Scout");
      store.mutate.session.setOverride("Other", "s/other");
      writeFileSync(projectPath, projectText);
      app.select("Reload model settings");
      app.press("\r");
      app.openClear(label);
      app.assertLevels(label === "Scout" ? ["Project"] : ["Session", "Project", "All levels"]);
      app.pickClear(label, "Project");
      expect(app.ctx.ui.notify).toHaveBeenCalledTimes(2);
      expect(store.sessionModelOverride("Other")).toBe("s/other");
      expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({});
    },
  );

  describe.each(["Scout", "Clear all model overrides..."])("Session + Project %s", (label) => {
    it.each(["malformed", "deleted"])("handles a project that becomes %s before confirmation", async (change) => {
      const globalText = '{ "agent": { "showCost": true } }\n';
      const projectText = '{ "agent": { "Scout": "test/project" }, "concurrency": { "providers": { "test": 2 } } }\n';
      const malformed = '{ "agent": { "Scout": "test/project" }, "concurrency": { "providers": [] } }\n';
      const { app, store, globalPath, projectPath, projectDir } = await fileMenu(globalText, projectText);
      app.select("Scout");
      app.press("\r");
      app.select("Session");
      app.press("\r", "scout", "\r");
      app.openClear(label);
      app.assertLevels(["Session", "Project", "All levels"]);
      app.select("All levels");
      if (label !== "Scout") {
        app.press("\r");
        app.select("Yes");
      }
      if (change === "deleted") rmSync(projectPath);
      else writeFileSync(projectPath, malformed);
      app.press("\r");
      expect(readFileSync(globalPath, "utf8")).toBe(globalText);
      if (change === "malformed") {
        expect(readFileSync(projectPath, "utf8")).toBe(malformed);
        expect(app.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/project.*malformed/i), "error");
        expect(store.sessionModelOverride("Scout")).toBe("test/scout");
        expect(store.projectTargetOffered).toBe(false);
        writeFileSync(projectPath, projectText);
        app.select("Reload model settings");
        app.press("\r");
        app.clear(label, "All levels");
        expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({ concurrency: { providers: { test: 2 } } });
      } else {
        expect(readdirSync(projectDir)).toEqual([]);
      }
      expect(app.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("cleared (all)"), "info");
      expect(store.describeModelSetting("Scout").clearable).toEqual({ session: false, global: false, project: false });
      expect(app.items().map(({ id }) => id)).not.toContain("type:Scout");
    });
  });

  it("lists toString only while its own project override exists", async () => {
    const { app, store, projectPath } = await fileMenu("{}", "{}", ["toString"]);
    const initial = [["defaultModel", "Global default model", "(inherits parent)"], rule, override, blank];
    app.assertItems(initial);
    app.select("Override another type...");
    app.press("\r", "\r");
    app.select("Project");
    app.press("\r", "scout", "\r");
    expect(store.describeModelSetting("toString").source).toBe("config-per-type");
    expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({ agent: { toString: "test/scout" } });
    app.assertItems([
      ["defaultModel", "Global default model", "(inherits parent)"],
      blank,
      header("test/scout"),
      ["type:toString", "toString", "off (pi default) [project]"],
      rule,
      blank,
      clearAll,
    ]);
    app.openClear("toString");
    app.assertLevels(["Project"]);
    app.pickClear("toString", "Project");
    expect(store.describeModelSetting("toString").source).toBe("parent");
    app.assertItems(initial);
  });

  it("empty raw layers do not invent global default membership or Clear-all", async () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    // Deletion test: production build and Clear must not use the old consumer snapshot/session reads.
    vi.spyOn(store, "agentConfigSnapshot").mockImplementation(() => {
      throw new Error("legacy snapshot read");
    });
    vi.spyOn(store, "sessionModelOverride").mockImplementation(() => {
      throw new Error("legacy session read");
    });
    vi.spyOn(store, "sessionDefaultModel", "get").mockImplementation(() => {
      throw new Error("legacy default read");
    });
    const app = await open(store);
    app.assertItems([["defaultModel", "Global default model", "(inherits parent)"], rule, override, blank]);
    app.select("Global default model");
    app.press("\r");
    expect(app.text()).not.toContain("Clear...");
    expect(saves).toEqual([]);
  });

  it("clears an empty non-winning project key, reveals global per-type provenance and rebuilds in place", async () => {
    const { io } = memIO({
      global: { agent: { default: "test/default", Scout: "test/scout", NullType: null } },
      project: { agent: { default: "test/project", Scout: "" } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    const app = await open(store);
    app.assertItems([
      ["defaultModel", "Global default model", "test/project [project]"],
      blank,
      header("test/project"),
      ["type:Scout", "Scout", "off (pi default) [project]"],
      rule,
      override,
      blank,
      clearAll,
    ]);
    app.clear("Scout", "Project");
    expect(app.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Scout override cleared (project). Effective model test/scout (global)",
      "info",
    );
    app.assertItems([
      ["defaultModel", "Global default model", "test/project [project]"],
      blank,
      header("test/scout"),
      ["type:Scout", "Scout", "off (pi default)"],
      rule,
      override,
      blank,
      clearAll,
    ]);
    // The rebuilt row now offers only the remaining carrying level.
    app.select("Scout");
    app.press("\r");
    app.select("Clear...");
    app.press("\r");
    expect(app.text()).toContain("Global");
    expect(app.text()).not.toContain("Project");
    app.press("\r");
    expect(app.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Scout override cleared (global). Effective model test/project (project)",
      "info",
    );
    app.assertItems([
      ["defaultModel", "Global default model", "test/project [project]"],
      rule,
      override,
      blank,
      clearAll,
    ]);
  });

  it("type Clear-all preserves the winning session default and no old consumer reads are needed", async () => {
    const store = new ConfigStore(
      memIO({
        global: { agent: { Scout: "test/scout" } },
        project: { agent: { Scout: "test/project" } },
        projectStatus: "loaded",
      }).io,
    );
    store.mutate.session.setOverride("default", "test/default");
    store.mutate.session.setOverride("Scout", "");
    vi.spyOn(store, "agentConfigSnapshot").mockImplementation(() => {
      throw new Error("legacy snapshot read");
    });
    vi.spyOn(store, "sessionModelOverride").mockImplementation(() => {
      throw new Error("legacy session read");
    });
    const app = await open(store);
    app.assertItems([
      ["defaultModel", "Global default model", "test/default [session]"],
      blank,
      header("test/default"),
      ["type:Scout", "Scout", "off (pi default) [session]"],
      rule,
      override,
      blank,
      clearAll,
    ]);
    app.clear("Scout", "All levels");
    expect(store.sessionDefaultModel).toBe("test/default");
    expect(store.describeModelSetting("Scout").clearable).toEqual({ session: false, global: false, project: false });
    expect(app.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Scout override cleared (all). Effective model test/default (session)",
      "info",
    );
    app.assertItems([
      ["defaultModel", "Global default model", "test/default [session]"],
      rule,
      override,
      blank,
      clearAll,
    ]);
  });

  it.each([
    { Unknown: "", NullType: null },
    { defaultThinking: "high" as const, defaultMaxTurns: 5 },
  ])("unknown/null or model-family-only settings add no registry rows but Clear-all works: %j", async (agent) => {
    const { io, global } = memIO({ global: { agent: { ...agent, graceTurns: 9 } } });
    const store = new ConfigStore(io);
    const app = await open(store);
    app.assertItems([["defaultModel", "Global default model", "(inherits parent)"], rule, override, blank, clearAll]);
    app.select("Clear all model overrides...");
    app.press("\r", "\r");
    app.select("Yes");
    app.press("\r");
    expect(global().agent).toEqual({ graceTurns: 9 });
    app.assertItems([["defaultModel", "Global default model", "(inherits parent)"], rule, override, blank]);
  });

  it("keeps the complete alphabetical multi-group layout and every separator", async () => {
    const store = new ConfigStore(
      memIO({
        global: { agent: { Scout: "test/scout", Plain: "test/default", NullType: null } },
      }).io,
    );
    const app = await open(store);
    app.assertItems([
      ["defaultModel", "Global default model", "(inherits parent)"],
      blank,
      header("test/default"),
      ["type:Plain", "Plain", "off (pi default)"],
      blank,
      header("test/scout"),
      ["type:Scout", "Scout", "off (pi default)"],
      rule,
      override,
      blank,
      clearAll,
    ]);
  });

  it.each(["", "test/default"])(
    "session-only unknown type %j adds no registry row and stays Clear-all eligible",
    async (model) => {
      const store = new ConfigStore(memIO().io);
      store.mutate.session.setOverride("Unknown", model);
      const app = await open(store);
      app.assertItems([["defaultModel", "Global default model", "(inherits parent)"], rule, override, blank, clearAll]);
      app.select("Clear all model overrides...");
      app.press("\r", "\r");
      app.select("Yes");
      app.press("\r");
      expect(store.hasSessionModelSettings).toBe(false);
      expect(store.describeModelSetting("Unknown").explicitPerTypeOverride).toBe(false);
      app.assertItems([["defaultModel", "Global default model", "(inherits parent)"], rule, override, blank]);
    },
  );

  it.each(["global", "project"] as const)(
    "Clear-all recovers from a real file-backed %s atomic rename failure",
    async (failedLayer) => {
      const globalText = '{ "agent": { "Scout": "test/scout", "graceTurns": 9 } }\n';
      const projectText = '{ "agent": { "Scout": "test/project" } }\n';
      const { app, store, globalDir, projectDir, globalPath, projectPath } = await fileMenu(globalText, projectText);
      const expected = [
        ["defaultModel", "Global default model", "(inherits parent)"],
        blank,
        header("test/project"),
        ["type:Scout", "Scout", "off (pi default) [project]"],
        rule,
        override,
        blank,
        clearAll,
      ];
      app.assertItems(expected);
      app.openClear("Clear all model overrides...");
      app.assertLevels(["Global", "Project", "All levels"]);
      disk.failPath = failedLayer === "global" ? globalPath : projectPath;
      expect(() => app.pickClear("Clear all model overrides...", "All levels")).not.toThrow();
      expect(app.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
        `${failedLayer === "project" ? "Global config was cleared but project config failed: Error: " : ""}` +
          `[subagents] Failed to save config ${disk.failPath}: Error: config rename failed`,
        "error",
      );
      expect(readFileSync(projectPath, "utf8")).toBe(projectText);
      if (failedLayer === "global") expect(readFileSync(globalPath, "utf8")).toBe(globalText);
      else expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ agent: { graceTurns: 9 } });
      expect(readdirSync(globalDir)).toEqual(["subagents-lite.json"]);
      expect(readdirSync(projectDir)).toEqual(["subagents-lite.json"]);
      expect(store.describeModelSetting("Scout")).toEqual({
        model: "test/project",
        source: "config-per-type",
        layer: "project",
        clearable: { session: false, global: failedLayer === "global", project: true },
        explicitPerTypeOverride: true,
      });
      app.assertItems(expected);
      app.openClear("Clear all model overrides...");
      app.assertLevels(failedLayer === "global" ? ["Global", "Project", "All levels"] : ["Project"]);
      disk.failPath = "";
      const target = failedLayer === "global" ? "All levels" : "Project";
      app.pickClear("Clear all model overrides...", target);
      expect(app.ctx.ui.notify).toHaveBeenLastCalledWith(
        `Model overrides cleared (${failedLayer === "global" ? "all" : "project"})`,
        "info",
      );
      expect(app.ctx.ui.notify).toHaveBeenCalledTimes(2);
      expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ agent: { graceTurns: 9 } });
      expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({});
      expect(store.agent.graceTurns).toBe(9);
      app.assertItems([["defaultModel", "Global default model", "(inherits parent)"], rule, override, blank]);
    },
  );

  it.each([
    ["Scout", "Scout"],
    ["default", "Global default model"],
    ["Scout", "Clear all model overrides..."],
  ])("a failed %s Clear via %s returns safely, preserves values and can retry", async (key, label) => {
    const { io: base, global } = memIO({ global: { agent: { [key]: "test/scout" } } });
    let fail = true;
    const io: ConfigIO = {
      ...base,
      updateLayer: (target, mutate, options) => {
        if (fail) throw new Error("disk\nunavailable");
        return base.updateLayer(target, mutate, options);
      },
    };
    const store = new ConfigStore(io);
    const app = await open(store);
    const expected = [
      ["defaultModel", "Global default model", key === "default" ? "test/scout" : "(inherits parent)"],
      ...(key === "Scout" ? [blank, header("test/scout"), ["type:Scout", "Scout", "off (pi default)"]] : []),
      rule,
      override,
      blank,
      clearAll,
    ];
    app.assertItems(expected);
    app.openClear(label);
    app.assertLevels(["Global"]);
    expect(() => app.pickClear(label, "Global")).not.toThrow();
    expect(app.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("disk unavailable", "error");
    expect(store.describeModelSetting(key).model).toBe("test/scout");
    expect(global().agent).toEqual({ [key]: "test/scout" });
    if (key === "Scout") expect(app.items().some((item) => item.id === "type:Scout")).toBe(true);
    app.assertItems(expected);
    app.openClear(label);
    app.assertLevels(["Global"]);
    fail = false;
    app.pickClear(label, "Global");
    expect(global().agent).toEqual({});
    expect(app.ctx.ui.notify).toHaveBeenLastCalledWith(
      label === "Clear all model overrides..."
        ? "Model overrides cleared (global)"
        : `${key} override cleared (global). Effective model test/model (parent)`,
      "info",
    );
    expect(app.ctx.ui.notify).toHaveBeenCalledTimes(2);
    app.assertItems([["defaultModel", "Global default model", "(inherits parent)"], rule, override, blank]);
  });

  it.each([
    ["Scout", "Scout"],
    ["default", "Global default model"],
    ["Scout", "Clear all model overrides..."],
  ])("partial %s Clear via %s preserves project and immediately refreshes remaining levels", async (key, label) => {
    const {
      io: base,
      global,
      project,
    } = memIO({
      global: { agent: { [key]: "test/scout" } },
      project: { agent: { [key]: "test/project" } },
      projectStatus: "loaded",
    });
    let fail = true;
    const io: ConfigIO = {
      ...base,
      updateLayer: (target, mutate, options) => {
        if (fail && target === "project") throw new Error("project rename failed");
        return base.updateLayer(target, mutate, options);
      },
    };
    const store = new ConfigStore(io);
    const app = await open(store);
    const expected = [
      ["defaultModel", "Global default model", key === "default" ? "test/project [project]" : "(inherits parent)"],
      ...(key === "Scout"
        ? [blank, header("test/project"), ["type:Scout", "Scout", "off (pi default) [project]"]]
        : []),
      rule,
      override,
      blank,
      clearAll,
    ];
    app.assertItems(expected);
    app.openClear(label);
    app.assertLevels(["Global", "Project", "All levels"]);
    expect(() => app.pickClear(label, "All levels")).not.toThrow();
    expect(app.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      "Global config was cleared but project config failed: Error: project rename failed",
      "error",
    );
    expect(global().agent).toEqual({});
    expect(project()?.agent).toEqual({ [key]: "test/project" });
    expect(store.describeModelSetting(key)).toEqual({
      model: "test/project",
      source: key === "default" ? "config-default" : "config-per-type",
      layer: "project",
      clearable: { session: false, global: false, project: true },
      explicitPerTypeOverride: key !== "default",
    });
    app.assertItems(expected);
    app.openClear(label);
    app.assertLevels(["Project"]);
    // Cancel and navigate again without closing/reopening the menu.
    app.press("\x1b");
    if (label !== "Clear all model overrides...") app.press("\x1b");
    app.openClear(label);
    app.assertLevels(["Project"]);
    fail = false;
    app.pickClear(label, "Project");
    expect(global().agent).toEqual({});
    expect(project()?.agent).toEqual({});
    expect(store.describeModelSetting(key).clearable).toEqual({ session: false, global: false, project: false });
    expect(app.ctx.ui.notify).toHaveBeenLastCalledWith(
      label === "Clear all model overrides..."
        ? "Model overrides cleared (project)"
        : `${key} override cleared (project). Effective model test/model (parent)`,
      "info",
    );
    expect(app.ctx.ui.notify).toHaveBeenCalledTimes(2);
    app.assertItems([["defaultModel", "Global default model", "(inherits parent)"], rule, override, blank]);
  });
});
