import type { AgentManager } from "../agents/agent-manager.ts";
import { canRequestStop, stopRequestedText } from "../agents/agent-status.ts";
import { getManager, type ExtensionOwner } from "../shell.ts";
import { SHORT_ID_LENGTH, type AgentRecord } from "../types.ts";
import { invalidateAgentRow } from "./renderer.ts";

/** Bind an action to the record, manager generation and exact run shown to the user. */
export function captureRunAction(owner: ExtensionOwner, record: AgentRecord) {
  const generation = owner.generation;
  const manager = getManager(owner);
  const id = record.id;
  const runId = manager?.getRuns(id).at(-1)?.id;
  return {
    manager,
    isCurrent: () => {
      if (!manager || !runId || owner.generation !== generation || getManager(owner) !== manager) return false;
      return record.id === id && manager.getRecord(id) === record && manager.getRuns(id).at(-1)?.id === runId;
    },
  };
}

export type RunActionTarget = ReturnType<typeof captureRunAction>;

interface RunActionResult {
  outcome: "accepted" | "stale" | "refused";
  text: string;
}

function requestRunAction(
  target: RunActionTarget,
  action: "Stop" | "Clear",
  eligible: boolean,
  request: (manager: AgentManager) => boolean,
  successText: () => string,
): RunActionResult {
  if (!target.manager || !target.isCurrent() || !eligible) {
    return {
      outcome: "stale",
      text: `${action} not accepted: The run is no longer eligible. Reopen the action and try again.`,
    };
  }
  if (!request(target.manager)) {
    return { outcome: "refused", text: `${action} not accepted: The manager refused the request.` };
  }
  return { outcome: "accepted", text: successText() };
}

export function requestRunStop(owner: ExtensionOwner, record: AgentRecord, target: RunActionTarget): RunActionResult {
  return requestRunAction(
    target,
    "Stop",
    canRequestStop(record),
    (manager) => manager.abort(record.id, "user"),
    () => {
      invalidateAgentRow(owner, record.id);
      return record.lifecycle.status === "stopped"
        ? `Stopped ${record.id.slice(0, SHORT_ID_LENGTH)}.`
        : stopRequestedText(record);
    },
  );
}

export function requestRunClear(record: AgentRecord, target: RunActionTarget): RunActionResult {
  const { phase, status } = record.lifecycle;
  return requestRunAction(
    target,
    "Clear",
    (phase === undefined || phase === "settled") && status !== "running" && status !== "queued",
    (manager) => manager.clear(record.id),
    () => `Cleared ${record.id.slice(0, SHORT_ID_LENGTH)}`,
  );
}
