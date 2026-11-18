import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents/types.ts";
import { getPiDefaultThinkingLevel, getPiModelThinkingLevels } from "../pi-settings.ts";
import { clampThinkingToModel, resolveDisplayedThinking, resolveThinkingLevel } from "../models/thinking-resolution.ts";
import type { ConfigStore } from "../config/config-store.ts";
import { getStore, type ExtensionOwner } from "../shell.ts";
import type { ThinkingChoice } from "../types.ts";
import { findModelInRegistry } from "../utils.ts";
import { computeSpawnTarget, surfaceSpawnTargetWarnings, type SpawnTarget } from "./spawn-target.ts";

type ValidTarget = Extract<SpawnTarget, { ok: true }>;

export interface SpawnSelection {
  type: string;
  agentConfig?: AgentConfig;
  target: ValidTarget;
}

export type SpawnModelChoice = { kind: "default" } | { kind: "parent" } | { kind: "explicit"; name: string };

export function toolModelChoice(value: unknown): SpawnModelChoice {
  return typeof value === "string" && value.length ? { kind: "explicit", name: value } : { kind: "default" };
}

/** Validate and resolve the selection before any model or settings reads. */
export async function resolveSpawnSelection(
  owner: ExtensionOwner,
  ctx: ExtensionContext,
  type: string,
  path: unknown,
  { preview = false }: { preview?: boolean } = {},
): Promise<SpawnSelection> {
  const generation = owner.generation;
  const target = await computeSpawnTarget(owner, ctx, path);
  assertCurrent();
  if (!preview) surfaceSpawnTargetWarnings(ctx.ui, target);
  if (!target.ok) throw new Error(target.error);

  const dir = target.projectTrusted && target.resolvedPath ? `${target.resolvedPath}/.pi/agents` : undefined;
  const resolution = await owner.registry.resolveTypeOrDiscover(type, dir);
  assertCurrent();
  if (resolution.kind === "ambiguous") {
    throw new Error(
      `Ambiguous agent type: ${type}. Candidates: ${resolution.candidates.join(", ")}. Use the exact registered name.`,
    );
  }
  if (resolution.kind === "not-found") throw new Error(`Unknown agent type: ${type}`);
  return { type: resolution.key, agentConfig: owner.registry.getAgentConfig(resolution.key, dir), target };

  function assertCurrent() {
    if (generation !== owner.generation) throw new Error("Subagents session changed while resolving the agent type");
  }
}

export class SpawnModelUnavailableError extends Error {
  constructor(model: string) {
    super(`Model not found: ${model}`);
  }
}

function findAvailableModel(name: string, registry: ExtensionContext["modelRegistry"]) {
  const model = findModelInRegistry(name, registry, undefined);
  return model && registry.getAvailable().some((entry) => entry.provider === model.provider && entry.id === model.id)
    ? model
    : undefined;
}

function resolveSpawnModel(
  store: ConfigStore,
  ctx: ExtensionContext,
  { type, agentConfig }: SpawnSelection,
  choice: SpawnModelChoice,
) {
  if (choice.kind === "explicit") {
    const model = findAvailableModel(choice.name, ctx.modelRegistry);
    if (!model) throw new SpawnModelUnavailableError(choice.name);
    return model;
  }
  const parent = ctx.model;
  if (choice.kind === "parent") return parent;
  const parentKey = parent ? `${parent.provider}/${parent.id}` : "";
  const configured = store.modelFor(type, parentKey, agentConfig);
  if (!configured || configured === parentKey) return parent;
  return findAvailableModel(configured, ctx.modelRegistry) ?? parent;
}

/** Resolve against the current parent/model registry and the selected target's Pi settings. */
export function resolveSpawnChoices(
  store: ConfigStore,
  ctx: ExtensionContext,
  selection: SpawnSelection,
  modelChoice: SpawnModelChoice,
  explicit: ThinkingChoice | undefined,
) {
  const { agentConfig, target } = selection;
  const model = resolveSpawnModel(store, ctx, selection, modelChoice);

  const modelKey = model ? `${model.provider}/${model.id}` : undefined;
  const cwd = target.resolvedPath ?? ctx.cwd;
  const scope = { projectTrusted: target.projectTrusted };
  const sources = {
    explicit,
    frontmatter: agentConfig?.thinkingLevel,
    perModel: modelKey ? getPiModelThinkingLevels(cwd, scope)[modelKey] : undefined,
    defaultThinking: store.agent.defaultThinking,
    parentLevel: ctx.thinkingLevel,
  };
  const configuredThinking = resolveThinkingLevel(sources);
  // When neither Spawn nor its parent has a model, Pi chooses the initial
  // model and applies per-model Thinking. A subagent default must wait for
  // that model so it cannot override its per-model setting.
  const modelIndependentThinking = resolveThinkingLevel({ ...sources, defaultThinking: undefined });
  const deferredDefaultThinking = !model && modelIndependentThinking === undefined ? configuredThinking : undefined;
  const thinkingLevel = model
    ? configuredThinking === undefined
      ? undefined
      : clampThinkingToModel(model, configuredThinking)
    : modelIndependentThinking;
  const selectedThinking = explicit === "parent" ? ctx.thinkingLevel : explicit;
  return {
    model,
    modelKey,
    thinkingLevel,
    deferredDefaultThinking,
    // Pi owns its own fallback when every configured source is absent.
    displayThinking: () => resolveDisplayedThinking(sources, getPiDefaultThinkingLevel(cwd, scope), model),
    explicitThinkingLevel: selectedThinking === undefined ? undefined : clampThinkingToModel(model, selectedThinking),
  };
}

export async function resolveSpawn(
  owner: ExtensionOwner,
  ctx: ExtensionContext,
  type: string,
  path: unknown,
  model: SpawnModelChoice,
  thinking: ThinkingChoice | undefined,
) {
  const store = getStore(owner);
  const selection = await resolveSpawnSelection(owner, ctx, type, path);
  return prepareResolvedSpawn(store, ctx, selection, model, thinking);
}

export function prepareResolvedSpawn(
  store: ConfigStore,
  ctx: ExtensionContext,
  selection: SpawnSelection,
  model: SpawnModelChoice,
  thinking: ThinkingChoice | undefined,
) {
  const choices = resolveSpawnChoices(store, ctx, selection, model, thinking);
  return {
    type: selection.type,
    agentConfig: selection.agentConfig,
    worktreePath: selection.target.resolvedPath,
    worktreeLabel: selection.target.worktreeLabel,
    projectTrusted: selection.target.projectTrusted,
    model: choices.model,
    modelKey: choices.modelKey,
    thinkingLevel: choices.thinkingLevel,
    deferredDefaultThinking: choices.deferredDefaultThinking,
  };
}
