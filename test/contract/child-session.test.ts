/**
 * child-session.test.ts — Contract tests: a Subagent without explicit tool
 * overrides behaves like a normal pi session in the same workspace.
 *
 * Drives the real SDK through the production createChildSession seam with only
 * the shell store stubbed; the announcement tests wrap
 * AgentSession.prototype.bindExtensions to mark the instant the SDK's bind is
 * invoked, then delegate to it unchanged and restore it. The reference session
 * is wired the way the pi CLI builds one (pi's own private builtInExtensions
 * registry), so child/reference equality is meaningful, not trivial. The fixture
 * extension pins registry completeness (a deferred tool and a session_start-
 * registered tool) and teardown (its live-resource count returns to zero).
 *
 * Matrix: unconfigured, +name, -name, replacement, project-over-global,
 * settings-level built-in disable, implicit OFF, explicit frontmatter
 * tools/extensions, and the child-lifecycle announcements a Subagent-aware
 * extension receives on the parent's bus.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The only mock: the composition-root shell, whose real ConfigStore reads the
// developer's real config file. Everything below drives real code.
const contractStore = vi.hoisted(() => ({
  agent: {
    systemPromptMode: "replace",
    includeContextFiles: false,
    loadSkillsImplicitly: true,
    loadExtensionsImplicitly: true,
    loadToolsImplicitly: true,
    defaultThinking: undefined,
    graceTurns: 6,
    forceBackground: false,
    showCost: false,
    defaultModel: null,
  },
}));

vi.mock("../../src/shell.js", async () =>
  (await import("../owner-fixtures.js")).ownerShellMock(
    await (() => ({
      getStore: () => contractStore,
    }))(),
  ),
);

import {
  AgentSession,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type EventBus,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { createChildSession, runAgent } from "../../src/agents/agent-runner.js";

import { disposeChildSession } from "../../src/agents/session-teardown.js";
import { assistantMessage } from "../agents/session-messages.js";
import { importPiBuiltInExtensions } from "../agents/pi-builtin-registry.js";
import { asExtensionAPI, asExtensionContext } from "../pi-boundaries.js";
import { defaultSessionManager } from "../mock-utils.js";

/** One observed timeline entry, plus its payload when the line carries one. */
interface Observed {
  event: string;
  data?: unknown;
}

interface Workspace {
  project: string;
  statePath: string;
  timelinePath: string;
  markerPath: string;
  hasProbe: boolean;
  writeGlobalSettings(settings: Record<string, unknown>): void;
  writeProjectSettings(settings: Record<string, unknown>): void;
  writeProbeExtension(lateOnly?: boolean): void;
  writeForkExtension(): void;
  writePeerExtension(): void;
  writeLifecycleProbe(): void;
  writeLoadMarkerProbe(): void;
  probeCount(): number;
  timeline(): string[];
  markers(): string[];
}

/** Every workspace root made so far; all removed in afterAll (PI_CODING_AGENT_DIR is reassigned per workspace). */
const workspaceRoots: string[] = [];

function makeWorkspace(name: string): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `subagents-contract-${name}-`));
  workspaceRoots.push(root);
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  // pi reads the agent dir per call: point it at this workspace so the global
  // settings layer and pi's built-in/extension settings resolve here. Tests in
  // this file run sequentially, so the last workspace wins.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const statePath = path.join(root, "probe-state.json");
  const timelinePath = path.join(root, "timeline.log");
  const markerPath = path.join(root, "load-markers.log");
  const workspace: Workspace = {
    project,
    statePath,
    timelinePath,
    markerPath,
    hasProbe: false,
    writeGlobalSettings(settings) {
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
    },
    writeProjectSettings(settings) {
      fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify(settings));
    },
    writeProbeExtension(lateOnly = false) {
      const dir = path.join(project, ".pi", "extensions");
      fs.mkdirSync(dir, { recursive: true });
      workspace.hasProbe = true;
      const startupExposures = lateOnly ? [] : ["deferred", "hidden"];
      // Deferred tool (callable by dispatchers while inactive), a tool
      // registered during session_start (late registration), and one live
      // resource per bound session (shutdown must release it).
      const source = `
import * as fs from "node:fs";
const statePath = ${JSON.stringify(statePath)};
function readCount() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf-8")).live; } catch { return 0; }
}
function writeCount(n) {
  fs.writeFileSync(statePath, JSON.stringify({ live: n }));
}
const probeSchema = { type: "object", properties: {}, required: [] };
export default function (pi) {
  for (const exposure of ${JSON.stringify(startupExposures)}) {
    pi.registerTool({
      name: "probe_" + exposure,
      label: "Probe " + exposure,
      description: exposure + " probe tool",
      parameters: probeSchema,
      exposure,
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    });
  }
  pi.on("session_start", async () => {
    writeCount(readCount() + 1);
    pi.registerTool({
      name: "probe_late",
      label: "Probe late",
      description: "session_start-registered probe tool",
      parameters: probeSchema,
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    });
  });
  pi.on("session_shutdown", async () => {
    writeCount(readCount() - 1);
  });
}
`;
      fs.writeFileSync(path.join(dir, "probe.ts"), source);
    },
    probeCount() {
      try {
        return JSON.parse(fs.readFileSync(statePath, "utf-8")).live;
      } catch {
        return 0;
      }
    },
    writeForkExtension() {
      const packageRoot = path.join(project, ".pi", "extensions", "pi-subagents-lite-fixture");
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.cpSync(path.join(process.cwd(), "src"), path.join(packageRoot, "src"), { recursive: true });
      fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(packageRoot, "node_modules"), "dir");
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "pi-subagents-lite-fixture",
          pi: { extensions: ["./src/index.ts"] },
        }),
      );
    },
    writePeerExtension() {
      const dir = path.join(project, ".pi", "extensions");
      fs.mkdirSync(dir, { recursive: true });
      const source = `
const schema = { type: "object", properties: {}, required: [] };
export default function (pi) {
  pi.registerTool({
    name: "peer_tool",
    label: "Peer tool",
    description: "A tool from an unrelated extension",
    parameters: schema,
    async execute() { return { content: [{ type: "text", text: "peer" }], details: {} }; },
  });
}
`;
      fs.writeFileSync(path.join(dir, "peer.ts"), source);
    },
    /** Appends a marker from inside the child's own extensions, at bind time. */
    writeLifecycleProbe() {
      const dir = path.join(project, ".pi", "extensions");
      fs.mkdirSync(dir, { recursive: true });
      const source = `
import * as fs from "node:fs";
export default function (pi) {
  pi.on("session_start", () => fs.appendFileSync(${JSON.stringify(timelinePath)}, "child:session_start\\n"));
}
`;
      fs.writeFileSync(path.join(dir, "lifecycle-probe.ts"), source);
    },
    writeLoadMarkerProbe() {
      const dir = path.join(project, ".pi", "extensions");
      fs.mkdirSync(dir, { recursive: true });
      workspace.hasProbe = true;
      const source = `
import * as fs from "node:fs";
const markerPath = ${JSON.stringify(markerPath)};
const markerContainer = globalThis[Symbol.for("pi-subagents-lite.child-extension-load.v1")];
function mark(stage) { fs.appendFileSync(markerPath, stage + ":" + (markerContainer?.storage?.getStore() === true) + String.fromCharCode(10)); }
export default function (pi) {
  mark("factory");
  pi.registerTool({
    name: "probe_late",
    label: "Probe late",
    description: "marker probe",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
  });
  pi.on("session_start", () => mark("session_start"));
}
`;
      fs.writeFileSync(path.join(dir, "probe.ts"), source);
    },
    timeline() {
      try {
        return fs.readFileSync(timelinePath, "utf-8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    markers() {
      try {
        return fs.readFileSync(markerPath, "utf-8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
  return workspace;
}

/** Appends one marker line; the write is synchronous, so the timeline order is total. */
function appendMarker(workspace: Workspace, marker: string): void {
  fs.appendFileSync(workspace.timelinePath, `${marker}\n`);
}

/** The spawning-session ctx: the child path reads the parent session id off its session manager. */
function parentCtx(project: string) {
  return asExtensionContext({ cwd: project, hasUI: false, sessionManager: defaultSessionManager() });
}

function stubPi(events?: EventBus) {
  return asExtensionAPI({
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    ...(events ? { events } : {}),
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The production child path: our wrapped built-in factories. */
async function spawnChild(workspace: Workspace): Promise<AgentSession> {
  const { session } = await createChildSession(owner, parentCtx(workspace.project), "general-purpose", {
    pi: stubPi(),
    cwd: workspace.project,
  });
  if (workspace.hasProbe) {
    await until(() => session.getAllTools().some((tool) => tool.name === "probe_late"), "probe_late registration");
  }
  return session;
}

/**
 * pi's inline extension factories, spelled through the loader's own options:
 * pi does not export that type from the package entry.
 */
type InlineExtensions = NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]>;

/** A real pi session in this workspace, loaded with these extension factories. */
async function openPiSession(workspace: Workspace, extensionFactories: InlineExtensions): Promise<AgentSession> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(workspace.project, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({
    cwd: workspace.project,
    agentDir,
    settingsManager,
    extensionFactories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: workspace.project,
    agentDir,
    sessionManager: SessionManager.inMemory(workspace.project),
    settingsManager,
    resourceLoader: loader,
  });
  await session.bindExtensions({});
  return session;
}

/** A normal pi session, wired the way the CLI wires one (pi's own built-ins). */
async function spawnReference(workspace: Workspace): Promise<AgentSession> {
  const session = await openPiSession(workspace, await importPiBuiltInExtensions<InlineExtensions[number]>());
  if (workspace.hasProbe) {
    await until(() => session.getAllTools().some((tool) => tool.name === "probe_late"), "probe_late registration");
  }
  return session;
}

const registryOf = (session: AgentSession) =>
  session
    .getAllTools()
    .map((tool) => tool.name)
    .sort();
const activeOf = (session: AgentSession) => [...session.getActiveToolNames()].sort();
const callableOf = (session: AgentSession) => [...session.getCallableToolNames()].sort();
const rawRunnerOf = (session: AgentSession) =>
  session.extensionRunner
    .getAllRegisteredTools()
    .map((tool) => tool.definition.name)
    .sort();

beforeAll(() => {
  owner.registry.registerAgents(new Map());
});

afterAll(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const root of workspaceRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe("contract: child session matches a normal pi session", () => {
  it("marks only child loader factories, not bind-time callbacks", async () => {
    const workspace = makeWorkspace("loader-marker");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeLoadMarkerProbe();
    const child = await spawnChild(workspace);

    expect(workspace.markers()).toEqual(["factory:true", "session_start:false"]);

    await child.reload();
    expect(workspace.markers()).toEqual(["factory:true", "session_start:false", "factory:true", "session_start:false"]);

    const reference = await spawnReference(workspace);
    expect(workspace.markers()).toEqual([
      "factory:true",
      "session_start:false",
      "factory:true",
      "session_start:false",
      "factory:false",
      "session_start:false",
    ]);

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });

  // Cold-loads a copy of src/ through jiti: ~1.5s alone, 4-5s under the full parallel suite.
  it("does not register its parent tools while retaining an unrelated extension", { timeout: 20_000 }, async () => {
    const workspace = makeWorkspace("self-exclusion");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeForkExtension();
    workspace.writePeerExtension();
    const child = await spawnChild(workspace);
    const ownTools = ["Agent", "StopAgent", "MessageAgent", "AgentStatus", "Workflow"];

    for (const name of ownTools) {
      expect(registryOf(child)).not.toContain(name);
      expect(rawRunnerOf(child)).not.toContain(name);
    }
    expect(registryOf(child)).toContain("peer_tool");
    expect(rawRunnerOf(child)).toContain("peer_tool");

    await disposeChildSession(child);
  });

  it("with unconfigured defaultTools, registries and active sets are equal", async () => {
    const workspace = makeWorkspace("unconfigured");
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(registryOf(child)).toEqual(registryOf(reference));
    expect(activeOf(child)).toEqual(activeOf(reference));
    expect(activeOf(child)).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });

  it("defaultTools ['+codemode'] activates codemode with a complete registry, like a normal session", async () => {
    const workspace = makeWorkspace("plus-codemode");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeProbeExtension();
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(activeOf(child)).toContain("codemode");
    expect(registryOf(child)).toEqual(registryOf(reference));
    expect(activeOf(child)).toEqual(activeOf(reference));
    // Registry completeness: the deferred probe is callable by dispatchers
    // while inactive, and the session_start-registered tool made it in.
    expect(registryOf(child)).toContain("probe_deferred");
    expect(registryOf(child)).toContain("probe_late");
    expect(callableOf(child)).toContain("probe_deferred");
    expect(activeOf(child)).not.toContain("probe_deferred");
    // Two sessions opened the live resource.
    expect(workspace.probeCount()).toBe(2);

    await disposeChildSession(child);
    expect(workspace.probeCount()).toBe(1);
    await disposeChildSession(reference);
    expect(workspace.probeCount()).toBe(0);
  });

  it.each(["child", "reference"] as const)("validates nested codemode arguments in a %s session", async (kind) => {
    const workspace = makeWorkspace("live-codemode-" + kind);
    workspace.writeGlobalSettings({ defaultTools: ["codemode"] });
    const extensionDir = path.join(workspace.project, ".pi", "extensions");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, "schema-probe.ts"),
      `
import { appendFileSync } from "node:fs";
export default function(pi) {
  pi.registerTool({
    name: "schema_probe",
    label: "Schema probe",
    description: "Returns a constant for the codemode contract",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    exposure: "deferred",
    async execute() {
      appendFileSync(${JSON.stringify(workspace.markerPath)}, "called" + String.fromCharCode(10));
      return { content: [{ type: "text", text: "schema-probe-ok" }], details: {} };
    },
  });
}
`,
    );
    const offline = fauxProvider({ provider: "offline-schema", models: [{ id: "probe" }] });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(offline.provider.id, async () => ({ type: "api_key", key: "test-only" }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(offline.provider);
    const createRuntime = vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
    let session: AgentSession | undefined;
    try {
      session = kind === "child" ? await spawnChild(workspace) : await spawnReference(workspace);
      await session.setModel(offline.getModel());
      expect(callableOf(session)).toContain("schema_probe");
      const call = (args: string, id: string) =>
        fauxAssistantMessage(
          fauxToolCall("codemode", { code: "text(await tools.schema_probe(" + args + "))" }, { id }),
          {
            stopReason: "toolUse",
          },
        );
      offline.setResponses([
        call("{}", "invalid"),
        fauxAssistantMessage("first"),
        call('{text: "fixture"}', "valid"),
        fauxAssistantMessage("second"),
      ]);
      await session.prompt("Check invalid arguments");
      const invalid = session.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "invalid",
      );
      expect(invalid).toMatchObject({ isError: true });
      expect(JSON.stringify(invalid)).toMatch(/required|validation/i);
      expect(workspace.markers()).toEqual([]);
      await session.prompt("Check valid arguments");
      const valid = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "valid");
      expect(valid).toMatchObject({ isError: false });
      expect(JSON.stringify(valid)).toContain("schema-probe-ok");
      expect(workspace.markers()).toEqual(["called"]);
    } finally {
      if (session) await disposeChildSession(session);
      createRuntime.mockRestore();
    }
  });

  it("replacement-style defaultTools resolves the same in both sessions", async () => {
    const workspace = makeWorkspace("replacement");
    workspace.writeGlobalSettings({ defaultTools: ["read", "grep"] });
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(registryOf(child)).toEqual(registryOf(reference));
    expect(activeOf(child)).toEqual(activeOf(reference));
    expect(activeOf(child)).toEqual(["grep", "read"]);

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });

  it("-name modifiers remove tools in both sessions", async () => {
    const workspace = makeWorkspace("minus-write");
    workspace.writeGlobalSettings({ defaultTools: ["-write"] });
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(registryOf(child)).toEqual(registryOf(reference));
    expect(activeOf(child)).toEqual(activeOf(reference));
    expect(activeOf(child)).not.toContain("write");
    expect(activeOf(child)).toContain("read");

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });

  it("project settings override global with modifier semantics preserved", async () => {
    const workspace = makeWorkspace("project-over-global");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeProjectSettings({ defaultTools: ["-codemode"] });
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(activeOf(child)).toEqual(activeOf(reference));
    expect(activeOf(child)).not.toContain("codemode");
    expect(activeOf(child)).toContain("read");

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });

  it("settings-level built-in disable (-builtin:codemode) keeps codemode out of both registries", async () => {
    const workspace = makeWorkspace("builtin-disable");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"], extensions: ["-builtin:codemode"] });
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(registryOf(child)).toEqual(registryOf(reference));
    expect(registryOf(child)).not.toContain("codemode");

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });
});

describe("contract: implicit OFF and explicit frontmatter", () => {
  it("loadToolsImplicitly OFF with omitted frontmatter tools yields a tool-less child", async () => {
    contractStore.agent.loadToolsImplicitly = false;
    try {
      const workspace = makeWorkspace("implicit-off");
      const child = await spawnChild(workspace);

      expect(registryOf(child)).toEqual([]);
      expect(activeOf(child)).toEqual([]);
    } finally {
      contractStore.agent.loadToolsImplicitly = true;
    }
  });

  it("explicit frontmatter tools gate the registry exactly", async () => {
    owner.registry.registerAgents(
      new Map([
        [
          "contract-explicit",
          { name: "contract-explicit", description: "", systemPrompt: "", tools: ["read", "bash"] },
        ],
      ]),
    );
    const workspace = makeWorkspace("explicit-tools");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    const { session } = await createChildSession(owner, parentCtx(workspace.project), "contract-explicit", {
      pi: stubPi(),
      cwd: workspace.project,
    });

    expect(registryOf(session)).toEqual(["bash", "read"]);
    expect(activeOf(session)).toEqual(["bash", "read"]);

    await disposeChildSession(session);
  });

  it.each([true, false])(
    "validates the bound registry and extension aliases with project trust %s",
    async (trusted) => {
      const workspace = makeWorkspace("explicit-probe");
      workspace.writeGlobalSettings({ extensions: ["-builtin:codemode", "-builtin:tool-search", "-builtin:mcp"] });
      workspace.writeProbeExtension();
      const { session, warnings } = await createChildSession(owner, parentCtx(workspace.project), "contract-probe", {
        pi: stubPi(),
        projectTrusted: trusted,
        agentConfig: {
          name: "contract-probe",
          description: "",
          systemPrompt: "",
          tools: ["probe_hidden", "probe_late", "probe/*"],
        },
      });

      try {
        expect(registryOf(session)).toEqual(trusted ? ["probe_deferred", "probe_hidden", "probe_late"] : []);
        expect(activeOf(session)).toEqual(trusted ? ["probe_deferred", "probe_late"] : []);
        expect(callableOf(session)).toEqual(trusted ? ["probe_deferred", "probe_late"] : []);
        expect(warnings).toEqual(
          trusted
            ? []
            : [
                'extension "probe" is not loaded, "probe/*" will have no effect',
                'tool "probe_hidden" is not registered in the child session',
                'tool "probe_late" is not registered in the child session',
              ],
        );
      } finally {
        await disposeChildSession(session);
      }
    },
  );

  it("frontmatter extensions: false loads no built-in extensions", async () => {
    owner.registry.registerAgents(
      new Map([["contract-no-ext", { name: "contract-no-ext", description: "", systemPrompt: "", extensions: false }]]),
    );
    const workspace = makeWorkspace("extensions-false");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeProbeExtension();
    const { session } = await createChildSession(owner, parentCtx(workspace.project), "contract-no-ext", {
      pi: stubPi(),
      cwd: workspace.project,
    });

    expect(registryOf(session)).not.toContain("codemode");
    // The probe extension is a project extension: extensions: false skips it too.
    expect(registryOf(session)).not.toContain("probe_deferred");
    expect(workspace.probeCount()).toBe(0);

    await disposeChildSession(session);
  });

  it("frontmatter extensions: ['codemode'] selects the built-in by bare name", async () => {
    owner.registry.registerAgents(
      new Map([
        [
          "contract-only-codemode",
          { name: "contract-only-codemode", description: "", systemPrompt: "", extensions: ["codemode"] },
        ],
      ]),
    );
    const workspace = makeWorkspace("only-codemode");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeProbeExtension();
    const { session } = await createChildSession(owner, parentCtx(workspace.project), "contract-only-codemode", {
      pi: stubPi(),
      cwd: workspace.project,
    });

    expect(registryOf(session)).toContain("codemode");
    expect(registryOf(session)).not.toContain("probe_deferred");
    // The whitelist excludes the probe extension, so it never loads: the count
    // stays 0 across teardown (teardown-with-loaded-probe is pinned by the
    // +codemode and exclude_extensions cases above).
    expect(workspace.probeCount()).toBe(0);

    await disposeChildSession(session);
    expect(workspace.probeCount()).toBe(0);
  });

  it("frontmatter exclude_extensions: ['codemode'] deselects the built-in by bare name", async () => {
    owner.registry.registerAgents(
      new Map([
        [
          "contract-no-codemode",
          { name: "contract-no-codemode", description: "", systemPrompt: "", excludeExtensions: ["codemode"] },
        ],
      ]),
    );
    const workspace = makeWorkspace("exclude-codemode");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeProbeExtension();
    const { session } = await createChildSession(owner, parentCtx(workspace.project), "contract-no-codemode", {
      pi: stubPi(),
      cwd: workspace.project,
    });

    expect(registryOf(session)).not.toContain("codemode");
    expect(registryOf(session)).toContain("probe_deferred");

    await disposeChildSession(session);
    expect(workspace.probeCount()).toBe(0);
  });
});

describe("contract: child setup failure", () => {
  it.each(["before binding", "during handoff"] as const)("disposes the session when setup fails %s", async (stage) => {
    const workspace = makeWorkspace("setup-failure");
    const offline = fauxProvider({ provider: "offline-setup", models: [{ id: "setup-test" }] });
    const error = new Error("setup failed");
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const thinking =
      stage === "before binding"
        ? vi.spyOn(AgentSession.prototype, "setThinkingLevel").mockImplementation(() => {
            throw error;
          })
        : undefined;
    try {
      await expect(
        createChildSession(owner, parentCtx(workspace.project), "general-purpose", {
          pi: stubPi(),
          cwd: workspace.project,
          model: offline.getModel(),
          deferredDefaultThinking: stage === "before binding" ? "low" : undefined,
          onSessionCreated:
            stage === "during handoff"
              ? () => {
                  throw error;
                }
              : undefined,
        }),
      ).rejects.toBe(error);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      thinking?.mockRestore();
      dispose.mockRestore();
    }
  });
});

describe("contract: startup wildcard diagnostics", () => {
  function probeWorkspace(lateOnly = true) {
    const workspace = makeWorkspace("alias-probe");
    workspace.writeGlobalSettings({ extensions: ["-builtin:codemode", "-builtin:tool-search", "-builtin:mcp"] });
    workspace.writeProbeExtension(lateOnly);
    return workspace;
  }

  it.each(["loaded", "disabled", "untrusted"] as const)(
    "keeps the explicit registry gate for a late-only wildcard when the extension is %s",
    async (state) => {
      const workspace = probeWorkspace();
      const { session, warnings } = await createChildSession(owner, parentCtx(workspace.project), "contract-late", {
        pi: stubPi(),
        projectTrusted: state !== "untrusted",
        agentConfig: {
          name: "contract-late",
          description: "",
          systemPrompt: "",
          tools: ["read", "probe/*", "missing/all"],
          extensions: state === "disabled" ? false : undefined,
        },
      });

      try {
        expect(workspace.probeCount()).toBe(state === "loaded" ? 1 : 0);
        expect(rawRunnerOf(session)).toEqual(state === "loaded" ? ["probe_late"] : []);
        expect(registryOf(session)).toEqual(["read"]);
        expect(activeOf(session)).toEqual(["read"]);
        expect(warnings).toEqual([
          state === "loaded"
            ? 'extension "probe" is loaded but declares no tools before binding, "probe/*" will have no effect'
            : 'extension "probe" is not loaded, "probe/*" will have no effect',
          'extension "missing" is not loaded, "missing/all" will have no effect',
        ]);
      } finally {
        await disposeChildSession(session);
      }
    },
  );

  it.each([
    { label: "a late-only alias", lateOnly: true, excludeTools: ["probe/all"], active: ["probe_late", "read"] },
    { label: "a startup alias", lateOnly: false, excludeTools: ["probe/all"], active: ["probe_late", "read"] },
    { label: "a concrete late name", lateOnly: false, excludeTools: ["probe/all", "probe_late"], active: ["read"] },
  ])("applies exclusions for $label to the active tool set", async ({ lateOnly, excludeTools, active }) => {
    const workspace = probeWorkspace(lateOnly);
    workspace.writeProjectSettings({ defaultTools: lateOnly ? ["read"] : ["read", "probe_deferred", "probe_hidden"] });
    const { session, warnings } = await createChildSession(owner, parentCtx(workspace.project), "contract-late", {
      pi: stubPi(),
      agentConfig: { name: "contract-late", description: "", systemPrompt: "", excludeTools },
    });

    try {
      expect(activeOf(session)).toEqual(active);
      expect(registryOf(session)).toContain("probe_late");
      if (!lateOnly) expect(callableOf(session)).toContain("probe_deferred");
      expect(callableOf(session)).not.toContain("probe_hidden");
      expect(warnings).toEqual(
        lateOnly
          ? ['extension "probe" is loaded but declares no tools before binding, "probe/all" will have no effect']
          : [],
      );
    } finally {
      await disposeChildSession(session);
    }
  });

  it("lets a concrete late name through the registry gate and reaches the faux provider", async () => {
    const workspace = probeWorkspace();
    const offline = fauxProvider({ provider: "offline-alias", models: [{ id: "alias-test" }] });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(offline.provider.id, async () => ({ type: "api_key", key: "test-only" }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(offline.provider);
    offline.setResponses([fauxAssistantMessage("offline reply")]);
    const createRuntime = vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
    const notify = vi.fn();
    const ctx = asExtensionContext({ ...parentCtx(workspace.project), ui: { notify } });
    let child: AgentSession | undefined;
    try {
      const result = await runAgent(owner, ctx, "contract-late", "run offline", {
        pi: stubPi(),
        agentConfig: {
          name: "contract-late",
          description: "",
          systemPrompt: "",
          tools: ["probe/*", "probe_late"],
        },
        model: offline.getModel(),
        onSessionCreated(session) {
          child = session;
        },
      });

      expect(registryOf(result.session)).toEqual(["probe_late"]);
      expect(activeOf(result.session)).toEqual(["probe_late"]);
      expect(offline.state.callCount).toBe(1);
      expect(result.responseText).toBe("offline reply");
      expect(notify.mock.calls).toEqual([
        [
          '[pi-subagents-lite] extension "probe" is loaded but declares no tools before binding, "probe/*" will have no effect',
          "warning",
        ],
      ]);
    } finally {
      createRuntime.mockRestore();
      if (child) await disposeChildSession(child);
    }
  });
});

const CREATED = "subagents:child:session-created";
const BOUND = "subagents:child:bound";
/** Timeline marker for the instant the SDK's own bindExtensions() is invoked. */
const BIND = "child:bindExtensions";
/** Timeline marker for the first microtask after an emit. */
const MICROTASK = "microtask";
/** The parent session id parentCtx()'s session manager reports. */
const PARENT_ID = "session-1";

describe("contract: child session announced on the parent's event bus", () => {
  /**
   * Runs a child spawn with the instant the SDK's own `bindExtensions()` is
   * invoked recorded on the timeline. The real bind still runs untouched, the
   * wrapper only appends a marker, so the subscriber's entries are ordered
   * against the bind call itself and not only against what the bind later emits.
   */
  async function withRecordedBind<T>(workspace: Workspace, spawn: () => Promise<T>): Promise<T> {
    const real = AgentSession.prototype.bindExtensions;
    const recording = function (this: AgentSession, ...args: Parameters<typeof real>) {
      appendMarker(workspace, BIND);
      return real.apply(this, args);
    };
    AgentSession.prototype.bindExtensions = recording;
    try {
      return await spawn();
    } finally {
      AgentSession.prototype.bindExtensions = real;
    }
  }

  /** One timeline for both sides: the bus subscriber and the child's own extension. */
  function observeLifecycle(
    workspace: Workspace,
    options: { marksMicrotask?: boolean } = {},
  ): { events: EventBus; entries: () => Observed[] } {
    const events = createEventBus();
    for (const channel of [CREATED, BOUND]) {
      // Tab-separated: JSON.stringify escapes control characters, so no payload
      // value can produce a second tab. A space would split a payload whose
      // value contains one.
      events.on(channel, (data) => {
        fs.appendFileSync(workspace.timelinePath, `${channel}\t${JSON.stringify(data)}\n`);
        if (options.marksMicrotask && channel === CREATED) {
          queueMicrotask(() => appendMarker(workspace, MICROTASK));
        }
      });
    }
    return {
      events,
      /** Order comes from one file both writers append to synchronously. */
      entries(): Observed[] {
        return workspace.timeline().map((line) => {
          const [event, payload] = line.split("\t");
          return payload ? { event, data: JSON.parse(payload) } : { event };
        });
      },
    };
  }

  it("lands created before the child's bind is invoked, bound after it", async () => {
    const workspace = makeWorkspace("announcements");
    workspace.writeLifecycleProbe();
    const { events, entries } = observeLifecycle(workspace);

    const { session: child } = await withRecordedBind(workspace, () =>
      createChildSession(owner, parentCtx(workspace.project), "general-purpose", {
        pi: stubPi(events),
        cwd: workspace.project,
      }),
    );

    // The child's own session_start handler runs inside the bind, so `bound` is
    // ordered against the bind completing, not merely against it being entered.
    expect(entries()).toEqual([
      { event: CREATED, data: { sessionId: child.sessionId, parentSessionId: PARENT_ID } },
      { event: BIND },
      { event: "child:session_start" },
      { event: BOUND, data: { sessionId: child.sessionId, parentSessionId: PARENT_ID } },
    ]);

    await disposeChildSession(child);
  });

  it("emits created on the bind's own call stack, with no await in between", async () => {
    const workspace = makeWorkspace("announcements-call-stack");
    const { events, entries } = observeLifecycle(workspace, { marksMicrotask: true });

    const { session: child } = await withRecordedBind(workspace, () =>
      createChildSession(owner, parentCtx(workspace.project), "general-purpose", {
        pi: stubPi(events),
        cwd: workspace.project,
      }),
    );

    // The microtask queued inside the created emit gets the queue ahead of every
    // continuation the bind awaits, so it lands before the bind returns. An await
    // between the emit and the bind would run it before the BIND entry instead.
    expect(entries()).toEqual([
      { event: CREATED, data: { sessionId: child.sessionId, parentSessionId: PARENT_ID } },
      { event: BIND },
      { event: MICROTASK },
      { event: BOUND, data: { sessionId: child.sessionId, parentSessionId: PARENT_ID } },
    ]);

    await disposeChildSession(child);
  });
});

describe("contract: untrusted target prompt resources", () => {
  it("keeps target cwd and global resources while omitting both plugin and SDK project resources", async () => {
    const workspace = makeWorkspace("untrusted-resources");
    const agentDir = getAgentDir();
    const skill = (root: string, name: string, content: string) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${content}\n---\n${content}`);
    };
    fs.writeFileSync(path.join(workspace.project, "AGENTS.md"), "TARGET-CONTEXT");
    fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "GLOBAL-CONTEXT");
    skill(path.join(agentDir, "skills"), "global-skill", "GLOBAL-SKILL");
    skill(path.join(workspace.project, ".pi", "skills"), "target-skill", "TARGET-SKILL");
    skill(path.join(workspace.project, ".agents", "skills"), "ancestor-skill", "ANCESTOR-SKILL");
    workspace.writeProbeExtension();
    const type = "contract-scoped-resources";
    owner.registry.registerAgents(
      new Map([
        [
          type,
          {
            name: type,
            description: "Scoped resources",
            systemPrompt: "test prompt",
            includeContextFiles: true,
            preloadSkills: ["global-skill", "target-skill"],
            skills: ["global-skill", "ancestor-skill"],
          },
        ],
      ]),
    );
    for (const trusted of [true, false]) {
      const { session } = await createChildSession(owner, parentCtx(workspace.project), type, {
        pi: stubPi(),
        cwd: workspace.project,
        projectTrusted: trusted,
      });
      try {
        const prompt = session.systemPrompt;
        expect(session.sessionManager.getCwd()).toBe(workspace.project);
        expect(prompt).toContain("GLOBAL-CONTEXT");
        expect(prompt).toContain("GLOBAL-SKILL");
        for (const text of ["TARGET-CONTEXT", "TARGET-SKILL", "ANCESTOR-SKILL"]) {
          expect(prompt.includes(text), text).toBe(trusted);
        }
        expect(registryOf(session).includes("probe_deferred")).toBe(trusted);
      } finally {
        await disposeChildSession(session);
      }
    }
  });
});

describe("contract: spawn-bound MessageParent obeys frontmatter tool gating", () => {
  const messageParent = () => createParentMessageTool({ deliver: () => true, runId: () => "run-1" });

  async function childWith(name: string, frontmatter: Record<string, unknown> | null) {
    const type = frontmatter ? `contract-mp-${name}` : "general-purpose";
    if (frontmatter) {
      owner.registry.registerAgents(
        new Map([[type, { name: type, description: "", systemPrompt: "", ...frontmatter }]]),
      );
    }
    const workspace = makeWorkspace(`mp-${name}`);
    const { session } = await createChildSession(owner, parentCtx(workspace.project), type, {
      pi: stubPi(),
      cwd: workspace.project,
      customTools: [messageParent()],
    });
    return session;
  }

  async function expectGate(session: AgentSession, present: boolean) {
    try {
      for (const names of [registryOf(session), activeOf(session)]) {
        if (present) expect(names).toContain("MessageParent");
        else expect(names).not.toContain("MessageParent");
        for (const own of ["Agent", "MessageAgent", "StopAgent", "AgentStatus"]) expect(names).not.toContain(own);
      }
    } finally {
      await disposeChildSession(session);
    }
  }

  it("is present for silent frontmatter with implicit tool loading ON", async () => {
    await expectGate(await childWith("silent", null), true);
  });

  it("is absent for silent frontmatter with implicit tool loading OFF", async () => {
    contractStore.agent.loadToolsImplicitly = false;
    try {
      await expectGate(await childWith("implicit-off", null), false);
    } finally {
      contractStore.agent.loadToolsImplicitly = true;
    }
  });

  it("is absent for tools: false and for an explicit list without it", async () => {
    await expectGate(await childWith("false", { tools: false }), false);
    await expectGate(await childWith("list", { tools: ["read"] }), false);
  });

  it("is present for an explicit list naming it, and for tools: true", async () => {
    await expectGate(await childWith("named", { tools: ["read", "MessageParent"] }), true);
    await expectGate(await childWith("true", { tools: true }), true);
  });

  it("runs an explicitly named MessageParent from the SDK registry without a warning", async () => {
    const workspace = makeWorkspace("mp-offline-run");
    const deliver = vi.fn(() => true);
    const notify = vi.fn();
    const ctx = asExtensionContext({ ...parentCtx(workspace.project), ui: { notify } });
    let child: AgentSession | undefined;
    try {
      const result = await runAgent(owner, ctx, "contract-mp-run", "send progress", {
        pi: stubPi(),
        agentConfig: {
          name: "contract-mp-run",
          description: "",
          systemPrompt: "",
          tools: ["MessageParent"],
          extensions: false,
        },
        customTools: [createParentMessageTool({ deliver, runId: () => "run-1" })],
        model: {
          id: "test-model",
          name: "Offline test model",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "http://unused.invalid",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8_192,
        },
        onSessionCreated(session) {
          child = session;
          const replies = [
            assistantMessage({
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: "progress", name: "MessageParent", arguments: { message: " ready " } }],
            }),
            assistantMessage({ content: [{ type: "text", text: "finished" }] }),
          ];
          vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
          session.agent.streamFunction = () => {
            const reply = replies.shift();
            if (!reply || (reply.stopReason !== "toolUse" && reply.stopReason !== "stop")) {
              throw new Error("Unexpected model request");
            }
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "done", reason: reply.stopReason, message: reply });
            stream.end(reply);
            return stream;
          };
        },
      });

      expect(registryOf(result.session)).toEqual(["MessageParent"]);
      expect(activeOf(result.session)).toEqual(["MessageParent"]);
      expect(result.modelError).toBeUndefined();
      expect(result.responseText).toBe("finished");
      expect(deliver.mock.calls).toEqual([["ready"]]);
      expect(result.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
        toolName: "MessageParent",
        isError: false,
        content: [{ type: "text", text: "Submitted to the parent session." }],
      });
      expect(notify).not.toHaveBeenCalled();
    } finally {
      if (child) await disposeChildSession(child);
    }
  });

  it("warns for bare names missing from the SDK registry when MessageParent is not injected", async () => {
    const workspace = makeWorkspace("mp-not-injected");
    const { session, warnings } = await createChildSession(owner, parentCtx(workspace.project), "contract-mp-missing", {
      pi: stubPi(),
      agentConfig: {
        name: "contract-mp-missing",
        description: "",
        systemPrompt: "",
        tools: ["MessageParent", "missing_tool", "Agent"],
        extensions: false,
      },
    });

    try {
      expect(registryOf(session)).toEqual([]);
      expect(activeOf(session)).toEqual([]);
      expect(warnings).toEqual([
        'tool "MessageParent" is not registered in the child session',
        'tool "missing_tool" is not registered in the child session',
        'tool "Agent" is not registered in the child session',
      ]);
    } finally {
      await disposeChildSession(session);
    }
  });

  it("is absent for a registeredTools list without it, present when listed", async () => {
    await expectGate(await childWith("registered", { registeredTools: ["read"] }), false);
    await expectGate(await childWith("registered-named", { registeredTools: ["read", "MessageParent"] }), true);
  });
});

import { createParentMessageTool } from "../../src/agents/parent-message.js";
import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
