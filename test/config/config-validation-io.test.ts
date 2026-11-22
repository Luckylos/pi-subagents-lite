/**
 * config-validation-io.test.ts — Load-time validation through the real
 * file read path: bad values warn once per key, drop from the effective
 * config, keep valid keys, and leave file bytes unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vite-plus/test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { KnownAgentSettings } from "../../src/config/types.js";

const MOCK_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-validate-global-"));
const GLOBAL_CONFIG_PATH = join(MOCK_AGENT_DIR, "subagents-lite.json");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

const { createConfigIO, loadConfig, mergeDefaults, mergeLayers } = await import("../../src/config/config-io.js");
const { ConfigStore } = await import("../../src/config/config-store.js");

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-subagents-validate-project-"));
  rmSync(GLOBAL_CONFIG_PATH, { force: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(MOCK_AGENT_DIR, { recursive: true, force: true });
});

function writeGlobal(config: unknown): void {
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config));
}

function writeProject(config: unknown): void {
  writeFileSync(join(projectDir, "subagents-lite.json"), JSON.stringify(config));
}

describe("load-time validation — global layer", () => {
  it("warns on an object-shaped model override, drops it, keeps valid keys", () => {
    writeGlobal({ agent: { default: { model: "x" }, graceTurns: 5 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO().load();
      expect(loaded.global.agent).toEqual({ graceTurns: 5 });
      expect(warn).toHaveBeenCalledOnce();
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain(GLOBAL_CONFIG_PATH);
      expect(msg).toContain("agent.default");
      expect(msg).toContain("object");
      expect(msg).toContain("string or null");
      expect(msg).toContain("/agents");
      expect(msg).toContain("edit or delete");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns on a mistyped non-model key and keeps valid keys", () => {
    writeGlobal({ agent: { graceTurns: "many", showCost: true } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO().load();
      expect(loaded.global.agent).toEqual({ showCost: true });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("agent.graceTurns");
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves file bytes unchanged after load with bad values", () => {
    const raw = { agent: { default: { model: "x" }, graceTurns: 5 } };
    writeGlobal(raw);
    const before = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createConfigIO().load();
    } finally {
      warn.mockRestore();
    }
    expect(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).toBe(before);
  });

  it("effective config falls back to defaults for dropped keys", () => {
    writeGlobal({ agent: { default: { model: "x" }, graceTurns: 5 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadConfig();
      expect(config.agent.default).toBeNull();
      expect(config.agent.graceTurns).toBe(5);
    } finally {
      warn.mockRestore();
    }
  });

  it("never migrates fork shapes: the object is dropped, not converted", () => {
    writeGlobal({ agent: { default: { model: "openai/gpt", thinking: "high" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO().load();
      expect(loaded.global.agent ?? {}).toEqual({});
      expect(mergeDefaults(loaded.global).agent.default).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("load-time validation — project layer", () => {
  it("warns on an object-shaped project model override and stays loaded", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProject({ agent: { default: { model: "x" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO(projectDir).load();
      expect(loaded.projectStatus).toBe("loaded");
      expect(loaded.project?.agent ?? {}).toEqual({});
      expect(warn).toHaveBeenCalledOnce();
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain(join(projectDir, "subagents-lite.json"));
      expect(msg).toContain("agent.default");
    } finally {
      warn.mockRestore();
    }
  });

  it("project file bytes stay unchanged after load with bad values", () => {
    writeProject({ agent: { default: { model: "x" } } });
    const projectPath = join(projectDir, "subagents-lite.json");
    const before = readFileSync(projectPath, "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createConfigIO(projectDir).load();
    } finally {
      warn.mockRestore();
    }
    expect(readFileSync(projectPath, "utf-8")).toBe(before);
  });

  it("merged layers fall back to global when the project key is dropped", () => {
    writeGlobal({ agent: { default: "g/default" } });
    writeProject({ agent: { default: { model: "x" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO(projectDir).load();
      const merged = mergeLayers(loaded.global, loaded.project);
      expect(mergeDefaults(merged).agent.default).toBe("g/default");
    } finally {
      warn.mockRestore();
    }
  });
});

it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max", "parent"])(
  "loads %s as a persisted Thinking choice",
  (choice) => {
    writeGlobal({ agent: { defaultThinking: choice } });
    expect(new ConfigStore(createConfigIO(projectDir)).agent.defaultThinking).toBe(choice);
  },
);

it.each(["pi default", "", "ultra"])("rejects %j as a persisted Thinking choice", (choice) => {
  writeGlobal({ agent: { defaultThinking: choice } });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(new ConfigStore(createConfigIO(projectDir)).agent.defaultThinking).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

it("uses the built-in behavior when there is no config file", () => {
  const store = new ConfigStore(createConfigIO(projectDir));
  expect(store.modelFor("Explore", "parent/model")).toBe("parent/model");
  expect(store.concurrency).toEqual({ default: 4, providers: {}, models: {} });
  expect(store.agent).toMatchObject({
    forceBackground: false,
    graceTurns: 6,
    toolTimeoutMinutes: 45,
    idleTimeoutMinutes: 45,
    agentStatusLimit: 8,
    widgetMaxLines: 12,
    widgetMaxLinesCompact: 6,
    finishedRetentionMinutes: 1,
    loadSkillsImplicitly: true,
    loadExtensionsImplicitly: true,
    loadToolsImplicitly: true,
    parentMessages: true,
  });
  expect(store.agentConfigSnapshot()).not.toHaveProperty("loadToolsImplicitly");
  expect(store.agentConfigSnapshot()).not.toHaveProperty("defaultThinking");
});

it("validates every known setting and shares project eligibility with model Clear all", () => {
  const globalOnly = {
    forceBackground: true,
    graceTurns: 0,
    toolTimeoutMinutes: -1,
    idleTimeoutMinutes: 0,
    showCost: true,
    showTools: true,
    showTurns: false,
    showInput: false,
    showOutput: false,
    showContext: false,
    showTime: false,
    widgetMaxLines: 9,
    widgetMaxLinesCompact: 2,
    widgetCompact: true,
    showCompletionCards: false,
    widgetShortcut: true,
    widgetShowModel: false,
    widgetShowThinking: false,
    widgetNavHint: false,
    systemPromptMode: "custom",
    includeContextFiles: false,
    loadSkillsImplicitly: false,
    loadExtensionsImplicitly: false,
    loadToolsImplicitly: false,
    disableDefaultAgents: true,
    agentToolStrictMode: true,
    exposeDescriptions: true,
    outputThinkingBufferSize: 16,
    finishedRetentionMinutes: 0,
    agentStatusLimit: 0,
    modelDisplayStyle: "id",
    modelThinkingPlacement: "metadata",
    statusBarFormat: "compact",
    outputTranscript: true,
    parentMessages: false,
    showAgentColors: false,
  } as const;
  const modelDefaults = { default: "global/model", defaultThinking: "parent", defaultMaxTurns: 5 } as const;
  const known = { ...globalOnly, ...modelDefaults } satisfies Required<KnownAgentSettings>;
  const dynamic = { Explore: "local/explore", Scout: "", Worker: null };
  const globalConcurrency = { default: 3, providers: { local: 2 }, models: { "local/explore": 1 } };
  const projectConcurrency = { default: 2, models: { "project/explore": 1 } };
  const projectModels = { ...modelDefaults, default: "project/model", ...dynamic };
  writeGlobal({ agent: { ...known, ...dynamic }, concurrency: globalConcurrency });
  const ignoredProject = { ...globalOnly, showCost: false, parentMessages: true };
  writeProject({ agent: { ...ignoredProject, ...projectModels }, concurrency: projectConcurrency });

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const io = createConfigIO(projectDir);
    const raw = io.load();
    expect(raw.global).toEqual({ agent: { ...known, ...dynamic }, concurrency: globalConcurrency });
    expect(raw.project).toEqual({ agent: { ...ignoredProject, ...projectModels }, concurrency: projectConcurrency });
    expect(mergeLayers(raw.global, raw.project).agent).toEqual({ ...globalOnly, ...projectModels });
    expect(warn).toHaveBeenCalledOnce();

    const store = new ConfigStore(io);
    expect(store.agent).toMatchObject({
      defaultModel: "project/model",
      graceTurns: 0,
      toolTimeoutMinutes: -1,
      finishedRetentionMinutes: 1 / 60,
      agentStatusLimit: 4,
      loadToolsImplicitly: false,
      parentMessages: false,
      showCost: true,
      widgetMaxLinesCompact: 2,
    });
    store.mutate.session.setOverride("Explore", "session/model");
    store.mutate.agent.clearAllModelOverrides("all");

    const cleared = io.load();
    expect(cleared.global).toEqual({ agent: globalOnly, concurrency: globalConcurrency });
    expect(cleared.project).toEqual({ agent: ignoredProject, concurrency: projectConcurrency });
    expect(mergeLayers(cleared.global, cleared.project).agent).toEqual(globalOnly);
    expect(store.modelFor("Explore", "parent/model")).toBe("parent/model");
    expect(store.agent.defaultThinking).toBeUndefined();
    expect(store.agent.defaultMaxTurns).toBeUndefined();
  } finally {
    warn.mockRestore();
  }
});

describe("file-backed model setting descriptions", () => {
  it.each(["systemPromptMode", "defaultThinking", "defaultMaxTurns", "default"])(
    "protects reserved %s from type writes and clears",
    (type) => {
      const globalText =
        '{ "agent": { "systemPromptMode": "custom", "defaultThinking": "high", "defaultMaxTurns": 4, "default": "g/base", "Scout": "g/scout", "showCost": true } }\n';
      const projectText = '{ "agent": { "default": "p/base", "Scout": "p/scout" } }\n';
      const projectPath = join(projectDir, "subagents-lite.json");
      writeFileSync(GLOBAL_CONFIG_PATH, globalText);
      writeFileSync(projectPath, projectText);
      const store = new ConfigStore(createConfigIO(projectDir));
      for (const target of ["global", "project"] as const) {
        store.mutate.agent.setModelOverride(type, "wrong/model", target);
        store.mutate.agent.clearModelOverride(type, target);
        expect(readFileSync(GLOBAL_CONFIG_PATH, "utf8")).toBe(globalText);
        expect(readFileSync(projectPath, "utf8")).toBe(projectText);
      }
      store.mutate.agent.setDefaultModel("s/base", "session");
      store.mutate.agent.setModelOverride(type, "s/type", "session");
      expect(store.modelFor(type, "parent")).toBe(type === "default" ? "s/base" : "s/type");
      store.mutate.agent.clearModelOverride(type, "all");
      expect(store.modelFor(type, "parent")).toBe("s/base");
      expect(readFileSync(GLOBAL_CONFIG_PATH, "utf8")).toBe(globalText);
      expect(readFileSync(projectPath, "utf8")).toBe(projectText);
    },
  );

  it.each(["toString", "__proto__"])("only lists and clears own model entries for %s", (type) => {
    writeGlobal({ agent: { systemPromptMode: "custom", Scout: "g/scout" } });
    writeProject({ agent: { Other: "p/other" } });
    const store = new ConfigStore(createConfigIO(projectDir));
    const absent = {
      layer: "frontmatter",
      source: "frontmatter",
      model: "fm",
      clearable: { session: false, global: false, project: false },
      explicitPerTypeOverride: false,
    };
    const describeType = () => store.describeModelSetting(type, "parent", { model: "fm" });
    expect(describeType()).toEqual(absent);
    expect(store.modelFor("systemPromptMode", "parent", { model: "fm" })).toBe("fm");
    store.mutate.agent.setModelOverride(type, "g/type");
    store.mutate.agent.setModelOverride(type, "", "project");
    store.mutate.agent.setModelOverride(type, "s/type", "session");
    expect(describeType()).toMatchObject({
      layer: "session",
      source: "session-per-type",
      explicitPerTypeOverride: true,
      clearable: { session: true, global: true, project: true },
    });
    store.mutate.agent.clearModelOverride(type, "session");
    expect(describeType()).toMatchObject({
      source: "frontmatter",
      clearable: { session: false, global: true, project: true },
    });
    store.mutate.agent.clearModelOverride(type, "project");
    expect(describeType()).toMatchObject({ layer: "global", model: "g/type" });
    store.mutate.agent.clearModelOverride(type, "global");
    expect(describeType()).toEqual(absent);
  });

  it.each(["deleted", "unrelated"])("All levels does not fail on a %s project with nothing to clear", (change) => {
    writeGlobal({ agent: { Scout: "g/scout", showCost: true } });
    writeProject({ agent: change === "deleted" ? { Scout: "p/scout" } : { Other: "p/other" } });
    const store = new ConfigStore(createConfigIO(projectDir));
    const projectPath = join(projectDir, "subagents-lite.json");
    if (change === "deleted") rmSync(projectPath);
    else writeFileSync(projectPath, "not json");
    store.mutate.agent.clearModelOverride("Scout", "all");
    expect(store.modelFor("Scout", "parent")).toBe("parent");
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf8"))).toEqual({ agent: { showCost: true } });
    if (change === "deleted") expect(() => readFileSync(projectPath)).toThrow(/ENOENT/);
    else expect(readFileSync(projectPath, "utf8")).toBe("not json");
  });

  it("explains validated keys without changing global or project file bytes", () => {
    const globalText =
      '{ "agent": { "default": { "model": "bad" }, "Scout": "g/scout", "Worker": null, "Unknown": "" } }\n';
    const projectText = '{ "agent": { "Scout": "", "default": "p/default" } }\n';
    writeFileSync(GLOBAL_CONFIG_PATH, globalText);
    const projectPath = join(projectDir, "subagents-lite.json");
    writeFileSync(projectPath, projectText);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new ConfigStore(createConfigIO(projectDir));
      expect(store.describeModelSetting("default", "parent")).toEqual({
        model: "p/default",
        source: "config-default",
        layer: "project",
        clearable: { session: false, global: false, project: true },
        explicitPerTypeOverride: false,
      });
      expect(store.describeModelSetting("Scout", "parent")).toEqual({
        model: "p/default",
        source: "config-default",
        layer: "project",
        clearable: { session: false, global: true, project: true },
        explicitPerTypeOverride: true,
      });
      expect(store.describeModelSetting("Worker").explicitPerTypeOverride).toBe(false);
      expect(store.describeModelSetting("Worker").clearable.global).toBe(true);
      expect(store.describeModelSetting("Unknown").explicitPerTypeOverride).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
      expect(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).toBe(globalText);
      expect(readFileSync(projectPath, "utf-8")).toBe(projectText);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not create files while reading absent layers or invent raw default membership", () => {
    const store = new ConfigStore(createConfigIO(projectDir));
    expect(store.describeModelSetting("default")).toEqual({
      model: "",
      source: "parent",
      layer: "parent",
      clearable: { session: false, global: false, project: false },
      explicitPerTypeOverride: false,
    });
    expect(() => readFileSync(GLOBAL_CONFIG_PATH)).toThrow();
    expect(() => readFileSync(join(projectDir, "subagents-lite.json"))).toThrow();
  });

  it("two stale file-backed stores preserve different-field writes and Clear adopts fresh inherited facts", () => {
    writeGlobal({ agent: { default: "base/model", Scout: "base/scout", graceTurns: 5 } });
    writeProject({ agent: { Scout: "project/scout" } });
    const a = new ConfigStore(createConfigIO(projectDir));
    const b = new ConfigStore(createConfigIO(projectDir));
    a.mutate.agent.setDefaultModel("fresh/default");
    b.mutate.agent.setForceBackground(true);
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"))).toEqual({
      agent: { default: "fresh/default", Scout: "base/scout", graceTurns: 5, forceBackground: true },
    });
    a.mutate.agent.clearModelOverride("Scout", "global");
    b.mutate.agent.clearModelOverride("Scout", "project");
    expect(b.describeModelSetting("Scout", "parent")).toEqual({
      model: "fresh/default",
      source: "config-default",
      layer: "global",
      clearable: { session: false, global: false, project: false },
      explicitPerTypeOverride: false,
    });
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"))).toEqual({
      agent: { default: "fresh/default", graceTurns: 5, forceBackground: true },
    });
    expect(JSON.parse(readFileSync(join(projectDir, "subagents-lite.json"), "utf-8"))).toEqual({});
  });
});

describe("load-time validation — runs and menus", () => {
  it("agent runs resolve models with fallback and without throw", () => {
    writeGlobal({ agent: { default: { model: "x" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO().load();
      const store = new ConfigStore({
        load: () => ({ global: loaded.global, project: null, projectStatus: "untrusted" }),
        updateLayer: () => ({ global: loaded.global, project: null, projectStatus: "untrusted" }),
        saveGlobal: () => {},
        saveProject: () => {},
      });
      expect(store.modelFor("Explore", "parent/model")).toBe("parent/model");
    } finally {
      warn.mockRestore();
    }
  });

  it("dropped keys read as absent for provenance", () => {
    writeGlobal({ agent: { default: { model: "x" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO().load();
      const store = new ConfigStore({
        load: () => ({ global: loaded.global, project: null, projectStatus: "untrusted" }),
        updateLayer: () => ({ global: loaded.global, project: null, projectStatus: "untrusted" }),
        saveGlobal: () => {},
        saveProject: () => {},
      });
      expect(store.hasGlobalModelKey("default")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
