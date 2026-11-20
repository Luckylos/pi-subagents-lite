import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { SystemPromptMode } from "../agents/types.ts";
import type { AgentSettings, KnownAgentSettings, ModelThinkingPlacement, SubagentsConfig } from "./types.ts";
import type { ThinkingChoice } from "../types.ts";
import { CONFIGURED_THINKING_CHOICES } from "../models/thinking-resolution.ts";

/** Legacy keys removed silently from both loaded and merged settings. */
export const LEGACY_AGENT_KEYS = new Set(["finishedEvictTurns"]);

/** Default number of grace turns before an agent is force-stopped. */
export const DEFAULT_GRACE_TURNS = 6;
/** Default watchdog timeout in minutes. Zero disables a check. */
export const DEFAULT_WATCHDOG_TIMEOUT_MINUTES = 45;
export const DEFAULT_MAX_WIDGET_LINES = 12;
export const DEFAULT_FINISHED_RETENTION_MINUTES = 1;
/** Minimum finished retention in minutes. */
export const MIN_FINISHED_RETENTION_MINUTES = 1 / 60;

/** One known key's runtime rule plus its human-readable expected shape. */
export interface KeySpec {
  schema: TSchema;
  expected: string;
}

const MODEL_KEY: KeySpec = { schema: Type.Union([Type.String(), Type.Null()]), expected: "string or null" };
const BOOL: KeySpec = { schema: Type.Boolean(), expected: "boolean" };
export const NUM: KeySpec = { schema: Type.Number(), expected: "number" };
const SYSTEM_PROMPT_MODE: KeySpec = {
  schema: Type.Union([Type.Literal("replace"), Type.Literal("inherit"), Type.Literal("custom")]),
  expected: '"replace" | "inherit" | "custom"',
};
const THINKING: KeySpec = {
  schema: Type.Union(CONFIGURED_THINKING_CHOICES.map((choice) => Type.Literal(choice))),
  expected:
    CONFIGURED_THINKING_CHOICES.map((choice) => JSON.stringify(choice)).join(" | ") + " (follow the parent session)",
};
const MODEL_DISPLAY: KeySpec = {
  schema: Type.Union([Type.Literal("id"), Type.Literal("name")]),
  expected: '"id" | "name"',
};
const THINKING_PLACEMENT: KeySpec = {
  schema: Type.Union([Type.Literal("header"), Type.Literal("metadata")]),
  expected: '"header" | "metadata"',
};
const STATUS_BAR: KeySpec = {
  schema: Type.Union([Type.Literal("full"), Type.Literal("compact")]),
  expected: '"full" | "compact"',
};

/** Runtime schema for every known agent key. Unknown keys are per-type model keys. */
interface AgentKeySpec<Value> extends KeySpec {
  defaultValue?: Value;
  /** Defaults used only by the resolved view leave the merged raw key absent. */
  bakeDefault?: false;
  modelFamily?: true;
}

type AgentKeySpecs = {
  readonly [Key in keyof KnownAgentSettings]-?: AgentKeySpec<KnownAgentSettings[Key]> &
    (undefined extends KnownAgentSettings[Key] ? unknown : { defaultValue: KnownAgentSettings[Key] });
};

const AGENT_KEY_SPECS = {
  default: { ...MODEL_KEY, defaultValue: null, modelFamily: true },
  forceBackground: { ...BOOL, defaultValue: false },
  graceTurns: { ...NUM, defaultValue: DEFAULT_GRACE_TURNS },
  toolTimeoutMinutes: { ...NUM, defaultValue: DEFAULT_WATCHDOG_TIMEOUT_MINUTES },
  idleTimeoutMinutes: { ...NUM, defaultValue: DEFAULT_WATCHDOG_TIMEOUT_MINUTES },
  showCost: { ...BOOL, defaultValue: false },
  showTools: { ...BOOL, defaultValue: false },
  showTurns: { ...BOOL, defaultValue: true },
  showInput: { ...BOOL, defaultValue: true },
  showOutput: { ...BOOL, defaultValue: true },
  showContext: { ...BOOL, defaultValue: true },
  showTime: { ...BOOL, defaultValue: true },
  widgetMaxLines: { ...NUM, defaultValue: DEFAULT_MAX_WIDGET_LINES },
  widgetMaxLinesCompact: NUM,
  widgetCompact: { ...BOOL, defaultValue: false },
  showCompletionCards: { ...BOOL, defaultValue: true },
  widgetShortcut: { ...BOOL, defaultValue: false },
  widgetShowModel: { ...BOOL, defaultValue: true },
  widgetShowThinking: { ...BOOL, defaultValue: true },
  widgetNavHint: { ...BOOL, defaultValue: true },
  systemPromptMode: { ...SYSTEM_PROMPT_MODE, defaultValue: "replace" },
  includeContextFiles: { ...BOOL, defaultValue: true },
  defaultThinking: { ...THINKING, modelFamily: true },
  defaultMaxTurns: { ...NUM, modelFamily: true },
  loadSkillsImplicitly: { ...BOOL, defaultValue: true, bakeDefault: false },
  loadExtensionsImplicitly: { ...BOOL, defaultValue: true, bakeDefault: false },
  loadToolsImplicitly: { ...BOOL, defaultValue: true, bakeDefault: false },
  disableDefaultAgents: { ...BOOL, defaultValue: false },
  agentToolStrictMode: { ...BOOL, defaultValue: false },
  exposeDescriptions: { ...BOOL, defaultValue: false },
  outputThinkingBufferSize: { ...NUM, defaultValue: 0, bakeDefault: false },
  finishedRetentionMinutes: { ...NUM, defaultValue: DEFAULT_FINISHED_RETENTION_MINUTES },
  agentStatusLimit: { ...NUM, defaultValue: 0 },
  modelDisplayStyle: { ...MODEL_DISPLAY, defaultValue: "name" },
  modelThinkingPlacement: { ...THINKING_PLACEMENT, defaultValue: "header" },
  statusBarFormat: { ...STATUS_BAR, defaultValue: "full" },
  outputTranscript: { ...BOOL, defaultValue: false },
  parentMessages: { ...BOOL, defaultValue: true },
  showAgentColors: { ...BOOL, defaultValue: true },
} satisfies AgentKeySpecs;

const knownSpecs: AgentKeySpecs = AGENT_KEY_SPECS;

export const DEFAULT_AGENT: AgentSettings = {
  ...Object.fromEntries(
    Object.entries(knownSpecs)
      .filter(([, spec]) => spec.defaultValue !== undefined && spec.bakeDefault !== false)
      .map(([key, spec]) => [key, spec.defaultValue]),
  ),
  default: AGENT_KEY_SPECS.default.defaultValue,
  forceBackground: AGENT_KEY_SPECS.forceBackground.defaultValue,
};

/** Unknown keys belong to the dynamic per-type model namespace. */
export function agentKeySpec(key: string): KeySpec {
  return isKnownAgentKey(key) ? AGENT_KEY_SPECS[key] : MODEL_KEY;
}

function isKnownAgentKey(key: string): key is keyof KnownAgentSettings {
  return Object.hasOwn(AGENT_KEY_SPECS, key);
}

/** Project files and model clearing use the same model-setting classification (ADR-0008). */
export function isAgentModelKey(key: string): boolean {
  return !isKnownAgentKey(key) || knownSpecs[key].modelFamily === true;
}

function normalizeSystemPromptMode(mode: SystemPromptMode | undefined): SystemPromptMode {
  return mode !== undefined && Check(SYSTEM_PROMPT_MODE.schema, mode)
    ? mode
    : AGENT_KEY_SPECS.systemPromptMode.defaultValue;
}

export function normalizeFinishedRetention(minutes = AGENT_KEY_SPECS.finishedRetentionMinutes.defaultValue): number {
  return Math.max(MIN_FINISHED_RETENTION_MINUTES, minutes);
}

/**
 * Stored form of agentStatusLimit: an explicit value ≥ 1 passes through;
 * anything below 1 (or unset) becomes 0, the auto marker — the effective
 * limit then derives as 2 × default concurrency at read time.
 */
export function canonicalAgentStatusLimit(raw: number | undefined): number {
  return raw != null && raw >= 1 ? raw : AGENT_KEY_SPECS.agentStatusLimit.defaultValue;
}

export function defaultCompactLines(fullLines: number): number {
  return Math.floor(fullLines / 2);
}

/** Menu writes clamp watchdog values. File validation accepts negative numbers. */
export function normalizeWatchdogMinutes(minutes: number): number {
  return Math.max(0, minutes);
}

export interface ResolvedAgentSettings {
  /** null = inherit parent. Kept nullable to preserve resolveModel's null-skip. */
  readonly defaultModel: string | null;
  readonly forceBackground: boolean;
  readonly showCost: boolean;
  readonly graceTurns: number;
  readonly widgetMaxLines: number;
  readonly widgetMaxLinesCompact: number;
  readonly widgetCompact: boolean;
  readonly showCompletionCards: boolean;
  readonly widgetShortcut: boolean;
  readonly widgetShowModel: boolean;
  readonly widgetShowThinking: boolean;
  readonly widgetNavHint: boolean;

  /** System prompt mode: replace (default), inherit parent, or custom file. */
  readonly systemPromptMode: SystemPromptMode;
  /** Whether to include AGENTS.md context files in the subagent system prompt. */
  readonly includeContextFiles: boolean;
  /** Default thinking level for spawned agents. Undefined = inherit from agent config. */
  readonly defaultThinking: ThinkingChoice | undefined;
  /** Default max turns for spawned agents. Undefined = unlimited. */
  readonly defaultMaxTurns: number | undefined;
  /** Global default for skills loading: true (load all) or false (none). */
  readonly loadSkillsImplicitly: boolean;
  /** Global default for extensions loading: true (load all) or false (none). */
  readonly loadExtensionsImplicitly: boolean;
  /** Global default for tools: true delegates tool setup to pi, false starts tool-less when frontmatter omits tool fields. */
  readonly loadToolsImplicitly: boolean;
  /** Whether to skip built-in default agents at registration. */
  readonly disableDefaultAgents: boolean;
  /** Whether to use strict-mode schema for the Agent tool. Costs more tokens. */
  readonly agentToolStrictMode: boolean;
  /** Whether the Agent tool's `agent` param description lists each visible agent's description. */
  readonly exposeDescriptions: boolean;
  /** Whether to show toolUses count in widget stats line. */
  readonly showTools: boolean;
  /** Whether to show turn count in widget stats line. */
  readonly showTurns: boolean;
  /** Whether to show input tokens in widget stats line. */
  readonly showInput: boolean;
  /** Whether to show output tokens in widget stats line. */
  readonly showOutput: boolean;
  /** Whether to show context percent and compactions in widget stats line. */
  readonly showContext: boolean;
  /** Whether to show elapsed time in widget stats line. */
  readonly showTime: boolean;
  /** Buffer size for streaming thinking blocks to output file. 0 = disabled. */
  readonly outputThinkingBufferSize: number;
  /** Minutes a finished agent stays visible in the widget after completion. */
  readonly finishedRetentionMinutes: number;
  /** Max settled agents the AgentStatus tool lists. Auto default: 2 × configured default concurrency. */
  readonly agentStatusLimit: number;
  /** Model display format: 'id' (short) or 'name' (full). */
  readonly modelDisplayStyle: "id" | "name";
  /** Model/thinking placement in full mode: 'header' (1st line) or 'metadata' (2nd line). */
  readonly modelThinkingPlacement: ModelThinkingPlacement;
  /** Status bar format: 'full' (default) or 'compact'. */
  readonly statusBarFormat: "full" | "compact";
  /** Stop an agent when a single tool call runs longer than this (minutes). 0 disables. */
  readonly toolTimeoutMinutes: number;
  /** Stop an agent showing no activity (tool events, streamed text) for this long (minutes). 0 disables. */
  readonly idleTimeoutMinutes: number;
  /** Whether to stream the agent transcript to the output file. Default: false. */
  readonly outputTranscript: boolean;
  /** Whether background agents get the MessageParent tool (ADR-0013). Default: true. */
  readonly parentMessages: boolean;
  /** Whether agent colors (spinner, status icons, picker bullets) are enabled. Default: true. */
  readonly showAgentColors: boolean;
}

type BooleanSetting = {
  [Key in keyof KnownAgentSettings]-?: NonNullable<KnownAgentSettings[Key]> extends boolean ? Key : never;
}[keyof KnownAgentSettings];

export function resolveAgentSettings(
  a: SubagentsConfig["agent"],
  defaultConcurrency: number,
  sessionShowCost?: boolean,
): ResolvedAgentSettings {
  const enabled = (key: BooleanSetting): boolean =>
    typeof a[key] === "boolean" ? a[key] : AGENT_KEY_SPECS[key].defaultValue;
  const widgetMaxLines = a.widgetMaxLines ?? AGENT_KEY_SPECS.widgetMaxLines.defaultValue;
  const widgetMaxLinesCompact = a.widgetMaxLinesCompact ?? defaultCompactLines(widgetMaxLines);
  // 0 = auto: the cap tracks the default concurrency (the manager's own
  // fallback chain, baked at 4) so it scales with the session.

  return {
    defaultModel: a.default ?? AGENT_KEY_SPECS.default.defaultValue,
    forceBackground: enabled("forceBackground"),
    showCost: sessionShowCost ?? enabled("showCost"),
    graceTurns: a.graceTurns ?? AGENT_KEY_SPECS.graceTurns.defaultValue,
    widgetMaxLines,
    widgetMaxLinesCompact,
    widgetCompact: enabled("widgetCompact"),
    showCompletionCards: enabled("showCompletionCards"),
    widgetShortcut: enabled("widgetShortcut"),
    widgetShowModel: enabled("widgetShowModel"),
    widgetShowThinking: enabled("widgetShowThinking"),
    widgetNavHint: enabled("widgetNavHint"),

    systemPromptMode: normalizeSystemPromptMode(a.systemPromptMode),
    includeContextFiles: a.includeContextFiles ?? AGENT_KEY_SPECS.includeContextFiles.defaultValue,
    defaultThinking: a.defaultThinking,
    defaultMaxTurns: a.defaultMaxTurns,
    loadSkillsImplicitly: enabled("loadSkillsImplicitly"),
    loadExtensionsImplicitly: enabled("loadExtensionsImplicitly"),
    loadToolsImplicitly: enabled("loadToolsImplicitly"),
    disableDefaultAgents: enabled("disableDefaultAgents"),
    agentToolStrictMode: enabled("agentToolStrictMode"),
    exposeDescriptions: enabled("exposeDescriptions"),
    showTools: enabled("showTools"),
    showTurns: enabled("showTurns"),
    showInput: enabled("showInput"),
    showOutput: enabled("showOutput"),
    showContext: enabled("showContext"),
    showTime: enabled("showTime"),
    outputThinkingBufferSize: a.outputThinkingBufferSize ?? AGENT_KEY_SPECS.outputThinkingBufferSize.defaultValue,
    finishedRetentionMinutes: normalizeFinishedRetention(a.finishedRetentionMinutes),
    agentStatusLimit: canonicalAgentStatusLimit(a.agentStatusLimit) || 2 * defaultConcurrency,
    modelDisplayStyle:
      a.modelDisplayStyle === "id" ? a.modelDisplayStyle : AGENT_KEY_SPECS.modelDisplayStyle.defaultValue,
    modelThinkingPlacement:
      a.modelThinkingPlacement === "metadata"
        ? a.modelThinkingPlacement
        : AGENT_KEY_SPECS.modelThinkingPlacement.defaultValue,
    statusBarFormat: a.statusBarFormat === "compact" ? a.statusBarFormat : AGENT_KEY_SPECS.statusBarFormat.defaultValue,
    toolTimeoutMinutes: a.toolTimeoutMinutes ?? DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
    idleTimeoutMinutes: a.idleTimeoutMinutes ?? DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
    outputTranscript: enabled("outputTranscript"),
    parentMessages: enabled("parentMessages"),
    showAgentColors: enabled("showAgentColors"),
  };
}
