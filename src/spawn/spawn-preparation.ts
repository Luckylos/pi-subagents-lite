import type { AgentInvocation } from "../agents/types.ts";
import type { SpawnConfig } from "../types.ts";
import { normalizeMaxTurns, resolveSpawnLimits } from "../agents/run-limits.ts";

/**
 * Input for SpawnCoordinator.spawn(), with caller-specific choices and limits
 * resolved after target and agent type selection.
 */
export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  runInBackground: boolean;
  /**
   * Parent run's interrupt signal, forwarded to the manager for foreground
   * spawns only. Background and menu-wizard spawns never carry one.
   */
  signal?: AbortSignal;
  /** Narrowed to required — all callers resolve this before spawn. */
  graceTurns: number;
}

export interface SpawnPreparationInput extends Omit<SpawnIntent, "invocation"> {
  defaultMaxTurns?: number;
  /**
   * Menu invocations historically record the selected run mode; tool and
   * replay invocations omit it. Keep that representation difference explicit.
   */
  includeRunModeInInvocation?: boolean;
}

/** Build one spawn intent and its display metadata after target and type selection. */
export function prepareSpawnIntent(input: SpawnPreparationInput): SpawnIntent {
  const { includeRunModeInInvocation = false, defaultMaxTurns, model, thinkingLevel, runInBackground, ...rest } = input;
  const limits = resolveSpawnLimits(rest, rest.agentConfig, defaultMaxTurns);

  const invocation: AgentInvocation = {
    modelName: model?.id,
    thinkingLevel,
    maxTurns: normalizeMaxTurns(limits.maxTurns),
  };
  if (includeRunModeInInvocation) {
    invocation.runInBackground = runInBackground;
  }

  return {
    ...rest,
    ...limits,
    model,
    thinkingLevel,
    runInBackground,
    invocation,
  };
}
