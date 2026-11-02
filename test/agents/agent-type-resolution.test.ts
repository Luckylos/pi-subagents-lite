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

import { describe, it, expect, beforeEach } from "vite-plus/test";

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

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
