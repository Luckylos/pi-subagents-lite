import { describe, expect, it, vi } from "vite-plus/test";
import { ConfigStore } from "../../src/config/config-store.js";
import type { ConfigIO, LoadedConfig, RawConfig } from "../../src/config/config-io.js";
import { memIO } from "./config-store-helpers.js";

function failingIO(error: Error): ConfigIO {
  const loaded: LoadedConfig = { global: {}, project: null, projectStatus: "untrusted" };
  return {
    load: () => loaded,
    updateLayer: () => {
      throw error;
    },
    saveGlobal: vi.fn(),
    saveProject: vi.fn(),
  };
}

describe("ConfigStore fresh persisted mutations", () => {
  it("preserves different fields from two stale stores", () => {
    const { io, global } = memIO({
      global: {
        agent: { default: "base/model", forceBackground: false },
        concurrency: { default: 4, providers: { openai: 2 } },
      },
    });
    const a = new ConfigStore(io);
    const b = new ConfigStore(io);

    a.mutate.agent.setForceBackground(true);
    b.mutate.concurrency.setDefault(8);

    expect(global()).toEqual({
      agent: { default: "base/model", forceBackground: true },
      concurrency: { default: 8, providers: { openai: 2 } },
    });
  });

  it("preserves nested map edits and applies a deletion to the latest layer", () => {
    const { io, global } = memIO({
      global: { concurrency: { providers: { openai: 2, anthropic: 3 }, models: { "openai/gpt": 1 } } },
    });
    const a = new ConfigStore(io);
    const b = new ConfigStore(io);

    a.mutate.concurrency.setProvider("google", 4);
    b.mutate.concurrency.setModel("anthropic/haiku", 5);
    b.mutate.concurrency.removeProvider("openai");

    expect(global()).toEqual({
      concurrency: {
        providers: { anthropic: 3, google: 4 },
        models: { "openai/gpt": 1, "anthropic/haiku": 5 },
      },
    });
  });

  it("lets the last completed write win only for the same field", () => {
    const { io, global } = memIO({ global: { agent: { default: "base/model" } } });
    const a = new ConfigStore(io);
    const b = new ConfigStore(io);

    a.mutate.agent.setDefaultModel("a/model");
    b.mutate.agent.setDefaultModel("b/model");

    expect(global()).toEqual({ agent: { default: "b/model" } });
  });

  it("keeps session model, concurrency and showCost overrides across an ordinary save", () => {
    const { io } = memIO({ global: { agent: { showCost: false }, concurrency: { default: 4 } } });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("default", "session/model");
    store.mutate.session.setShowCost(true);
    store.mutate.concurrency.setDefault(2, "session");

    store.mutate.agent.setForceBackground(true);

    expect(store.modelFor("general-purpose", "parent/model")).toBe("session/model");
    expect(store.agent.showCost).toBe(true);
    expect(store.concurrency.default).toBe(2);
  });

  it("reports a failed fresh read/write without changing effective memory state", () => {
    const error = new Error("disk is unavailable");
    const store = new ConfigStore(failingIO(error));
    const before = store.agent.forceBackground;

    expect(() => store.mutate.agent.setForceBackground(true)).toThrow("disk is unavailable");
    expect(store.agent.forceBackground).toBe(before);
  });

  it("does not create an absent project file for a clear", () => {
    const { io, saves, project } = memIO({ global: { agent: { default: "global/model" } } });
    const store = new ConfigStore(io);

    store.mutate.agent.clearDefaultMaxTurns("project");

    expect(project()).toBeNull();
    expect(saves).toHaveLength(0);
  });

  it("reports partial all-layer failure after the global layer is committed", () => {
    let global: RawConfig = { agent: { default: "global/model" } };
    let project: RawConfig | null = { agent: { default: "project/model", defaultMaxTurns: 8 } };
    const io: ConfigIO = {
      load: () => ({ global: structuredClone(global), project: structuredClone(project), projectStatus: "loaded" }),
      updateLayer: (target, mutate) => {
        const latest = structuredClone(target === "global" ? global : (project ?? {}));
        mutate(latest);
        if (target === "global") global = latest;
        else throw new Error("project rename failed");
        return { global: structuredClone(global), project: structuredClone(project), projectStatus: "loaded" };
      },
      saveGlobal: vi.fn(),
      saveProject: vi.fn(),
    };
    const store = new ConfigStore(io);

    expect(() => store.mutate.agent.clearAllModelOverrides("all")).toThrow("Global config was cleared");
    expect(global.agent?.default).toBeUndefined();
    expect(project?.agent?.default).toBe("project/model");
  });
});
