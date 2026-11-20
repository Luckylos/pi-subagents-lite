import type { ExtensionOwner } from "../shell.ts";
/**
 * restart-last-agents.ts — Find and replay Agent tool calls from session history.
 *
 * Reads the current session's entry list, locates the most recent assistant
 * message containing Agent tool calls, and replays them via the coordinator.
 * Running agents are skipped.
 */

import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UICtx } from "../ui/agent-widget.ts";
import type { ToolCall } from "@earendil-works/pi-ai";
import { getCoordinator, getManager, getPiInstance, getStore, getWidget } from "../shell.ts";
import { parseModelKey, parseThinkingChoice } from "../utils.ts";

import { prepareResolvedSpawn, resolveSpawnSelection, toolModelChoice } from "../spawn/spawn-resolution.ts";
import { prepareSpawnIntent } from "../spawn/spawn-preparation.ts";
import type { SpawnCoordinator } from "../spawn/spawn-coordinator.ts";

/** Extracted parameters from a historical Agent tool call. */
export interface AgentCallParams {
  prompt: string;
  description?: string;
  agent?: string;
  worktree_path?: string;
  model?: string;
  /** Older callers could persist the listener's inferred model and display key. */
  _modelOverride?: string;
  thinking?: string;
  run_in_background?: boolean;
  max_turns?: number;
}

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
export function findLastAgentCallsFromEntries(entries: SessionEntry[]): AgentCallParams[] {
  // Walk backwards to find the most recent assistant message with Agent tool calls.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;

    const agentCalls: AgentCallParams[] = [];
    for (const block of msg.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as ToolCall).type === "toolCall" &&
        (block as ToolCall).name === "Agent"
      ) {
        agentCalls.push((block as ToolCall).arguments as unknown as AgentCallParams);
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

/**
 * Resolve and spawn a single agent from historical parameters.
 *
 * Returns a status string for the caller to collect: "restarted: ..." or "skipped: ...".
 */
async function resolveAndSpawn(
  owner: ExtensionOwner,
  call: AgentCallParams,
  ctx: ExtensionCommandContext,
  running: Set<string>,
  coordinator: SpawnCoordinator,
  pi: ExtensionAPI,
): Promise<{ restarted: string } | { skipped: string }> {
  coordinator.assertCurrentParent(ctx);
  const type = call.agent || "general-purpose";
  const description = agentCallDescription(call);
  if (running.has(`${type}::${description}`)) {
    return { skipped: skippedCallLabel(call, "already running") };
  }

  const store = getStore(owner);
  let spawn: ReturnType<typeof prepareResolvedSpawn>;
  try {
    const selection = await resolveSpawnSelection(owner, ctx, type, call.worktree_path, { coordinator });
    coordinator.assertCurrentParent(ctx);
    if (running.has(`${selection.type}::${description}`)) {
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
      parseThinkingChoice(call.thinking),
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

  await coordinator.spawn(
    pi,
    ctx,
    prepareSpawnIntent({
      ...spawn,
      prompt: call.prompt,
      description,
      maxTurns: call.max_turns ?? spawn.agentConfig?.maxTurns ?? store.agent.defaultMaxTurns,
      graceTurns: store.agent.graceTurns,
      runInBackground: true,
    }),
  );
  return { restarted: `${spawn.type}: ${description}` };
}

/**
 * Restart agents from the most recent Agent tool calls in session history.
 *
 * Skips agents whose type + description match a currently running agent.
 * Returns what was restarted and what was skipped.
 */
export async function handleRestartLastAgents(
  owner: ExtensionOwner,
  ctx: ExtensionCommandContext,
  coordinator = getCoordinator(owner),
): Promise<RestartResult> {
  if (!coordinator?.isCurrentParent(ctx)) return { restarted: [], skipped: [] };
  const entries = ctx.sessionManager.getEntries();
  const calls = findLastAgentCallsFromEntries(entries);

  if (calls.length === 0) {
    return { restarted: [], skipped: [] };
  }

  const manager = getManager(owner);
  if (!manager) return { restarted: [], skipped: [] };
  const pi = getPiInstance(owner);

  const running = new Set(
    manager
      .listAgents()
      .filter((a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued")
      .map((a) => `${a.display.type}::${a.display.description}`),
  );

  const restarted: string[] = [];
  const skipped: string[] = [];

  for (const call of calls) {
    try {
      const result = await resolveAndSpawn(owner, call, ctx, running, coordinator, pi);
      if ("restarted" in result) restarted.push(result.restarted);
      else skipped.push(result.skipped);
    } catch (err) {
      skipped.push(skippedCallLabel(call, `spawn failed: ${String(err).slice(0, 80)}`));
    }
  }

  return { restarted, skipped };
}
