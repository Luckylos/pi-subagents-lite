import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

// Set the SDK's agent directory before production config constants are imported.
const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const ownTmp = fs.mkdtempSync("/tmp/pi-f2-child-context-");
  fs.chmodSync(ownTmp, 0o700);
  const agentDir = `${ownTmp}/agent`;
  fs.mkdirSync(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { ownTmp, agentDir, previousAgentDir };
});

import { ModelRuntime, ProjectTrustStore, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createChildSession } from "../../src/agents/agent-runner.js";
import { disposeChildSession } from "../../src/agents/session-teardown.js";
import { ConfigStore } from "../../src/config/config-store.js";
import { createExtensionOwner } from "../../src/shell.js";
import { createSubagentTrustDeps, resolveSubagentTrust } from "../../src/spawn/project-trust.js";
import { asExtensionAPI, asExtensionContext } from "../pi-boundaries.js";

const globalMarker = "F2_GLOBAL_CONTEXT_MARKER";
const ancestorMarker = "F2_NONGLOBAL_ANCESTOR_MARKER";
const ancestor = join(fixture.ownTmp, "P");
const repo = join(ancestor, "R");
const target = join(repo, "sub");
const parentCwd = join(fixture.ownTmp, "parent");
const deniedReads: string[] = [];

beforeAll(async () => {
  for (const dir of [target, parentCwd]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(fixture.agentDir, "AGENTS.md"), globalMarker);
  fs.writeFileSync(join(ancestor, "AGENTS.md"), ancestorMarker);
  fs.writeFileSync(join(fixture.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));

  // Keep the actual SDK loader/session/tools. Only resource FS queries are
  // guarded: external metadata is absent and external body reads are rejected.
  const inside = (path: fs.PathLike | number) =>
    typeof path !== "number" && resolve(String(path)).startsWith(`${fixture.ownTmp}${sep}`);
  const exists = fs.existsSync;
  const read = fs.readFileSync;
  const readdir = fs.readdirSync;
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
  vi.spyOn(fs, "readdirSync").mockImplementation(
    new Proxy(readdir, {
      apply(fn, _receiver, args: Parameters<typeof fs.readdirSync>) {
        if (!inside(args[0])) return [];
        return fn(...args);
      },
    }),
  );
  vi.spyOn(fs, "readFileSync").mockImplementation(
    new Proxy(read, {
      apply(fn, _receiver, args: Parameters<typeof fs.readFileSync>) {
        if (!inside(args[0])) {
          deniedReads.push(String(args[0]));
          throw new Error("Body read outside isolated fixture");
        }
        return fn(...args);
      },
    }),
  );
  syncBuiltinESMExports();

  // A real runtime with in-memory credentials; no provider is called.
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
  vi.spyOn(runtime, "streamSimple").mockImplementation(() => {
    throw new Error("Provider request forbidden");
  });
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
});

afterAll(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  if (fixture.previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = fixture.previousAgentDir;
  fs.rmSync(fixture.ownTmp, { recursive: true, force: true });
});

async function openChild(savedTrust: boolean) {
  new ProjectTrustStore(fixture.agentDir).set(target, savedTrust);
  const projectTrusted = resolveSubagentTrust({
    targetPath: target,
    sameRepo: false,
    deps: createSubagentTrustDeps(fixture.agentDir, parentCwd, repo),
  });
  const exec = vi.fn<ExtensionAPI["exec"]>(async () => ({ code: 1, stdout: "", stderr: "", killed: false }));
  const pi = asExtensionAPI({ exec });
  const owner = createExtensionOwner(pi);
  owner.store = new ConfigStore({
    load: () => ({
      global: {
        agent: {
          systemPromptMode: "replace",
          includeContextFiles: true,
          loadSkillsImplicitly: false,
          loadExtensionsImplicitly: false,
        },
      },
      project: null,
      projectStatus: "untrusted",
    }),
    updateLayer: () => {
      throw new Error("Config writes forbidden");
    },
    saveGlobal: () => {
      throw new Error("Config writes forbidden");
    },
    saveProject: () => {
      throw new Error("Config writes forbidden");
    },
  });
  const ctx = asExtensionContext({ cwd: parentCwd, hasUI: false, sessionManager: SessionManager.inMemory(parentCwd) });
  const { session } = await createChildSession(owner, ctx, "f2-context", {
    pi,
    cwd: target,
    projectTrusted,
    agentConfig: {
      name: "f2-context",
      description: "",
      systemPrompt: "F2 child",
      includeContextFiles: true,
      extensions: false,
      skills: false,
    },
  });
  return { session, projectTrusted };
}

describe("production child systemPrompt with real SDK ancestor context", () => {
  it("excludes an untrusted nonglobal ancestor marker while keeping global context", async () => {
    const { session, projectTrusted } = await openChild(false);
    try {
      expect(session.systemPrompt).toContain(globalMarker);
      expect(session.systemPrompt).not.toContain(ancestorMarker);
      expect(projectTrusted).toBe(false);
      expect(session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "bash"]));
      expect(deniedReads).toEqual([]);
    } finally {
      await disposeChildSession(session);
    }
  });

  it("keeps the same ancestor inheritance when trusted, with global context", async () => {
    const { session, projectTrusted } = await openChild(true);
    try {
      expect(session.systemPrompt).toContain(globalMarker);
      expect(session.systemPrompt).toContain(ancestorMarker);
      expect(projectTrusted).toBe(true);
      expect(deniedReads).toEqual([]);
    } finally {
      await disposeChildSession(session);
    }
  });
});
