/**
 * model-groups.ts — Pure display rules for Model settings: tags, grouping,
 * alphabetical ordering and spawn-effective Thinking previews. Configuration
 * facts come from ConfigStore descriptions; legacy snapshot exports adapt to
 * the same configuration-owned interpretation for source consumers.
 */

import { ownEntry } from "../config/agent-settings.ts";
import { explainModelSetting, type ModelSettingDescription, type ModelSettingsLayers } from "../config/config-store.ts";
import type { ConfiguredModelResolution } from "./model-availability.ts";
import { resolveDisplayedThinking, type DisplayedThinking } from "./thinking-resolution.ts";
import type { ThinkingChoice, ThinkingLevel } from "../types.ts";

export { hasExplicitPerTypeOverride, modelSettingLevels } from "../config/config-store.ts";
export type { ModelSettingsLayers } from "../config/config-store.ts";

/** Frontmatter fields the group builder reads per type. */
export interface AgentTypeModelConfig {
  model?: string;
  thinkingLevel?: ThinkingChoice;
}

interface ModelGroupsContext {
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

/** Legacy snapshot input retained for published-source compatibility. */
export interface ModelGroupsInput extends ModelSettingsLayers, ModelGroupsContext {}

/** Production input contains configuration facts, not layers or membership callbacks. */
export interface ExplainedModelGroupsInput extends ModelGroupsContext {
  modelSettings: Readonly<Record<string, ModelSettingDescription>>;
  defaultThinking?: ThinkingChoice;
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

/** Display-only provenance tag: membership never substitutes for the winning layer. */
export function modelSettingTag(setting: Pick<ModelSettingDescription, "layer">): string {
  return setting.layer === "session" || setting.layer === "project" ? `[${setting.layer}]` : "";
}

/** Legacy helper preserves its original result shape, delegating all configuration facts. */
export function describeModelSetting(
  layers: ModelSettingsLayers,
  key: string,
  parentModelId = "(inherits parent)",
  agentConfig?: AgentTypeModelConfig,
) {
  const setting = explainModelSetting(layers, key, parentModelId, agentConfig);
  return { model: setting.model, layer: setting.layer, tag: modelSettingTag(setting), clearable: setting.clearable };
}

export function buildModelGroups(input: ExplainedModelGroupsInput | ModelGroupsInput): ModelGroups {
  // Compatibility only: production and tests pass descriptions from the store.
  const explained: ExplainedModelGroupsInput =
    "modelSettings" in input
      ? input
      : {
          ...input,
          defaultThinking: input.config.defaultThinking,
          modelSettings: Object.fromEntries(
            input.types.map((type) => [
              type,
              explainModelSetting(input, type, input.parentModelId, ownEntry(input.agentConfigs, type)),
            ]),
          ),
        };
  const { types, agentConfigs, modelSettings } = explained;
  const byModel = new Map<string, ModelGroupRow[]>();
  for (const type of types) {
    const setting = ownEntry(modelSettings, type);
    if (!setting?.explicitPerTypeOverride) continue;
    const { model: modelId, layer } = setting;
    const { model, unavailable } = explained.resolveModel(layer === "parent" ? undefined : modelId);
    const rows = byModel.get(modelId) ?? [];
    rows.push({
      type,
      thinking: displayThinking(ownEntry(agentConfigs, type), model, explained),
      tag: modelSettingTag(setting),
      ...(unavailable ? { unavailable } : {}),
    });
    byModel.set(modelId, rows);
  }

  return [...byModel.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([modelId, modelRows]) => ({ modelId, rows: modelRows }));
}

/** Resolve the Thinking preview using the model that Spawn can actually pass to Pi. */
function displayThinking(
  cfg: AgentTypeModelConfig | undefined,
  model: ConfiguredModelResolution["model"],
  input: ExplainedModelGroupsInput,
): DisplayedThinking {
  return resolveDisplayedThinking(
    {
      frontmatter: cfg?.thinkingLevel,
      perModel: model ? input.piModelThinking?.(`${model.provider}/${model.id}`) : undefined,
      defaultThinking: input.defaultThinking,
      parentLevel: input.parentLevel,
    },
    input.piDefaultThinking,
    model,
  );
}
