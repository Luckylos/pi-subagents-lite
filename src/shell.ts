/** Per-factory composition root. Construction registers ownership without session IO. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agents/agent-manager.ts";
import type { AgentWidget } from "./ui/agent-widget.ts";
import type { SpawnCoordinator } from "./spawn/spawn-coordinator.ts";
import type { ConfigStore } from "./config/config-store.ts";
import { createAgentRegistry, type AgentRegistry } from "./agents/agent-types.ts";

export interface ExtensionOwner {
  readonly pi: ExtensionAPI;
  readonly registry: AgentRegistry;
  readonly rendererInvalidations: Map<string, () => void>;
  sessionCtx: ExtensionContext | null;
  store: ConfigStore | null;
  manager: AgentManager | null;
  widget: AgentWidget | null;
  coordinator: SpawnCoordinator | null;
  generation: number;
  unregisterTerminalInput: (() => void) | null;
}

export function createExtensionOwner(pi: ExtensionAPI): ExtensionOwner {
  return {
    pi,
    registry: createAgentRegistry(),
    rendererInvalidations: new Map(),
    sessionCtx: null,
    store: null,
    manager: null,
    widget: null,
    coordinator: null,
    generation: 0,
    unregisterTerminalInput: null,
  };
}

export function getPiInstance(owner: ExtensionOwner): ExtensionAPI {
  return owner.pi;
}
export function getSessionCtx(owner: ExtensionOwner): ExtensionContext | null {
  return owner.sessionCtx;
}
export function getManager(owner: ExtensionOwner): AgentManager | null {
  return owner.manager;
}
export function getWidget(owner: ExtensionOwner): AgentWidget | null {
  return owner.widget;
}
export function getStore(owner: ExtensionOwner): ConfigStore {
  if (!owner.store) throw new Error("Subagents session has not started");
  return owner.store;
}
export function getCoordinator(owner: ExtensionOwner): SpawnCoordinator | null {
  return owner.coordinator;
}
export function setSessionCtx(owner: ExtensionOwner, ctx: ExtensionContext): void {
  owner.sessionCtx = ctx;
}
export function setManager(owner: ExtensionOwner, manager: AgentManager | null): void {
  owner.manager = manager;
}
export function setWidget(owner: ExtensionOwner, widget: AgentWidget | null): void {
  owner.widget = widget;
}
export function setCoordinator(owner: ExtensionOwner, coordinator: SpawnCoordinator | null): void {
  owner.coordinator = coordinator;
}
