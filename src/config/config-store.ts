/**
 * config-store.ts — Deep module owning persisted config + per-session overrides.
 *
 * Absorbs config-io.ts, config-mutator.ts, and the config/widget-sync half of
 * state.ts. See docs/adr/0004-composition-root-over-shared-state.md.
 *
 * - Reads return defaults baked in (no `?? 6` at call sites).
 * - Each persisted mutate method is mutate + persist + its side effect, so a
 *   side effect cannot be forgotten.
 * - Widget/manager are injected after construction (they're created lazily).
 * - Effective config resolves session overrides → project file → global file
 *   → built-in defaults (ADR-0008). Mutations target one layer; each file
 *   stores only its own keys and the merged config is never written back.
 *
 * Lifecycle: per-session. `reload()` re-reads disk + resets session overrides
 * at session_start. `dispose()` drops deps at session_shutdown.
 */

import type { ModelSource, SessionModelOverrides } from "../models/model-precedence.ts";
import { resolveModel, resolveModelSource } from "../models/model-precedence.ts";
import type { AgentWidget } from "../ui/agent-widget.ts";
import type { AgentManager } from "../agents/agent-manager.ts";
import type { ModelThinkingPlacement, SubagentsConfig } from "./types.ts";
import {
  canonicalAgentStatusLimit,
  defaultCompactLines,
  isAgentModelKey,
  isPerTypeModelKey,
  ownEntry,
  normalizeFinishedRetention,
  normalizeWatchdogMinutes,
  resolveAgentSettings,
  type ResolvedAgentSettings,
} from "./agent-settings.ts";
import type { SystemPromptMode } from "../agents/types.ts";
import type { ThinkingChoice } from "../types.ts";
import {
  createConfigIO,
  type ConfigIO,
  type ConfigTarget,
  type ProjectLayerStatus,
  type RawConfig,
  type RawConcurrency,
} from "./config-io.ts";

import { clearAgentModelKeys, mergeDefaults, mergeLayers, mergeRawConcurrency } from "./config-layers.ts";

export type { ConfigIO, ConfigTarget, ProjectLayerStatus, RawConfig, RawConcurrency } from "./config-io.ts";

export const fileConfigIO: ConfigIO = createConfigIO();

/** True when a raw agent layer carries a model setting: the model family (default, defaultThinking,
 * defaultMaxTurns) or a per-type model key (ADR-0008). */
export function agentLayerHasModelSettings(layer: RawConfig | null): boolean {
  const agent = layer?.agent;
  if (!agent) return false;
  return Object.keys(agent).some((key) => isAgentModelKey(key) && agent[key] !== undefined);
}

/** True when the session layer carries a default model or any per-type override. */
export function sessionOverridesHasModelSettings(overrides: SessionModelOverrides): boolean {
  return Object.values(overrides).some((value) => value != null);
}

/** True when a raw concurrency layer carries any entry (default, provider, or model). */
export function concurrencyLayerHasSettings(layer: RawConcurrency): boolean {
  return (
    layer.default !== undefined ||
    (layer.providers != null && Object.keys(layer.providers).length > 0) ||
    (layer.models != null && Object.keys(layer.models).length > 0)
  );
}

/** Configuration facts only: provenance is winning layer, Clear eligibility is requested-key membership. */
export interface ModelSettingDescription {
  model: string;
  source: ModelSource;
  layer: "session" | "project" | "global" | "frontmatter" | "parent";
  clearable: { session: boolean; global: boolean; project: boolean };
  /** Existing listing rule, distinct from membership: persisted null alone does not list a type. */
  explicitPerTypeOverride: boolean;
}

/** Legacy snapshot contract, retained for source consumers; new consumers read the store instance. */
export interface ModelSettingsLayers {
  config: SubagentsConfig["agent"];
  sessionOverrides: SessionModelOverrides;
  hasGlobalModelKey: (key: string) => boolean;
  hasProjectModelKey: (key: string) => boolean;
}

/** Shared configuration interpretation for the instance read and legacy snapshot adapters. */
export function explainModelSetting(
  layers: ModelSettingsLayers,
  key: string,
  parentModelId = "",
  agentConfig?: { model?: string },
): ModelSettingDescription {
  const { model, source } = resolveModelSource({
    subagentType: key,
    agentConfig,
    config: { agent: layers.config },
    parentModelId,
    sessionOverrides: layers.sessionOverrides,
  });
  let layer: ModelSettingDescription["layer"];
  switch (source) {
    case "session-per-type":
    case "session-default":
      layer = "session";
      break;
    case "config-per-type":
    case "config-default":
      layer = layers.hasProjectModelKey(source === "config-default" ? "default" : key) ? "project" : "global";
      break;
    default:
      layer = source;
  }
  return {
    model,
    source,
    layer,
    clearable: modelSettingLevels(layers, key),
    explicitPerTypeOverride: hasExplicitPerTypeOverride(layers.sessionOverrides, layers.config, key),
  };
}

/** An empty stored value can be cleared even when resolution skips it. */
export function modelSettingLevels(layers: ModelSettingsLayers, key: string): ModelSettingDescription["clearable"] {
  const persisted = (key === "default" || isPerTypeModelKey(key)) && Object.hasOwn(layers.config, key);
  return {
    session: ownEntry(layers.sessionOverrides, key) != null,
    global: persisted && layers.hasGlobalModelKey(key),
    project: persisted && layers.hasProjectModelKey(key),
  };
}

/** Listing eligibility is not raw membership: only session non-null or merged per-type string qualifies. */
export function hasExplicitPerTypeOverride(
  sessionOverrides: SessionModelOverrides,
  agentConfig: SubagentsConfig["agent"],
  type: string,
): boolean {
  return (
    type !== "default" &&
    (ownEntry(sessionOverrides, type) != null ||
      (isPerTypeModelKey(type) && typeof ownEntry(agentConfig, type) === "string"))
  );
}

/** Agent settings with all scalar defaults resolved. Model fields stay nullable. */
/** Side-effect targets, injected after construction. */
export interface ConfigStoreDeps {
  widget?: AgentWidget;
  manager?: AgentManager;
}

export class ConfigStore {
  private globalRaw: RawConfig;
  private projectRaw: RawConfig | null;
  private projectStatus: ProjectLayerStatus;
  private config: SubagentsConfig;
  private io: ConfigIO;
  private sessionOverrides: SessionModelOverrides = { default: null };
  private sessionConcurrencyLayer: RawConcurrency = {};
  private sessionShowCost: boolean | undefined;
  private widget?: AgentWidget;
  private manager?: AgentManager;
  /** Previous tool-expansion state, for ctrl+o compact sync. */
  private lastToolsExpanded: boolean | undefined;

  constructor(io: ConfigIO = fileConfigIO) {
    this.io = io;
    const loaded = io.load();
    this.globalRaw = loaded.global;
    this.projectRaw = loaded.project;
    this.projectStatus = loaded.projectStatus;
    this.config = mergeDefaults(mergeLayers(this.globalRaw, this.projectRaw));
  }

  /**
   * Point persistence at a project's `.pi` directory (or back to global-only
   * when undefined). Does not reload; session_start follows with reload().
   */
  setProjectDir(projectDir: string | undefined): void {
    this.io = createConfigIO(projectDir);
  }

  // ── Reads ──────────────────────────────────────────────────────

  /** True when the project layer may be written: trusted project, valid or absent file. */
  get projectTargetOffered(): boolean {
    return this.projectStatus === "loaded" || this.projectStatus === "absent";
  }

  get hasSessionShowCost(): boolean {
    return this.sessionShowCost !== undefined;
  }

  get agent(): ResolvedAgentSettings {
    const defaultConcurrency = this.sessionConcurrencyLayer.default ?? this.config.concurrency.default;
    return resolveAgentSettings(this.config.agent, defaultConcurrency, this.sessionShowCost);
  }

  get concurrency(): {
    default: number;
    providers: Record<string, number>;
    models: Record<string, number>;
  } {
    const base = this.config.concurrency;
    const { providers = {}, models = {} } = mergeRawConcurrency(base, this.sessionConcurrencyLayer);
    return {
      default: this.sessionConcurrencyLayer.default ?? base.default,
      providers,
      models,
    };
  }

  get sessionDefaultModel(): string | null {
    return ownEntry(this.sessionOverrides, "default") ?? null;
  }

  sessionModelOverride(type: string): string | null {
    return ownEntry(this.sessionOverrides, type) ?? null;
  }

  /** Whether the global agent layer carries this key (provenance from layer membership). */
  hasGlobalModelKey(key: string): boolean {
    return isAgentModelKey(key) && ownEntry(this.globalRaw.agent, key) !== undefined;
  }

  /** Whether the project agent layer carries this key (provenance from layer membership). */
  hasProjectModelKey(key: string): boolean {
    return isAgentModelKey(key) && ownEntry(this.projectRaw?.agent, key) !== undefined;
  }

  /** Whether the session layer carries a default model or any per-type override. */
  get hasSessionModelSettings(): boolean {
    return sessionOverridesHasModelSettings(this.sessionOverrides);
  }

  /** Whether the global agent layer carries a model setting (model family or per-type key). */
  get hasGlobalModelSettings(): boolean {
    return agentLayerHasModelSettings(this.globalRaw);
  }

  /** Whether the project agent layer carries a model setting. */
  get hasProjectModelSettings(): boolean {
    return agentLayerHasModelSettings(this.projectRaw);
  }

  get projectConcurrency(): RawConcurrency {
    return { ...this.projectRaw?.concurrency };
  }

  get globalConcurrency(): RawConcurrency {
    return { ...this.globalRaw.concurrency };
  }

  get sessionConcurrency(): RawConcurrency {
    return { ...this.sessionConcurrencyLayer };
  }

  /** Whether the session layer carries any concurrency entry (default, provider, or model). */
  get hasSessionConcurrencySettings(): boolean {
    return concurrencyLayerHasSettings(this.sessionConcurrencyLayer);
  }

  /** Whether the global layer carries any concurrency entry. */
  get hasGlobalConcurrencySettings(): boolean {
    return concurrencyLayerHasSettings(this.globalRaw.concurrency ?? {});
  }

  /** Whether the project layer carries any concurrency entry. */
  get hasProjectConcurrencySettings(): boolean {
    return concurrencyLayerHasSettings(this.projectRaw?.concurrency ?? {});
  }

  /** Raw agent config incl. dynamic per-type model keys (for menu display). */
  agentConfigSnapshot(): Readonly<SubagentsConfig["agent"]> {
    return this.config.agent;
  }

  /** Explain this instance's current configuration, without SDK availability, Thinking, labels, or I/O. */
  describeModelSetting(key: string, parentModelId = "", agentConfig?: { model?: string }): ModelSettingDescription {
    return explainModelSetting(
      {
        config: this.config.agent,
        sessionOverrides: this.sessionOverrides,
        hasGlobalModelKey: (requestedKey) => this.hasGlobalModelKey(requestedKey),
        hasProjectModelKey: (requestedKey) => this.hasProjectModelKey(requestedKey),
      },
      key,
      parentModelId,
      agentConfig,
    );
  }

  /**
   * Resolve the effective model for a spawn, hiding resolveModel's option
   * assembly. Precedence: session per-type → session default → config per-type
   * → config default → frontmatter → parentModelId.
   */
  modelFor(type: string, parentModelId: string, agentConfig?: { model?: string }): string {
    return resolveModel({
      subagentType: type,
      agentConfig,
      config: this.config,
      parentModelId,
      sessionOverrides: this.sessionOverrides,
    });
  }

  // ── Mutations ──────────────────────────────────────────────────
  // Session methods are in-memory only: never persisted, no side effects.
  // Target-aware methods default to the global layer; "all" clears the key or
  // the model set in every layer that offers a project target.

  readonly mutate = {
    agent: {
      setDefaultModel: (value: string | null, target: ConfigTarget = "global"): void => {
        this.setAgentModelKey("default", value, target);
      },
      clearDefaultModel: (target: ConfigTarget | "all" = "global"): void => {
        this.clearModelKey("default", target);
      },
      setModelOverride: (type: string, value: string | null, target: ConfigTarget = "global"): void => {
        if (type === "default" || (target !== "session" && !isPerTypeModelKey(type))) return;
        this.setAgentModelKey(type, value, target);
      },
      clearModelOverride: (type: string, target: ConfigTarget | "all" = "global"): void => {
        if (type === "default") return;
        if (!isPerTypeModelKey(type)) {
          if (target === "session" || target === "all") delete this.sessionOverrides[type];
          return;
        }
        this.clearModelKey(type, target);
      },
      /** Clear all model keys (default, thinking, max turns, per-type), keeping non-model settings. */
      clearAllModelOverrides: (target: ConfigTarget | "all" = "global"): void => {
        this.clearAtTarget(
          target,
          () => {
            this.sessionOverrides = { default: null };
          },
          clearAgentModelKeys,
          { includes: agentLayerHasModelSettings },
        );
      },
      setForceBackground: (enabled: boolean) => this.setAgentLayerEntry("forceBackground", enabled, "global"),
      setShowCost: (enabled: boolean): void => {
        this.updatePersistedLayer("global", (layer) => {
          layer.agent ??= {};
          layer.agent.showCost = enabled;
        });
      },
      setGraceTurns: (n: number) => this.setAgentLayerEntry("graceTurns", n, "global"),
      setToolTimeoutMinutes: (n: number) =>
        this.setAgentLayerEntry("toolTimeoutMinutes", normalizeWatchdogMinutes(n), "global"),
      setIdleTimeoutMinutes: (n: number) =>
        this.setAgentLayerEntry("idleTimeoutMinutes", normalizeWatchdogMinutes(n), "global"),
      setOutputTranscript: (enabled: boolean) => this.setAgentLayerEntry("outputTranscript", enabled, "global"),
      setParentMessages: (enabled: boolean) => this.setAgentLayerEntry("parentMessages", enabled, "global"),
      setSystemPromptMode: (mode: SystemPromptMode) => this.setAgentLayerEntry("systemPromptMode", mode, "global"),
      setIncludeContextFiles: (enabled: boolean) => this.setAgentLayerEntry("includeContextFiles", enabled, "global"),
      setDefaultThinking: (level: ThinkingChoice | undefined, target: "global" | "project" = "global"): void => {
        this.setAgentLayerEntry("defaultThinking", level, target);
      },
      setDefaultMaxTurns: (n: number | undefined, target: "global" | "project" = "global"): void => {
        this.setAgentLayerEntry("defaultMaxTurns", n, target);
      },
      /** Delete defaultMaxTurns at a persisted layer (or every layer) so the value falls through. */
      clearDefaultMaxTurns: (target: "global" | "project" | "all" = "global"): void => {
        this.clearAtTarget(
          target,
          () => {
            // Spawn defaults have no session layer; "all" clears only the persisted layers.
          },
          (layer) => {
            if (layer.agent) delete layer.agent.defaultMaxTurns;
          },
        );
      },
      setLoadSkillsImplicitly: (value: boolean) => this.setAgentLayerEntry("loadSkillsImplicitly", value, "global"),
      setLoadExtensionsImplicitly: (value: boolean) =>
        this.setAgentLayerEntry("loadExtensionsImplicitly", value, "global"),
      setLoadToolsImplicitly: (value: boolean) => this.setAgentLayerEntry("loadToolsImplicitly", value, "global"),
      setDisableDefaultAgents: (value: boolean) => this.setAgentLayerEntry("disableDefaultAgents", value, "global"),
      setAgentToolStrictMode: (value: boolean) => this.setAgentLayerEntry("agentToolStrictMode", value, "global"),
      setExposeDescriptions: (value: boolean) => this.setAgentLayerEntry("exposeDescriptions", value, "global"),
      setShowTools: (enabled: boolean) => this.setAgentVisibility("showTools", enabled),
      setShowTurns: (enabled: boolean) => this.setAgentVisibility("showTurns", enabled),
      setShowInput: (enabled: boolean) => this.setAgentVisibility("showInput", enabled),
      setShowOutput: (enabled: boolean) => this.setAgentVisibility("showOutput", enabled),
      setShowContext: (enabled: boolean) => this.setAgentVisibility("showContext", enabled),
      setShowTime: (enabled: boolean) => this.setAgentVisibility("showTime", enabled),
      setOutputThinkingBufferSize: (size: number) =>
        this.setAgentLayerEntry("outputThinkingBufferSize", size, "global"),
      setFinishedRetentionMinutes: (minutes: number): void => {
        const n = normalizeFinishedRetention(minutes);
        this.setAgentLayerEntry("finishedRetentionMinutes", n, "global");
      },
      /** Max settled agents AgentStatus lists. 0 = auto (2 × default concurrency); below 1 clamps to 0. */
      setAgentStatusLimit: (limit: number): void => {
        this.setAgentLayerEntry("agentStatusLimit", canonicalAgentStatusLimit(limit), "global");
      },
      setShowAgentColors: (enabled: boolean) => this.setAgentLayerEntry("showAgentColors", enabled, "global"),
    },
    widget: {
      setCompact: (enabled: boolean): void => {
        this.setAgentLayerEntry("widgetCompact", enabled, "global");
      },
      setShowCompletionCards: (enabled: boolean) => this.setAgentLayerEntry("showCompletionCards", enabled, "global"),
      setMaxLines: (lines: number): void => {
        this.updatePersistedLayer("global", (layer) => {
          layer.agent ??= {};
          layer.agent.widgetMaxLines = lines;
          if (layer.agent.widgetMaxLinesCompact === undefined) {
            layer.agent.widgetMaxLinesCompact = defaultCompactLines(lines);
          }
        });
      },
      setMaxLinesCompact: (lines: number): void => {
        this.setAgentLayerEntry("widgetMaxLinesCompact", lines, "global");
      },

      setShortcut: (enabled: boolean) => this.setAgentLayerEntry("widgetShortcut", enabled, "global"),
      setShowModel: (enabled: boolean): void => {
        this.setAgentLayerEntry("widgetShowModel", enabled, "global");
      },
      setShowThinking: (enabled: boolean): void => {
        this.setAgentLayerEntry("widgetShowThinking", enabled, "global");
      },
      setNavHint: (enabled: boolean): void => {
        this.setAgentLayerEntry("widgetNavHint", enabled, "global");
      },
      setModelDisplayStyle: (style: "id" | "name"): void => {
        this.setAgentLayerEntry("modelDisplayStyle", style, "global");
      },
      setModelThinkingPlacement: (placement: ModelThinkingPlacement): void => {
        this.setAgentLayerEntry("modelThinkingPlacement", placement, "global");
      },
      setStatusBarFormat: (format: "full" | "compact"): void => {
        this.setAgentLayerEntry("statusBarFormat", format, "global");
      },
    },
    concurrency: {
      setDefault: (n: number, target: ConfigTarget = "global"): void => {
        this.applyConcurrencyWrite(target, (layer) => {
          layer.default = n;
        });
      },
      setProvider: (key: string, n: number, target: ConfigTarget = "global"): void => {
        this.applyConcurrencyWrite(target, (layer) => {
          layer.providers = { ...layer.providers, [key]: n };
        });
      },
      setModel: (key: string, n: number, target: ConfigTarget = "global"): void => {
        this.applyConcurrencyWrite(target, (layer) => {
          layer.models = { ...layer.models, [key]: n };
        });
      },
      removeProvider: (key: string, target: ConfigTarget | "all" = "global"): void => {
        this.removeConcurrencyEntry("providers", key, target);
      },
      removeDefault: (target: ConfigTarget | "all" = "global"): void => {
        this.removeConcurrencyEntry("default", undefined, target);
      },
      removeModel: (key: string, target: ConfigTarget | "all" = "global"): void => {
        this.removeConcurrencyEntry("models", key, target);
      },
      /** Remove every concurrency key at the target level; effective values fall through. */
      clearAll: (target: ConfigTarget | "all" = "global"): void => {
        this.clearAtTarget(
          target,
          () => {
            this.sessionConcurrencyLayer = {};
          },
          (layer) => {
            delete layer.concurrency;
          },
          { after: () => this.applyConcurrency() },
        );
      },
    },
    session: {
      /** Not persisted; key "default" sets the session-wide default. */
      setOverride: (type: string, model: string): void => {
        this.setAgentModelKey(type, model, "session");
      },
      clearOverride: (type: string): void => {
        delete this.sessionOverrides[type];
      },
      clearAll: (): void => {
        this.sessionOverrides = { default: null };
      },
      /** Not persisted. */
      setShowCost: (enabled: boolean): void => {
        this.sessionShowCost = enabled;
        this.widget?.setShowCost(enabled);
        this.syncWidgetStatsVisibility();
      },
      /** Revert to config value. */
      clearShowCost: (): void => {
        this.sessionShowCost = undefined;
        this.widget?.setShowCost(this.config.agent.showCost === true);
        this.syncWidgetStatsVisibility();
      },
    },
  };

  // ── ctrl+o compact sync (absorbs syncCompactFromToolsExpanded) ──

  /**
   * Toggle widget compact mode when tool expansion changes (ctrl+o), gated on
   * widgetShortcut. No-op when widgetCompact is forced on. Only acts on actual
   * state transitions (not every call).
   */
  notifyToolsExpanded(expanded: boolean): void {
    if (this.config.agent.widgetShortcut !== true) {
      this.lastToolsExpanded = expanded;
      return;
    }
    if (this.config.agent.widgetCompact === true) {
      this.lastToolsExpanded = expanded;
      return;
    }
    if (this.lastToolsExpanded !== undefined && this.lastToolsExpanded !== expanded) {
      this.widget?.setCompactMode(!expanded);
    }
    this.lastToolsExpanded = expanded;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Re-read disk, reset session overrides + toggle state, re-sync deps. Called at session_start. */
  reload(): void {
    const loaded = this.io.load();
    this.globalRaw = loaded.global;
    this.projectRaw = loaded.project;
    this.projectStatus = loaded.projectStatus;
    this.rebuildEffective();
    this.sessionOverrides = { default: null };
    this.sessionConcurrencyLayer = {};
    this.sessionShowCost = undefined;
    this.lastToolsExpanded = undefined;
    this.syncAllDeps();
  }

  /** Inject side-effect targets. Re-syncs whatever deps are present (lazy widget/manager). */
  setDeps(deps: ConfigStoreDeps): void {
    if (deps.widget !== undefined) this.widget = deps.widget;
    if (deps.manager !== undefined) this.manager = deps.manager;
    this.syncAllDeps();
  }

  /** Drop deps at session_shutdown. The widget/manager are disposed by the composition root. */
  dispose(): void {
    this.widget = undefined;
    this.manager = undefined;
  }

  // ── Private helpers ────────────────────────────────────────────

  /** Refresh persisted layers in an open menu without resetting session overrides. */
  refreshPersisted(): void {
    this.adoptPersisted(this.io.load());
  }

  /** Write an agent key against a freshly read persisted layer; undefined deletes it. */
  private setAgentLayerEntry(key: string, value: unknown, target: "global" | "project"): void {
    if (target === "project" && !this.projectTargetOffered) {
      console.warn(`[subagents] Project config target unavailable (${this.projectStatus}); change ignored`);
      return;
    }
    this.updatePersistedLayer(
      target,
      (layer) => {
        layer.agent ??= {};
        if (value === undefined) delete layer.agent[key];
        else layer.agent = { ...layer.agent, [key]: value };
      },
      { createIfMissing: target === "project" },
    );
  }

  /** Write a model key (default or per-type) at the target layer; session writes are in-memory. */
  private setAgentModelKey(key: string, value: string | null, target: ConfigTarget): void {
    if (target === "session") {
      this.sessionOverrides = { ...this.sessionOverrides, [key]: value };
      return;
    }
    this.setAgentLayerEntry(key, value, target);
  }

  /** Write a concurrency value into the target layer, then persist and re-sync the manager. */
  private applyConcurrencyWrite(target: ConfigTarget, write: (layer: RawConcurrency) => void): void {
    if (target === "session") {
      write(this.sessionConcurrencyLayer);
      this.applyConcurrency();
      return;
    }
    if (target === "project" && !this.projectTargetOffered) {
      console.warn(`[subagents] Project config target unavailable (${this.projectStatus}); change ignored`);
      return;
    }
    this.updatePersistedLayer(
      target,
      (layer) => {
        layer.concurrency ??= {};
        write(layer.concurrency!);
      },
      { createIfMissing: target === "project" },
    );
  }

  /**
   * Apply a persisted mutation to the latest target file, adopt the returned
   * layers, and re-sync every dep from the effective config. The fresh read can
   * carry other writers' changes, so syncing only the written key would leave
   * the widget and manager stale.
   */
  private updatePersistedLayer(
    target: "global" | "project",
    mutate: (layer: RawConfig) => void,
    options?: { createIfMissing?: boolean },
  ): void {
    let loaded: ReturnType<ConfigIO["load"]>;
    try {
      loaded = this.io.updateLayer(target, mutate, options);
    } catch (err) {
      // A project can become protected after confirmation but before replacement.
      // Rebuild from disk so the open menu can offer recovery while keeping Session.
      if (target === "project") this.refreshPersisted();
      throw err;
    }
    this.adoptPersisted(loaded);
  }

  private adoptPersisted(loaded: ReturnType<ConfigIO["load"]>): void {
    this.globalRaw = loaded.global;
    this.projectRaw = loaded.project;
    this.projectStatus = loaded.projectStatus;
    this.rebuildEffective();
    this.syncAllDeps();
  }

  private rebuildEffective(): void {
    this.config = mergeDefaults(mergeLayers(this.globalRaw, this.projectRaw));
  }

  private clearModelKey(key: string, target: ConfigTarget | "all"): void {
    this.clearAtTarget(
      target,
      () => {
        delete this.sessionOverrides[key];
      },
      (layer) => {
        if (layer.agent) delete layer.agent[key];
      },
      { includes: (layer) => ownEntry(layer.agent, key) !== undefined },
    );
  }

  /**
   * Clear the same model/concurrency key set at one target. Persisted writes
   * always mutate a fresh target layer; an all-layer failure reports whether
   * the first layer was already committed.
   */
  private clearAtTarget(
    target: ConfigTarget | "all",
    sessionClear: () => void,
    layerClear: (layer: RawConfig) => void,
    { after, includes = () => true }: { after?: () => void; includes?: (layer: RawConfig) => boolean } = {},
  ): void {
    if (target === "session") {
      sessionClear();
      after?.();
      return;
    }
    if (target === "all") {
      // Capture the offered layers before re-reading: a newly malformed project
      // has no readable keys but still needs to be reported as a failed Clear.
      const globalPending = includes(this.globalRaw);
      const projectPending = this.projectRaw !== null && includes(this.projectRaw);
      if (globalPending) this.updatePersistedLayer("global", layerClear);
      else if (projectPending) this.refreshPersisted();
      if (projectPending && this.projectStatus !== "absent") {
        try {
          if (this.projectStatus !== "loaded") throw new Error(`project layer is ${this.projectStatus}`);
          this.updatePersistedLayer("project", layerClear, { createIfMissing: false });
        } catch (err) {
          if (!globalPending) throw err;
          throw new Error(`Global config was cleared but project config failed: ${String(err)}`, { cause: err });
        }
      }
      sessionClear();
      after?.();
      return;
    }
    if (target === "project" && !this.projectTargetOffered) {
      if (this.projectStatus !== "absent") {
        console.warn(`[subagents] Project config target unavailable (${this.projectStatus}); change ignored`);
      }
      return;
    }
    if (target === "project" && !this.projectRaw && this.projectStatus === "absent") return;
    this.updatePersistedLayer(target, layerClear, { createIfMissing: false });
    after?.();
  }

  private removeConcurrencyEntry(
    section: "default" | "providers" | "models",
    key: string | undefined,
    target: ConfigTarget | "all",
  ): void {
    const removeFrom = (layer: RawConcurrency | undefined): void => {
      if (!layer) return;
      if (section === "default") {
        delete layer.default;
      } else if (key) {
        const entries = layer[section];
        if (entries) delete entries[key];
      }
    };
    this.clearAtTarget(
      target,
      () => removeFrom(this.sessionConcurrencyLayer),
      (layer) => removeFrom(layer.concurrency),
      { after: () => this.applyConcurrency() },
    );
  }

  private syncWidgetSettings(): void {
    const w = this.widget;
    if (!w) return;
    const a = this.agent;
    w.setForceCompact(a.widgetCompact);
    w.setWidgetShortcut(a.widgetShortcut);
    w.setMaxLines(a.widgetMaxLines);
    w.setMaxLinesCompact(a.widgetMaxLinesCompact);

    w.setNavHint(a.widgetNavHint);
    w.setFinishedRetentionMinutes(a.finishedRetentionMinutes);
    w.setModelDisplayStyle(a.modelDisplayStyle);
    w.setStatusBarFormat(a.statusBarFormat);
    w.setModelThinkingPlacement(a.modelThinkingPlacement);
  }

  private syncWidgetStatsVisibility(): void {
    const w = this.widget;
    if (!w) return;
    const a = this.agent;
    w.setStatsVisibility({
      showTools: a.showTools,
      showTurns: a.showTurns,
      showInput: a.showInput,
      showOutput: a.showOutput,
      showContext: a.showContext,
      showCost: a.showCost,
      showTime: a.showTime,
      showModel: a.widgetShowModel,
      showThinking: a.widgetShowThinking,
    });
  }

  private setAgentVisibility(
    key: "showTools" | "showTurns" | "showInput" | "showOutput" | "showContext" | "showTime",
    value: boolean,
  ): void {
    this.setAgentLayerEntry(key, value, "global");
  }

  private applyConcurrency(): void {
    this.manager?.setConcurrency(this.concurrency);
  }

  private syncAllDeps(): void {
    if (this.widget) {
      this.widget.setShowCost(this.agent.showCost);
      this.syncWidgetSettings();
      this.syncWidgetStatsVisibility();
    }
    this.applyConcurrency();
  }
}
