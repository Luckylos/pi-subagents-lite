import type { AgentInvocation } from "../agents/types.ts";
import type { SpawnConfig } from "../types.ts";

/**
 * Input for SpawnCoordinator.spawn(). Callers resolve their own source-specific
 * values, then this module builds the common intent and display metadata.
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
  /**
   * Menu invocations historically record the selected run mode; tool and
   * replay invocations omit it. Keep that representation difference explicit.
   */
  includeRunModeInInvocation?: boolean;
}

/** Build one normalized spawn intent from already-resolved caller values. */
export function prepareSpawnIntent(input: SpawnPreparationInput): SpawnIntent {
  const { includeRunModeInInvocation = false, model, maxTurns, thinkingLevel, runInBackground, ...rest } = input;

  const invocation: AgentInvocation = {
    modelName: model?.id,
    thinkingLevel,
    maxTurns,
  };
  if (includeRunModeInInvocation) {
    invocation.runInBackground = runInBackground;
  }

  return {
    ...rest,
    model,
    maxTurns,
    thinkingLevel,
    runInBackground,
    invocation,
  };
}
