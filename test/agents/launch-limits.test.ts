import { createMockSession, defaultAgentConfig, makeMockModel, mockModules, resetMocks } from "./agent-runner-mocks.js";
import { expect, it, vi } from "vite-plus/test";
import type { createAgentSession, ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { executeMessageAgentTool } from "../../src/agents/tool-execution.js";
import { ConfigStore } from "../../src/config/config-store.js";
import { registerTools } from "../../src/registration.js";
import { createExtensionOwner } from "../../src/shell.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import { createMockExtensionAPI, fakeCtx } from "../fixtures.js";
import { asCommandContext, asExtensionAPI, asTui } from "../pi-boundaries.js";

// Drive the registered command through Pi's own list and numeric input components.
function wizardUI(turns?: string, tokens?: string): ExtensionUIContext {
  const ui = fakeCtx().ui;
  const { theme } = ui;
  vi.mocked(theme.fg).mockImplementation((_color, text) => text);
  vi.mocked(theme.bold).mockImplementation((text) => text);
  let launched = false;
  const custom: ExtensionUIContext["custom"] = (factory) =>
    new Promise((resolve, reject) => {
      Promise.resolve(
        factory(asTui({ requestRender: vi.fn() }), theme, getKeybindings() as KeybindingsManager, resolve),
      )
        .then((component: Component) => {
          const press = (...keys: string[]) => keys.forEach((key) => component.handleInput?.(key));
          const select = (label: string) => {
            for (let i = 0; i < 15; i++) {
              if (component.render(100).some((line) => line.startsWith(`→ ${label}`))) return;
              press("\x1b[B");
            }
            throw new Error(`Missing row: ${label}`);
          };
          const edit = (label: string, value: string) => {
            select(label);
            press("\r", "\x05", "\x15");
            if (value) press(value);
            press("\r");
          };
          switch (component.render(100)[2]?.trim()) {
            case "Agents":
              return launched ? press("\x1b") : press("\x1b[B", "\r");
            case "Select Agent Type":
              return press("test-agent", "\r");
            case "Agent Prompt":
              return press("initial", "\r");
            case "Spawn Options":
              if (turns !== undefined) edit("Max turns", turns);
              if (tokens !== undefined) edit("Max tokens", tokens);
              edit("Grace turns", "1");
              select("Spawn");
              launched = true;
              return press("\r");
            default:
              throw new Error("Unexpected wizard screen");
          }
        })
        .catch(reject);
    });
  return { ...ui, custom };
}

it.each([
  { name: "unlimited", typeCaps: true, turns: "unlimited", tokens: "", soft: undefined, cap: 8192 },
  { name: "clear turns only", typeCaps: true, turns: "", soft: undefined, cap: 400 },
  { name: "unlimited tokens only", typeCaps: true, tokens: "unlimited", soft: 2, cap: 8192 },
  { name: "frontmatter defaults", typeCaps: true, soft: 2, cap: 400 },
  { name: "explicit numbers", typeCaps: true, turns: "3", tokens: "700", soft: 3, cap: 700 },
  { name: "global turn default", typeCaps: false, globalTurns: 4, soft: 4, cap: 8192 },
  { name: "omitted limits", typeCaps: false, soft: undefined, cap: 8192 },
  { name: "SDK model, explicit cap", sdkModel: true, typeCaps: true, tokens: "700", soft: 2, cap: 700 },
  { name: "SDK model, unlimited tokens", sdkModel: true, typeCaps: true, tokens: "unlimited", soft: 2, cap: 8192 },
  { name: "SDK model, frontmatter defaults", sdkModel: true, typeCaps: true, soft: 2, cap: 400 },
  { name: "SDK model, omitted limits", sdkModel: true, typeCaps: false, soft: undefined, cap: 8192 },
])(
  "/agents $name: initial and MessageAgent apply the same limits",
  async ({ turns, tokens, typeCaps, globalTurns, soft, cap, sdkModel }) => {
    resetMocks();
    const settings = {
      getModelThinkingLevel: () => undefined,
      getAllModelThinkingLevels: () => ({}),
      getDefaultThinkingLevel: () => undefined,
    };
    mockModules.mockSettingsManagerCreate.mockReturnValue(settings);
    const api = createMockExtensionAPI();
    api.api.exec.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const pi = asExtensionAPI(api.api);
    const owner = createExtensionOwner(pi);
    const ctx = asCommandContext(fakeCtx({ ui: wizardUI(turns, tokens), ...(sdkModel ? { model: undefined } : {}) }));
    owner.sessionCtx = ctx;
    const config = { ...defaultAgentConfig, ...(typeCaps ? { maxTurns: 2, maxTokens: 400 } : {}) };
    owner.registry.registerAgents(new Map([[config.name, config]]));
    mockModules.mockGetAgentConfig.mockReturnValue(config);
    owner.store = new ConfigStore({
      load: () => ({ global: { agent: { defaultMaxTurns: globalTurns } }, project: null, projectStatus: "absent" }),
      updateLayer: vi.fn(),
      saveGlobal: vi.fn(),
      saveProject: vi.fn(),
    });
    const manager = (owner.manager = new AgentManager(owner));
    owner.coordinator = new SpawnCoordinator(owner, manager);
    registerTools(pi, owner);

    const fallbackModel = makeMockModel({ provider: "anthropic", api: "anthropic-messages", maxTokens: 8192 });
    const session = { ...createMockSession(), model: fallbackModel, clearQueue: vi.fn() };
    session.getActiveToolNames.mockReturnValue([]);
    mockModules.mockCreateAgentSession.mockImplementation(async (options: Parameters<typeof createAgentSession>[0]) => {
      session.model = options?.model ?? fallbackModel;
      return { session, extensionsResult: {} };
    });
    const observations: { prompt: string; steers: number[]; aborts: number[]; cap: unknown }[] = [];
    session.prompt.mockImplementation(async (prompt) => {
      const payload = { max_tokens: session.model.maxTokens };
      const request = (await session.agent.onPayload?.(payload, session.model)) ?? payload;
      const steers: number[] = [],
        aborts: number[] = [];
      let turn = 0;
      session.steer.mockImplementation(async () => {
        steers.push(turn);
      });
      session.abort.mockImplementation(async () => {
        aborts.push(turn);
      });
      for (turn = 1; turn <= 10 && !aborts.length; turn++) {
        session._getListeners().forEach((listener) => listener({ type: "turn_end" }));
      }
      observations.push({ prompt, steers: [...steers], aborts: [...aborts], cap: request.max_tokens });
    });

    try {
      await api.commands.find((command) => command.name === "agents")!.handler("", ctx);
      await vi.waitFor(() => expect(manager.listAgents()).toHaveLength(1));
      const [record] = manager.listAgents();
      const first = await record.execution.promise;
      expect(record.error).toBeUndefined();
      const message = await executeMessageAgentTool(
        owner,
        "message",
        { agent_id: record.id, message: "continued" },
        undefined,
        undefined,
        ctx,
      );
      expect(message.details.delivery).toBe("continuation");
      const second = await record.execution.promise;
      expect(mockModules.mockCreateAgentSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ model: sdkModel ? undefined : ctx.model }),
      );
      const limits = { steers: soft ? [soft] : [], aborts: soft ? [soft + 1] : [], cap };
      expect(observations).toEqual([
        { prompt: "initial", ...limits },
        { prompt: "continued", ...limits },
      ]);
      expect(record.display.invocation?.maxTurns).toBe(soft);
      expect([first?.stats.maxTurns, second?.stats.maxTurns, record.stats.maxTurns]).toEqual([soft, soft, soft]);
      expect(second?.stats.turnCount).toBe(2 * (soft ? soft + 1 : 10));
    } finally {
      await manager.dispose();
    }
  },
);
