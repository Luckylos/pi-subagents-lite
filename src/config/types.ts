import type { ThinkingChoice } from "../types.ts";
import type { SystemPromptMode } from "../agents/types.ts";

/** Where model/thinking appears in the widget in full mode: 'header' (1st line) or 'metadata' (2nd line). */
export type ModelThinkingPlacement = "header" | "metadata";

export interface KnownAgentSettings {
  default: string | null;
  forceBackground: boolean;
  graceTurns?: number;
  showCost?: boolean;
  /** Stop an agent when a single tool call runs longer than this (minutes). 0 disables. Default: 45. */
  toolTimeoutMinutes?: number;
  /** Stop an agent showing no activity (tool events, streamed text) for this long (minutes). 0 disables. Default: 45. */
  idleTimeoutMinutes?: number;
  widgetMaxLines?: number;
  widgetMaxLinesCompact?: number;
  widgetCompact?: boolean;
  /** Show background completion cards in the TUI. Default: true. */
  showCompletionCards?: boolean;
  widgetShortcut?: boolean;
  widgetShowModel?: boolean;
  widgetShowThinking?: boolean;
  widgetNavHint?: boolean;
  /** System prompt mode: replace (default), inherit parent, or custom file. */
  systemPromptMode?: SystemPromptMode;
  /** Whether to include AGENTS.md context files in the subagent system prompt. Default: true. */
  includeContextFiles?: boolean;
  /** Default thinking level for spawned agents. Undefined = inherit from agent config; `parent` follows the parent session. */
  defaultThinking?: ThinkingChoice;
  /** Default max turns for spawned agents. Undefined = unlimited. */
  defaultMaxTurns?: number;
  /** Global default for skills loading when agent doesn't explicitly set skills. true (default) or false. */
  loadSkillsImplicitly?: boolean;
  /** Global default for extensions loading when agent doesn't explicitly set extensions. true (default) or false. */
  loadExtensionsImplicitly?: boolean;
  /** Global default for tools: ON delegates tool setup to pi (defaultTools applies); OFF starts new agents with no tools when frontmatter omits tool fields. Default true. */
  loadToolsImplicitly?: boolean;
  /** When true, skip built-in default agents (general-purpose, Explore) at registration. */
  disableDefaultAgents?: boolean;
  /** When true, use strict-mode schema for the Agent tool. Costs more tokens due to nullable field encoding. */
  agentToolStrictMode?: boolean;
  /** When true, the Agent tool's `agent` param description lists each visible agent's description. Default: false. */
  exposeDescriptions?: boolean;
  /** Whether to show toolUses count in widget stats line. Default: false. */
  showTools?: boolean;
  /** Whether to show turn count in widget stats line. Default: true. */
  showTurns?: boolean;
  /** Whether to show input tokens in widget stats line. Default: true. */
  showInput?: boolean;
  /** Whether to show output tokens in widget stats line. Default: true. */
  showOutput?: boolean;
  /** Whether to show context percent and compactions in widget stats line. Default: true. */
  showContext?: boolean;
  /** Whether to show elapsed time in widget stats line. Default: true. */
  showTime?: boolean;
  /** Whether to stream the agent transcript to the output file. Default: false. */
  outputTranscript?: boolean;
  /** Whether background agents get the MessageParent tool. Default: true. */
  parentMessages?: boolean;
  /** When true, agent colors (spinner, status icons, picker bullets) are enabled. Default: true. */
  showAgentColors?: boolean;

  /** When > 0, thinking deltas stream to output file during message_update events. Default: 0 (disabled). */
  outputThinkingBufferSize?: number;
  /** Minutes to retain finished agents in the widget. Default: 1. */
  finishedRetentionMinutes?: number;
  /** Max settled agents the AgentStatus tool lists. 0 or absent = auto: 2 × default concurrency. */
  agentStatusLimit?: number;
  /** How to display the model label: short ID or full name. Default: 'name'. */
  modelDisplayStyle?: "id" | "name";
  /** Where model/thinking appears in full mode: 'header' (1st line) or 'metadata' (2nd line). Default: 'header'. */
  modelThinkingPlacement?: ModelThinkingPlacement;
  /** Status bar format: 'full' (default) or 'compact'. */
  statusBarFormat?: "full" | "compact";
}

export type AgentSettings = KnownAgentSettings & Record<string, string | null | undefined | boolean | number>;

/** Raw concurrency section as stored in a config file. */
export interface RawConcurrency {
  default?: number;
  providers?: Record<string, number>;
  models?: Record<string, number>;
}

/** Raw config file contents: only the keys that file carries. */
export interface RawConfig {
  agent?: Record<string, unknown>;
  concurrency?: RawConcurrency;
}

/** Shape of the effective subagents-lite.json configuration. */
export interface SubagentsConfig {
  agent: AgentSettings;
  concurrency: {
    default: number;
    providers?: Record<string, number>;
    models?: Record<string, number>;
  };
}
