/**
 * config-validation.ts — Load-time validation for config files.
 *
 * One runtime schema per known key (single source of truth for rules and
 * warning text). Each invalid value is dropped from the effective config so
 * built-in defaults apply, valid keys are kept, file bytes are untouched,
 * and one loud warning per bad value names the file, key, got, expected,
 * and fix hint. Never migrates fork shapes or throws.
 */
import { Check } from "typebox/value";
import { agentKeySpec, LEGACY_AGENT_KEYS, type KeySpec } from "./agent-settings.ts";
import { isConcurrencyLimit } from "./config-layers.ts";
import type { RawConfig } from "./types.ts";

/** Received-kind label for warnings: arrays and null get their own names. */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

/** One loud warning naming file, key, got, expected, and the fix path. */
function formatIncompatibleWarning(filePath: string, keyPath: string, value: unknown, expected: string): string {
  return (
    `[subagents] Incompatible value in ${filePath}: "${keyPath}" is ${describeValue(value)}, ` +
    `expected ${expected}. Set it again in the /agents menu, or edit or delete the file to fix it.`
  );
}

/** Emit one loud warning for a dropped value. Pure formatting stays in formatIncompatibleWarning. */
function warnIncompatible(filePath: string, keyPath: string, value: unknown, expected: string): void {
  console.warn(formatIncompatibleWarning(filePath, keyPath, value, expected));
}

/** Plain-object guard, shared with config-io for its project malformed checks. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Expected-shape label for JSON-object sections. */
const EXPECTED_OBJECT = "object";

/**
 * Check a value against one known key's rule. Never throws: TypeBox is an
 * external call at a file-load boundary, so a missed check warns and drops
 * instead of crashing the load.
 */
function isValidValue(spec: KeySpec, value: unknown): boolean {
  try {
    return Check(spec.schema, value);
  } catch {
    return false;
  }
}

/**
 * Validate one raw file layer, dropping invalid values from the result.
 * Pure except for one console.warn per dropped value. Never throws on
 * bad input: unknown shapes fall back to empty sections.
 */
export function validateRawLayer(raw: unknown, filePath: string): RawConfig {
  const cleaned: RawConfig = {};
  if (!isPlainObject(raw)) {
    warnIncompatible(filePath, "(config)", raw, EXPECTED_OBJECT);
    return cleaned;
  }

  if (raw.agent !== undefined) {
    if (!isPlainObject(raw.agent)) {
      warnIncompatible(filePath, "agent", raw.agent, EXPECTED_OBJECT);
    } else {
      const agent = cleanAgentEntries(raw.agent, filePath);
      if (Object.keys(agent).length > 0) cleaned.agent = agent;
    }
  }

  if (raw.concurrency !== undefined) {
    const concurrency = cleanConcurrencySection(raw.concurrency, filePath);
    if (Object.keys(concurrency).length > 0) cleaned.concurrency = concurrency;
  }

  return cleaned;
}

/**
 * Keep valid agent entries, warn and drop the rest. Unknown keys are
 * per-type model keys; legacy keys vanish quietly.
 */
function cleanAgentEntries(agent: Record<string, unknown>, filePath: string): Record<string, unknown> {
  const kept: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(agent)) {
    if (LEGACY_AGENT_KEYS.has(key)) continue;
    if (value === undefined) continue;
    const spec = agentKeySpec(key);
    if (isValidValue(spec, value)) kept[key] = value;
    else warnIncompatible(filePath, `agent.${key}`, value, spec.expected);
  }
  return kept;
}

/**
 * Keep valid concurrency entries, warn and drop the rest.
 */
function cleanConcurrencySection(concurrency: unknown, filePath: string): NonNullable<RawConfig["concurrency"]> {
  const kept: NonNullable<RawConfig["concurrency"]> = {};
  if (!isPlainObject(concurrency)) {
    warnIncompatible(filePath, "concurrency", concurrency, EXPECTED_OBJECT);
    return kept;
  }
  if (concurrency.default !== undefined) {
    if (isConcurrencyLimit(concurrency.default)) kept.default = concurrency.default;
    else warnIncompatible(filePath, "concurrency.default", concurrency.default, "positive integer");
  }
  for (const section of ["providers", "models"] as const) {
    const entries = concurrency[section];
    if (entries === undefined) continue;
    if (!isPlainObject(entries)) {
      warnIncompatible(filePath, `concurrency.${section}`, entries, EXPECTED_OBJECT);
      continue;
    }
    const keptEntries: Record<string, number> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (isConcurrencyLimit(value)) keptEntries[key] = value;
      else warnIncompatible(filePath, `concurrency.${section}.${key}`, value, "positive integer");
    }
    if (Object.keys(keptEntries).length > 0) kept[section] = keptEntries;
  }
  return kept;
}
