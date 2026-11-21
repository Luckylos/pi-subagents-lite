import type { RunTunables } from "../types.ts";

type RunLimits = Pick<RunTunables, "maxTurns" | "maxTokens">;

/** Resolve limits against the selected agent type. Zero is an explicit unlimited choice. */
export function resolveSpawnLimits(
  explicit: RunLimits,
  agentConfig: RunLimits | undefined,
  defaultMaxTurns?: number,
): RunLimits {
  return {
    maxTurns: explicit.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns,
    maxTokens: explicit.maxTokens ?? agentConfig?.maxTokens,
  };
}

/** Normalize a resolved turn limit for execution and display. */
export function normalizeMaxTurns(maxTurns: number | undefined): number | undefined {
  if (maxTurns == null || maxTurns === 0) return undefined;
  return Math.max(1, maxTurns);
}
