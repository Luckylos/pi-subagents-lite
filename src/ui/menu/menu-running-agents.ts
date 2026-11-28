import type { ExtensionOwner } from "../../shell.ts";
/**
 * menu-running-agents.ts — Running agents menu concern.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Agent list is a snapshot at construction time (stale until re-entry is acceptable).
 * Selecting an agent opens an actions submenu (SelectList).
 *
 * Exports:
 *   - showRunningAgentsMenu: list running/queued/completed agents
 *   - buildAgentActionsList: per-agent action sub-menu (view result, steer, stop, clear)
 *
 * Private helpers (single-consumer, co-located):
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, wrapTextWithAnsi, type Component, type SelectItem } from "@earendil-works/pi-tui";
import type { AgentRecord, SubagentRun, SubagentRunResult } from "../../types.ts";
import type { CompletionNotificationState } from "../../spawn/spawn-coordinator.ts";
import { SHORT_ID_LENGTH } from "../../types.ts";
import { prepareConversationViewer } from "../open-conversation-viewer.ts";
import { showRunTextViewer } from "../run-text-viewer.ts";
import { canRequestStop, displayAgentStatus } from "../../agents/agent-status.ts";
import { messageIntent, MessageComposer, STALE_RUN_REASON, submitToRun } from "../message-composer.ts";
import { captureRunAction, requestRunClear, requestRunStop } from "../run-actions.ts";
import { agentBulletPrefix, formatMs } from "../format.ts";
import { SEPARATOR_ID, buildSelectListTheme, createDelegatingComponent, installSeparatorSkip } from "./helpers.ts";
import { getCoordinator, getManager } from "../../shell.ts";
import { plainText } from "../sanitize.ts";
import type { Theme } from "../types.ts";

/** Running or queued — the only non-terminal statuses (ADR-0006: active work is never cleared). */
function isActive(record: AgentRecord): boolean {
  return record.lifecycle.status === "running" || record.lifecycle.status === "queued";
}

type TerminalRun = SubagentRun & { readonly outcome: SubagentRunResult };

const EMPTY_RUN_RESULT = "No output was produced for this run.";
const RETRY_WARNING =
  "Retrying may deliver this notification twice or wake the parent twice. Retry only if you accept this risk.";
const RECEIPT_TEXT: Record<CompletionNotificationState["status"], string> = {
  pending: "Pending — not submitted.",
  submitted: "Submitted — receipt unconfirmed.",
  observed: "Observed in parent history.",
  "not-required": "Not required for this run.",
  unavailable: "Status unavailable.",
};

function terminalRuns(owner: ExtensionOwner, agentId: string): TerminalRun[] {
  return (getManager(owner)?.getRuns(agentId) ?? [])
    .filter((run): run is TerminalRun => run.phase === "settled" && !!run.outcome)
    .sort((a, b) => b.sequence - a.sequence);
}

function showRunHistory(
  owner: ExtensionOwner,
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  theme: Theme,
  setActive: (c: Component) => void,
  back: () => void,
  selectedRunId?: string,
): void {
  const runs = terminalRuns(owner, record.id);
  if (runs.length === 0) return back();
  const items = runs.map((run) => ({
    value: run.id,
    label: `Run ${run.sequence} · ${run.outcome.status} · ${formatMs(run.outcome.elapsedMs)}`,
  }));
  const list = new SelectList(items, 10, buildSelectListTheme(theme));
  if (selectedRunId !== undefined) {
    const index = items.findIndex((item) => item.value === selectedRunId);
    if (index >= 0) list.setSelectedIndex(index);
  }
  list.onCancel = back;
  list.onSelect = (item) => {
    const run = runs.find((candidate) => candidate.id === item.value);
    if (run) {
      setActive(
        buildRunPage(owner, ctx, record, run, theme, () =>
          showRunHistory(owner, ctx, record, theme, setActive, back, run.id),
        ),
      );
    }
  };
  getCoordinator(owner)?.observeCompletionNotifications(ctx);
  setActive(list);
}

function buildRunPage(
  owner: ExtensionOwner,
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  run: TerminalRun,
  theme: Theme,
  back: () => void,
): Component {
  const coordinator = getCoordinator(owner);
  const listTheme = buildSelectListTheme(theme);
  const getReceipt = (): CompletionNotificationState =>
    coordinator?.getCompletionNotification(run.id) ?? { status: "unavailable", canRetry: false };
  coordinator?.observeCompletionNotifications(ctx);
  let receipt = getReceipt();
  let feedback: string | undefined;
  let warnedList: SelectList | undefined;
  let awaitingRefresh = false;
  let list = buildActions(receipt);

  function buildActions(state: CompletionNotificationState): SelectList {
    const items: SelectItem[] = [{ value: "view-result", label: "View result" }];
    if (run.outcome.error) items.push({ value: "view-error", label: "View error" });
    if (state.canRetry) items.push({ value: "retry", label: "Retry completion notification" });
    const actions = new SelectList(items, 10, listTheme);
    actions.onCancel = back;
    actions.onSelect = async (item) => {
      if (item.value === "view-result") {
        await showRunTextViewer(owner, ctx.ui, record, "result", run.outcome.result || EMPTY_RUN_RESULT, run.sequence);
      } else if (item.value === "view-error" && run.outcome.error) {
        await showRunTextViewer(owner, ctx.ui, record, "error", run.outcome.error, run.sequence);
      } else if (item.value === "retry" && state.notificationId && coordinator && warnedList === actions) {
        // A key burst can arrive before the page's first render or reenter the host call.
        warnedList = undefined;
        awaitingRefresh = true;
        const result = coordinator.retryCompletionNotification(run.id, state.notificationId, ctx);
        feedback = {
          submitted: "Retry attempted. Receipt remains unconfirmed.",
          observed: "This notification is already in parent history.",
          "not-eligible": "Retry is not available for this notification.",
          unavailable: "The parent session or notification is no longer available.",
        }[result];
        // Reset to the read-only default so repeat Enter cannot submit again.
        receipt = getReceipt();
        list = buildActions(receipt);
      }
    };
    return actions;
  }

  return {
    invalidate() {
      list.invalidate();
    },
    handleInput(data) {
      if (awaitingRefresh && matchesKey(data, "enter")) return;
      list.handleInput(data);
    },
    render(width) {
      const current = getReceipt();
      if (current.canRetry !== receipt.canRetry || current.notificationId !== receipt.notificationId) {
        list = buildActions(current);
      }
      receipt = current;
      const wrap = (text: string, color: string) =>
        wrapTextWithAnsi(plainText(text), Math.max(1, width - 2)).map((line) => `  ${theme.fg(color, line)}`);
      const warning = receipt.canRetry ? wrap(RETRY_WARNING, "warning") : [];
      warnedList = warning.length > 0 ? list : undefined;
      awaitingRefresh = false;
      return [
        ...wrap(`Completion notification: ${RECEIPT_TEXT[receipt.status]}`, "muted"),
        ...(receipt.status === "observed" ? wrap("This confirms history entry only.", "muted") : []),
        ...warning,
        ...(feedback ? wrap(feedback, "muted") : []),
        "",
        ...list.render(width),
      ];
    },
  };
}

/**
 * Build a SelectList of actions for a single agent (view result/error/snapshot,
 * steer, stop, clear) for use as a submenu inside a delegating component.
 * @param done — return to the parent agent list (cancel / no actions).
 * @param setActive — swap the delegating component's active child (steer input).
 * @param onClose — close the entire menu after an accepted Stop or Clear.
 */
export function buildAgentActionsList(
  owner: ExtensionOwner,
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  theme: Theme,
  done: () => void,
  setActive: (c: Component) => void,
  onClose: () => void,
  refresh = () => {},
  onClearStale = () => {},
): SelectList {
  const items: SelectItem[] = [];
  const shortId = record.id.slice(0, SHORT_ID_LENGTH);
  const isRunning = isActive(record);
  const hasSession = !!record.execution.session;
  const runs = terminalRuns(owner, record.id);
  const resultRun = runs.find((run) => !!run.outcome.result);
  const errorRun = runs.find((run) => !!run.outcome.error);
  const intent = messageIntent(record);
  const target = captureRunAction(owner, record);
  let draft: MessageComposer | undefined;

  if (record.lifecycle.status === "running" && hasSession) {
    items.push({ value: "view-snapshot", label: "View snapshot" });
  }
  if (hasSession && !isRunning) {
    items.push({ value: "view-conversation", label: "View conversation" });
  }
  if (resultRun) {
    items.push({ value: "view-result", label: `View result · Run ${resultRun.sequence}` });
  }
  if (errorRun) {
    items.push({ value: "view-error", label: `View error · Run ${errorRun.sequence}` });
  }
  if (runs.length > 0) {
    items.push({ value: "run-history", label: `Run history (${runs.length})` });
  }
  if (intent) items.push({ value: intent, label: intent === "steer" ? "Steer" : "Continue" });
  if (canRequestStop(record)) items.push({ value: "stop", label: "Stop" });
  if (!isRunning) items.push({ value: "clear", label: "Clear" });
  if (items.length === 0) {
    items.push({ value: "status", label: `Agent ${shortId} — ${displayAgentStatus(record.lifecycle)}` });
  } else if (record.lifecycle.phase === "stopping") {
    items[0].label += " · stopping";
  }

  const list = new SelectList(items, 10, buildSelectListTheme(theme));
  list.onSelect = async (item) => {
    if (item.value === "view-snapshot" || item.value === "view-conversation") {
      try {
        await prepareConversationViewer(owner, ctx.ui, record, "overlay", {
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        })?.();
      } catch (err) {
        ctx.ui.notify(`Failed to open agent viewer: ${String(err)}`, "error");
      }
    } else if (item.value === "view-result" && resultRun?.outcome.result) {
      await showRunTextViewer(owner, ctx.ui, record, "result", resultRun.outcome.result, resultRun.sequence);
    } else if (item.value === "view-error" && errorRun?.outcome.error) {
      await showRunTextViewer(owner, ctx.ui, record, "error", errorRun.outcome.error, errorRun.sequence);
    } else if (item.value === "run-history") {
      showRunHistory(owner, ctx, record, theme, setActive, () => setActive(list));
    } else if (item.value === "steer" || item.value === "continue") {
      const manager = target.manager;
      if (!manager || !target.isCurrent() || intent !== item.value || messageIntent(record) !== intent) {
        ctx.ui.notify(
          `${item.value === "continue" ? "Continue" : "Message"} not accepted: ${STALE_RUN_REASON}`,
          "warning",
        );
        return;
      }
      const composer = (draft ??= new MessageComposer(
        intent,
        submitToRun(record, target, intent, (message) => manager.submitMessage(record.id, message)),
        () => setActive(list),
        refresh,
      ));
      composer.open();
      const component = {
        dispose: () => composer.hide(),
        invalidate: () => composer.input.invalidate(),
        handleInput: (data: string) => composer.handleInput(data),
        render: (width: number) => {
          const hint = composer.pending ? "Submitting…" : composer.feedback;
          return [
            ...composer.input.render(width),
            ...(hint ? wrapTextWithAnsi(hint, Math.max(1, width)).map((line) => theme.fg("warning", line)) : []),
          ];
        },
      };
      setActive(component);
    } else if (item.value === "stop") {
      const result = requestRunStop(owner, record, target);
      ctx.ui.notify(result.text, result.outcome === "accepted" ? "info" : "warning");
      if (result.outcome === "accepted") onClose();
    } else if (item.value === "clear") {
      const result = requestRunClear(record, target);
      ctx.ui.notify(result.text, result.outcome === "accepted" ? "info" : "warning");
      if (result.outcome === "accepted") onClose();
      else if (result.outcome === "stale") onClearStale();
    }
  };
  list.onCancel = () => {
    draft?.hide();
    done();
  };
  return list;
}

export async function showRunningAgentsMenu(owner: ExtensionOwner, ctx: ExtensionCommandContext): Promise<void> {
  const generation = owner.generation;
  const manager = getManager(owner);
  const isCurrentRoster = () => owner.generation === generation && getManager(owner) === manager;
  const initialAgents = manager?.listAgents() ?? [];
  if (initialAgents.length === 0) {
    ctx.ui.notify("No agents have been spawned this session", "info");
    return;
  }
  await ctx.ui.custom((tui, theme, _kb, done) => {
    let agents = isCurrentRoster() ? initialAgents : [];
    const buildAgentItems = (stoppableCount: number, finishedCount: number, completedCount: number): SelectItem[] => {
      // One timestamp for every row: rows stay mutually consistent instead of
      // skewing by a millisecond per Date.now() call.
      const now = Date.now();
      const items: SelectItem[] = agents.map((record) => {
        // Finished runs freeze at completion; the now fallback is defensive only
        // (completedAt is stamped on every terminal path and cleared on continue).
        const active = isActive(record);
        const end = active ? now : (record.lifecycle.completedAt ?? now);
        const duration = formatMs(end - record.lifecycle.startedAt);
        const ago = active ? "" : ` ${formatMs(now - end)} ago`;
        const statusIcon =
          record.lifecycle.status === "running"
            ? "\u25B6"
            : record.lifecycle.status === "completed"
              ? "\u2713"
              : record.lifecycle.status === "queued"
                ? "\u23F3"
                : record.lifecycle.status === "error"
                  ? "\u2717"
                  : "\u2022";
        const headline = plainText(record.display.description);
        const type = plainText(record.display.type);
        const suffix = headline ? ` \u2014 ${headline}` : "";
        const bullet = agentBulletPrefix(owner, record.display.type);
        return {
          value: record.id,
          label: `${statusIcon} ${record.id.slice(0, SHORT_ID_LENGTH)}  ${bullet}${type}  ${displayAgentStatus(record.lifecycle)}  ${duration}${suffix}${ago}`,
        };
      });
      if (stoppableCount > 0) {
        items.push({ value: SEPARATOR_ID, label: " " });
        items.push({ value: "__stop-all", label: `Stop ${stoppableCount} running agent(s)` });
      }
      if (finishedCount > 0) {
        // One group: "Clear done" (only when completed agents exist) above "Clear all".
        items.push({ value: SEPARATOR_ID, label: " " });
        if (completedCount > 0) {
          items.push({ value: "__clear-done", label: "Clear done" });
        }
        items.push({ value: "__clear-all", label: "Clear all" });
      }
      return items;
    };

    function makeAgentList(previous?: SelectList): SelectList {
      const stoppable = agents
        .filter(canRequestStop)
        .map((record) => ({ record, target: captureRunAction(owner, record) }));
      const finished = agents
        .filter((record) => !isActive(record))
        .map((record) => ({ record, target: captureRunAction(owner, record) }));
      const completed = finished.filter(({ record }) => record.lifecycle.status === "completed");
      const items = buildAgentItems(stoppable.length, finished.length, completed.length);
      const list = new SelectList(items, 15, buildSelectListTheme(theme));
      installSeparatorSkip(list);
      const selected = previous?.getSelectedItem?.()?.value;
      const index = items.findIndex((item) => item.value === selected);
      if (index >= 0) list.setSelectedIndex(index);
      list.onSelect = (item) => {
        if (item.value === "__stop-all") {
          const accepted = stoppable.filter(
            ({ record, target }) => requestRunStop(owner, record, target).outcome === "accepted",
          ).length;
          const allAccepted = accepted === stoppable.length;
          const suffix = allAccepted ? "" : " Some requests were not accepted.";
          ctx.ui.notify(
            `Stop requested for ${accepted} of ${stoppable.length} agent(s).${suffix}`,
            allAccepted ? "info" : "warning",
          );
          if (allAccepted) close();
        } else if (item.value === "__clear-all" || item.value === "__clear-done") {
          const onlyDone = item.value === "__clear-done";
          const targets = onlyDone ? completed : finished;
          const accepted = targets.filter(
            ({ record, target }) => requestRunClear(record, target).outcome === "accepted",
          ).length;
          const rejected = targets.length - accepted;
          const kind = onlyDone ? "completed" : "finished";
          if (rejected === 0) {
            ctx.ui.notify(`Cleared ${accepted} ${kind} agent(s)`, "info");
            close();
          } else {
            ctx.ui.notify(
              `Cleared ${accepted} of ${targets.length} ${kind} agent(s). ${rejected} not accepted.`,
              "warning",
            );
            refreshRoster();
          }
        } else if (isCurrentRoster()) {
          const record = agents.find((r) => r.id === item.value);
          if (record) openActions(record);
        }
      };
      list.onCancel = close;
      return list;
    }

    const phaseKey = (record: AgentRecord) =>
      `${record.lifecycle.phase}:${record.lifecycle.status}:${record.lifecycle.startedAt}`;
    const rosterKey = () => agents.map(phaseKey).join("|");
    let displayedRoster = rosterKey();
    let agentList = makeAgentList();
    const delegator = createDelegatingComponent(agentList);
    let closed = false;
    let actions: { record: AgentRecord; key: string; list: SelectList } | undefined;

    function dispose(): void {
      closed = true;
      const active = delegator.getActive();
      if ("dispose" in active && typeof active.dispose === "function") active.dispose();
    }

    function close(): void {
      if (closed) return;
      dispose();
      done(undefined);
    }

    function rebuildRoster(): void {
      displayedRoster = rosterKey();
      agentList = makeAgentList(agentList);
      delegator.setActive(agentList);
    }

    function refreshRoster(): void {
      agents = isCurrentRoster() ? (manager?.listAgents() ?? []) : [];
      actions = undefined;
      rebuildRoster();
    }

    function openActions(record: AgentRecord): void {
      const list = buildAgentActionsList(
        owner,
        ctx,
        record,
        theme,
        () => {
          actions = undefined;
          delegator.setActive(agentList);
        },
        (component) => {
          if (!closed) delegator.setActive(component);
        },
        close,
        () => {
          if (!closed) tui.requestRender?.();
        },
        () => {
          if (isCurrentRoster() && manager?.getRecord(record.id) === record) openActions(record);
          else refreshRoster();
        },
      );
      actions = { record, key: phaseKey(record), list };
      delegator.setActive(list);
    }

    function refreshActions(): void {
      if (!isCurrentRoster()) return;
      const active = delegator.getActive();
      if (active === agentList) {
        if (rosterKey() !== displayedRoster) rebuildRoster();
      } else if (actions && active === actions.list && phaseKey(actions.record) !== actions.key) {
        openActions(actions.record);
      }
    }

    // Simple title wrapper — SettingsListWrapper doesn't work with delegators
    // because it intercepts onSelect on the wrapper target, not on the active child.
    const sep = "\u2500";
    const title = theme.bold(theme.fg("accent", "Running Agents"));
    return {
      invalidate() {
        delegator.invalidate();
      },
      render(width: number) {
        refreshActions();
        const lines: string[] = [];
        lines.push(sep.repeat(width));
        lines.push("");
        lines.push("  " + title);
        lines.push("");
        lines.push(...delegator.render(width));
        lines.push("");
        lines.push(sep.repeat(width));
        return lines;
      },
      dispose,
      handleInput(data: string) {
        if (!closed) delegator.handleInput?.(data);
      },
    };
  });
}
