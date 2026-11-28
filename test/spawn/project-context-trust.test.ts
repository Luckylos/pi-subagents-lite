import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  loadProjectContextFiles,
  ProjectTrustStore,
  SettingsManager,
  type DefaultProjectTrust,
} from "@earendil-works/pi-coding-agent";
import { createSubagentTrustDeps, resolveSubagentTrust } from "../../src/spawn/project-trust.js";
import { validateWorktreePath } from "../../src/spawn/worktree-validator.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
let ownTmp: string;
let agentDir: string;
let parentCwd: string;
let ancestor: string;
let repo: string;
let target: string;

// Update Node's real ESM fs bindings as well: the SDK stays external to Vitest.
// Metadata outside the fixture is absent; instruction bodies can only be read inside it.
function guardResources() {
  const inside = (path: fs.PathLike | number) =>
    typeof path !== "number" && resolve(String(path)).startsWith(`${ownTmp}${sep}`);
  const exists = fs.existsSync;
  const read = fs.readFileSync;
  const stat = fs.statSync;
  vi.spyOn(fs, "existsSync").mockImplementation((path) => inside(path) && exists(path));
  vi.spyOn(fs, "statSync").mockImplementation(
    new Proxy(stat, {
      apply(fn, _receiver, args: Parameters<typeof fs.statSync>) {
        if (!inside(args[0])) throw new Error("Resource metadata outside isolated fixture");
        return fn(...args);
      },
    }),
  );
  const reads = vi.spyOn(fs, "readFileSync").mockImplementation(
    new Proxy(read, {
      apply(fn, _receiver, args: Parameters<typeof fs.readFileSync>) {
        if (!inside(args[0])) throw new Error("Body read outside isolated fixture");
        return fn(...args);
      },
    }),
  );
  syncBuiltinESMExports();
  return reads;
}

beforeEach(() => {
  ownTmp = fs.mkdtempSync("/tmp/pi-f2-context-");
  fs.chmodSync(ownTmp, 0o700);
  agentDir = join(ownTmp, "agent");
  parentCwd = join(ownTmp, "parent");
  ancestor = join(ownTmp, "P");
  repo = join(ancestor, "R");
  target = join(repo, "sub");
  for (const dir of [agentDir, parentCwd, target]) fs.mkdirSync(dir, { recursive: true });
  guardResources();
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(ownTmp, { recursive: true, force: true });
});

function setDefault(value: DefaultProjectTrust) {
  fs.writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: value }));
  expect(SettingsManager.create(parentCwd, agentDir).getDefaultProjectTrust()).toBe(value);
}

function trust(sameRepo = false, root: string | undefined = repo) {
  return resolveSubagentTrust({
    targetPath: target,
    sameRepo,
    deps: createSubagentTrustDeps(agentDir, parentCwd, root),
  });
}

describe("project context trust with real SDK dependencies", () => {
  it("reads only global settings for an undecided target while its parent is untrusted", () => {
    setDefault("always");
    fs.writeFileSync(join(ancestor, "AGENTS.md"), "target context");
    new ProjectTrustStore(agentDir).set(parentCwd, false);
    fs.mkdirSync(join(parentCwd, ".pi"));
    const file = join(parentCwd, ".pi", "settings.json");
    fs.writeFileSync(file, JSON.stringify({ hideThinkingBlock: true }));

    // Positive control: this spy sees the external SDK's actual project body read.
    const reads = vi.mocked(fs.readFileSync);
    expect(SettingsManager.create(parentCwd, agentDir).getHideThinkingBlock()).toBe(true);
    expect(reads.mock.calls.some(([path]) => path === file)).toBe(true);
    reads.mockClear();

    expect(trust()).toBe(true);
    const paths = reads.mock.calls.map(([path]) => path);
    expect(paths).toContain(join(agentDir, "settings.json"));
    expect(paths).not.toContain(file);
  });

  it("gates context above the worktree for saved false, even with default always", () => {
    fs.writeFileSync(join(ancestor, "AGENTS.md"), "untrusted ancestor");
    setDefault("always");
    new ProjectTrustStore(agentDir).set(target, false);
    expect(trust()).toBe(false);
  });

  it.each(["never", "ask"] as const)("gates context above the worktree with default %s", (value) => {
    fs.writeFileSync(join(ancestor, "AGENTS.md"), "undecided ancestor");
    setDefault(value);
    expect(trust()).toBe(false);
  });

  it("keeps saved true ahead of default never", () => {
    fs.writeFileSync(join(ancestor, "AGENTS.md"), "trusted ancestor");
    setDefault("never");
    new ProjectTrustStore(agentDir).set(target, true);
    expect(trust()).toBe(true);
  });

  it("keeps default always for undecided ancestor context", () => {
    fs.writeFileSync(join(ancestor, "AGENTS.md"), "trusted ancestor");
    setDefault("always");
    expect(trust()).toBe(true);
  });

  it.each(["fallback", "omitted"] as const)("detects repo context with %s worktree root", (root) => {
    fs.writeFileSync(join(repo, "AGENTS.md"), "repo ancestor");
    const deps =
      root === "omitted"
        ? createSubagentTrustDeps(agentDir, parentCwd)
        : createSubagentTrustDeps(agentDir, parentCwd, target);
    expect(deps.hasTrustRequiringProjectResources(target)).toBe(true);
  });

  it("detects context after the real validator falls back to cwd", async () => {
    fs.writeFileSync(join(repo, "AGENTS.md"), "fallback ancestor");
    const exec = vi.fn<ExtensionAPI["exec"]>(async (_cmd, args, options) => ({
      code: args.includes("--show-toplevel") ? 1 : 0,
      stdout: args.includes("--show-toplevel") ? "" : join(options?.cwd ?? target, ".git"),
      stderr: "",
      killed: false,
    }));
    const validation = await validateWorktreePath({ exec }, target, parentCwd);
    expect(validation).toMatchObject({ ok: true, sameRepo: false, worktreeRoot: target });
    if (!validation.ok) throw new Error(validation.error);
    expect(
      createSubagentTrustDeps(agentDir, parentCwd, validation.worktreeRoot).hasTrustRequiringProjectResources(target),
    ).toBe(true);
  });

  it.each(candidates)("pins real SDK loading and metadata detection of %s above root", (filename) => {
    const file = join(ancestor, filename);
    fs.writeFileSync(file, `context ${filename}`);
    expect(loadProjectContextFiles({ cwd: target, agentDir })).toEqual([
      { path: file, content: `context ${filename}` },
    ]);
    const reads = vi.mocked(fs.readFileSync);
    reads.mockClear();
    expect(createSubagentTrustDeps(agentDir, parentCwd, repo).hasTrustRequiringProjectResources(target)).toBe(true);
    expect(reads).not.toHaveBeenCalled();
  });

  it("does not count explicit global context when agentDir is an ancestor", () => {
    agentDir = ancestor;
    fs.writeFileSync(join(agentDir, "AGENTS.md"), "global only");
    expect(loadProjectContextFiles({ cwd: target, agentDir })).toEqual([
      { path: join(agentDir, "AGENTS.md"), content: "global only" },
    ]);
    const deps = createSubagentTrustDeps(agentDir, parentCwd, agentDir);
    const decision = vi.spyOn(deps, "getTrustDecision");
    expect(deps.hasTrustRequiringProjectResources(target)).toBe(false);
    expect(resolveSubagentTrust({ targetPath: target, sameRepo: false, deps })).toBe(true);
    expect(decision).not.toHaveBeenCalled();
  });

  it("continues above a global ancestor to find nonglobal context", () => {
    agentDir = repo;
    fs.writeFileSync(join(repo, "AGENTS.md"), "global");
    fs.writeFileSync(join(ancestor, "AGENTS.md"), "nonglobal");
    setDefault("never");
    expect(trust(false, target)).toBe(false);
  });

  it("keeps same-repo and genuinely empty targets ungated without consulting decisions", () => {
    new ProjectTrustStore(agentDir).set(target, false);
    const deps = createSubagentTrustDeps(agentDir, parentCwd, repo);
    const decision = vi.spyOn(deps, "getTrustDecision");
    expect(deps.hasTrustRequiringProjectResources(target)).toBe(false);
    expect(resolveSubagentTrust({ targetPath: target, sameRepo: false, deps })).toBe(true);
    fs.writeFileSync(join(ancestor, "AGENTS.md"), "same repo ancestor");
    expect(resolveSubagentTrust({ targetPath: target, sameRepo: true, deps })).toBe(true);
    expect(decision).not.toHaveBeenCalled();
  });

  it.each([".pi/settings.json", ".agents/skills", ".pi/agents", ".pi/subagents-lite.json"])(
    "retains existing local resource detection for %s",
    (resource) => {
      const file = join(target, resource);
      if (resource.endsWith(".json")) {
        fs.mkdirSync(join(file, ".."), { recursive: true });
        fs.writeFileSync(file, "{}");
      } else {
        fs.mkdirSync(file, { recursive: true });
      }
      expect(createSubagentTrustDeps(agentDir, parentCwd, repo).hasTrustRequiringProjectResources(target)).toBe(true);
    },
  );

  it("does not expand other .pi resource checks to ancestors", () => {
    fs.mkdirSync(join(ancestor, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(join(ancestor, ".pi", "settings.json"), "{}");
    fs.writeFileSync(join(ancestor, ".pi", "subagents-lite.json"), "{}");
    expect(createSubagentTrustDeps(agentDir, parentCwd, repo).hasTrustRequiringProjectResources(target)).toBe(false);
  });
});
