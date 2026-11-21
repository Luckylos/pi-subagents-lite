/**
 * model-groups.ts — Group Agent types by Resolved model for the Model
 * settings menu.
 *
 * Pure function — no store access, no file I/O, no pi SDK imports (pi-ai's
 * clampThinkingLevel is a pure helper). The menu assembles the snapshot input
 * from ConfigStore + the extension context and maps the result to
 * SettingsList items.
 *
 * A type gets a row iff it has an explicit per-type Model override at the
 * session, project, or global layer (the anti-spam rule: frontmatter and
 * inherited models alone never add a row). Each row stays grouped under the
 * winning ID, even if Spawn uses a fallback, and is tagged with its layer:
 * [session] when the
 * session per-type override or the session default won; [project] for a
 * project per-type win with no session default; untagged for a global
 * per-type win with no session default. Groups are ordered alphabetically
 * by model id.
 *
 * Exports:
 *   - buildModelGroups: types + config snapshot → model groups with
 *     clamped thinking levels, their winning sources, and provenance tags
 *   - hasExplicitPerTypeOverride: the anti-spam listing rule (shared with
 *     the menu's "Override another type..." list)
 */

import type { SubagentsConfig } from "../config/types.ts";
import type { ConfiguredModelResolution } from "./model-availability.ts";
import type { SessionModelOverrides } from "./model-precedence.ts";
import { resolveModelSource } from "./model-precedence.ts";
import { resolveDisplayedThinking, type DisplayedThinking } from "./thinking-resolution.ts";
import type { ThinkingChoice, ThinkingLevel } from "../types.ts";

/** Frontmatter fields the group builder reads per type. */
export interface AgentTypeModelConfig {
  model?: string;
  thinkingLevel?: ThinkingChoice;
}

/** Merged values for resolution and layer membership for clearing. */
export interface ModelSettingsLayers {
  /** Merged config.agent (project over global): default, per-type model keys, defaultThinking. */
  config: SubagentsConfig["agent"];
  /** Session-layer Model overrides: "default" + per-type. */
  sessionOverrides: SessionModelOverrides;
  hasGlobalModelKey: (key: string) => boolean;
  hasProjectModelKey: (key: string) => boolean;
}

export interface ModelGroupsInput extends ModelSettingsLayers {
  /** All registered Agent type names (UI listing order). */
  types: readonly string[];
  /** Frontmatter config per type (undefined = no config). */
  agentConfigs: Readonly<Record<string, AgentTypeModelConfig | undefined>>;
  /** Parent session model ID; empty when there is no parent model. */
  parentModelId: string;
  /** pi's defaultThinkingLevel setting (project over global). */
  piDefaultThinking?: ThinkingLevel;
  /** pi's per-model thinking lookup, keyed by the chosen model's `provider/modelId`. */
  piModelThinking?: (modelKey: string) => ThinkingLevel | undefined;
  /** The model Spawn will use; undefined input means pure inheritance, not a configured ID. */
  resolveModel: (configuredId: string | undefined) => ConfiguredModelResolution;
  /** The parent session's current level, for a source holding `parent`. */
  parentLevel?: ThinkingLevel;
}

/** One Agent type listed under a model group. */
export interface ModelGroupRow {
  type: string;
  /** Thinking preview for the model Spawn will use, or its preference while Pi selects a model. */
  thinking: DisplayedThinking;
  /** Model provenance tag when the winning model comes from the session or project layer. */
  tag: string;
  /** Set when the winning configured ID is unavailable, never for pure inheritance. */
  unavailable?: true;
}

export interface ModelGroup {
  modelId: string;
  rows: ModelGroupRow[];
}

/** Groups ordered alphabetically by model id; each type appears in at most one row. */
export type ModelGroups = ModelGroup[];

/** Explain the selected model and record which layers still carry the requested key. */
export function describeModelSetting(
  layers: ModelSettingsLayers,
  key: string,
  parentModelId = "(inherits parent)",
  agentConfig?: AgentTypeModelConfig,
) {
  const { config, sessionOverrides, hasProjectModelKey } = layers;
  const { model, source } = resolveModelSource({
    subagentType: key,
    agentConfig,
    config: { agent: config },
    parentModelId,
    sessionOverrides,
  });
  let layer: "session" | "project" | "global" | "frontmatter" | "parent";
  switch (source) {
    case "session-per-type":
    case "session-default":
      layer = "session";
      break;
    case "config-per-type":
    case "config-default":
      layer = hasProjectModelKey(source === "config-default" ? "default" : key) ? "project" : "global";
      break;
    default:
      layer = source;
  }
  const tag = layer === "session" || layer === "project" ? "[" + layer + "]" : "";
  return { model, layer, tag, clearable: modelSettingLevels(layers, key) };
}

/** An empty stored value can be cleared even when resolution skips it. */
export function modelSettingLevels(layers: ModelSettingsLayers, key: string) {
  return {
    session: layers.sessionOverrides[key] != null,
    global: layers.hasGlobalModelKey(key),
    project: layers.hasProjectModelKey(key),
  };
}

export function buildModelGroups(input: ModelGroupsInput): ModelGroups {
  const { types, agentConfigs, config, sessionOverrides, parentModelId } = input;

  const byModel = new Map<string, ModelGroupRow[]>();
  for (const type of types) {
    if (!hasExplicitPerTypeOverride(sessionOverrides, config, type)) continue;
    const cfg = agentConfigs[type];
    const { model: modelId, layer, tag } = describeModelSetting(input, type, parentModelId, cfg);
    const { model, unavailable } = input.resolveModel(layer === "parent" ? undefined : modelId);

    const rows = byModel.get(modelId) ?? [];
    rows.push({
      type,
      thinking: displayThinking(cfg, model, input),
      tag,
      ...(unavailable ? { unavailable } : {}),
    });
    byModel.set(modelId, rows);
  }

  return [...byModel.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([modelId, modelRows]) => ({ modelId, rows: modelRows }));
}

/**
 * True when the type carries an explicit per-type model override at the
 * session or config layer (including an empty-string key). The anti-spam
 * listing rule shared with the menu's "Override another type..." list:
 * frontmatter-only and inheriting types are never listed.
 */
export function hasExplicitPerTypeOverride(
  sessionOverrides: SessionModelOverrides,
  agentConfig: SubagentsConfig["agent"],
  type: string,
): boolean {
  return sessionOverrides[type] != null || typeof agentConfig[type] === "string";
}

/** Resolve the Thinking preview using the model that Spawn can actually pass to Pi. */
function displayThinking(
  cfg: AgentTypeModelConfig | undefined,
  model: ConfiguredModelResolution["model"],
  input: ModelGroupsInput,
): DisplayedThinking {
  return resolveDisplayedThinking(
    {
      frontmatter: cfg?.thinkingLevel,
      perModel: model ? input.piModelThinking?.(`${model.provider}/${model.id}`) : undefined,
      defaultThinking: input.config.defaultThinking,
      parentLevel: input.parentLevel,
    },
    input.piDefaultThinking,
    model,
  );
}
