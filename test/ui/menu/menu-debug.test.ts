/**
 * menu-debug.test.ts — Tests for showDebugMenu using SelectList.
 *
 * Uses ctx.ui.custom (not ctx.ui.select).
 * The debug menu is a SelectList with 2 items that execute actions on select.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";

import type { AgentConfig } from "../../../src/agents/types.js";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem, SelectListTheme } from "@earendil-works/pi-tui";
import type { SettingsListWrapperOptions } from "../../../src/ui/menu/wrappers/settings-list.js";

// Capture SettingsManager creation so the menu's defaultTools read is
// test-controllable without touching real pi settings files.
const codingAgentMock = vi.hoisted(() => ({
  SettingsManager: {
    create: vi.fn<(...args: Parameters<typeof SettingsManager.create>) => Pick<SettingsManager, "getDefaultTools">>(
      () => ({ getDefaultTools: () => ["read", "bash", "edit", "write"] }),
    ),
  },
  getAgentDir: vi.fn(() => "/home/test/.pi/agent"),
}));

vi.mock("@earendil-works/pi-coding-agent", () => codingAgentMock);

// Capture SelectList constructor calls
let selectListCalls: Array<{
  items: SelectItem[];
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
}> = [];

let settingsListWrapperCalls: Array<{
  component: Component;
  options: SettingsListWrapperOptions;
}> = [];

vi.mock("@earendil-works/pi-tui", () => {
  return {
    SettingsList: class MockSettingsList {
      constructor() {}
    },
    SelectList: class MockSelectList {
      items: SelectItem[];
      maxVisible: number;
      onSelect?: (item: SelectItem) => void;
      onCancel?: () => void;
      constructor(items: SelectItem[], maxVisible: number, _theme: SelectListTheme) {
        this.items = items;
        this.maxVisible = maxVisible;
        selectListCalls.push(this);
      }
      render() {
        return [];
      }
      handleInput() {}
    },
    Input: class MockInput {
      value = "";
      onSubmit?: (v: string) => void;
      onEscape?: () => void;
      setValue(v: string) {
        this.value = v;
      }
      getValue() {
        return this.value;
      }
    },
  };
});

// Capture SettingsListWrapper usage
vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(component: Component, options: SettingsListWrapperOptions) {
      settingsListWrapperCalls.push({ component, options });
    }
    render() {
      return [];
    }
    handleInput() {}
    invalidate() {}
  },
}));

// Keep the shared registry spies while exercising the real runner tool rules.
const registryMock = await import("../../../src/agents/agent-types.js");
vi.doMock("../../../src/agents/agent-types.js", async (original) => ({
  ...(await original<typeof import("../../../src/agents/agent-types.js")>()),
  ...registryMock,
}));
const { showDebugMenu } = await import("../../../src/ui/menu/menu-debug.js");

/**
 * Assert a getAgentConfig fixture against the real AgentConfig at the mocked
 * module boundary (one cast, pi-boundaries style). Needed for the single
 * fixture that models `source` as a project-local agent path: the debug menu
 * interpolates cfg.source verbatim, but src's AgentConfig.source is
 * "project" | "global", so no typed fixture can carry the path without a
 * boundary assertion.
 */
function asAgentConfig<S extends object>(fake: S): AgentConfig & S {
  return fake as AgentConfig & S;
}

afterEach(() => resetConfig());

describe("showDebugMenu — SelectList migration", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    vi.mocked(owner.registry.getAllTypes).mockReturnValue([]);
    vi.mocked(owner.registry.getAvailableTypes).mockReturnValue([]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation(() => undefined);
  });

  it("sanitizes debug display copies while retaining the raw model briefing", async () => {
    const raw = "A\u009b?1049hB\x1b]0;hidden\x07C";
    const config: AgentConfig = {
      name: raw,
      displayName: raw,
      description: raw,
      model: raw,
      registeredTools: [raw],
      systemPrompt: "",
    };
    vi.mocked(owner.registry.getAllTypes).mockReturnValue([raw]);
    vi.mocked(owner.registry.getAvailableTypes).mockReturnValue([raw]);
    vi.mocked(owner.registry.getAgentConfig).mockReturnValue(config);
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    await selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Available agent types:\n\n  ABC\n    ABC\n  Model: ABC\n  Tools: ABC (startup candidates for this directory). The registry allows ABC and tools from loaded extensions. Extension and per-spawn tools are resolved at launch.\n",
      "info",
    );
    await selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockModules.mockPiInstance.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining(raw));
    expect(config.description).toBe(raw);
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("creates a SelectList with 2 items", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    expect(selectListCalls.length).toBe(1);
    expect(selectListCalls[0].items).toHaveLength(3);
    expect(selectListCalls[0].items[0].value).toBe("agent-types");
    expect(selectListCalls[0].items[1].value).toBe("agent-briefing");
    expect(selectListCalls[0].items[2].value).toBe("restart-last-agents");
  });

  it("wraps SelectList in SettingsListWrapper with title 'Debug'", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    expect(settingsListWrapperCalls.length).toBe(1);
    expect(settingsListWrapperCalls[0].options.title).toBe("Debug");
  });
});

describe("showDebugMenu — agent types action (SelectList)", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    codingAgentMock.SettingsManager.create.mockReturnValue({
      getDefaultTools: () => ["read", "bash", "edit", "write"],
    });
  });

  it("shows 'No agent types available' when getAllTypes returns empty", async () => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue([]);
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    // Simulate selecting "agent-types"
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No agent types available"), "info");
    // Empty branch opens no further UI: only the debug menu's custom call
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("lists each agent type with its description", async () => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["general-purpose", "Explore"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name, description: "General-purpose agent", systemPrompt: "" };
      if (name === "Explore") return { name, description: "Explore agent", systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    // The notification text we show the user is the observable outcome.
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("general-purpose"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("General-purpose agent"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Explore"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Explore agent"), "info");
  });

  it("marks hidden types with [HIDDEN]", async () => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["secret-agent"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation((name: string) => {
      if (name === "secret-agent") return { name, description: "Hidden agent", hidden: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("[HIDDEN]"), "info");
  });

  it("shows model when config has one", async () => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["test-agent"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation(() => ({
      name: "test-agent",
      description: "Test agent",
      model: "claude-sonnet-4-20250514",
      systemPrompt: "",
    }));
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Model: claude-sonnet-4-20250514"), "info");
  });

  it("shows explicit registeredTools when present", async () => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["tool-agent"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation(() => ({
      name: "tool-agent",
      description: "Agent with tools",
      registeredTools: ["file_read", "file_write"],
      systemPrompt: "",
    }));
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Tools: file_read, file_write (startup candidates for this directory)."),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("The registry allows file_read, file_write and tools from loaded extensions."),
      "info",
    );
  });

  it("shows pi's resolved defaultTools when registeredTools is absent", async () => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["default-agent"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation(() => ({
      name: "default-agent",
      description: "Default agent",
      systemPrompt: "",
    }));
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tools: read, bash, edit, write"), "info");
    // The generic "all built-in tools" placeholder is gone.
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("all built-in tools"), "info");
  });

  it("reads defaultTools from a SettingsManager over the menu cwd and agent dir", async () => {
    codingAgentMock.SettingsManager.create.mockReturnValue({ getDefaultTools: () => ["read", "bash", "grep"] });
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["general-purpose"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation(() => ({
      name: "general-purpose",
      description: "General-purpose agent",
      systemPrompt: "",
    }));
    const ctx = { ...createMockCtx(), cwd: "/repo" };
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    // Same manager acquisition as the spawn path: SettingsManager over cwd + agent dir.
    expect(codingAgentMock.SettingsManager.create).toHaveBeenCalledWith("/repo", "/home/test/.pi/agent", {
      projectTrusted: true,
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tools: read, bash, grep"), "info");
  });

  it("shows the distinction between an empty default activation and an empty registry", async () => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["tool-agent"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation(() => ({
      name: "tool-agent",
      description: "Agent with no default tools",
      systemPrompt: "",
    }));
    codingAgentMock.SettingsManager.create.mockReturnValue({ getDefaultTools: () => [] });
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    await selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Tools: (none) (startup candidates for this directory). Pi defaults select startup tools from the available registry.",
      ),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Extension and per-spawn tools are resolved at launch."),
      "info",
    );
  });

  it("shows pi's fallback set when defaultTools is unconfigured and tool loading is implicit", async () => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["silent-agent"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation(() => ({
      name: "silent-agent",
      description: "Agent with silent frontmatter",
      systemPrompt: "",
    }));
    codingAgentMock.SettingsManager.create.mockReturnValue({ getDefaultTools: () => undefined });
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    // The delegated child starts with pi's DEFAULT_TOOL_NAMES here, not "(none)".
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("read, bash, edit, write"), "info");
  });

  it("shows '(none)' for a silent agent when defaultTools is unconfigured and implicit loading is off", async () => {
    mockModules.mockConfig.agent.loadToolsImplicitly = false;
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["silent-agent"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation(() => ({
      name: "silent-agent",
      description: "Agent with silent frontmatter",
      systemPrompt: "",
    }));
    codingAgentMock.SettingsManager.create.mockReturnValue({ getDefaultTools: () => undefined });
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Tools: (none). The tool registry is empty."),
      "info",
    );
    expect(codingAgentMock.SettingsManager.create).not.toHaveBeenCalled();
  });

  it.each([
    { tools: false },
    { tools: [] },
    { tools: ["Agent"] },
    { tools: ["plugin/Agent", "plugin/none"] },
  ] satisfies Pick<AgentConfig, "tools">[])("shows an empty registry for explicit tools $tools", async ({ tools }) => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["no-tools"]);
    vi.mocked(owner.registry.getAgentConfig).mockReturnValue({
      name: "no-tools",
      description: "Agent with tools explicitly disabled",
      registeredTools: ["read"],
      tools,
      systemPrompt: "",
    });
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    await selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Tools: (none). The tool registry is empty."),
      "info",
    );
    expect(codingAgentMock.SettingsManager.create).not.toHaveBeenCalled();
  });

  it("shows the explicit PowerShell candidate without a contradictory launch warning", async () => {
    const { createPowerShellTool } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
    const { resolveVisibleTools } = await import("../../../src/agents/agent-types.js");
    const ctx = createMockCtx();
    const tools = ["powershell"];
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["shell-agent"]);
    vi.mocked(owner.registry.getAgentConfig).mockReturnValue({
      name: "shell-agent",
      description: "Agent with PowerShell",
      tools,
      systemPrompt: "",
    });
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Tools: powershell (startup candidates"),
      "info",
    );

    const notify = vi.fn();
    const powershell = createPowerShellTool(ctx.cwd).name;
    expect(
      resolveVisibleTools({ activeTools: [powershell], registeredToolNames: [powershell], tools, notify }),
    ).toEqual(tools);
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips types where getAgentConfig returns undefined", async () => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["known", "unknown"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation((name: string) => {
      if (name === "known") return { name, description: "Known agent", systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("known"), "info");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("unknown"), "info");
  });

  it("shows source when present", async () => {
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["ext-agent"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation(() =>
      asAgentConfig({
        name: "ext-agent",
        description: "Extension agent",
        systemPrompt: "",
        source: ".pi/agents/ext-agent.md",
      }),
    );
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Source: .pi/agents/ext-agent.md"), "info");
  });
});

describe("showDebugMenu — agent briefing action (SelectList)", () => {
  let mockSendUserMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    mockSendUserMessage = vi.fn();
    mockModules.mockPiInstance.sendUserMessage = mockSendUserMessage;
    codingAgentMock.SettingsManager.create.mockReturnValue({
      getDefaultTools: () => ["read", "bash", "edit", "write"],
    });
    vi.mocked(owner.registry.getAvailableTypes).mockReturnValue(["general-purpose", "Explore"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          name,
          displayName: "General Purpose",
          description: "General-purpose agent",
          registeredTools: ["file_read", "file_write"],
          model: "claude-sonnet-4-20250514",
          maxTurns: 50,
          systemPrompt: "",
        };
      if (name === "Explore")
        return {
          name,
          description: "Explore agent",
          systemPrompt: "",
        };
      return undefined;
    });
  });

  it("sends briefing to LLM via sendUserMessage", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("includes agent type headings in the briefing", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    // The briefing message sent to the LLM is the observable outcome.
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("General Purpose"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Explore"));
  });

  it("includes tool and model info when present", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Tools:** file_read, file_write"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("**Default model:** claude-sonnet-4-20250514"),
    );
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Max turns:** 50"));
  });

  it("includes the parameters table with all required parameters", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("prompt"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("description"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("agent"));
    expect(mockSendUserMessage).not.toHaveBeenCalledWith(expect.stringContaining("| `thinking` |"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("run_in_background"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("worktree_path"));
  });
  it("always includes a Tools line, with pi's default set when registeredTools is absent", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Tools:** file_read, file_write"));
    // Explore has no explicit registeredTools: pi's defaultTools still renders.
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Tools:** read, bash, edit, write"));
  });

  it("shows '(none)' for an empty Pi default selection in the briefing", async () => {
    codingAgentMock.SettingsManager.create.mockReturnValue({ getDefaultTools: () => [] });
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Tools:** (none)"));
  });

  it("shows the activation filter separately from legacy registered names", async () => {
    vi.mocked(owner.registry.getAvailableTypes).mockReturnValue(["configured"]);
    vi.mocked(owner.registry.getAgentConfig).mockReturnValue({
      name: "configured",
      description: "Agent with separate registration and activation",
      registeredTools: ["read", "write"],
      excludeTools: ["write", "plugin/*"],
      systemPrompt: "",
    });
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    await selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("**Tools:** read (startup candidates for this directory)."),
    );
    expect(mockSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("The registry allows read, write and tools from loaded extensions."),
    );
    expect(mockSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        "The activation filter excludes write, plugin/*. Extension and per-spawn tools are resolved at launch.",
      ),
    );
    expect(codingAgentMock.SettingsManager.create).not.toHaveBeenCalled();
  });

  it("shows unresolved extension aliases and gives the tool allowlist precedence over exclusions", async () => {
    mockModules.mockConfig.agent.loadToolsImplicitly = false;
    vi.mocked(owner.registry.getAvailableTypes).mockReturnValue(["configured"]);
    vi.mocked(owner.registry.getAgentConfig).mockReturnValue({
      name: "configured",
      description: "Agent with an allowlist",
      tools: [
        "read",
        "Agent",
        "plugin/Agent",
        "plugin/search",
        "plugin/*",
        "other/all",
        "skipped/none",
        "MessageParent",
      ],
      excludeTools: ["read"],
      systemPrompt: "",
    });
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    await selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("**Tools:** read, search, MessageParent (startup candidates for this directory)."),
    );
    expect(mockSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        "Known allowlist names for registration and activation are read, search, MessageParent. The allowlist includes extension aliases plugin/*, other/all.",
      ),
    );
    expect(codingAgentMock.SettingsManager.create).not.toHaveBeenCalled();
  });

  it.each([
    { selection: { registeredTools: [] }, rule: "The registry allows tools from loaded extensions." },
    {
      selection: { tools: ["Agent", "plugin/*"] },
      rule: "The allowlist includes extension aliases plugin/*.",
    },
  ] satisfies { selection: Partial<AgentConfig>; rule: string }[])(
    "keeps extension tools possible when no candidate names are known for $selection",
    async ({ selection, rule }) => {
      vi.mocked(owner.registry.getAvailableTypes).mockReturnValue(["configured"]);
      vi.mocked(owner.registry.getAgentConfig).mockReturnValue({
        name: "configured",
        description: "Agent whose tools can come from extensions",
        systemPrompt: "",
        ...selection,
      });
      const ctx = createMockCtx();
      await showDebugMenu(owner, ctx);
      await selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
      expect(mockSendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          `**Tools:** (none) (startup candidates for this directory). ${rule} Extension and per-spawn tools are resolved at launch.`,
        ),
      );
      expect(codingAgentMock.SettingsManager.create).not.toHaveBeenCalled();
    },
  );

  it("reads Pi defaults once per action with current cwd trust, including an explicit standard set", async () => {
    const { SettingsManager: PiSettingsManager } = await vi.importActual<
      typeof import("@earendil-works/pi-coding-agent")
    >("@earendil-works/pi-coding-agent");
    const readSettings = vi.fn((scope: "global" | "project") =>
      scope === "global" ? '{"defaultTools":["read","grep","Agent"]}' : '{"defaultTools":["write","ls"]}',
    );
    codingAgentMock.SettingsManager.create.mockImplementation((_cwd, _agentDir, options) =>
      PiSettingsManager.fromStorage(
        {
          withLock: (scope, read) => {
            read(readSettings(scope));
          },
        },
        options,
      ),
    );
    vi.mocked(owner.registry.getAllTypes).mockReturnValue(["standard", "delegated"]);
    vi.mocked(owner.registry.getAvailableTypes).mockReturnValue(["standard", "delegated"]);
    vi.mocked(owner.registry.getAgentConfig).mockImplementation((name) => ({
      name,
      description: "Agent using Pi startup defaults",
      tools: name === "standard" ? true : undefined,
      excludeTools: ["plugin/grep", "ls"],
      systemPrompt: "",
    }));
    const isProjectTrusted = vi.fn(() => true);
    const ctx = { ...createMockCtx(), cwd: "/repo", isProjectTrusted };
    await showDebugMenu(owner, ctx);
    await selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Tools: write (startup candidates for this directory)."),
      "info",
    );
    expect(codingAgentMock.SettingsManager.create).toHaveBeenCalledTimes(1);
    expect(readSettings.mock.calls).toEqual([["global"], ["project"]]);

    readSettings.mockClear();
    isProjectTrusted.mockReturnValue(false);
    mockModules.mockConfig.agent.loadToolsImplicitly = false;
    await selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(codingAgentMock.SettingsManager.create).toHaveBeenLastCalledWith("/repo", "/home/test/.pi/agent", {
      projectTrusted: false,
    });
    expect(codingAgentMock.SettingsManager.create).toHaveBeenCalledTimes(2);
    expect(readSettings.mock.calls).toEqual([["global"]]);
    expect(mockSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("**Tools:** read (startup candidates for this directory)."),
    );
    expect(mockSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("**Tools:** (none). The tool registry is empty."),
    );
  });

  it("notifies the user after sending the briefing", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("includes worktree_path usage guidelines", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("worktree_path"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("any git repository"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Relative paths"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining(".pi/agents/"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("trust"));
  });

  it("includes usage guidelines for background agents", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("run_in_background"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("do NOT poll"));
  });
});

describe("showDebugMenu — restart last agents action (SelectList)", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
  });

  it("has a restart-last-agents menu item as the third option", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(owner, ctx);
    expect(selectListCalls[0].items[2].value).toBe("restart-last-agents");
    expect(selectListCalls[0].items[2].label).toBe("Restart last agents");
  });

  it("notifies when no Agent tool calls exist in session history", async () => {
    const ctx = createMockCtx();
    // Mock sessionManager.getEntries to return empty
    ctx.sessionManager = { ...ctx.sessionManager, getEntries: vi.fn(() => []) };
    await showDebugMenu(owner, ctx);
    await selectListCalls[0].onSelect!({ value: "restart-last-agents", label: "Restart last agents" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No recent Agent tool calls found"), "info");
  });
});

import { createTestOwner } from "../../owner-fixtures.js";
const owner = await createTestOwner();
