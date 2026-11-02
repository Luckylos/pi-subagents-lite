import type { AgentRecord } from "./types.ts";

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, isKeyRelease } from "@earendil-works/pi-tui";
import { ConfigStore } from "./config/config-store.ts";
import { createConfigIO } from "./config/config-io.ts";
import type { ExtensionOwner } from "./shell.ts";
import { AgentManager } from "./agents/agent-manager.ts";
import { AgentWidget, type UICtx } from "./ui/agent-widget.ts";
import { ConversationViewer } from "./ui/conversation-viewer.ts";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.ts";
import { toolCallListener } from "./agents/tool-execution.ts";
import { invalidateAgentRow, cleanupInvalidations } from "./ui/renderer.ts";
import { registerAgentTool } from "./registration.ts";
import {
  getManager,
  getWidget,
  getCoordinator,
  getStore,
  setSessionCtx,
  setManager,
  setWidget,
  setCoordinator,
} from "./shell.ts";

// --- Config loader — session_start handler logic ---

/** Idempotent — safe to call on every session_start. */
export function ensureManagerAndWidget(owner: ExtensionOwner): void {
  if (!owner.sessionCtx || !owner.store) return;
  const currentManager = getManager(owner);
  const currentWidget = getWidget(owner);

  if (!currentManager) {
    // Coordinator needs the manager, so wire onComplete after creating it.
    // Invalidate row when agent starts running (queued → running transition)
    const onStart = (record: AgentRecord) => {
      if (owner.manager !== newManager) return;
      invalidateAgentRow(owner, record.id);
      getWidget(owner)?.update();
    };

    const newManager = new AgentManager(owner, undefined, getStore(owner).concurrency, onStart);
    setManager(owner, newManager);
    // Sync the manager as a config side-effect target (concurrency setters call setConcurrency).
    getStore(owner).setDeps({ manager: newManager });

    const coordinator = new SpawnCoordinator(owner, newManager);
    setCoordinator(owner, coordinator);

    newManager.setOnComplete((record) => {
      if (owner.manager !== newManager) return;
      coordinator.onAgentComplete(record);
      invalidateAgentRow(owner, record.id);
      getWidget(owner)?.update();
    });
  }

  if (!currentWidget) {
    const newWidget = new AgentWidget(owner, getManager(owner)!, (id: string) => getCoordinator(owner)?.liveView(id));
    setWidget(owner, newWidget);
    // Sync widget as config side-effect target — setDeps re-syncs all display settings from config.
    getStore(owner).setDeps({ widget: newWidget });
  }
}

export async function scanAndRegisterAgents(
  owner: ExtensionOwner,
  ctx: ExtensionContext,
  generation = owner.generation,
): Promise<void> {
  const agentDir = getAgentDir();
  const userAgentDir = path.join(agentDir, "agents");
  const projectTrusted = ctx.isProjectTrusted();
  const sharedAgentDir = projectTrusted ? path.join(ctx.cwd, ".agents", "agents") : "";
  const projectAgentDir = projectTrusted ? path.join(ctx.cwd, ".pi", "agents") : "";

  // Store scan dirs for on-demand discovery (agents added during the session)
  owner.registry.setAgentScanDirs(userAgentDir, projectAgentDir, sharedAgentDir);

  const disableDefaults = getStore(owner).agent.disableDefaultAgents;

  const merged = await owner.registry.scanAndMerge({ disableDefaultAgents: disableDefaults });

  if (owner.generation !== generation) return;
  owner.registry.registerAgents(merged, { disableDefaultAgents: disableDefaults });
}

export async function loadConfigAndRegisterAgents(
  owner: ExtensionOwner,
  ctx: ExtensionContext,
  generation = owner.generation,
): Promise<void> {
  const projectDir = ctx.isProjectTrusted() ? path.join(ctx.cwd, ".pi") : undefined;
  // Each session owns its IO instance; no ConfigStore construction at factory/import time.
  owner.store = new ConfigStore(createConfigIO(projectDir));
  await scanAndRegisterAgents(owner, ctx, generation);
  if (owner.generation !== generation) return;
  ensureManagerAndWidget(owner);
}

// --- Event listener setup ---

/** Open the viewer overlay; the viewerOpen flag prevents nav deactivation while open. */
async function openViewer(owner: ExtensionOwner, ctx: ExtensionContext, record: AgentRecord | null): Promise<void> {
  if (!record) return;
  if (!record.execution?.session) return;
  const widget = getWidget(owner);
  if (!widget) return;
  const manager = getManager(owner);

  try {
    widget.setViewerOpen(true);

    await ctx.ui.custom<void>((tui, theme, kb, done) => {
      const viewer = new ConversationViewer(
        owner,
        tui,
        record.execution.session!,
        record,
        theme,
        done,
        () => manager?.abort(record.id, "user"),
        kb,
        (msg: string) => manager?.steer(record.id, msg),
      );
      viewer.setModelDisplayStyle(getStore(owner).agent.modelDisplayStyle);
      return viewer;
    });
  } finally {
    widget.setViewerOpen(false);
  }
}

type InputListenerResult = { consume: true } | undefined;

/** Exposed for tests to drive the real handler with a stubbed ctx. */
export function createNavInputHandler(
  owner: ExtensionOwner,
  ctx: ExtensionContext,
): (data: string) => InputListenerResult {
  const generation = owner.generation;
  return (data: string) => {
    if (generation !== owner.generation) return undefined;
    const widget = getWidget(owner);

    // Only fire on key press (not release).
    if (isKeyRelease(data)) return undefined;

    // Viewer overlay open — don't consume, don't deactivate.
    if (widget?.isViewerOpen()) {
      return undefined;
    }

    // Editor lost focus (dialog, menu, etc.) — deactivate.
    if (widget && !widget.isEditorFocused()) {
      if (widget.isNavActive()) widget.navDeactivate();
      return undefined;
    }

    if (widget) {
      if (!widget.isNavActive()) {
        // ↓ + empty editor + visible agents exist → activate
        const editorEmpty = (ctx.ui as any).getEditorText?.() === "";
        if (matchesKey(data, "down") && widget.hasVisibleAgents() && editorEmpty) {
          widget.navActivate();
          return { consume: true };
        }
      } else {
        if (matchesKey(data, "down")) {
          widget.navDown();
          return { consume: true };
        }
        if (matchesKey(data, "up")) {
          widget.navUp();
          return { consume: true };
        }
        if (matchesKey(data, "escape")) {
          widget.navDeactivate();
          return { consume: true };
        }
        if (matchesKey(data, "enter")) {
          const record = widget.navSelect();
          openViewer(owner, ctx, record).catch((err) => {
            ctx.ui.notify(`Failed to open agent viewer: ${String(err)}`, "error");
          });
          return { consume: true };
        }
        // Any other key → deactivate, pass through.
        widget.navDeactivate();
      }
    }

    // ctrl+o toggles tool expansion — sync compact mode with the new state.
    // Not consumed: pi's built-in handler owns the actual toggle.
    if (matchesKey(data, "ctrl+o")) {
      // Read state after a tick so the built-in handler applies the toggle first.
      setTimeout(() => {
        if (generation !== owner.generation || !owner.store) return;
        const ui = ctx.ui as unknown as { getToolsExpanded?: () => boolean };
        const expanded = ui.getToolsExpanded?.();
        if (expanded !== undefined) {
          getStore(owner).notifyToolsExpanded(expanded);
        }
      }, 0);
    }

    return undefined; // Don't consume the input
  };
}

/** Disable notifications before aborting children; detach every reference synchronously. */
function disposeSession(owner: ExtensionOwner): Promise<void> {
  owner.unregisterTerminalInput?.();
  owner.unregisterTerminalInput = null;
  cleanupInvalidations(owner);
  owner.registry.reset();
  owner.coordinator?.dispose();
  owner.coordinator = null;
  owner.widget?.dispose();
  owner.widget = null;
  owner.store?.dispose();
  owner.store = null;
  const manager = owner.manager;
  owner.manager = null;
  owner.sessionCtx = null;
  return manager?.dispose() ?? Promise.resolve();
}

export function setupEventListeners(pi: ExtensionAPI, owner: ExtensionOwner): void {
  pi.on("tool_call", (event, ctx) => toolCallListener(owner, event, ctx));

  pi.on("turn_start", async (_event, ctx) => {
    getWidget(owner)?.setUICtx(ctx.ui as unknown as UICtx);
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const generation = ++owner.generation;
    await disposeSession(owner);
    if (owner.generation !== generation) return;
    setSessionCtx(owner, ctx);
    await loadConfigAndRegisterAgents(owner, ctx, generation);
    if (owner.generation !== generation) return;
    registerAgentTool(pi, owner);
    if (ctx.hasUI) {
      owner.unregisterTerminalInput = ctx.ui.onTerminalInput(createNavInputHandler(owner, ctx));
    }
    getStore(owner).notifyToolsExpanded(false);
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    ++owner.generation;
    const active =
      owner.manager?.listAgents().filter((r) => r.lifecycle.status === "running" || r.lifecycle.status === "queued") ??
      [];
    if (active.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`${active.length} agent(s) killed by reload`, "warning");
    }
    await disposeSession(owner);
  });
}
