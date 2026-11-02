/**
 * agent-types-discovery.test.ts — Tests for worktree-local agent type discovery.
 */

import { describe, it, expect, beforeEach } from "vite-plus/test";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.js";

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("discoverNewAgents — worktree-local agent types", () => {
  beforeEach(() => {
    // Reset to clean state: just the default agents
    owner.registry.registerAgents(new Map());
    // Clear scan dirs so they don't pollute tests
    owner.registry.setAgentScanDirs("", "");
  });

  it("discovers a worktree-local agent type when worktreeDir is set", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [
        {
          name: "feature-reviewer.md",
          content: makeAgentMd({ name: "feature-reviewer", description: "Reviews feature branches" }),
        },
      ],
      "worktree-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      expect(owner.registry.resolveType("feature-reviewer")).toEqual({ kind: "not-found" });

      const count = await owner.registry.discoverNewAgents(worktreeDir);
      expect(count).toBeGreaterThanOrEqual(1);

      expect(owner.registry.resolveType("feature-reviewer")).toEqual({ kind: "resolved", key: "feature-reviewer" });
      expect(owner.registry.getAgentConfig("feature-reviewer")?.description).toBe("Reviews feature branches");
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("worktree-local type is NOT found without worktreeDir", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: _worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "feature-reviewer.md", content: makeAgentMd({ name: "feature-reviewer" }) }],
      "worktree-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      await owner.registry.discoverNewAgents();
      expect(owner.registry.resolveType("feature-reviewer")).toEqual({ kind: "not-found" });
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("worktree-discovered types stay in the session-wide registry when a later discovery runs without the worktree", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent", description: "WT agent" }) }],
      "worktree-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      // First discovery with worktree
      await owner.registry.discoverNewAgents(worktreeDir);
      expect(owner.registry.resolveType("wt-agent")).toEqual({ kind: "resolved", key: "wt-agent" });

      // Second discovery WITHOUT worktree — should still be in registry
      const count = await owner.registry.discoverNewAgents();
      expect(owner.registry.resolveType("wt-agent")).toEqual({ kind: "resolved", key: "wt-agent" });
      expect(count).toBe(0); // No new agents (already known)
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("worktree scan does not interfere with existing parent/global discovery", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles(
      [{ name: "project-agent.md", content: makeAgentMd({ name: "project-agent", description: "Project" }) }],
      "project-agents",
    );
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent", description: "WT" }) }],
      "worktree-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      const count = await owner.registry.discoverNewAgents(worktreeDir);

      expect(owner.registry.resolveType("project-agent")).toEqual({ kind: "resolved", key: "project-agent" });
      expect(owner.registry.resolveType("wt-agent")).toEqual({ kind: "resolved", key: "wt-agent" });
      expect(count).toBeGreaterThanOrEqual(2);
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("handles missing worktree .pi/agents/ directory gracefully (no error)", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: nonexistentDir, cleanup: cleanupNonexistent } = tempDirWithFiles([], "nonexistent-base");

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      // Point to a directory that doesn't have .pi/agents/ — should not error
      const fakeWorktreeDir = nonexistentDir + "/.pi/agents";
      const count = await owner.registry.discoverNewAgents(fakeWorktreeDir);
      expect(count).toBe(0);
    } finally {
      cleanupProject();
      cleanupNonexistent();
    }
  });

  it("uses the same parsing rules as the parent scan (frontmatter format, name field)", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [
        {
          name: "wt-agent.md",
          content: makeAgentMd({ name: "wt-agent", extensions: "read, bash", thinking: "high", max_turns: "50" }),
        },
      ],
      "worktree-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      await owner.registry.discoverNewAgents(worktreeDir);
      const config = owner.registry.getAgentConfig("wt-agent");
      expect(config).toBeDefined();
      expect(config!.extensions).toEqual(["read", "bash"]);
      expect(config!.thinkingLevel).toBe("high");
      expect(config!.maxTurns).toBe(50);
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("parses thinking level max from frontmatter", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "max-thinker.md", content: makeAgentMd({ name: "max-thinker", thinking: "max" }) }],
      "worktree-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      await owner.registry.discoverNewAgents(worktreeDir);
      const config = owner.registry.getAgentConfig("max-thinker");
      expect(config).toBeDefined();
      expect(config!.thinkingLevel).toBe("max");
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("returns 0 when worktreeDir is empty string (treated as omitted)", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: _worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent" }) }],
      "worktree-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      const count = await owner.registry.discoverNewAgents("");
      expect(count).toBe(0);
      expect(owner.registry.resolveType("wt-agent")).toEqual({ kind: "not-found" });
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("does not duplicate agents already in the registry", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles(
      [{ name: "shared.md", content: makeAgentMd({ name: "shared", description: "From project" }) }],
      "project-agents",
    );
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "wt-shared.md", content: makeAgentMd({ name: "shared", description: "From worktree" }) }],
      "worktree-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      // First discovery — project agent gets added
      await owner.registry.discoverNewAgents();
      expect(owner.registry.getAgentConfig("shared")?.description).toBe("From project");

      // Second discovery with worktree — should NOT override the already-registered agent
      const count = await owner.registry.discoverNewAgents(worktreeDir);
      expect(count).toBe(0); // "shared" is already known
      expect(owner.registry.getAgentConfig("shared")?.description).toBe("From project");
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("resolves a case-insensitive request for a worktree-discovered agent", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "Feature-Reviewer.md", content: makeAgentMd({ name: "Feature-Reviewer", description: "Reviews" }) }],
      "worktree-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      await owner.registry.discoverNewAgents(worktreeDir);
      expect(owner.registry.resolveType("feature-reviewer")).toEqual({ kind: "resolved", key: "Feature-Reviewer" });
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("reports ambiguity when a discovered agent differs only by case from a registered type", async () => {
    // Defaults register "Explore"; the worktree adds "explore".
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "explore.md", content: makeAgentMd({ name: "explore", description: "Lowercase explore" }) }],
      "worktree-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir);
      owner.registry.registerAgents(new Map());

      await owner.registry.discoverNewAgents(worktreeDir);
      expect(owner.registry.resolveType("EXPLORE")).toEqual({ kind: "ambiguous", candidates: ["Explore", "explore"] });
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });
});

describe("discoverNewAgents — shared .agents/agents/ discovery", () => {
  beforeEach(() => {
    owner.registry.registerAgents(new Map());
    owner.registry.setAgentScanDirs("", "", "");
  });

  it("discovers agents from .agents/agents/ directory", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles(
      [
        {
          name: "shared-agent.md",
          content: makeAgentMd({ name: "shared-agent", description: "Shared workspace agent" }),
        },
      ],
      "shared-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir, sharedDir);
      owner.registry.registerAgents(new Map());

      expect(owner.registry.resolveType("shared-agent")).toEqual({ kind: "not-found" });

      const count = await owner.registry.discoverNewAgents();
      expect(count).toBeGreaterThanOrEqual(1);

      expect(owner.registry.resolveType("shared-agent")).toEqual({ kind: "resolved", key: "shared-agent" });
      expect(owner.registry.getAgentConfig("shared-agent")?.description).toBe("Shared workspace agent");
    } finally {
      cleanupProject();
      cleanupShared();
    }
  });

  it("project agents override shared agents on name clash", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles(
      [{ name: "clash.md", content: makeAgentMd({ name: "clash", description: "From project" }) }],
      "project-agents",
    );
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles(
      [{ name: "clash.md", content: makeAgentMd({ name: "clash", description: "From shared" }) }],
      "shared-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir, sharedDir);
      owner.registry.registerAgents(new Map());

      await owner.registry.discoverNewAgents();

      expect(owner.registry.getAgentConfig("clash")?.description).toBe("From project");
    } finally {
      cleanupProject();
      cleanupShared();
    }
  });

  it("shared agents override user agents on name clash", async () => {
    const { dir: userDir, cleanup: cleanupUser } = tempDirWithFiles(
      [{ name: "clash.md", content: makeAgentMd({ name: "clash", description: "From user" }) }],
      "user-agents",
    );
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles(
      [{ name: "clash.md", content: makeAgentMd({ name: "clash", description: "From shared" }) }],
      "shared-agents",
    );

    try {
      owner.registry.setAgentScanDirs(userDir, projectDir, sharedDir);
      owner.registry.registerAgents(new Map());

      await owner.registry.discoverNewAgents();

      expect(owner.registry.getAgentConfig("clash")?.description).toBe("From shared");
    } finally {
      cleanupUser();
      cleanupProject();
      cleanupShared();
    }
  });

  it("shared agents get source 'project'", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles(
      [{ name: "shared-agent.md", content: makeAgentMd({ name: "shared-agent", description: "Shared" }) }],
      "shared-agents",
    );

    try {
      owner.registry.setAgentScanDirs("", projectDir, sharedDir);
      owner.registry.registerAgents(new Map());

      await owner.registry.discoverNewAgents();

      expect(owner.registry.getAgentConfig("shared-agent")?.source).toBe("project");
    } finally {
      cleanupProject();
      cleanupShared();
    }
  });

  it("silently skips non-existent .agents/agents/ directory", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");

    try {
      owner.registry.setAgentScanDirs("", projectDir, "/tmp/nonexistent-shared-agents-dir");
      owner.registry.registerAgents(new Map());

      const count = await owner.registry.discoverNewAgents();
      expect(count).toBe(0);
    } finally {
      cleanupProject();
    }
  });

  it("full precedence: default < user < shared < project", async () => {
    const { dir: userDir, cleanup: cleanupUser } = tempDirWithFiles(
      [
        {
          name: "layered.md",
          content: makeAgentMd({ name: "layered", description: "From user", model: "model/user" }),
        },
      ],
      "user-agents",
    );
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles(
      [
        {
          name: "layered.md",
          content: makeAgentMd({ name: "layered", description: "From project", _skip: ["model"] }),
        },
      ],
      "project-agents",
    );
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles(
      [
        {
          name: "layered.md",
          content: makeAgentMd({ name: "layered", description: "From shared", model: "model/shared" }),
        },
      ],
      "shared-agents",
    );

    try {
      owner.registry.setAgentScanDirs(userDir, projectDir, sharedDir);
      owner.registry.registerAgents(new Map());

      await owner.registry.discoverNewAgents();

      const config = owner.registry.getAgentConfig("layered")!;
      expect(config.description).toBe("From project");
      expect(config.model).toBe("model/shared");
    } finally {
      cleanupUser();
      cleanupProject();
      cleanupShared();
    }
  });
});

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
