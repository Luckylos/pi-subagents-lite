/**
 * agent-type-resolution.test.ts — Tests for case-insensitive agent type resolution.
 *
 * Verifies the resolution contract in agent-types.ts:
 *   - the exact registered name wins
 *   - a single case-insensitive match resolves to the canonical registered name
 *   - two or more registered types differing only by case are ambiguous
 *   - unknown names are not found; displayName is display-only (no synonym matching)
 *   - hidden agents participate in resolution like any registered type
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vite-plus/test";
import { createAgentRegistry } from "../../src/agents/agent-types.js";

import type { AgentConfig } from "../../src/agents/types.js";

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name, description: `Agent ${name}`, systemPrompt: "", ...overrides };
}

const EXPLORE_AND_GENERAL = new Map<string, AgentConfig>([
  ["Explore", agent("Explore")],
  ["general-purpose", agent("general-purpose")],
]);

beforeEach(() => {
  owner.registry.registerAgents(new Map(EXPLORE_AND_GENERAL));
});

describe("resolveType", () => {
  it("resolves an exact-case registered name to itself", () => {
    expect(owner.registry.resolveType("Explore")).toEqual({ kind: "resolved", key: "Explore" });
    expect(owner.registry.resolveType("general-purpose")).toEqual({ kind: "resolved", key: "general-purpose" });
  });

  it("resolves a single case-insensitive match to the canonical name", () => {
    expect(owner.registry.resolveType("explore")).toEqual({ kind: "resolved", key: "Explore" });
    expect(owner.registry.resolveType("EXPLORE")).toEqual({ kind: "resolved", key: "Explore" });
    expect(owner.registry.resolveType("General-Purpose")).toEqual({ kind: "resolved", key: "general-purpose" });
  });

  it("an exact-case match beats a case-insensitive match when both exist", () => {
    owner.registry.registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        ["explore", agent("explore")],
      ]),
    );
    expect(owner.registry.resolveType("Explore")).toEqual({ kind: "resolved", key: "Explore" });
    expect(owner.registry.resolveType("explore")).toEqual({ kind: "resolved", key: "explore" });
  });

  it("two registered types differing only by case are ambiguous with both candidates", () => {
    owner.registry.registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        ["explore", agent("explore")],
      ]),
    );
    expect(owner.registry.resolveType("EXPLORE")).toEqual({ kind: "ambiguous", candidates: ["Explore", "explore"] });
  });

  it("hidden agents participate in resolution and ambiguity", () => {
    owner.registry.registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        ["explore", agent("explore", { hidden: true })],
      ]),
    );
    expect(owner.registry.resolveType("explore")).toEqual({ kind: "resolved", key: "explore" });
    expect(owner.registry.resolveType("EXPLORE")).toEqual({ kind: "ambiguous", candidates: ["Explore", "explore"] });
  });

  it("does not resolve displayName aliases (no synonyms)", () => {
    owner.registry.registerAgents(
      new Map([
        ["general-purpose", agent("general-purpose", { displayName: "Agent" })],
        ["Explore", agent("Explore", { displayName: "Explorer" })],
      ]),
    );
    expect(owner.registry.resolveType("Agent")).toEqual({ kind: "not-found" });
    expect(owner.registry.resolveType("Explorer")).toEqual({ kind: "not-found" });
  });

  it("returns not-found for unknown and empty names", () => {
    expect(owner.registry.resolveType("nope")).toEqual({ kind: "not-found" });
    expect(owner.registry.resolveType("")).toEqual({ kind: "not-found" });
  });
});

describe("getAgentConfig", () => {
  it("returns the config for exact and case-insensitive names", () => {
    expect(owner.registry.getAgentConfig("Explore")?.name).toBe("Explore");
    expect(owner.registry.getAgentConfig("explore")?.name).toBe("Explore");
  });

  it("returns undefined for ambiguous and unknown names", () => {
    owner.registry.registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        ["explore", agent("explore")],
      ]),
    );
    expect(owner.registry.getAgentConfig("EXPLORE")).toBeUndefined();
    expect(owner.registry.getAgentConfig("nope")).toBeUndefined();
  });
});

describe("getAvailableTypes", () => {
  it("lists registered names as-is, not normalized variants", () => {
    owner.registry.registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        ["explore", agent("explore")],
        ["general-purpose", agent("general-purpose")],
      ]),
    );
    const types = owner.registry.getAvailableTypes();
    expect(types).toContain("Explore");
    expect(types).toContain("explore");
    expect(types).toContain("general-purpose");
    expect(types).not.toContain("EXPLORE");
  });
});

describe("hidden selection boundaries", () => {
  it("keeps the complete visible listing while exact and ambiguous hidden names remain resolvable", () => {
    const registry = createAgentRegistry();
    const hidden = agent("explore", { hidden: true, displayName: "Hidden explorer" });
    registry.registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        [hidden.name, hidden],
        ["general-purpose", agent("general-purpose")],
      ]),
      { disableDefaultAgents: true },
    );
    expect(registry.getVisibleAgentInfos()).toEqual([
      { name: "Explore", description: "Agent Explore" },
      { name: "general-purpose", description: "Agent general-purpose" },
    ]);
    expect(registry.getAvailableTypes()).toEqual(["Explore", "general-purpose"]);
    expect(registry.getAllTypes()).toEqual(["Explore", "explore", "general-purpose"]);
    expect(registry.getAgentConfig("explore")).toBe(hidden);
    expect(registry.resolveType("EXPLORE")).toEqual({ kind: "ambiguous", candidates: ["Explore", "explore"] });
    expect(registry.resolveType("Hidden explorer")).toEqual({ kind: "not-found" });
  });

  it("uses a discovered hidden target snapshot without leaking into another target or instance", async () => {
    const ownTmp = mkdtempSync("/tmp/pi-f4-type-target-");
    chmodSync(ownTmp, 0o700);
    try {
      const target = join(ownTmp, "target");
      const otherTarget = join(ownTmp, "other");
      mkdirSync(target);
      mkdirSync(otherTarget);
      writeFileSync(
        join(target, "Target.md"),
        "---\nname: Target\ndescription: Target role\nhidden: true\ntools: [read]\nregistered_tools: [read]\nextensions: false\nskills: false\n---\nTarget prompt",
      );
      const registry = createAgentRegistry();
      const other = createAgentRegistry();
      const general = agent("general-purpose", { extensions: true, skills: true, tools: ["bash"] });
      registry.registerAgents(new Map([[general.name, general]]), { disableDefaultAgents: true });
      other.registerAgents(new Map([[general.name, general]]), { disableDefaultAgents: true });
      expect(await registry.resolveTypeOrDiscover("TARGET", target)).toEqual({ kind: "resolved", key: "Target" });
      const selected = registry.getAgentConfig("target", target);
      expect(selected?.hidden).toBe(true);
      expect(selected?.systemPrompt).toBe("Target prompt");
      expect(registry.getConfig("Target", true, true, selected)).toEqual({
        displayName: "Target",
        description: "Target role",
        tools: ["read"],
        registeredTools: ["read"],
        extensions: false,
        skills: false,
      });
      expect(registry.getAgentConfig("Target")).toBeUndefined();
      expect(registry.resolveType("Target", otherTarget)).toEqual({ kind: "not-found" });
      expect(other.resolveType("Target", target)).toEqual({ kind: "not-found" });
      expect(registry.getVisibleAgentInfos()).toEqual([
        { name: "general-purpose", description: "Agent general-purpose" },
      ]);
      expect(other.getAvailableTypes()).toEqual(["general-purpose"]);
    } finally {
      rmSync(ownTmp, { recursive: true, force: true });
    }
  });
});

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
