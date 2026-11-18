import type { AgentLifecycle, AgentRecord, RunResultStats } from "../types.ts";
import { getStatusNote } from "../status-note.ts";
import { getSessionContextPercent } from "./usage.ts";

/** Copy the stats needed to format a tool result or a completion notification. */
export function captureResultStats(record: AgentRecord): RunResultStats {
  const { stats, display } = record;
  const session = record.execution.session;
  return Object.freeze({
    lifetimeUsage: Object.freeze({ ...stats.lifetimeUsage }),
    turnCount: stats.turnCount,
    maxTurns: stats.maxTurns,
    toolUses: stats.toolUses,
    contextPercent: getSessionContextPercent(session),
    compactionCount: stats.compactionCount,
    modelName: session?.model?.name ?? display.invocation?.modelName,
    modelId: session?.model?.id ?? display.invocation?.modelName,
    thinkingLevel: session?.thinkingLevel ?? display.invocation?.thinkingLevel,
  });
}

export function formatResultStats(stats: RunResultStats, elapsedMs: number): Record<string, unknown> {
  return {
    turnCount: stats.turnCount,
    maxTurns: stats.maxTurns,
    toolUses: stats.toolUses,
    input: stats.lifetimeUsage.input,
    output: stats.lifetimeUsage.output,
    contextPercent: stats.contextPercent,
    durationMs: elapsedMs,
    compactions: stats.compactionCount,
    modelName: stats.modelName,
    modelId: stats.modelId,
    thinkingLevel: stats.thinkingLevel,
    cost: stats.lifetimeUsage.cost,
  };
}

type ResultContent = Pick<AgentLifecycle, "status" | "started" | "stoppedBy" | "stopDetail"> &
  Pick<AgentRecord, "result" | "error">;

/** Shared text and separators for the foreground tool result and completion notification. */
export function formatTerminalContent(result: ResultContent): string {
  const errorNote = result.status === "error" && result.error ? `\n\nError: ${result.error}` : "";
  return (result.result ?? "") + errorNote + getStatusNote(result);
}
