import type { ExtensionOwner } from "../shell.ts";
import { getPiInstance, getSessionCtx, getWidget } from "../shell.ts";
import { SHORT_ID_LENGTH } from "../types.ts";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, RunNotificationBinding, SubagentParentReport, SubagentRunResult } from "../types.ts";
import type { AgentManager, SpawnOptions } from "../agents/agent-manager.ts";
import { type SpawnIntent } from "./spawn-preparation.ts";
export type { SpawnIntent } from "./spawn-preparation.ts";
import {
  CompletionNotifications,
  readParentSessionId,
  type CompletionNotificationRetryResult,
  type CompletionNotificationState,
} from "./completion-notifications.ts";
export type { CompletionNotificationRetryResult, CompletionNotificationState } from "./completion-notifications.ts";
import { createParentMessageTool } from "../agents/parent-message.ts";

/**
 * spawn-coordinator.ts — Spawn-and-track coordination for subagents.
 *
 * Single entry point for both LLM tool and menu spawn paths.
 * Connects parent delivery and the manager's run lifecycle. CompletionNotifications
 * owns the formatting and delivery of each run's notification.
 */

// --- Types ---

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
  foregroundReport?: SubagentParentReport;
}

export class SpawnCoordinator {
  private readonly notifications: CompletionNotifications;
  private readonly generation: number;
  private readonly parentSessionId: string | undefined;
  private readonly parentSessionManager: ExtensionContext["sessionManager"] | undefined;
  private disposed = false;

  constructor(
    private owner: ExtensionOwner,
    private manager: AgentManager,
  ) {
    this.generation = owner.generation;
    const parent = getSessionCtx(owner);
    this.parentSessionId = readParentSessionId(parent);
    this.parentSessionManager = this.parentSessionId ? parent?.sessionManager : undefined;
    this.notifications = new CompletionNotifications(getPiInstance(owner), this.generation, this.parentSessionId, () =>
      this.currentParent(),
    );
  }

  private currentParent(): ExtensionContext | null {
    const ctx = getSessionCtx(this.owner);
    return this.isCurrentParent(ctx) ? ctx : null;
  }

  /** A fresh SDK context can refer to the same parent; the coordinator cannot change. */
  isCurrentParent(ctx: ExtensionContext | null): boolean {
    if (this.disposed || this.generation !== this.owner.generation || this.owner.coordinator !== this) return false;
    const current = getSessionCtx(this.owner);
    return this.matchesParent(current) && (ctx === current || this.matchesParent(ctx));
  }

  assertCurrentParent(ctx: ExtensionContext): void {
    if (!this.isCurrentParent(ctx)) throw new Error("Subagents parent session changed before spawn");
  }

  private matchesParent(ctx: ExtensionContext | null): boolean {
    if (!this.parentSessionId || !ctx) return false;
    try {
      // Pi can create fresh contexts for commands and tools within the same session.
      const sessionManager = ctx.sessionManager;
      return sessionManager === this.parentSessionManager && sessionManager.getSessionId() === this.parentSessionId;
    } catch {
      // Reload can invalidate a captured SDK context.
      return false;
    }
  }

  /**
   * Spawn + wire tracking + (foreground) await.
   * Single entry point for the Agent tool, menu wizard and Restart.
   */
  async spawn(pi: ExtensionAPI, ctx: ExtensionContext, intent: SpawnIntent): Promise<SpawnResult> {
    this.assertCurrentParent(ctx);
    const sessionId = this.parentSessionId!;
    // SpawnConfig fields pass through unchanged; only the intent-only fields
    // (type/prompt/runInBackground/signal) are handled explicitly.
    const { type, prompt, runInBackground, signal, ...config } = intent;
    const spawnOptions: SpawnOptions = {
      ...config,
      isBackground: runInBackground,
      notificationOwner: { ownerGeneration: this.generation, parentSessionId: sessionId },
      signal,
    };

    // MessageParent is bound at session creation, before the id exists, so its
    // closures read the id once spawn returns (ADR-0013: background only).
    let spawnedId: string | undefined;
    if (runInBackground && this.owner.store?.agent.parentMessages) {
      spawnOptions.customTools = [
        createParentMessageTool({
          deliver: (text) => spawnedId !== undefined && this.deliverParentMessage(spawnedId, text),
          runId: () => (spawnedId === undefined ? undefined : this.manager.getCurrentRunId(spawnedId)),
        }),
      ];
    }

    const agentId = this.manager.spawn(pi, ctx, type, prompt, spawnOptions);
    spawnedId = agentId;
    const record = this.manager.getRecord(agentId)!;
    const parentWait = runInBackground ? undefined : record.execution.promise;

    // Ensure widget timer is running so it displays the new agent
    // (menu path calls this explicitly, but tool path doesn't)
    const widget = getWidget(this.owner);
    if (widget) {
      widget.ensureTimer();
    }

    if (!parentWait) return { agentId, record };
    return { agentId, record, foregroundReport: await parentWait };
  }

  /** Publish only the originating run's result, with its spawn-time delivery binding. */
  onAgentComplete(result: SubagentRunResult, binding?: RunNotificationBinding): void {
    if (binding) this.notifications.record(result, binding);
  }

  getCompletionNotification(runId: string): CompletionNotificationState {
    return this.notifications.state(runId);
  }

  observeCompletionNotifications(ctx: ExtensionContext): void {
    this.notifications.observe(ctx);
  }

  retryCompletionNotification(
    runId: string,
    notificationId: string,
    ctx: ExtensionContext,
  ): CompletionNotificationRetryResult {
    return this.notifications.retry(runId, notificationId, ctx);
  }

  onAgentClear(agentId: string): void {
    this.notifications.clearAgent(agentId);
  }

  dispose(): void {
    this.disposed = true;
    this.notifications.dispose();
  }

  /**
   * Deliver a Parent message to the session a Nudge would reach. Immediate, not
   * batched, so it precedes that run's Nudge. Returns false instead of falling
   * back to a UI toast so the Subagent learns it was not delivered.
   */
  deliverParentMessage(agentId: string, text: string): boolean {
    const ctx = this.currentParent();
    if (!ctx) return false;
    const record = this.manager.getRecord(agentId);
    if (!record) return false;

    try {
      const parentIdle = ctx.isIdle();
      if (!this.currentParent()) return false;
      getPiInstance(this.owner).sendMessage(
        {
          customType: "subagent-message",
          content: `[Subagent "${record.display.type}" ${record.id.slice(0, SHORT_ID_LENGTH)} message]\n\n${text}`,
          display: true,
          details: { agentId: record.id, type: record.display.type, description: record.display.description },
        },
        { deliverAs: parentIdle ? "followUp" : "steer", triggerTurn: true },
      );
      return true;
    } catch {
      return false;
    }
  }
}
