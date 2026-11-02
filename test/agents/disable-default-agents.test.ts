/**
 * disable-default-agents.test.ts — Tests for the disableDefaultAgents setting.
 */

import { describe, it, expect, beforeEach } from "vite-plus/test";

import type { AgentConfig } from "../../src/agents/types.js";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.js";

/* ------------------------------------------------------------------ */
/*  registerAgents with disableDefaultAgents                          */
/* ------------------------------------------------------------------ */

describe("registerAgents — disableDefaultAgents", () => {
  beforeEach(() => {
    owner.registry.registerAgents(new Map());
    owner.registry.setAgentScanDirs("", "");
  });

  it("includes DEFAULT_AGENTS by default (disableDefaultAgents=false)", () => {
    owner.registry.registerAgents(new Map());
    const types = owner.registry.getAvailableTypes();
    expect(types).toContain("general-purpose");
    expect(types).toContain("Explore");
  });

  it("skips DEFAULT_AGENTS when disableDefaultAgents is true", () => {
    owner.registry.registerAgents(new Map(), { disableDefaultAgents: true });
    const types = owner.registry.getAvailableTypes();
    expect(types).not.toContain("general-purpose");
    expect(types).not.toContain("Explore");
  });

  it("still includes user-defined agents when disableDefaultAgents is true", () => {
    const userAgents = new Map<string, AgentConfig>();
    userAgents.set("my-agent", {
      name: "my-agent",
      description: "Custom agent",
      systemPrompt: "test",
    });
    owner.registry.registerAgents(userAgents, { disableDefaultAgents: true });
    const types = owner.registry.getAvailableTypes();
    expect(types).toContain("my-agent");
    expect(types).not.toContain("general-purpose");
  });

  it("user agent overriding a default by name is still registered when setting is on", () => {
    const userAgents = new Map<string, AgentConfig>();
    userAgents.set("general-purpose", {
      name: "general-purpose",
      description: "My custom general-purpose agent",
      systemPrompt: "custom prompt",
    });
    owner.registry.registerAgents(userAgents, { disableDefaultAgents: true });
    const config = owner.registry.getAgentConfig("general-purpose");
    expect(config).toBeDefined();
    expect(config!.description).toBe("My custom general-purpose agent");
  });

  it("returns empty types when defaults disabled and no user agents", () => {
    owner.registry.registerAgents(new Map(), { disableDefaultAgents: true });
    expect(owner.registry.getAvailableTypes()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  discoverNewAgents with disableDefaultAgents                       */
/* ------------------------------------------------------------------ */

describe("discoverNewAgents — disableDefaultAgents", () => {
  beforeEach(() => {
    owner.registry.registerAgents(new Map());
    owner.registry.setAgentScanDirs("", "");
  });

  it("skips defaults when discovering with disableDefaultAgents", async () => {
    const { dir: projectDir, cleanup } = tempDirWithFiles(
      [{ name: "custom.md", content: makeAgentMd({ name: "custom", description: "Custom" }) }],
      "project-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map(), { disableDefaultAgents: true });

      await owner.registry.discoverNewAgents(undefined, { disableDefaultAgents: true });

      const types = owner.registry.getAvailableTypes();
      expect(types).toContain("custom");
      expect(types).not.toContain("general-purpose");
      expect(types).not.toContain("Explore");
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  getConfig fallback when defaults are disabled                     */
/* ------------------------------------------------------------------ */

describe("getConfig — fallback when defaults disabled", () => {
  beforeEach(() => {
    owner.registry.registerAgents(new Map());
    owner.registry.setAgentScanDirs("", "");
  });

  it("falls back to generic config when defaults disabled and general-purpose missing", () => {
    owner.registry.registerAgents(new Map(), { disableDefaultAgents: true });
    const config = owner.registry.getConfig("some-unknown-type");
    // Should fall through to the absolute fallback (generic config)
    expect(config.displayName).toBe("Agent");
    expect(config.description).toBe("General-purpose agent for complex, multi-step tasks");
  });
});

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
