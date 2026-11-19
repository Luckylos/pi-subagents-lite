import type { ExtensionOwner } from "../shell.ts";
import { formatStopReason } from "../status-note.ts";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination and live-view tracking live in spawn-coordinator.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.ts";
import { SHORT_ID_LENGTH } from "../types.ts";
import { captureResultStats, formatResultStats, formatTerminalContent } from "./agent-result.ts";
import { resolveSpawn, toolModelChoice } from "../spawn/spawn-resolution.ts";
import { prepareSpawnIntent } from "../spawn/spawn-preparation.ts";
import { parseThinkingChoice } from "../utils.ts";
import { getPiInstance, getStore, getCoordinator, getManager } from "../shell.ts";
import { canRequestStop, displayAgentStatus, formatAgentStatusList, stopRequestedText } from "./agent-status.ts";
import { invalidateAgentRow } from "../ui/renderer.ts";
import { plainText } from "../ui/sanitize.ts";

// --- Tool result helpers ---

function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

/**
 * Build a details record from an AgentRecord. Always includes type and
 * description; includeStatus adds status/outputFile/stopReason, includeStats
 * adds turn/token/cost/context/compaction/model fields.
 */
export function buildAgentDetails(
  record: AgentRecord,
  opts?: { includeStats?: boolean; includeStatus?: boolean },
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    type: record.display.type,
    description: record.display.description,
  };

  if (record.display.worktreePath) {
    details.worktreePath = record.display.worktreePath;
  }

  if (opts?.includeStatus) {
    details.status = record.lifecycle.status;
    details.outputFile = record.display.outputFile;
    const stopReason = formatStopReason(record.lifecycle);
    if (stopReason) details.stopReason = stopReason;
  }

  if (opts?.includeStats) {
    const elapsedMs = record.lifecycle.completedAt ? record.lifecycle.completedAt - record.lifecycle.startedAt : 0;

    Object.assign(details, formatResultStats(captureResultStats(record), elapsedMs));
  }

  return details;
}

/** Result text plus status note, for display. */
export function formatResultContent(record: AgentRecord): string {
  return formatTerminalContent({ ...record.lifecycle, result: record.result, error: record.error });
}

// --- Tool execute handlers ---

export async function executeAgentTool(
  owner: ExtensionOwner,
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  // Capture the session resources before any await. On-demand discovery can
  // outlive a /new or /reload; it must never continue against the replacement.
  const generation = owner.generation;
  const store = getStore(owner);
  const coordinator = getCoordinator(owner);
  if (!coordinator) throw new Error("Subagents session has not started");
  const assertCurrentSession = (): void => {
    if (owner.generation !== generation || owner.store !== store || owner.coordinator !== coordinator) {
      throw new Error("Subagents session changed while resolving the agent type");
    }
  };

  const spawn = await resolveSpawn(
    owner,
    ctx,
    (params.agent as string) || "general-purpose",
    params.worktree_path,
    toolModelChoice(params.model),
    parseThinkingChoice(params.thinking as string | undefined),
  );
  assertCurrentSession();

  const prompt = params.prompt as string;
  const description =
    (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  const maxTurns =
    (params.max_turns as number | undefined) ?? spawn.agentConfig?.maxTurns ?? store.agent.defaultMaxTurns;

  // Background spawns (explicit or forceBackground) never bind to the parent
  // run's interrupt signal — only foreground spawns can be interrupted.
  const isBackground = runInBackground || store.agent.forceBackground;

  const result = await coordinator.spawn(
    getPiInstance(owner),
    ctx,
    prepareSpawnIntent({
      ...spawn,
      prompt,
      description,
      maxTurns,
      graceTurns: store.agent.graceTurns,
      runInBackground: isBackground,
      signal: isBackground ? undefined : signal,
    }),
  );

  const { agentId, record } = result;
  if (_toolCallId) record.display.toolCallId = _toolCallId;

  if (isBackground) {
    const suffix = `Success! You delegated to an agent. A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!\n\nAgent ID: ${agentId}`;
    const label =
      record.lifecycle.phase === "stopping"
        ? "Agent stopping"
        : record.lifecycle.status === "queued"
          ? "Agent queued"
          : "Agent running";
    const details = buildAgentDetails(record);
    details.agentId = agentId;
    details.status = record.lifecycle.status;
    return successResult(`[${label}] ${suffix}`, details);
  }

  // The coordinator awaits the parent gate, which Stop can open before execution settles.
  const details = buildAgentDetails(record, { includeStats: true });
  if (record.lifecycle.phase === "stopping") return successResult(stopRequestedText(record), details);

  if (record.lifecycle.status === "error") {
    throw new Error(`Agent failed: ${record.error || "unknown error"}`);
  }

  return successResult(formatResultContent(record), details);
}

// --- Agent id resolution and failure lists, shared by the agent tools ---

/** The id form tool output prints and the model quotes back (ADR-0010). */
function shortId(record: AgentRecord): string {
  return record.id.slice(0, SHORT_ID_LENGTH);
}

/**
 * Build a compact list of running (or queued) agents.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 */
function formatRunningAgents(owner: ExtensionOwner): string {
  const agents = getManager(owner)!.listAgents().filter(canRequestStop);

  if (agents.length === 0) return "none";

  return agents.map((a) => `${shortId(a)} (${a.display.type})`).join(", ");
}

/**
 * Resolve tool input to exactly one retained record: exact id, else an unambiguous
 * prefix (ADR-0010). A blank id is a missing id, so resolution never sees a prefix
 * that matches every record; ambiguity names every candidate by full id, the only
 * place full ids are printed. `notFoundDetail` names the agents the calling tool can
 * act on, because stop and message have opposite preconditions.
 */
function resolveAgent(owner: ExtensionOwner, agentId: unknown, notFoundDetail: () => string): AgentRecord {
  const id = (agentId as string | undefined)?.trim() ?? "";
  if (!id) throw new Error("agent_id is required");

  const matches = getManager(owner)!.matchAgents(id);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous agent id ${id}. Matching agents: ${matches.map((m) => m.id).join(", ")}. Use a longer id.`,
    );
  }
  throw new Error(`Agent ${id} not found. ${notFoundDetail()}`);
}

// --- StopAgent execute handler ---

export async function executeStopAgentTool(
  owner: ExtensionOwner,
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const manager = getManager(owner)!;
  const record = resolveAgent(owner, params.agent_id, () => `Running agents: ${formatRunningAgents(owner)}`);

  if (!canRequestStop(record)) {
    const state = displayAgentStatus(record.lifecycle);
    const status = record.lifecycle.phase === "settling" ? "settling" : state;
    return successResult(
      `Agent ${shortId(record)} is already ${status}. Running agents: ${formatRunningAgents(owner)}`,
    );
  }

  if (manager.abort(record.id, "agent")) {
    invalidateAgentRow(owner, record.id);
    return successResult(
      record.lifecycle.status === "stopped" ? `Stopped agent ${shortId(record)}` : stopRequestedText(record),
    );
  }

  throw new Error(`Failed to stop agent ${shortId(record)}`);
}

// --- MessageAgent execute handler ---

/** Bounded list of every retained agent, settled ones included: a message needs a
 * live session, not a run, so the addressable set is wider than StopAgent's.
 */
function formatKnownAgents(owner: ExtensionOwner): string {
  const agents = getManager(owner)!.listAgents();
  if (agents.length === 0) return "none";
  return formatAgentStatusList(agents, getStore(owner).agent.agentStatusLimit);
}

/**
 * Give an existing agent more input through the manager's steer/continue seam: a
 * running target takes the message at its next turn boundary, a settled target with
 * a live session restarts on it. No agent is created and no queue is owned here. The
 * report names what was queued, never a promise that it was read before the run ended.
 */
export async function executeMessageAgentTool(
  owner: ExtensionOwner,
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const text = (params.message as string | undefined)?.trim() ?? "";
  if (!text) throw new Error("message is required");

  const record = resolveAgent(owner, params.agent_id, () => `Known agents: ${formatKnownAgents(owner)}`);
  const manager = getManager(owner);
  if (!manager) throw new Error("Subagents session has not started");
  const result = await manager.submitMessage(record.id, text);
  if (!result.accepted) {
    if (result.reason === "unavailable" && !record.execution.session && !canRequestStop(record)) {
      return successResult(
        `Agent ${shortId(record)} is ${displayAgentStatus(record.lifecycle)} with no live session. Message not sent.`,
        { reason: result.reason },
      );
    }
    throw new Error(`Failed to send message to agent ${shortId(record)}. ${plainText(result.message)}`);
  }

  const { agentId, runId, delivery } = result;
  const report = {
    steer: "Sent (steered)",
    pending_steer: "Accepted (pending steer; waiting for session startup)",
    continuation: "Sent (continued)",
  }[delivery];
  return successResult(report, { agentId, runId, delivery });
}
