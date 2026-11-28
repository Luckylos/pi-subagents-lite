import { DEFAULT_AGENT, isAgentModelKey, LEGACY_AGENT_KEYS } from "./agent-settings.ts";
import type { RawConcurrency, RawConfig, SubagentsConfig } from "./types.ts";

/** Default concurrency config — used when no layer specifies a limit. */
export const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = { default: 4 };

export function isConcurrencyLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Merge the two raw layers into one raw config: project keys win, absent keys
 * inherit from global. Project agent keys that are not model keys are dropped
 * (they were warned about at load). Concurrency merges per entry: default
 * wins, providers/models combine. Pure — no I/O.
 */
export function mergeLayers(global: RawConfig, project: RawConfig | null): RawConfig {
  const agent = {
    ...global.agent,
    ...Object.fromEntries(Object.entries(project?.agent ?? {}).filter(([key]) => isAgentModelKey(key))),
  };
  return { agent, concurrency: mergeRawConcurrency(global.concurrency, project?.concurrency) };
}

/**
 * Merge raw concurrency layers, highest priority last. Never emits an explicit
 * undefined default: an explicit `default: undefined` would override the baked
 * default in mergeDefaults' spread.
 */
export function mergeRawConcurrency(...layers: Array<RawConcurrency | undefined>): RawConcurrency {
  const out: RawConcurrency = {};
  const providers: Record<string, number> = {};
  const models: Record<string, number> = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.default !== undefined) out.default = layer.default;
    Object.assign(providers, layer.providers ?? {});
    Object.assign(models, layer.models ?? {});
  }
  if (Object.keys(providers).length > 0) out.providers = providers;
  if (Object.keys(models).length > 0) out.models = models;
  return out;
}

/** Bake hardcoded defaults into a raw config; normalize legacy keys on it. */
export function mergeDefaults(raw: RawConfig): SubagentsConfig {
  // Spread form (not an explicit default key) so the loaded value wins
  // without triggering TS2783; identical runtime semantics. Values come from
  // JSON, so the casts are honest at this boundary.
  const concurrency = {
    ...DEFAULT_CONCURRENCY,
    ...raw.concurrency,
  } as SubagentsConfig["concurrency"];
  const agent = { ...DEFAULT_AGENT, ...raw.agent } as SubagentsConfig["agent"];
  // Legacy pre-ADR-0006 key: normalize without error, touching no other keys (US-15).
  for (const key of LEGACY_AGENT_KEYS) delete agent[key];
  return {
    agent,
    concurrency,
  };
}

export function clearAgentModelKeys(layer: RawConfig): void {
  if (!layer.agent) return;
  for (const key of Object.keys(layer.agent)) {
    if (isAgentModelKey(key)) delete layer.agent[key];
  }
}
