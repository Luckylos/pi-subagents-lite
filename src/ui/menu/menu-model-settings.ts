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
import { getStore } from "../../shell.ts";
import { buildModelGroups, modelSettingTag, type AgentTypeModelConfig } from "../../models/model-groups.ts";
import { formatDisplayedThinking } from "../../models/thinking-resolution.ts";
import { resolveConfiguredModel } from "../../models/model-availability.ts";
import { getPiDefaultThinkingLevel, getPiModelThinkingLevels } from "../../pi-settings.ts";
import { isPerTypeModelKey } from "../../config/agent-settings.ts";
import type { ModelSettingDescription } from "../../config/config-store.ts";
import { errorMessage } from "../../utils.ts";

export async function showModelSettingsMenu(
  owner: ExtensionOwner,
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  let offerReload = false;
  const buildItems = (store: ReturnType<typeof getStore>, theme: Theme): SettingItem[] => {
    const items: SettingItem[] = [];
    const projectOffered = store.projectTargetOffered;
    const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const autoModelLabel = "Pi selects on spawn";
    const resolveModel = (configuredId: string | undefined) => resolveConfiguredModel(configuredId, ctx);
    const fallbackNote = () =>
      parentModelId
        ? `Unavailable. Spawn uses parent model ${plainText(parentModelId)}.`
        : "Unavailable. No parent model is set. Pi selects the model on spawn.";

    const notifyClearError = (err: unknown) => {
      offerReload ||= projectOffered && !store.projectTargetOffered;
      ctx.ui.notify(errorMessage(err), "error");
    };
    const clearOverride = (key: string, target: TargetChoice) => {
      try {
        if (key === "default") store.mutate.agent.clearDefaultModel(target);
        else store.mutate.agent.clearModelOverride(key, target);
      } catch (err) {
        notifyClearError(err);
        return;
      }
      const { model, layer } = store.describeModelSetting(
        key,
        parentModelId,
        key === "default" ? undefined : owner.registry.getAgentConfig(key),
      );
      const { unavailable } = resolveModel(layer === "parent" ? undefined : model);
      const effective = unavailable
        ? `Configured model ${plainText(model)} (${layer}). ${fallbackNote()}`
        : model
          ? `Effective model ${plainText(model)} (${layer})`
          : "Pi selects the model on spawn.";
      ctx.ui.notify(`${key} override cleared (${target}). ${effective}`, "info");
    };

    // Shared submenu factory: target + model picker for one config key.
    // Clear is available only at layers carrying this key.
    // A type sharing a persisted setting name may still use its independent session slot.
    const modelSubmenuFor = (typeName: string, effectiveModel: string, availableLevels: AvailableLevels) =>
      createModelSelectSubmenu(owner, {
        modelOptions,
        showClear: availableLevels.session || availableLevels.global || (projectOffered && availableLevels.project),
        globalOffered: typeName === "default" || isPerTypeModelKey(typeName),
        projectOffered: projectOffered && (typeName === "default" || isPerTypeModelKey(typeName)),
        theme,
        currentModel: effectiveModel,
        availableLevels,
        fallbackLabel: "Clear override at this level",
        onSet: (target, model) => {
          if (model === null || model === "(inherits parent)") {
            clearOverride(typeName, target);
          } else {
            if (typeName === "default") store.mutate.agent.setDefaultModel(model, target);
            else store.mutate.agent.setModelOverride(typeName, model, target);
            ctx.ui.notify(`${typeName} model set to ${model} (${target})`, "info");
          }
        },
        onClear: (target) => clearOverride(typeName, target),
      });

    const defaultModel = store.describeModelSetting("default", parentModelId ? "(inherits parent)" : "");

    items.push({
      id: "defaultModel",
      label: "Global default model",
      currentValue: [defaultModel.model || autoModelLabel, modelSettingTag(defaultModel)].filter(Boolean).join(" "),
      description: resolveModel(defaultModel.layer === "parent" ? undefined : defaultModel.model).unavailable
        ? fallbackNote()
        : "Used after session and per-type overrides, before the agent's frontmatter model.",
      submenu: modelSubmenuFor("default", defaultModel.model, defaultModel.clearable),
    });

    // Model groups: one group per Resolved model with a listed row (an
    // explicit per-type override, including one pointing at the effective
    // default), alphabetical by model id. Rows show the type name, the
    // spawn-effective thinking level with its winning thinking source in
    // brackets, and the winning model layer's provenance tag.
    const types = owner.registry.getAllTypes().filter((type) => type !== "default");

    const agentConfigs: Record<string, AgentTypeModelConfig | undefined> = Object.create(null);
    const modelSettings: Record<string, ModelSettingDescription> = Object.create(null);
    for (const type of types) {
      agentConfigs[type] = owner.registry.getAgentConfig(type);
      modelSettings[type] = store.describeModelSetting(type, parentModelId, agentConfigs[type]);
    }

    // Use the same settings scope as Spawn without a worktree target.
    const scope = { projectTrusted: ctx.isProjectTrusted?.() ?? true };
    const modelThinkingLevels = getPiModelThinkingLevels(ctx.cwd, scope);
    const groups = buildModelGroups({
      types,
      agentConfigs,
      modelSettings,
      defaultThinking: store.agent.defaultThinking,
      parentModelId,
      piDefaultThinking: getPiDefaultThinkingLevel(ctx.cwd, scope),
      piModelThinking: (modelKey) => modelThinkingLevels[modelKey],
      resolveModel,
      parentLevel: ctx.thinkingLevel,
    });

    for (const group of groups) {
      // Blank spacer above each block: pre-groups spacer and between-groups
      // separator are the same row; the long rule divides after the last group.
      items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
      // Section title: bare model id in bold accent, matching the menu title
      items.push(headerItem(theme, group.modelId || autoModelLabel));
      for (const row of group.rows) {
        const thinkingLabel = formatDisplayedThinking(row.thinking);
        items.push({
          id: `type:${row.type}`,
          label: `${agentBulletPrefix(owner, row.type)}${plainText(row.type)}`,
          // SettingsList truncates the value with no ellipsis, so the row carries no
          // reserved padding: an empty tag contributes no space.
          currentValue: [thinkingLabel, row.tag].filter(Boolean).join(" "),
          description: row.unavailable
            ? fallbackNote()
            : `Model for the ${row.type} agent type. Select to set or clear its override.`,
          submenu: modelSubmenuFor(row.type, group.modelId, modelSettings[row.type].clearable),
        });
      }
    }

    // "Override another type..." lists types without an explicit per-type
    // override: frontmatter-only and inheriting types.
    items.push({ id: SEPARATOR_ID, label: "─────────────────────────", currentValue: "────────" });
    const nonOverridden = types.filter((type) => !modelSettings[type].explicitPerTypeOverride);
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
                const { model, clearable } = store.describeModelSetting(
                  typeName,
                  parentModelId,
                  owner.registry.getAgentConfig(typeName),
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
            try {
              store.mutate.agent.clearAllModelOverrides(target);
            } catch (err) {
              notifyClearError(err);
              return;
            }
            ctx.ui.notify(`Model overrides cleared (${target})`, "info");
          },
        }),
      });
    }

    if (offerReload) {
      items.push({
        id: "reload",
        label: "Reload model settings",
        currentValue: "",
        values: [""],
        description: "Read the config files again after repairing the project file.",
      });
    }
    return items;
  };

  let rebuild: ((items: SettingItem[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const store = getStore(owner);
    const items = buildItems(store, theme);

    const settingsList = new SettingsList(
      items,
      15,
      buildSettingsListTheme(theme),
      (id) => {
        if (id === "reload") {
          store.refreshPersisted();
          offerReload = !store.projectTargetOffered;
        }
        rebuild?.(buildItems(store, theme));
      },
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
