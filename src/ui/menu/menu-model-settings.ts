import type { ExtensionOwner } from "../../shell.ts";
/**
 * menu-model-settings.ts — Model settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * Model overrides use target-level submenus (session/global/project, plus
 * nested per-level clear) per ADR-0008. Agent types are grouped by their
 * Resolved model (one group per listed model, alphabetical); each row
 * shows the type name, the spawn-effective thinking level with its winning
 * source in brackets, and the model-layer provenance tag ([session] for a
 * session-layer win, per-type override or session default; [project];
 * untagged for a global-layer win).
 *
 *   - showModelSettingsMenu: model settings with global default and model
 *     groups for types carrying an explicit per-type override
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";

import type { Theme } from "../types.ts";
import { SEPARATOR_ID, buildSettingsListTheme, createSearchableSelect, headerItem } from "./helpers.ts";
import { plainText } from "../sanitize.ts";
import { agentBulletPrefix } from "../format.ts";
import { createModelSelectSubmenu } from "./submenus/model-select.ts";
import { createClearAllSubmenu, type AvailableLevels, type TargetChoice } from "./submenus/target-select.ts";
import { SettingsListWrapper } from "./wrappers/settings-list.ts";
import { getSessionCtx, getStore } from "../../shell.ts";
import {
  buildModelGroups,
  describeModelSetting,
  hasExplicitPerTypeOverride,
  modelSettingLevels,
  type AgentTypeModelConfig,
  type ModelSettingsLayers,
} from "../../models/model-groups.ts";
import { formatDisplayedThinking } from "../../models/thinking-resolution.ts";
import { findModelInRegistry } from "../../utils.ts";
import { getPiDefaultThinkingLevel, getPiModelThinkingLevels } from "../../pi-settings.ts";
import type { SessionModelOverrides } from "../../models/model-precedence.ts";

export async function showModelSettingsMenu(
  owner: ExtensionOwner,
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const buildItems = (store: ReturnType<typeof getStore>, theme: Theme): SettingItem[] => {
    const items: SettingItem[] = [];
    const projectOffered = store.projectTargetOffered;

    const clearOverride = (key: string, target: TargetChoice) => {
      store.mutate.agent.clearModelOverride(key, target);
      const parent = getSessionCtx(owner)?.model ?? ctx.model;
      const parentModelId = parent ? `${parent.provider}/${parent.id}` : undefined;
      const { model, layer } = describeModelSetting(
        {
          ...layers,
          config: store.agentConfigSnapshot(),
          sessionOverrides: { default: store.sessionDefaultModel, [key]: store.sessionModelOverride(key) },
        },
        key,
        parentModelId,
        key === "default" ? undefined : owner.registry.getAgentConfig(key),
      );
      const effective =
        layer === "parent" && !parent ? "Inherits parent model" : `Effective model ${plainText(model)} (${layer})`;
      ctx.ui.notify(`${key} override cleared (${target}). ${effective}`, "info");
    };

    // Shared submenu factory: target + model picker for one config key.
    // availableLevels filters the nested clear picker (the default and per-type
    // rows pass the levels where the key exists); set entries are never filtered.
    const modelSubmenuFor = (typeName: string, effectiveModel: string, availableLevels: AvailableLevels) =>
      createModelSelectSubmenu(owner, {
        modelOptions,
        showClear: availableLevels.session || availableLevels.global || (projectOffered && availableLevels.project),
        projectOffered,
        theme,
        currentModel: effectiveModel,
        availableLevels,
        fallbackLabel: "Clear override at this level",
        onSet: (target, model) => {
          if (model === null || model === "(inherits parent)") {
            clearOverride(typeName, target);
          } else {
            store.mutate.agent.setModelOverride(typeName, model, target);
            ctx.ui.notify(`${typeName} model set to ${model} (${target})`, "info");
          }
        },
        onClear: (target) => clearOverride(typeName, target),
      });

    const sessionOverrides: SessionModelOverrides = { default: store.sessionDefaultModel };
    const layers: ModelSettingsLayers = {
      config: store.agentConfigSnapshot(),
      sessionOverrides,
      hasGlobalModelKey: (key) => store.hasGlobalModelKey(key),
      hasProjectModelKey: (key) => store.hasProjectModelKey(key),
    };
    const defaultModel = describeModelSetting(layers, "default");

    items.push({
      id: "defaultModel",
      label: "Global default model",
      currentValue: [defaultModel.model, defaultModel.tag].filter(Boolean).join(" "),
      description: "Model used when no session default, per-type override, or frontmatter model applies.",
      submenu: modelSubmenuFor("default", defaultModel.model, defaultModel.clearable),
    });

    // Model groups: one group per Resolved model with a listed row (an
    // explicit per-type override, including one pointing at the effective
    // default), alphabetical by model id. Rows show the type name, the
    // spawn-effective thinking level with its winning thinking source in
    // brackets, and the winning model layer's provenance tag.
    const session = getSessionCtx(owner);
    const parentModel = session?.model ?? ctx.model;
    const parentModelId = parentModel ? `${parentModel.provider}/${parentModel.id}` : "(inherits parent)";
    const registry = session?.modelRegistry ?? ctx.modelRegistry;
    const types = owner.registry.getAllTypes();

    const agentConfigs: Record<string, AgentTypeModelConfig | undefined> = {};
    for (const type of types) {
      // Null entries read as absent downstream, so every type is recorded.
      sessionOverrides[type] = store.sessionModelOverride(type);
      agentConfigs[type] = owner.registry.getAgentConfig(type);
    }

    // One settings read per build feeds both thinking displays: the global
    // default and the per-model map (the prediction of what a spawn would
    // run with — the session is the source of truth once it exists).
    const modelThinkingLevels = getPiModelThinkingLevels(ctx.cwd);
    const groups = buildModelGroups({
      types,
      agentConfigs,
      ...layers,
      parentModelId,
      piDefaultThinking: getPiDefaultThinkingLevel(ctx.cwd),
      piModelThinking: (modelKey) => modelThinkingLevels[modelKey],
      findModel: (modelId) => findModelInRegistry(modelId, registry, undefined),
      parentLevel: ctx.thinkingLevel,
    });

    for (const group of groups) {
      // Blank spacer above each block: pre-groups spacer and between-groups
      // separator are the same row; the long rule divides after the last group.
      items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
      // Section title: bare model id in bold accent, matching the menu title
      items.push(headerItem(theme, group.modelId));
      for (const row of group.rows) {
        const thinkingLabel = formatDisplayedThinking({ level: row.thinking, source: row.source });
        items.push({
          id: `type:${row.type}`,
          label: `${agentBulletPrefix(owner, row.type)}${plainText(row.type)}`,
          // SettingsList truncates the value with no ellipsis, so the row carries no
          // reserved padding: an empty tag contributes no space.
          currentValue: [thinkingLabel, row.tag].filter(Boolean).join(" "),
          description: `Model for the ${row.type} agent type. Select to set or clear its override.`,
          submenu: modelSubmenuFor(row.type, group.modelId, modelSettingLevels(layers, row.type)),
        });
      }
    }

    // "Override another type..." lists types without an explicit per-type
    // override: frontmatter-only and inheriting types.
    items.push({ id: SEPARATOR_ID, label: "─────────────────────────", currentValue: "────────" });
    const nonOverridden = types.filter((type) => !hasExplicitPerTypeOverride(sessionOverrides, layers.config, type));
    if (nonOverridden.length > 0) {
      items.push({
        id: "overrideType",
        label: "Override another type...",
        currentValue: "",
        description: "Add a model override for an agent type that currently inherits.",
        submenu: (_currentValue, subDone) =>
          createSearchableSelect(
            nonOverridden.map((typeName) => ({
              value: typeName,
              label: `${agentBulletPrefix(owner, typeName)}${plainText(typeName)}`,
            })),
            {
              onSelect: (typeName) => {
                const { model, clearable } = describeModelSetting(
                  layers,
                  typeName,
                  parentModelId,
                  agentConfigs[typeName],
                );
                return modelSubmenuFor(typeName, model, clearable)(model, subDone);
              },
              onCancel: () => subDone(),
            },
            theme,
          ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    // Clear-all per target: nested level picker, then confirm. Each level is
    // offered only when it has model settings (project additionally requires
    // the project target to be offered); the entry itself is hidden when no
    // level is offered.
    const availableLevels: AvailableLevels = {
      session: store.hasSessionModelSettings,
      global: store.hasGlobalModelSettings,
      project: store.hasProjectModelSettings && projectOffered,
    };
    if (availableLevels.session || availableLevels.global || availableLevels.project) {
      items.push({
        id: "clearAll",
        label: "Clear all model overrides...",
        currentValue: "",
        description: "Discard model overrides at the chosen level (session, global, project, or all).",
        submenu: createClearAllSubmenu({
          theme,
          projectOffered,
          availableLevels,
          message: (target) => `Clear all model overrides at the ${target} level?`,
          onConfirm: (target) => {
            store.mutate.agent.clearAllModelOverrides(target);
            ctx.ui.notify(`Model overrides cleared (${target})`, "info");
          },
        }),
      });
    }

    return items;
  };

  let rebuild: ((items: any[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const store = getStore(owner);
    const items = buildItems(store, theme);

    const settingsList = new SettingsList(
      items,
      15,
      buildSettingsListTheme(theme),
      (_id, _v) => rebuild?.(buildItems(getStore(owner), theme)),
      () => done(undefined),
    );
    return new SettingsListWrapper(settingsList, {
      title: "Model Settings",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
