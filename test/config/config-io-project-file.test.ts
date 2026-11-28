/**
 * config-io-project-file.test.ts — Project config as an override layer
 * (ADR-0008): the project file's model/concurrency keys merge over the global
 * file; absent keys inherit. Unknown keys are ignored with a warning, a
 * malformed file is never written, and per-layer saves touch only their layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vite-plus/test";
import { join } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

// Per-run temp dirs: must never read a real user config file.
const MOCK_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-global-"));
const GLOBAL_CONFIG_PATH = join(MOCK_AGENT_DIR, "subagents-lite.json");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

// Import after mock is set up
const { createConfigIO, loadConfig, mergeLayers, mergeDefaults } = await import("../../src/config/config-io.js");
const { ConfigStore } = await import("../../src/config/config-store.js");

let projectRoot: string;
let projectDir: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "pi-subagents-project-"));
  projectDir = join(projectRoot, ".pi");
  mkdirSync(projectDir);
  rmSync(GLOBAL_CONFIG_PATH, { force: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(MOCK_AGENT_DIR, { recursive: true, force: true });
});

describe("project config file boundaries", () => {
  it.skipIf(process.platform === "win32")("reads and saves through a file link within the project", () => {
    const linked = join(projectDir, "subagents-lite.json");
    const target = join(projectRoot, "local.json");
    writeFileSync(target, JSON.stringify({ agent: { graceTurns: 5 } }));
    symlinkSync(target, linked);
    const io = createConfigIO(projectDir);

    expect(io.load().project).toEqual({ agent: { graceTurns: 5 } });
    io.updateLayer("project", (config) => {
      config.agent = { graceTurns: 7 };
    });

    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ agent: { graceTurns: 7 } });
  });

  it.skipIf(process.platform === "win32")("does not overwrite unrelated contents through an internal link", () => {
    const target = join(projectDir, "other-settings.json");
    const original = JSON.stringify({ unrelated: true });
    writeFileSync(target, original);
    symlinkSync(target, join(projectDir, "subagents-lite.json"));
    const io = createConfigIO(projectDir);
    io.load();

    const mutate = vi.fn();
    expect(() => io.updateLayer("project", mutate)).toThrow(/existing fields would be discarded/);
    expect(mutate).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      io.saveProject({ concurrency: { default: 6 } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("existing fields would be discarded"));
      expect(readFileSync(target, "utf-8")).toBe(original);
    } finally {
      warn.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("refuses duplicate keys in a linked project config before writing", () => {
    const target = join(projectDir, "duplicate-key-target.json");
    const original = String.raw`{"concurrency":{"unknown":true},"concurr\u0065ncy":{"default":4}}`;
    writeFileSync(target, original);
    symlinkSync(target, join(projectDir, "subagents-lite.json"));
    const io = createConfigIO(projectDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mutate = vi.fn();
      expect(() => io.updateLayer("project", mutate)).toThrow(/duplicate JSON key/);
      expect(mutate).not.toHaveBeenCalled();
      io.saveProject({ concurrency: { default: 6 } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate JSON key"));
      expect(readFileSync(target, "utf8")).toBe(original);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects nested duplicate keys before either kind of global write", () => {
    const original = '{"agent":{"showCost":true,"showCost":false}}';
    writeFileSync(GLOBAL_CONFIG_PATH, original);
    const io = createConfigIO();
    const mutate = vi.fn();
    expect(() => io.updateLayer("global", mutate)).toThrow(/duplicate JSON key/);
    expect(mutate).not.toHaveBeenCalled();
    expect(() => io.saveGlobal({ agent: { showCost: true } })).toThrow(/duplicate JSON key/);
    expect(readFileSync(GLOBAL_CONFIG_PATH, "utf8")).toBe(original);
  });

  it("accepts the same key in separate objects and ignores JSON punctuation in strings", () => {
    const extra = [{ key: '{"key":1}', quote: '"' }, { key: "[]" }];
    writeGlobal({ extra });
    const store = new ConfigStore(createConfigIO());
    store.mutate.agent.setShowCost(true);
    expect(readGlobalFile()).toEqual({ extra, agent: { showCost: true } });
  });

  it.each(["9007199254740993", "1e400", "1e-400", "1.00000000000000001"])(
    "refuses a write that would change the exact value of %s",
    (literal) => {
      const original = `{"extra":[${literal}]}`;
      writeFileSync(GLOBAL_CONFIG_PATH, original);
      const store = new ConfigStore(createConfigIO());
      expect(() => store.mutate.agent.setShowCost(true)).toThrow(
        /number cannot be written without changing its value/i,
      );
      expect(readFileSync(GLOBAL_CONFIG_PATH, "utf8")).toBe(original);
    },
  );

  it("accepts numeric literals that differ only in spelling", () => {
    writeFileSync(GLOBAL_CONFIG_PATH, '{"extra":[1.50,15e-1,1E+21,0.00e+10]}');
    new ConfigStore(createConfigIO()).mutate.agent.setShowCost(true);
    expect(readGlobalFile()).toEqual({ extra: [1.5, 1.5, 1e21, 0], agent: { showCost: true } });
  });

  it("preserves ignored global values while applying only the requested edits", () => {
    const original = { concurrency: { default: 1.5, providers: { old: 2.5, active: 2 } }, extra: true };
    writeGlobal(original);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new ConfigStore(createConfigIO());
      store.mutate.agent.setShowCost(true);
      expect(readGlobalFile()).toEqual({ ...original, agent: { showCost: true } });
      store.mutate.concurrency.setProvider("active", 3);
      store.mutate.concurrency.removeProvider("active");
      expect(readGlobalFile()).toEqual({
        agent: { showCost: true },
        concurrency: { default: 1.5, providers: { old: 2.5 } },
        extra: true,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("retries an all-layer clear against the repaired project file", () => {
    writeGlobal({ concurrency: { default: 5 } });
    const repaired = '{"concurrency":{"default":4,"providers":{"keep":2}}}';
    writeProjectRaw(repaired);
    const store = new ConfigStore(createConfigIO(projectDir));
    const clear = () => store.mutate.concurrency.removeDefault("all");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeProjectRaw("{");
      expect(clear).toThrow(/global config was cleared but project config failed/i);
      expect(readGlobalFile()).toEqual({});
      const afterGlobalClear = "{ }";
      writeFileSync(GLOBAL_CONFIG_PATH, afterGlobalClear);
      expect(clear).toThrow(/^project layer is malformed$/i);
      expect(readFileSync(GLOBAL_CONFIG_PATH, "utf8")).toBe(afterGlobalClear);
      const unrelated = '{ "concurrency": { "providers": { "keep": 2 } } }';
      writeProjectRaw(unrelated);
      expect(clear).not.toThrow();
      expect(readFileSync(join(projectDir, "subagents-lite.json"), "utf8")).toBe(unrelated);
      writeProjectRaw(repaired);
      expect(clear).not.toThrow();
      expect(readProjectFile()).toEqual({ concurrency: { providers: { keep: 2 } } });
    } finally {
      warn.mockRestore();
    }
  });

  it("reports repeated mutations against a malformed project and recovers after repair", () => {
    writeProjectRaw('{"concurrency":{"default":4}}');
    const store = new ConfigStore(createConfigIO(projectDir));
    writeProjectRaw("{");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => store.mutate.concurrency.setDefault(6, "project")).toThrow(/parse config/);
      expect(() => store.mutate.concurrency.setDefault(6, "project")).toThrow(/malformed/);
      expect(() => store.mutate.concurrency.removeDefault("project")).toThrow(/malformed/);
      expect(() => store.mutate.agent.setDefaultModel("p/m", "project")).toThrow(/malformed/);
      expect(readFileSync(join(projectDir, "subagents-lite.json"), "utf-8")).toBe("{");

      writeProjectRaw("{}");
      store.mutate.concurrency.setDefault(6, "project");
      expect(readProjectFile()).toEqual({ concurrency: { default: 6 } });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not silently discard a legacy fractional limit when saving another project setting", () => {
    const original = JSON.stringify({ concurrency: { default: 1.5 } });
    writeProjectRaw(original);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const io = createConfigIO(projectDir);
      io.load();
      expect(() =>
        io.updateLayer("project", (layer) => {
          layer.agent = { default: "model" };
        }),
      ).toThrow(/existing fields would be discarded/);
      expect(readFileSync(join(projectDir, "subagents-lite.json"), "utf-8")).toBe(original);
    } finally {
      warn.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses reads and writes when the config directory points outside the project",
    () => {
      const external = mkdtempSync(join(tmpdir(), "pi-subagents-external-"));
      const externalConfig = join(external, "subagents-lite.json");
      const original = JSON.stringify({ agent: { graceTurns: 5 } });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        writeFileSync(externalConfig, original);
        rmSync(projectDir, { recursive: true });
        symlinkSync(external, projectDir);
        const io = createConfigIO(projectDir);

        expect(io.load()).toMatchObject({ project: null, projectStatus: "malformed" });
        expect(() => io.updateLayer("project", () => {}, { createIfMissing: true })).toThrow(/outside the project/);
        io.saveProject({ agent: { graceTurns: 7 } });
        expect(readFileSync(externalConfig, "utf-8")).toBe(original);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("outside the project"));
      } finally {
        warn.mockRestore();
        rmSync(external, { recursive: true, force: true });
      }
    },
  );

  it("refuses a non-regular config file", () => {
    mkdirSync(join(projectDir, "subagents-lite.json"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const io = createConfigIO(projectDir);
      expect(io.load()).toMatchObject({ project: null, projectStatus: "malformed" });
      expect(() => io.updateLayer("project", () => {})).toThrow(/regular file/);
    } finally {
      warn.mockRestore();
    }
  });
});

function writeGlobal(config: unknown): void {
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config));
}

function readGlobalFile(): unknown {
  return JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf8"));
}

function writeProject(config: unknown): void {
  writeFileSync(join(projectDir, "subagents-lite.json"), JSON.stringify(config));
}

/** Write raw text (e.g. malformed JSON) to the project file. */
function writeProjectRaw(text: string): void {
  writeFileSync(join(projectDir, "subagents-lite.json"), text);
}

function readProjectFile(): unknown {
  return JSON.parse(readFileSync(join(projectDir, "subagents-lite.json"), "utf-8"));
}

describe("createConfigIO load — two-layer override model", () => {
  it("returns the raw global and project layers with status loaded", () => {
    writeGlobal({ agent: { graceTurns: 5 }, concurrency: { default: 2 } });
    writeProject({ agent: { default: "p/default" }, concurrency: { default: 8 } });

    const loaded = createConfigIO(projectDir).load();

    expect(loaded.projectStatus).toBe("loaded");
    expect(loaded.global).toEqual({ agent: { graceTurns: 5 }, concurrency: { default: 2 } });
    expect(loaded.project).toEqual({ agent: { default: "p/default" }, concurrency: { default: 8 } });
  });

  it("reports untrusted and no project layer when created without a project dir", () => {
    const loaded = createConfigIO().load();

    expect(loaded.projectStatus).toBe("untrusted");
    expect(loaded.project).toBeNull();
    expect(loaded.global).toEqual({});
  });

  it("reports absent when the trusted project has no config file yet", () => {
    const loaded = createConfigIO(projectDir).load();

    expect(loaded.projectStatus).toBe("absent");
    expect(loaded.project).toBeNull();
  });

  it("an empty project file is inert: loaded as an empty layer", () => {
    writeProject({});

    const loaded = createConfigIO(projectDir).load();

    expect(loaded.projectStatus).toBe("loaded");
    expect(loaded.project).toEqual({});
  });

  it("ignores a malformed JSON project file with a warning; status malformed", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProjectRaw("{ not json !!");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO(projectDir).load();
      expect(loaded.projectStatus).toBe("malformed");
      expect(loaded.project).toBeNull();
      // The global layer still loads.
      expect(loaded.global).toEqual({ agent: { graceTurns: 5 } });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("treats structurally invalid project files as malformed", () => {
    const violations = [
      { agent: "nope" },
      { concurrency: "nope" },
      { concurrency: { providers: 5 } },
      { concurrency: { models: [] } },
      [1, 2],
      "text",
      42,
      null,
    ];
    for (const bad of violations) {
      writeProject(bad);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const loaded = createConfigIO(projectDir).load();
        expect(loaded.projectStatus).toBe("malformed");
        expect(loaded.project).toBeNull();
      } finally {
        warn.mockRestore();
      }
    }
  });

  it("warns once about unknown project keys, per IO instance", () => {
    // graceTurns is a global-only setting: not allowed in the project file.
    writeProject({ agent: { default: "p/default", graceTurns: 9 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const io = createConfigIO(projectDir);
      io.load();
      io.load();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("graceTurns"));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn for a project file with only model and concurrency keys", () => {
    writeProject({
      agent: { default: "p", Explore: "p/x", defaultThinking: "high", defaultMaxTurns: 3 },
      concurrency: { default: 2, providers: { a: 1 }, models: { b: 2 } },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createConfigIO(projectDir).load();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("strips the legacy finishedEvictTurns key from the global layer at load", () => {
    writeGlobal({ agent: { finishedEvictTurns: 7, graceTurns: 5 } });

    const loaded = createConfigIO().load();

    expect("finishedEvictTurns" in loaded.global.agent!).toBe(false);
    expect(loaded.global.agent).toEqual({ graceTurns: 5 });
  });
});

describe("mergeLayers — project over global, per key", () => {
  it("project agent keys override global; absent keys inherit", () => {
    const merged = mergeLayers({ agent: { default: "g", Explore: "g/x", graceTurns: 5 } }, { agent: { default: "p" } });

    expect(merged.agent).toEqual({ default: "p", Explore: "g/x", graceTurns: 5 });
  });

  it("drops project agent keys that are not model keys", () => {
    const merged = mergeLayers(
      { agent: { default: "g" } },
      { agent: { default: "p", graceTurns: 9, widgetMaxLines: 3, exposeDescriptions: true } },
    );

    expect(merged.agent).toEqual({ default: "p" });
  });

  it("keeps an explicit null project default as an override", () => {
    const merged = mergeLayers({ agent: { default: "g" } }, { agent: { default: null } });

    expect(merged.agent).toEqual({ default: null });
  });

  it("merges concurrency per entry: default wins, providers/models combine", () => {
    const merged = mergeLayers(
      { concurrency: { default: 2, providers: { llamacpp: 1, openai: 2 }, models: { a: 1 } } },
      { concurrency: { default: 8, providers: { llamacpp: 3 } } },
    );

    expect(merged.concurrency).toEqual({
      default: 8,
      providers: { llamacpp: 3, openai: 2 },
      models: { a: 1 },
    });
  });

  it("project provider/model entries fall through to global entries", () => {
    const merged = mergeLayers(
      { concurrency: { providers: { llamacpp: 1 } } },
      { concurrency: { providers: { openai: 2 } } },
    );

    expect(merged.concurrency).toEqual({ providers: { llamacpp: 1, openai: 2 } });
  });

  it("with no project layer, the global layer passes through", () => {
    expect(mergeLayers({ agent: { default: "g" }, concurrency: { default: 2 } }, null)).toEqual({
      agent: { default: "g" },
      concurrency: { default: 2 },
    });
  });

  it("empty layers merge to empty sections without explicit undefined default", () => {
    const merged = mergeLayers({}, {});

    expect(merged.agent).toEqual({});
    expect("default" in merged.concurrency!).toBe(false);
    expect(merged.concurrency).toEqual({});
  });
});

describe("mergeDefaults / loadConfig", () => {
  it("bakes built-in defaults for absent keys", () => {
    const config = mergeDefaults({ agent: { default: "x" }, concurrency: { default: 2 } });

    expect(config.agent.graceTurns).toBe(6);
    expect(config.agent.widgetMaxLines).toBe(12);
    expect(config.agent.showCost).toBe(false);
    expect(config.concurrency.providers).toBeUndefined();
  });

  it("strips the legacy finishedEvictTurns key from the effective agent", () => {
    const config = mergeDefaults({ agent: { finishedEvictTurns: 7, forceBackground: true } });

    expect("finishedEvictTurns" in config.agent).toBe(false);
    expect(config.agent.forceBackground).toBe(true);
  });

  it("loadConfig merges only the global file", () => {
    writeGlobal({ agent: { default: "g", graceTurns: 5 }, concurrency: { default: 2 } });
    writeProject({ agent: { default: "p" } });

    expect(loadConfig()).toEqual(
      mergeDefaults({ agent: { default: "g", graceTurns: 5 }, concurrency: { default: 2 } }),
    );
  });
});

describe("createConfigIO save — per-layer writes", () => {
  it("saveGlobal writes only the global file, leaving the project file untouched", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProject({ agent: { default: "p" } });
    const io = createConfigIO(projectDir);
    io.load();

    io.saveGlobal({ agent: { graceTurns: 9 } });

    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"))).toEqual({ agent: { graceTurns: 9 } });
    expect(readProjectFile()).toEqual({ agent: { default: "p" } });
  });

  it("saveProject writes only the project file, leaving the global file untouched", () => {
    writeGlobal({ agent: { graceTurns: 5, showCost: true } });
    writeProject({ agent: { graceTurns: 9 } });
    const io = createConfigIO(projectDir);
    io.load();

    io.saveProject({ agent: { graceTurns: 12 } });

    expect(readProjectFile()).toEqual({ agent: { graceTurns: 12 } });
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"))).toEqual({
      agent: { graceTurns: 5, showCost: true },
    });
  });

  it("the first saveProject in a trusted project without a file creates it", () => {
    const io = createConfigIO(projectDir);
    io.load();

    io.saveProject({ agent: { default: "p" } });

    expect(readProjectFile()).toEqual({ agent: { default: "p" } });
  });

  it("saveProject refuses to write a malformed project file; bytes untouched", () => {
    writeProjectRaw("{ not json !!");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const io = createConfigIO(projectDir);
      io.load();

      io.saveProject({ agent: { default: "p" } });

      expect(readFileSync(join(projectDir, "subagents-lite.json"), "utf-8")).toBe("{ not json !!");
      // One warning for the malformed load, one for the refused save.
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("saveProject without a trusted project dir writes nothing", () => {
    const io = createConfigIO();
    io.load();

    io.saveProject({ agent: { default: "p" } });

    expect(existsSync(join(projectDir, "subagents-lite.json"))).toBe(false);
  });

  it.each(["providers", "models"])("refuses stale project writes when concurrency.%s becomes an array", (section) => {
    const io = createConfigIO(projectDir);
    writeProject({ agent: { Scout: "p/scout" } });
    expect(io.load().projectStatus).toBe("loaded");
    const malformed = `{ "agent": { "Scout": "p/scout" }, "concurrency": { "${section}": [] } }\n`;
    writeProjectRaw(malformed);
    io.saveProject({});
    expect(readFileSync(join(projectDir, "subagents-lite.json"), "utf8")).toBe(malformed);
    expect(() => io.updateLayer("project", () => {})).toThrow(/malformed/i);
    expect(readFileSync(join(projectDir, "subagents-lite.json"), "utf8")).toBe(malformed);
  });

  it.each(["deleted", "malformed"])("rechecks a project that becomes %s during the mutation", (change) => {
    const io = createConfigIO(projectDir);
    const projectPath = join(projectDir, "subagents-lite.json");
    const malformed = '{ "concurrency": { "models": [] } }\n';
    writeProject({ agent: { Scout: "p/scout" } });
    expect(io.load().projectStatus).toBe("loaded");
    const clear = () =>
      io.updateLayer(
        "project",
        (latest) => {
          delete latest.agent;
          if (change === "deleted") rmSync(projectPath);
          else writeProjectRaw(malformed);
        },
        { createIfMissing: false },
      );
    if (change === "deleted") {
      expect(clear().projectStatus).toBe("absent");
      expect(readdirSync(projectDir)).toEqual([]);
    } else {
      expect(clear).toThrow(/malformed/i);
      expect(readFileSync(projectPath, "utf8")).toBe(malformed);
      expect(readdirSync(projectDir)).toEqual(["subagents-lite.json"]);
    }
  });

  it("updateLayer rereads the latest file and preserves unrelated fields", () => {
    writeGlobal({ agent: { graceTurns: 5, forceBackground: false } });
    const io = createConfigIO();
    io.load();
    writeGlobal({ agent: { graceTurns: 9, forceBackground: false } });

    io.updateLayer("global", (latest) => {
      latest.agent ??= {};
      latest.agent.forceBackground = true;
    });

    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"))).toEqual({
      agent: { graceTurns: 9, forceBackground: true },
    });
    expect(readdirSync(MOCK_AGENT_DIR).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("updateLayer rejects malformed JSON without overwriting the original bytes", () => {
    const malformed = "{ broken";
    writeFileSync(GLOBAL_CONFIG_PATH, malformed);
    const io = createConfigIO();

    expect(() => io.updateLayer("global", () => {})).toThrow("Failed to parse config");
    expect(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).toBe(malformed);
  });

  it("updateLayer reports an unreadable target instead of treating it as empty", () => {
    rmSync(GLOBAL_CONFIG_PATH, { force: true });
    mkdirSync(GLOBAL_CONFIG_PATH);
    const io = createConfigIO();

    expect(() => io.updateLayer("global", () => {})).toThrow("Failed to read config");
    expect(existsSync(GLOBAL_CONFIG_PATH)).toBe(true);
    rmSync(GLOBAL_CONFIG_PATH, { recursive: true, force: true });
  });
});
