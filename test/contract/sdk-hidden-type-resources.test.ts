import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Type } from "typebox";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const ownTmp = fs.mkdtempSync("/tmp/pi-f4-sdk-hidden-");
  fs.chmodSync(ownTmp, 0o700);
  const agentDir = `${ownTmp}/agent`;
  fs.mkdirSync(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { ownTmp, agentDir, previousAgentDir };
});

import {
  AgentSession,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createChildSession } from "../../src/agents/agent-runner.js";
import { disposeChildSession } from "../../src/agents/session-teardown.js";
import type { AgentConfig } from "../../src/agents/types.js";
import { ConfigStore } from "../../src/config/config-store.js";
import { createExtensionOwner } from "../../src/shell.js";
import { asExtensionAPI, asExtensionContext } from "../pi-boundaries.js";

const project = join(fixture.ownTmp, "project");
const lifecyclePath = join(fixture.ownTmp, "lifecycle.log");
const deniedReads: string[] = [];
const skillReads: string[] = [];
let created = 0;
let tornDown = 0;
let providers = 0;
const previousCwd = process.cwd();
interface DisposalSpy {
  mock: { calls: unknown[][] };
}
let sdkDisposals: DisposalSpy;

function writeResources(root: string, label: string) {
  const extensionDir = join(root, "extensions");
  const skillDir = join(root, "skills", `${label}-skill`);
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  // Stop the runner's package-alias lookup at this fixture directory.
  fs.writeFileSync(join(extensionDir, "package.json"), JSON.stringify({ name: `${label}-fixtures`, type: "module" }));
  const tool: ToolDefinition = {
    name: `${label}_probe`,
    label: `${label} probe`,
    description: `Isolated ${label} resource`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: label }], details: {} };
    },
  };
  fs.writeFileSync(
    join(extensionDir, `${label}-probe.js`),
    `
import fs from "node:fs";
const mark = (event) => fs.appendFileSync(${JSON.stringify(lifecyclePath)}, ${JSON.stringify(label)} + ":" + event + "\\n");
/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */
export default function (pi) {
  mark("factory");
  pi.registerTool({ ...${JSON.stringify(tool)}, async execute() { return { content: [{ type: "text", text: "fixture" }], details: {} }; } });
  pi.on("session_start", () => mark("start"));
  pi.on("session_shutdown", () => mark("shutdown"));
}
`,
  );
  fs.writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${label}-skill\ndescription: F4 ${label} skill marker\n---\nFixture body only.\n`,
  );
}

beforeAll(async () => {
  fs.mkdirSync(project);
  fs.writeFileSync(
    join(fixture.ownTmp, "package.json"),
    JSON.stringify({ name: "f4-isolated-fixture", type: "module" }),
  );
  process.chdir(fixture.ownTmp);
  fs.writeFileSync(lifecyclePath, "");
  writeResources(fixture.agentDir, "global");
  writeResources(join(project, ".pi"), "project");

  // Keep the real SDK loader and built-in factories. Every resource query sees
  // only our fixture; external bodies are rejected before the real FS call.
  const inside = (path: fs.PathLike | number) =>
    typeof path !== "number" &&
    (resolve(String(path)) === fixture.ownTmp || resolve(String(path)).startsWith(`${fixture.ownTmp}${sep}`));
  const exists = fs.existsSync;
  const stat = fs.statSync;
  const readdir = fs.readdirSync;
  const read = fs.readFileSync;
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
        if (String(args[0]).endsWith("/SKILL.md")) skillReads.push(String(args[0]));
        return fn(...args);
      },
    }),
  );
  syncBuiltinESMExports();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
  vi.spyOn(runtime, "streamSimple").mockImplementation(() => {
    providers++;
    throw new Error("Provider request forbidden");
  });
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
  sdkDisposals = vi.spyOn(AgentSession.prototype, "dispose");
});

afterAll(() => {
  try {
    expect(tornDown).toBe(created);
    expect(sdkDisposals).toHaveBeenCalledTimes(created);
    expect(providers).toBe(0);
    expect(deniedReads).toEqual([]);
    const events = fs.readFileSync(lifecyclePath, "utf8").trim().split("\n");
    expect(events.filter((event) => event.endsWith(":shutdown"))).toHaveLength(
      events.filter((event) => event.endsWith(":start")).length,
    );
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    if (fixture.previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = fixture.previousAgentDir;
    process.chdir(previousCwd);
    fs.rmSync(fixture.ownTmp, { recursive: true, force: true });
  }
});

interface ChildCase {
  hidden: boolean;
  allowed: boolean;
  selected: boolean;
  trusted: boolean;
}

async function verifyChild({ hidden, allowed, selected, trusted }: ChildCase) {
  const pi = asExtensionAPI({
    exec: vi.fn<ExtensionAPI["exec"]>(async () => ({ code: 1, stdout: "", stderr: "", killed: false })),
  });
  const owner = createExtensionOwner(pi);
  owner.store = new ConfigStore({
    load: () => ({
      global: {
        agent: {
          systemPromptMode: "replace",
          includeContextFiles: false,
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
  const role: AgentConfig = {
    name: "ResourceRole",
    displayName: "Own resource role",
    description: "F4 role",
    systemPrompt: "F4_OWN_ROLE_PROMPT",
    hidden,
    extensions: allowed,
    skills: allowed,
    registeredTools: ["read"],
  };
  const general: AgentConfig = {
    name: "general-purpose",
    description: "GP sentinel",
    systemPrompt: "F4_GP_PROMPT",
    extensions: !allowed,
    skills: !allowed,
    tools: ["bash"],
  };
  owner.registry.registerAgents(
    new Map([
      [general.name, general],
      [role.name, selected ? { ...role, extensions: !allowed, skills: !allowed } : role],
    ]),
    { disableDefaultAgents: true },
  );
  const ctx = asExtensionContext({ cwd: project, hasUI: false, sessionManager: SessionManager.inMemory(project) });
  const beforeEvents = fs.readFileSync(lifecyclePath, "utf8").length;
  const beforeSkills = skillReads.length;
  const result = await createChildSession(owner, ctx, "RESOURCEROLE", {
    pi,
    cwd: project,
    projectTrusted: trusted,
    ...(selected ? { agentConfig: role } : {}),
  });
  created++;
  try {
    expect(result.agentConfig).toBe(role);
    expect(result.session.systemPrompt).toContain("F4_OWN_ROLE_PROMPT");
    expect(result.session.systemPrompt).not.toContain("F4_GP_PROMPT");
    expect(result.session.resourceLoader.getExtensions().errors).toEqual([]);
    const loaded = allowed ? ["global", ...(trusted ? ["project"] : [])] : [];
    const events = fs.readFileSync(lifecyclePath, "utf8").slice(beforeEvents).trim().split("\n").filter(Boolean).sort();
    const toolNames = [
      "read",
      ...loaded.map((label) => `${label}_probe`),
      ...(allowed ? ["codemode", "tool_search"] : []),
    ].sort();
    expect({
      events,
      skills: result.session.resourceLoader
        .getSkills()
        .skills.map((skill) => skill.name)
        .sort(),
      skillReads: [...new Set(skillReads.slice(beforeSkills))].sort(),
      registry: result.session
        .getAllTools()
        .map((tool) => tool.name)
        .sort(),
      active: result.session.getActiveToolNames().sort(),
    }).toEqual({
      events: loaded.flatMap((label) => [`${label}:factory`, `${label}:start`]).sort(),
      skills: loaded.map((label) => `${label}-skill`).sort(),
      skillReads: loaded
        .map((label) =>
          join(label === "global" ? fixture.agentDir : join(project, ".pi"), "skills", `${label}-skill`, "SKILL.md"),
        )
        .sort(),
      registry: toolNames,
      active: toolNames,
    });
    expect(deniedReads).toEqual([]);
  } finally {
    await disposeChildSession(result.session);
    tornDown++;
  }
}

describe("production hidden role resource identity with the real SDK", () => {
  it.each([
    { hidden: false, allowed: true, selected: false, trusted: true },
    { hidden: false, allowed: false, selected: false, trusted: true },
    { hidden: false, allowed: true, selected: false, trusted: false },
    { hidden: false, allowed: false, selected: false, trusted: false },
  ])("visible controls: allowed=$allowed trusted=$trusted", verifyChild);
  it.each([
    { hidden: true, allowed: false, selected: false, trusted: true },
    { hidden: true, allowed: false, selected: true, trusted: true },
    { hidden: true, allowed: false, selected: false, trusted: false },
    { hidden: true, allowed: false, selected: true, trusted: false },
    { hidden: true, allowed: true, selected: false, trusted: true },
    { hidden: true, allowed: true, selected: true, trusted: true },
    { hidden: true, allowed: true, selected: false, trusted: false },
    { hidden: true, allowed: true, selected: true, trusted: false },
  ])("hidden role: allowed=$allowed selected=$selected trusted=$trusted", verifyChild);
});
