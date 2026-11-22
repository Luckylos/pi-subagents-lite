import { expect, it, vi } from "vite-plus/test";
import type { Component } from "@earendil-works/pi-tui";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit, parent, services } from "../../instance-fixtures.js";
import { runAgent } from "../../../src/agents/agent-runner.js";
import { getPiDefaultThinkingLevel, getPiModelThinkingLevels } from "../../../src/pi-settings.js";
import type { ThinkingChoice, ThinkingLevel } from "../../../src/types.js";
import { createMockCtx, type ComponentFactory } from "../../menu-test-helpers.js";
import { defaultModel, defaultModelRegistry } from "../../mock-utils.js";

vi.mock("../../../src/pi-settings.js", { spy: true });

const parentModel = { ...defaultModel()!, id: "parent", reasoning: true };
const registryParent = { ...parentModel, reasoning: false };
const configured = { ...parentModel, id: "configured" };
const configuredId = `${configured.provider}/${configured.id}`;
const parentId = `${parentModel.provider}/${parentModel.id}`;
const type = "general-purpose";

async function setup({
  available = [],
  hasParent = true,
  override = configuredId,
  parentThinking,
  piThinking,
  frontmatterThinking,
}: {
  available?: (typeof parentModel)[];
  hasParent?: boolean;
  override?: string;
  parentThinking?: ThinkingLevel;
  piThinking?: ThinkingLevel;
  frontmatterThinking?: ThinkingChoice;
} = {}) {
  vi.mocked(getPiDefaultThinkingLevel).mockReturnValue(piThinking);
  vi.mocked(getPiModelThinkingLevels).mockReturnValue({ [parentId]: "xhigh", [configuredId]: "low" });
  const fixture = parent();
  const custom = vi.fn<(factory: ComponentFactory) => Promise<unknown>>().mockResolvedValue(undefined);
  const ctx = createMockCtx([], [], [], {
    ui: { custom },
    modelRegistry: defaultModelRegistry({
      find: (provider: string, id: string) =>
        [configured, registryParent].find((m) => m.provider === provider && m.id === id),
      getAvailable: () => available,
    }),
  });
  const context = { ...ctx, hasUI: false, model: hasParent ? parentModel : undefined, thinkingLevel: parentThinking };
  await emit(fixture, "session_start", context);
  if (frontmatterThinking) {
    const config = fixture.owner.registry.getAgentConfig(type)!;
    fixture.owner.registry.registerAgents(new Map([[type, { ...config, thinkingLevel: frontmatterThinking }]]));
  }
  const { store } = services(fixture);
  store.mutate.session.setOverride("default", override);
  store.mutate.session.setOverride(type, override);

  const agents = fixture.api.commands.find((command) => command.name === "agents")!;
  const tool = fixture.api.tools.filter((tool) => tool.name === "Agent").at(-1)!;
  if (!("execute" in tool) || typeof tool.execute !== "function") throw new Error("Agent tool not registered");
  const execute = tool.execute;

  async function open(choices: string[]) {
    for (const choice of choices) custom.mockResolvedValueOnce(choice);
    let component: Component | undefined;
    custom.mockImplementationOnce(async (factory) => {
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      const tui = { terminal: { rows: 40 }, requestRender: vi.fn() };
      const result = await factory(tui, theme, undefined, () => {});
      if (!result || typeof result !== "object" || !("render" in result) || !("handleInput" in result)) {
        throw new Error("Expected interactive menu");
      }
      component = result as Component;
    });
    await agents.handler("", context);
    if (!component) throw new Error("Menu not opened");
    const menu = component;
    const text = () => menu.render(160).join("\n");
    const press = (...keys: string[]) => keys.forEach((key) => menu.handleInput!(key));
    return {
      text,
      press,
      selectRow(label: string) {
        for (let step = 0; step < 15; step++) {
          if (
            text()
              .split("\n")
              .some((line) => line.startsWith(`→ ${label} `))
          )
            return;
          press("j");
        }
        throw new Error(`Could not select ${label}`);
      },
    };
  }

  return {
    settings: () => open(["settings", "model"]),
    async wizard() {
      const menu = await open(["spawn", type, "preview"]);
      return {
        ...menu,
        pickModel(query: string) {
          menu.selectRow("Model");
          menu.press("\r", "\r", query, "\r");
        },
      };
    },
    agent: (params = {}) => execute("call", { prompt: "test", agent: type, ...params }, undefined, undefined, context),
    store,
    manager: services(fixture).manager,
    notify: context.ui.notify,
  };
}

it("explains the same parent fallback used by the registered Agent and Spawn wizard, and keeps the override clearable", async () => {
  const available = [registryParent];
  const app = await setup({ available });
  await expect(app.agent({ model: configuredId })).rejects.toThrow(`Model not found: ${configuredId}`);
  await app.agent();
  expect(vi.mocked(runAgent).mock.lastCall?.[4].model).toBe(parentModel);
  expect(vi.mocked(runAgent).mock.lastCall?.[4].thinkingLevel).toBe("high");
  const wizard = await app.wizard();
  expect(wizard.text()).toMatch(/Model\s+test\/parent/);
  expect(wizard.text()).toMatch(/Thinking level\s+high \(pi per-model\)/);
  wizard.selectRow("Model");
  expect(wizard.text()).toContain(
    `Configured model ${configuredId} is unavailable. Spawn uses parent model ${parentId}.`,
  );
  wizard.selectRow("Spawn");
  wizard.press("\r");
  await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
  expect(vi.mocked(runAgent).mock.lastCall?.[4].model).toBe(parentModel);
  expect(vi.mocked(runAgent).mock.lastCall?.[4].thinkingLevel).toBe("high");

  const menu = await app.settings();
  expect(menu.text()).toContain(`${configuredId} [session]`);
  expect(menu.text()).toMatch(/unavailable.*test\/parent/i);
  menu.press("j");
  expect(menu.text()).toMatch(/test\/configured\s+.*general-purpose\s+high \(pi per-model\) \[session\]/);
  expect(menu.text()).toMatch(/unavailable.*test\/parent/i);
  menu.press("\r", "j", "j", "\r");
  expect(menu.text()).toContain("Removes from the session");
  menu.press("\r");
  expect(app.store.sessionModelOverride(type)).toBeNull();
  expect(app.store.sessionDefaultModel).toBe(configuredId);

  // The parent is active even if an ID matching it is no longer selectable from the registry.
  available.length = 0;
  app.store.mutate.session.setOverride("default", parentId);
  const sameId = await app.wizard();
  sameId.selectRow("Model");
  expect(sameId.text()).toContain(`Configured model ${parentId} is unavailable. Spawn uses parent model ${parentId}.`);
  expect(sameId.text()).toMatch(/Thinking level\s+high \(pi per-model\)/);

  sameId.pickModel("inherits parent");
  expect(sameId.text()).toMatch(/Model\s+\(inherits parent\)/);
  expect(sameId.text()).not.toMatch(/unavailable/i);
  expect(sameId.text()).toMatch(/Thinking level\s+high \(pi per-model\)/);

  app.store.mutate.agent.clearDefaultModel("session");
  const inherited = await app.wizard();
  inherited.selectRow("Model");
  expect(inherited.text()).toMatch(/Model\s+test\/parent/);
  expect(inherited.text()).not.toMatch(/unavailable/i);
  expect(inherited.text()).toMatch(/Thinking level\s+high \(pi per-model\)/);
});

it.each([configuredId, "test/unknown"])("does not name a parent fallback for %s when none is set", async (override) => {
  const app = await setup({ hasParent: false, override });
  await app.agent();
  expect(vi.mocked(runAgent).mock.lastCall?.[4].model).toBeUndefined();
  const menu = await app.settings();
  expect(menu.text()).toMatch(/unavailable.*no parent model/i);
  expect(menu.text()).not.toContain(parentId);
  menu.press("j");
  expect(menu.text()).toMatch(/general-purpose\s+Pending \[session\]/);
  expect(menu.text()).toMatch(/unavailable.*no parent model/i);
  menu.press("\r", "j", "j", "\r", "\r");
  expect(app.store.sessionModelOverride(type)).toBeNull();
  expect(app.store.sessionDefaultModel).toBe(override);

  const wizard = await app.wizard();
  expect(wizard.text()).toMatch(/Model\s+Pi selects on spawn/);
  expect(wizard.text()).toMatch(/Thinking level\s+Pending$/m);
  wizard.press("j");
  expect(wizard.text()).toContain(`Configured model ${override} is unavailable.`);
});

it("keeps pure inheritance pending until the real Pi SDK chooses an offline model and clamps Thinking", async () => {
  const app = await setup({ hasParent: false, override: "" });
  const wizard = await app.wizard();
  const settings = await app.settings();
  wizard.press("\r");
  await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
  const { model, thinkingLevel } = vi.mocked(runAgent).mock.lastCall![4];
  expect(model).toBeUndefined();
  expect(thinkingLevel).toBeUndefined();

  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
    await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  vi.stubEnv("PI_OFFLINE", "1");
  const cwd = mkdtempSync(join(tmpdir(), "subagent-thinking-"));
  try {
    const offline = fauxProvider({ provider: "offline-preview-test", models: [{ id: "no-reasoning" }] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    // Supply an offline catalog. The SDK still chooses and clamps its initial model.
    vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue(offline.models);
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      modelRuntime: runtime,
      model,
      thinkingLevel,
    });
    try {
      expect(session.model?.provider).toBe(offline.provider.id);
      expect(session.model?.id).toBe(offline.getModel().id);
      expect(session.thinkingLevel).toBe("off");
      expect(offline.state.callCount).toBe(0);
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }

  expect(settings.text()).toMatch(/general-purpose\s+Pending$/m);
  expect(settings.text()).toContain("Pi selects on spawn");
  expect(settings.text()).not.toContain("Unavailable");
  expect(wizard.text()).toMatch(/Model\s+Pi selects on spawn/);
  expect(wizard.text()).toMatch(/Thinking level\s+Pending$/m);
});

it.each([
  { frontmatterThinking: "parent", parentThinking: "high", piThinking: "low", label: "high (parent)" },
  { frontmatterThinking: "max", piThinking: "low", label: "max (frontmatter)" },
  { frontmatterThinking: "parent", piThinking: "low", label: "low (pi default)" },
] as const)("shows $label as a preference while Pi has yet to select a model", async (entry) => {
  const app = await setup({ ...entry, hasParent: false });
  const settings = await app.settings();
  expect(settings.text()).toContain(`Pending · ${entry.label} [session]`);
  const wizard = await app.wizard();
  expect(wizard.text()).toContain(`Pending · ${entry.label}`);
});

it.each([
  { keys: ["j", "j", "j", "j"], effective: "high", preference: "high (explicit)", requested: "high" },
  { keys: ["k", "k"], effective: "high (parent)", preference: "xhigh (parent)", requested: "xhigh" },
])("keeps a picked Thinking value $preference pending when switching to Pi's model choice", async (entry) => {
  const app = await setup({
    hasParent: false,
    available: [configured],
    override: "test/unknown",
    parentThinking: "xhigh",
  });
  const wizard = await app.wizard();
  wizard.pickModel("configured");
  expect(wizard.text()).toMatch(/Model\s+test\/configured/);
  expect(wizard.text()).toMatch(/Thinking level\s+low \(pi per-model\)/);
  wizard.selectRow("Thinking level");
  wizard.press("\r", ...entry.keys, "\r");
  expect(wizard.text().match(/Thinking level +(.+)$/m)?.[1]).toBe(entry.effective);

  wizard.pickModel("inherits parent");
  expect(wizard.text()).toMatch(/Model\s+Pi selects on spawn/);
  expect(wizard.text()).toMatch(/Thinking level\s+Pending · /);
  expect(wizard.text()).toContain(`Pending · ${entry.preference}`);

  wizard.pickModel("configured");
  expect(wizard.text()).toMatch(/Model\s+test\/configured/);
  expect(wizard.text().match(/Thinking level +(.+)$/m)?.[1]).toBe(entry.effective);

  wizard.pickModel("inherits parent");
  wizard.selectRow("Spawn");
  wizard.press("\r");
  await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
  expect(vi.mocked(runAgent).mock.lastCall?.[4]).toMatchObject({
    model: undefined,
    thinkingLevel: entry.requested,
  });
});

it("clears an explicit Thinking pick while Pi's model choice is pending", async () => {
  const app = await setup({ hasParent: false, available: [configured], piThinking: "low" });
  const wizard = await app.wizard();
  wizard.pickModel("configured");
  wizard.selectRow("Thinking level");
  wizard.press("\r", "j", "j", "j", "j", "\r");
  expect(wizard.text()).toMatch(/Thinking level\s+high$/m);

  wizard.pickModel("inherits parent");
  expect(wizard.text()).toMatch(/Model\s+Pi selects on spawn/);
  expect(wizard.text()).toMatch(/Thinking level\s+Pending · high \(explicit\)$/m);
  wizard.selectRow("Thinking level");
  wizard.press("\r");
  expect(wizard.text()).toContain("pi default");
  expect(wizard.text()).not.toMatch(/\b(?:Off|Low|High)\b/);
  wizard.press("j", "\r");
  expect(wizard.text()).toMatch(/Thinking level\s+Pending · low \(pi default\)$/m);

  wizard.pickModel("configured");
  expect(wizard.text()).toMatch(/Thinking level\s+low \(pi per-model\)$/m);
  wizard.pickModel("inherits parent");
  expect(wizard.text()).toMatch(/Thinking level\s+Pending · low \(pi default\)$/m);

  wizard.selectRow("Spawn");
  wizard.press("\r");
  await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
  expect(vi.mocked(runAgent).mock.lastCall?.[4]).toMatchObject({
    model: undefined,
    thinkingLevel: undefined,
    deferredDefaultThinking: undefined,
  });
  expect(app.manager.listAgents()[0]?.display.invocation).toMatchObject({
    modelName: undefined,
    thinkingLevel: undefined,
  });
});

it("clears stale Thinking after an explicit model becomes unavailable and permits another choice", async () => {
  const available = [configured];
  const app = await setup({ hasParent: false, available, override: "" });
  const wizard = await app.wizard();
  wizard.pickModel("configured");
  expect(wizard.text()).toContain("low (pi per-model)");

  available.length = 0;
  wizard.selectRow("Spawn");
  wizard.press("\r");
  await vi.waitFor(() => expect(app.notify).toHaveBeenCalledWith(`Model not found: ${configuredId}`, "error"));
  expect(runAgent).not.toHaveBeenCalled();
  expect(wizard.text()).toMatch(/Model\s+test\/configured/);
  expect(wizard.text()).toMatch(/Thinking level +$/m);

  wizard.pickModel("inherits parent");
  expect(wizard.text()).toMatch(/Model\s+Pi selects on spawn/);
  expect(wizard.text()).toMatch(/Thinking level\s+Pending$/m);
});

it("does not warn when the configured model is available", async () => {
  const app = await setup({ available: [registryParent, configured] });
  await app.agent();
  expect(vi.mocked(runAgent).mock.lastCall?.[4].model).toBe(configured);
  const menu = await app.settings();
  expect(menu.text()).not.toMatch(/unavailable|test\/parent/i);
  menu.press("j");
  expect(menu.text()).toMatch(/general-purpose\s+low \(pi per-model\) \[session\]/);
  expect(menu.text()).not.toMatch(/unavailable|test\/parent/i);
});

it("warns when a configured ID matches the unavailable parent, but not when the same ID is inherited", async () => {
  const app = await setup({ override: parentId });
  await app.agent();
  expect(vi.mocked(runAgent).mock.lastCall?.[4].model).toBe(parentModel);
  const wizard = await app.wizard();
  expect(wizard.text()).toMatch(/Model\s+test\/parent/);
  expect(wizard.text()).toMatch(/Thinking level\s+high \(pi per-model\)/);

  const configuredMenu = await app.settings();
  expect(configuredMenu.text()).toMatch(/unavailable.*test\/parent/i);
  configuredMenu.press("j");
  expect(configuredMenu.text()).toMatch(/general-purpose\s+high \(pi per-model\) \[session\]/);
  expect(configuredMenu.text()).toMatch(/unavailable.*test\/parent/i);

  // An empty override retains the editable row but does not win model resolution.
  app.store.mutate.agent.clearDefaultModel("session");
  app.store.mutate.session.setOverride(type, "");
  const inheritedMenu = await app.settings();
  expect(inheritedMenu.text()).toContain("(inherits parent)");
  expect(inheritedMenu.text()).not.toMatch(/unavailable/i);
  inheritedMenu.press("j");
  expect(inheritedMenu.text()).toMatch(/test\/parent\s+.*general-purpose\s+high \(pi per-model\)/);
  expect(inheritedMenu.text()).not.toMatch(/unavailable|\[session\]/i);
});
