/**
 * model-precedence.ts — Model resolution with explicit precedence.
 *
 * Pure function — no side effects, no file I/O, no pi SDK imports.
 *
 * Precedence chain (highest to lowest):
 *   1. sessionOverrides[subagentType]  (session per-type override)
 *   2. sessionOverrides["default"]     (session global default)
 *   3. config.agent[subagentType]      (config per-type override)
 *   4. config.agent["default"]         (config global default)
 *   5. agentConfig?.model              (agent config / frontmatter)
 *   6. parentModelId                   (inherit from parent)
 */

import type { SubagentsConfig } from "../config/types.ts";

/**
 * Session-only model overrides: "default" plus per-agent-type entries.
 * Not persisted — cleared on session_start.
 */
export interface SessionModelOverrides {
  default: string | null;
  [agentType: string]: string | null | undefined;
}

export interface ResolveModelOptions {
  /** The type of subagent being spawned. */
  subagentType: string;
  /** The agent's config (from .md frontmatter or defaults). */
  agentConfig?: { model?: string };
  /** The subagents-lite.json config (model overrides); only the agent section is read. */
  config: Pick<SubagentsConfig, "agent">;
  /** The parent agent's model ID (final fallback). */
  parentModelId: string;
  /** Session-only overrides (checked first). */
  sessionOverrides?: SessionModelOverrides;
}

/** Which chain position won resolution (see resolveModelSource). */
export type ModelSource =
  | "session-per-type"
  | "session-default"
  | "config-per-type"
  | "config-default"
  | "frontmatter"
  | "parent";

/**
 * Resolve the model for a subagent invocation and report which chain
 * position won. resolveModel() is the model-only projection; callers that
 * need the winning layer (the Model settings menu's provenance tags) use
 * this instead of re-deriving precedence from the inputs.
 *
 * Returns the first non-null, non-undefined, non-empty-string value
 * from the precedence chain; parentModelId (always valid) is the final
 * fallback.
 */
export function resolveModelSource(options: ResolveModelOptions): { model: string; source: ModelSource } {
  const { subagentType, agentConfig, config, parentModelId, sessionOverrides } = options;

  // Cast agent values: index signature includes number (graceTurns), but models are always strings
  const candidates: Array<[ModelSource, string | null | undefined]> = [
    ["session-per-type", sessionOverrides?.[subagentType]],
    ["session-default", sessionOverrides?.["default"]],
    ["config-per-type", config.agent[subagentType] as string | null | undefined],
    ["config-default", config.agent["default"]],
    ["frontmatter", agentConfig?.model],
  ];
  for (const [source, value] of candidates) {
    if (isValidModelValue(value)) return { model: value, source };
  }
  // Parent model id is the final fallback (always a valid string).
  return { model: parentModelId, source: "parent" };
}

/**
 * Resolve the model for a subagent invocation — model-only projection of
 * resolveModelSource() for callers that do not need the winning source.
 */
export function resolveModel(options: ResolveModelOptions): string {
  return resolveModelSource(options).model;
}

/** True when the value is a usable model string (null/undefined/empty are unset). */
export function isValidModelValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
