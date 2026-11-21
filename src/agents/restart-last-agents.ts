import type { ExtensionOwner } from "../shell.ts";
/**
 * restart-last-agents.ts — Find and replay Agent tool calls from session history.
 *
 * Reads the current session's entry list, locates the most recent assistant
 * message containing Agent tool calls, and replays them via the coordinator.
 * Agents already running or queued are skipped.
 */

import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UICtx } from "../ui/agent-widget.ts";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { getCoordinator, getManager, getPiInstance, getStore, getWidget } from "../shell.ts";
import type { AgentRecord } from "../types.ts";
import { parseModelKey, parseThinkingChoice } from "../utils.ts";
import type { AgentManager } from "./agent-manager.ts";

import { prepareResolvedSpawn, resolveSpawnSelection, toolModelChoice } from "../spawn/spawn-resolution.ts";
import { prepareSpawnIntent } from "../spawn/spawn-preparation.ts";
import type { SpawnCoordinator } from "../spawn/spawn-coordinator.ts";

// History spans optional, strict-nullable, and older internal tool arguments.
const optionalString = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const historicalAgentCall = Type.Object({
  prompt: Type.String(),
  description: optionalString,
  agent: optionalString,
  // The shared target resolver treats non-string paths as omitted, as on live calls.
  worktree_path: Type.Optional(Type.Unknown()),
  run_in_background: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  model: optionalString,
  _modelOverride: optionalString,
  thinking: optionalString,
  max_turns: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});
export type AgentCallParams = Static<typeof historicalAgentCall>;

/** Result of a restart attempt. */
export interface RestartResult {
  restarted: string[];
  skipped: string[];
}

/**
 * Find Agent tool calls from the most recent assistant message in session entries.
 *
 * Returns the arguments of every `Agent` tool call found in the latest assistant
 * message that contains at least one. Returns an empty array if none exist.
 */
export function findLastAgentCallsFromEntries(entries: SessionEntry[]): unknown[] {
  // Walk backwards to find the most recent assistant message with Agent tool calls.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;

    const agentCalls: unknown[] = [];
    for (const block of msg.content) {
      if (block?.type === "toolCall" && block.name === "Agent") {
        agentCalls.push(block.arguments);
      }
    }

    if (agentCalls.length > 0) return agentCalls;
  }
  return [];
}

function agentCallDescription(call: AgentCallParams): string {
  if (call.description) return call.description;
  const firstLine = call.prompt.split("\n")[0];
  return firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine || call.prompt.slice(0, 80);
}

/** User-facing label for a skipped call: "type: description (reason)". */
function skippedCallLabel(call: AgentCallParams, reason: string): string {
  return `${call.agent || "general-purpose"}: ${agentCallDescription(call)} (${reason})`;
}

interface RestartBatch {
  manager: AgentManager;
  initiallyActive: Set<string>;
  restartedIds: Set<string>;
}

function isActiveAgent({ lifecycle }: AgentRecord): boolean {
  return lifecycle.status === "running" || lifecycle.status === "queued";
}

/** Resolve and spawn a single agent from historical parameters. */
async function resolveAndSpawn(
  owner: ExtensionOwner,
  call: AgentCallParams,
  ctx: ExtensionCommandContext,
  batch: RestartBatch,
  coordinator: SpawnCoordinator,
  pi: ExtensionAPI,
): Promise<{ restarted: string } | { skipped: string }> {
  coordinator.assertCurrentParent(ctx);
  const type = call.agent || "general-purpose";
  const description = agentCallDescription(call);
  if (batch.initiallyActive.has(`${type}::${description}`)) {
    return { skipped: skippedCallLabel(call, "already running") };
  }

  const store = getStore(owner);
  let spawn: ReturnType<typeof prepareResolvedSpawn>;
  try {
    const selection = await resolveSpawnSelection(owner, ctx, type, call.worktree_path, { coordinator });
    coordinator.assertCurrentParent(ctx);
    // Independent spawns can enter the manager during resolution. Replays from
    // this batch must leave the remaining historical calls eligible to launch.
    if (
      batch.initiallyActive.has(`${selection.type}::${description}`) ||
      batch.manager
        .listAgents()
        .some(
          (agent) =>
            agent.display.type === selection.type &&
            agent.display.description === description &&
            !batch.restartedIds.has(agent.id) &&
            isActiveAgent(agent),
        )
    ) {
      return { skipped: skippedCallLabel(call, "already running") };
    }
    // Pi saves original arguments. The old render marker matched the ID of
    // an injected model. Restart recomputed that model and replayed the stored
    // Thinking value, whose provenance is ambiguous in legacy records.
    const recordedModel = parseModelKey(call.model);
    const inferredModel = recordedModel && recordedModel.modelId === call._modelOverride;
    spawn = prepareResolvedSpawn(
      store,
      ctx,
      selection,
      toolModelChoice(inferredModel ? undefined : call.model),
      parseThinkingChoice(call.thinking ?? undefined),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = /^(?:Unknown|Ambiguous) agent type:/.test(message) ? "unknown type" : message;
    return { skipped: skippedCallLabel(call, reason) };
  }

  // Prepare the widget only once there is a current launch to display.
  coordinator.assertCurrentParent(ctx);
  const widget = getWidget(owner);
  // SAFETY: Pi's UI supplies the setStatus and setWidget operations used by AgentWidget.
  widget?.setUICtx(ctx.ui as unknown as UICtx);

  const { agentId } = await coordinator.spawn(
    pi,
    ctx,
    prepareSpawnIntent({
      ...spawn,
      prompt: call.prompt,
      description,
      maxTurns: call.max_turns ?? undefined,
      defaultMaxTurns: store.agent.defaultMaxTurns,
      graceTurns: store.agent.graceTurns,
      runInBackground: true,
    }),
  );
  batch.restartedIds.add(agentId);
  return { restarted: `${spawn.type}: ${description}` };
}

/**
 * Restart agents from the most recent Agent tool calls in session history.
 *
 * Skips overlapping batches in the same parent and calls whose type and
 * description match an active agent outside the batch.
 */
export async function handleRestartLastAgents(
  owner: ExtensionOwner,
  ctx: ExtensionCommandContext,
  coordinator = getCoordinator(owner),
): Promise<RestartResult> {
  if (!coordinator?.isCurrentParent(ctx)) return { restarted: [], skipped: [] };
  if (owner.restartInProgress === coordinator) return { restarted: [], skipped: ["Restart already in progress"] };

  owner.restartInProgress = coordinator;
  try {
    const calls = findLastAgentCallsFromEntries(ctx.sessionManager.getEntries());
    const manager = getManager(owner);
    if (calls.length === 0 || !manager) return { restarted: [], skipped: [] };
    const pi = getPiInstance(owner);
    const batch: RestartBatch = {
      manager,
      initiallyActive: new Set(
        manager
          .listAgents()
          .filter(isActiveAgent)
          .map((agent) => `${agent.display.type}::${agent.display.description}`),
      ),
      restartedIds: new Set(),
    };
    const restarted: string[] = [];
    const skipped: string[] = [];

    for (const [index, call] of calls.entries()) {
      if (!Check(historicalAgentCall, call)) {
        skipped.push(`Agent call #${index + 1} (invalid arguments)`);
        continue;
      }
      try {
        const result = await resolveAndSpawn(owner, call, ctx, batch, coordinator, pi);
        if ("restarted" in result) restarted.push(result.restarted);
        else skipped.push(result.skipped);
      } catch (err) {
        skipped.push(skippedCallLabel(call, `spawn failed: ${String(err).slice(0, 80)}`));
      }
    }

    return { restarted, skipped };
  } finally {
    // A replacement session may already own a new batch.
    if (owner.restartInProgress === coordinator) owner.restartInProgress = undefined;
  }
}
