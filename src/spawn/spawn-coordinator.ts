import type { ExtensionOwner } from "../shell.ts";
import { getPiInstance, getSessionCtx, getWidget } from "../shell.ts";
import { SHORT_ID_LENGTH } from "../types.ts";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, LiveView, RunNotificationBinding, SubagentRunResult, ToolActivity } from "../types.ts";
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
 * Connects parent delivery and the manager's run lifecycle. Live-view state
 * rides on the record so continuations re-feed it. CompletionNotifications
 * owns the formatting and delivery of each run's notification.
 */

// --- Types ---

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
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
    if (
      this.disposed ||
      this.generation !== this.owner.generation ||
      (this.owner.coordinator && this.owner.coordinator !== this)
    )
      return null;
    const ctx = getSessionCtx(this.owner);
    return this.matchesParent(ctx) ? ctx : null;
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
    const sessionId = this.parentSessionId;
    if (!sessionId || !this.currentParent() || !this.matchesParent(ctx)) {
      throw new Error("Subagents parent session changed before spawn");
    }
    // Create live view BEFORE spawn so callbacks can close over it
    const liveView: LiveView = {
      activeTools: new Map(),
      responseText: "",
    };
    const liveViewCallbacks = this.createLiveViewCallbacks(liveView);

    // SpawnConfig fields pass through unchanged; only the intent-only fields
    // (type/prompt/runInBackground/signal) are handled explicitly.
    const { type, prompt, runInBackground, signal, ...config } = intent;
    const spawnOptions: SpawnOptions = {
      ...config,
      isBackground: runInBackground,
      notificationOwner: { ownerGeneration: this.generation, parentSessionId: sessionId },
      signal,
      ...liveViewCallbacks,
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
    // The live view is re-fed by continuations.
    record.execution.liveView = liveView;

    // Ensure widget timer is running so it displays the new agent
    // (menu path calls this explicitly, but tool path doesn't)
    const widget = getWidget(this.owner);
    if (widget) {
      widget.ensureTimer();
    }

    if (!runInBackground) await record.execution.promise;

    return { agentId, record };
  }

  /** Read the live view for an agent. Widget calls this. */
  liveView(id: string): LiveView | undefined {
    return this.manager.getRecord(id)?.execution.liveView;
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

  // ── Private ──

  /** Create callbacks that bridge manager events to a specific live view. */
  private createLiveViewCallbacks(view: LiveView): Pick<SpawnOptions, "onToolActivity" | "onTextDelta"> {
    return {
      onToolActivity: (activity: ToolActivity) => {
        if (activity.type === "start") {
          view.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName);
        } else {
          for (const [key, name] of view.activeTools) {
            if (name === activity.toolName) {
              view.activeTools.delete(key);
              break;
            }
          }
        }
      },
      onTextDelta: (_delta: string, fullText: string) => {
        view.responseText = fullText;
      },
    };
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
