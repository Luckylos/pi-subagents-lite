import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SHORT_ID_LENGTH, type RunNotificationBinding, type SubagentRunResult } from "../types.ts";
import { formatResultStats, formatTerminalContent } from "../agents/agent-result.ts";
import { formatStopReason } from "../status-note.ts";
import { plainText } from "../ui/sanitize.ts";

export type CompletionNotificationStatus = "pending" | "submitted" | "observed" | "not-required" | "unavailable";
export type CompletionNotificationRetryResult = "submitted" | "observed" | "not-eligible" | "unavailable";

export interface CompletionNotificationState {
  readonly status: CompletionNotificationStatus;
  readonly notificationId?: string;
  readonly canRetry: boolean;
}

interface NotificationIdentity {
  readonly notificationId: string;
  readonly runId: string;
  readonly ownerGeneration: number;
  readonly parentSessionId: string;
}

interface CompletionMessage {
  readonly customType: "subagent-result";
  readonly content: string;
  readonly display: true;
  readonly details: Readonly<NotificationIdentity & Record<string, unknown>>;
}

interface Notification {
  readonly message: CompletionMessage;
  readonly notifyOnSynchronousFailure: () => void;
  status: "pending" | "submitted" | "observed";
  submitting: boolean;
}

interface CompletionEntry {
  readonly agentId: string;
  readonly notification?: Notification;
}

const NUDGE_DELAY_MS = 200;

export function readParentSessionId(ctx: ExtensionContext | null): string | undefined {
  try {
    return ctx?.sessionManager.getSessionId();
  } catch {
    // A captured SDK context can become stale on reload.
    return undefined;
  }
}

/** Private delivery state of one SpawnCoordinator, scoped to its captured parent. */
export class CompletionNotifications {
  private readonly entries = new Map<string, CompletionEntry>();
  private readonly pending = new Set<Notification>();
  private readonly unconfirmed = new Map<string, Notification>();
  private timer?: ReturnType<typeof setTimeout>;
  private observing = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ownerGeneration: number,
    private readonly parentSessionId: string | undefined,
    private readonly currentParent: () => ExtensionContext | null,
  ) {}

  record(result: SubagentRunResult, binding: RunNotificationBinding): void {
    if (
      binding.ownerGeneration !== this.ownerGeneration ||
      binding.parentSessionId !== this.parentSessionId ||
      !this.currentParent() ||
      this.entries.has(result.runId)
    )
      return;
    if (!binding.required) {
      this.entries.set(result.runId, { agentId: result.agentId });
      return;
    }

    const stopReason = formatStopReason(result);
    const details = Object.freeze({
      type: result.type,
      description: result.description,
      ...(result.worktreePath && { worktreePath: result.worktreePath }),
      status: result.status,
      outputFile: result.outputFile,
      ...(stopReason && { stopReason }),
      ...formatResultStats(result.stats, result.elapsedMs),
      notificationId: randomUUID(),
      runId: result.runId,
      ownerGeneration: binding.ownerGeneration,
      parentSessionId: binding.parentSessionId,
    });
    const headline = `[Subagent "${result.type}" ${result.agentId.slice(0, SHORT_ID_LENGTH)} ${result.status}]`;
    const fallbackText = plainText(`[Subagent "${result.type}" ${result.status}] Result available`);
    const notification: Notification = {
      message: Object.freeze({
        customType: "subagent-result",
        display: true,
        content: `${headline}\n\n${formatTerminalContent(result)}`,
        details,
      }),
      status: "pending",
      submitting: false,
      notifyOnSynchronousFailure: () => binding.spawnCtx.ui.notify(fallbackText, "info"),
    };
    this.entries.set(result.runId, { agentId: result.agentId, notification });
    this.pending.add(notification);
    this.timer ??= setTimeout(() => this.flush(), NUDGE_DELAY_MS);
  }

  state(runId: string): CompletionNotificationState {
    const entry = this.currentParent() ? this.entries.get(runId) : undefined;
    const notification = entry?.notification;
    return Object.freeze({
      status: notification?.status ?? (entry ? "not-required" : "unavailable"),
      notificationId: notification?.message.details.notificationId,
      canRetry: notification?.status === "submitted" && !notification.submitting,
    });
  }

  observe(ctx: ExtensionContext): void {
    if (this.observing || this.unconfirmed.size === 0 || !this.ownsContext(ctx)) return;
    this.observing = true;
    try {
      // Entries span the whole session. The current branch may hide an already received notice.
      const entries = ctx.sessionManager.getEntries();
      if (!this.ownsContext(ctx)) return;
      for (const entry of entries) {
        if (entry.type !== "custom_message" || entry.customType !== "subagent-result") continue;
        const details = entry.details;
        if (typeof details !== "object" || !details || !("notificationId" in details)) continue;
        const id = details.notificationId;
        if (typeof id !== "string") continue;
        const notification = this.unconfirmed.get(id);
        if (!notification) continue;
        const identity = notification.message.details;
        if (
          "runId" in details &&
          details.runId === identity.runId &&
          "ownerGeneration" in details &&
          details.ownerGeneration === identity.ownerGeneration &&
          "parentSessionId" in details &&
          details.parentSessionId === identity.parentSessionId
        ) {
          notification.status = "observed";
          this.unconfirmed.delete(id);
          if (this.unconfirmed.size === 0) break;
        }
      }
    } catch {
      // Unreadable history supplies no positive receipt.
    } finally {
      this.observing = false;
    }
  }

  retry(runId: string, notificationId: string, ctx: ExtensionContext): CompletionNotificationRetryResult {
    const notification = this.entries.get(runId)?.notification;
    if (!notification || notification.message.details.notificationId !== notificationId || !this.ownsContext(ctx)) {
      return "unavailable";
    }
    if (notification.status === "observed") return "observed";
    if (notification.status !== "submitted" || notification.submitting || this.observing) return "not-eligible";
    return this.submit(notification, ctx);
  }

  clearAgent(agentId: string): void {
    for (const [runId, entry] of this.entries) {
      if (entry.agentId !== agentId) continue;
      this.entries.delete(runId);
      if (entry.notification) {
        this.pending.delete(entry.notification);
        this.unconfirmed.delete(entry.notification.message.details.notificationId);
      }
    }
    if (this.pending.size === 0) this.cancelTimer();
  }

  dispose(): void {
    this.cancelTimer();
    this.entries.clear();
    this.pending.clear();
    this.unconfirmed.clear();
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private ownsContext(ctx: ExtensionContext): boolean {
    return !!this.currentParent() && readParentSessionId(ctx) === this.parentSessionId;
  }

  private flush(): void {
    this.timer = undefined;
    // Keep the batch stable under synchronous callbacks; they may clear other runs.
    const batch = [...this.pending];
    this.pending.clear();
    for (const notification of batch) this.submit(notification);
  }

  private submit(notification: Notification, retryCtx?: ExtensionContext): CompletionNotificationRetryResult {
    const { runId, notificationId } = notification.message.details;
    const isRetained = () => this.entries.get(runId)?.notification === notification;
    notification.submitting = true;
    try {
      if (retryCtx) this.observe(retryCtx);
      const ctx = this.currentParent();
      if (!ctx || !isRetained()) return "unavailable";
      const deliverAs = ctx.isIdle() ? "followUp" : "steer";
      if (!this.currentParent() || !isRetained()) return "unavailable";
      if (notification.status === "observed") return "observed";

      // Register before crossing the SDK boundary: sendMessage may synchronously
      // reenter a lifecycle handler, and void says nothing about host acceptance.
      notification.status = "submitted";
      this.unconfirmed.set(notificationId, notification);
      try {
        this.pi.sendMessage(notification.message, { deliverAs, triggerTurn: true });
      } catch {
        this.observe(ctx);
        if (notification.status === "submitted" && isRetained() && this.currentParent()) {
          try {
            notification.notifyOnSynchronousFailure();
          } catch {
            // A UI fallback is best effort; it does not establish receipt.
          }
        }
      }
      return isRetained() && this.currentParent() ? notification.status : "unavailable";
    } catch {
      // The host context became unusable before sendMessage was reached.
      return "unavailable";
    } finally {
      notification.submitting = false;
    }
  }
}
