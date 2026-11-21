import type { ExtensionOwner } from "../../shell.ts";
/**
 * menu-debug.ts — Debug menu concern.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Items: Agent types (notify), Agent briefing (send to LLM).
 * Actions execute on select; Escape closes the menu.
 *
 * Exports:
 *   - showDebugMenu: agent types listing, agent briefing
 *
 * Private helpers (single-consumer, co-located):
 *   - showAgentTypes: list available agent types and their configs
 *   - handleAgentBriefing: send agent types/capabilities info to LLM
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";

import { plainText } from "../sanitize.ts";
import { resolveSessionToolOptions, resolveVisibleTools } from "../../agents/agent-types.ts";
import type { AgentConfig } from "../../agents/types.ts";
import { buildSelectListTheme } from "./helpers.ts";
import { SettingsListWrapper } from "./wrappers/settings-list.ts";
import { getCoordinator, getPiInstance, getStore } from "../../shell.ts";
import type { SpawnCoordinator } from "../../spawn/spawn-coordinator.ts";
import { handleRestartLastAgents } from "../../agents/restart-last-agents.ts";

// Pi's unconfigured defaultTools fallback, pinned by the child-session contract tests.
const PI_DEFAULT_ACTIVE_TOOLS = ["read", "bash", "edit", "write"];
const EMPTY_TOOL_REGISTRY = "(none). The tool registry is empty.";
const LAUNCH_TOOL_RESOLUTION = "Extension and per-spawn tools are resolved at launch.";

function formatTools(tools: string[]): string {
  return tools.length > 0 ? tools.join(", ") : "(none)";
}

function formatToolCandidates(tools: string[]): string {
  return `${formatTools(tools)} (startup candidates for this directory).`;
}

function formatToolAllowlist(entries: string[], names: string[]): string {
  // Only wildcard aliases can yield more names once the child loads extensions.
  const aliases = entries.filter((entry) => /^[^/]*\/(?:\*|all)$/.test(entry));
  if (names.length === 0 && aliases.length === 0) return EMPTY_TOOL_REGISTRY;

  const parts = [formatToolCandidates(names)];
  if (names.length > 0) parts.push(`Known allowlist names for registration and activation are ${formatTools(names)}.`);
  if (aliases.length > 0) parts.push(`The allowlist includes extension aliases ${formatTools(aliases)}.`);
  return [...parts, LAUNCH_TOOL_RESOLUTION].join(" ");
}

/** One trust-scoped defaults read per action, only if a type delegates tool selection to Pi. */
function createToolDisplay(owner: ExtensionOwner, ctx: ExtensionCommandContext): (config: AgentConfig) => string {
  const loadToolsImplicitly = getStore(owner).agent.loadToolsImplicitly;
  let defaultTools: string[] | undefined;

  return (config) => {
    const { tools, noTools } = resolveSessionToolOptions({
      registeredTools: config.registeredTools,
      tools: config.tools,
      loadToolsImplicitly,
    });
    if (noTools || config.tools === false) return EMPTY_TOOL_REGISTRY;
    if (Array.isArray(config.tools)) return formatToolAllowlist(config.tools, tools ?? []);

    // Without a child loader or binding, unknown names may never register and
    // extension aliases cannot be expanded. Report candidates and retain the rules.
    const candidates =
      tools ??
      (defaultTools ??=
        SettingsManager.create(ctx.cwd, getAgentDir(), {
          projectTrusted: ctx.isProjectTrusted?.() ?? true,
        }).getDefaultTools() ?? PI_DEFAULT_ACTIVE_TOOLS);
    const activeTools = [...new Set(candidates)];
    const visible = resolveVisibleTools({ activeTools, tools: config.tools, excludeTools: config.excludeTools });
    const parts = [formatToolCandidates(visible ?? activeTools)];

    if (tools) {
      parts.push(
        tools.length > 0
          ? `The registry allows ${formatTools(tools)} and tools from loaded extensions.`
          : "The registry allows tools from loaded extensions.",
      );
    } else {
      parts.push("Pi defaults select startup tools from the available registry.");
    }
    if (config.excludeTools?.length) {
      parts.push(`The activation filter excludes ${formatTools(config.excludeTools)}.`);
    }
    return [...parts, LAUNCH_TOOL_RESOLUTION].join(" ");
  };
}

async function showAgentTypes(owner: ExtensionOwner, ctx: ExtensionCommandContext): Promise<void> {
  const types = owner.registry.getAllTypes();
  if (types.length === 0) {
    ctx.ui.notify("No agent types available", "info");
    return;
  }

  const displayTools = createToolDisplay(owner, ctx);
  const lines: string[] = ["Available agent types:\n"];
  for (const name of types) {
    const cfg = owner.registry.getAgentConfig(name);
    if (!cfg) continue;
    const hidden = cfg.hidden === true ? " [HIDDEN]" : "";
    const model = cfg.model ? `  Model: ${cfg.model}` : "";
    const tools = `  Tools: ${displayTools(cfg)}`;
    const source = cfg.source ? `  Source: ${cfg.source}` : "";
    lines.push(`  ${name}${hidden}`);
    lines.push(`    ${cfg.description}`);
    if (model) lines.push(model);
    lines.push(tools);
    if (source) lines.push(source);
    lines.push("");
  }

  ctx.ui.notify(plainText(lines.join("\n")), "info");
}

async function handleAgentBriefing(owner: ExtensionOwner, ctx: ExtensionCommandContext): Promise<void> {
  const types = owner.registry.getAvailableTypes();
  const agents = types.map((t) => ({ name: t, config: owner.registry.getAgentConfig(t) }));
  const displayTools = createToolDisplay(owner, ctx);
  const lines: string[] = [
    "# Agent Types and Capabilities\n",
    "The following agent types are available. Use the `agent` parameter to select one.\n",
  ];

  for (const { name, config } of agents) {
    if (!config) continue;
    lines.push(`## ${config.displayName ?? name}`);
    lines.push(config.description);
    lines.push("");

    lines.push(`**Tools:** ${displayTools(config)}`);
    if (config.model) {
      lines.push(`**Default model:** ${config.model}`);
    }
    if (config.maxTurns) {
      lines.push(`**Max turns:** ${config.maxTurns}`);
    }
    lines.push("");
  }

  // Parameter descriptions
  lines.push("## Agent Tool Parameters\n");
  lines.push("| Parameter | Description |");
  lines.push("|-----------|-------------|");
  lines.push("| `prompt` | The task for the agent (required) |");
  lines.push("| `description` | Optional one-line summary of what the agent should do |");
  lines.push("| `agent` | Which agent type to use (default: general-purpose) |");
  lines.push(
    "| `run_in_background` | When `true`, result is auto-delivered — do NOT poll. Continue working while waiting. |",
  );
  lines.push("| `worktree_path` | Optional path inside any git repository on disk. See below for details. |");
  lines.push("");

  // Usage guidelines
  lines.push("## Usage Guidelines\n");
  lines.push("- Agents start fresh with their config — they do NOT inherit the parent conversation");
  lines.push("- For parallel tasks, spawn multiple `run_in_background: true` agents in one turn");
  lines.push("  → Results are auto-delivered — do NOT poll, the result will arrive when ready");
  lines.push("");
  lines.push("## `worktree_path` Parameter\n");
  lines.push(
    "Use `worktree_path` to run a subagent in a directory inside any git repository on disk: a worktree of the parent's repo, its main checkout, or a different repo entirely.",
  );
  lines.push("");
  lines.push("- **Optional.** Omit to run the subagent in the parent's working directory (default behavior).");
  lines.push("- **Must be a path** inside a git repository (any repo on disk). Not a non-git directory.");
  lines.push("- **Relative paths** are resolved against the parent's working directory.");
  lines.push(
    "- **On failure** the validator returns a specific reason (e.g., 'not inside a git repository', 'path does not exist') — use this to self-correct.",
  );
  lines.push(
    "- **Agent type discovery:** The target's `.pi/agents/` directory is scanned for agent types when this param is set, so repo-local types become available to that spawn.",
  );
  lines.push(
    "- **Cross-repo trust:** a target in a different git repo is gated by pi's trust framework. An untrusted target still spawns, but its project resources (.pi/ settings, extensions, skills, prompts, themes, system prompt files, .agents/skills) are ignored and its `.pi/agents` types are not discovered.",
  );
  getPiInstance(owner).sendUserMessage(lines.join("\n"));
  ctx.ui.notify("Agent briefing sent to LLM", "info");
}

async function handleRestartLastAgentsMenu(
  owner: ExtensionOwner,
  ctx: ExtensionCommandContext,
  coordinator: SpawnCoordinator | null,
): Promise<void> {
  if (!coordinator?.isCurrentParent(ctx)) return;
  const { restarted, skipped } = await handleRestartLastAgents(owner, ctx, coordinator);
  if (!coordinator.isCurrentParent(ctx)) return;

  if (restarted.length === 0 && skipped.length === 0) {
    ctx.ui.notify("No recent Agent tool calls found in session history.", "info");
    return;
  }

  const lines: string[] = [];
  if (restarted.length > 0) {
    lines.push(`Restarted ${restarted.length} agent(s):`);
    for (const r of restarted) lines.push(`  • ${r}`);
  }
  if (skipped.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Skipped ${skipped.length} agent(s):`);
    for (const s of skipped) lines.push(`  • ${s}`);
  }

  ctx.ui.notify(plainText(lines.join("\n")), "info");
}

export async function showDebugMenu(
  owner: ExtensionOwner,
  ctx: ExtensionCommandContext,
  coordinator = getCoordinator(owner),
): Promise<void> {
  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const items: SelectItem[] = [
      { value: "agent-types", label: "Agent types", description: "List available agent types and their configs" },
      {
        value: "agent-briefing",
        label: "Agent briefing",
        description: "Send agent types/capabilities info to LLM (Optional, if having issues)",
      },
      {
        value: "restart-last-agents",
        label: "Restart last agents",
        description: "Replay the most recent Agent tool calls from session history",
      },
    ];

    const selectList = new SelectList(items, 10, buildSelectListTheme(theme));
    selectList.onSelect = async (item) => {
      if (item.value === "agent-types") {
        await showAgentTypes(owner, ctx);
      } else if (item.value === "agent-briefing") {
        await handleAgentBriefing(owner, ctx);
      } else if (item.value === "restart-last-agents") {
        await handleRestartLastAgentsMenu(owner, ctx, coordinator).catch((err: unknown) => {
          if (!coordinator?.isCurrentParent(ctx)) return;
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(plainText(`Failed to restart agents: ${message}`), "error");
        });
      }
    };
    return new SettingsListWrapper(selectList, { title: "Debug", theme, onCancel: () => done(undefined) });
  });
}
