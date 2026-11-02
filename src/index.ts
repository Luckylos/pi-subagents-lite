/**
 * index.ts — Local subagents extension entry point.
 *
 * Stealth tool registration: all tools register at init with no description,
 * promptSnippet, or promptGuidelines; the model param is injected via the
 * tool_call listener. Config lives in ConfigStore (loaded from
 * ~/.pi/agent/subagents-lite.json at session_start); tool execution and
 * menus read/write through it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtensionOwner } from "./shell.ts";
import { isChildExtensionLoad } from "./child-load-context.ts";
import { registerTools } from "./registration.ts";
import { setupEventListeners } from "./events.ts";

export default function (pi: ExtensionAPI) {
  // Child resource loaders mark only their own factory-loading calls.
  if (isChildExtensionLoad()) return;
  const owner = createExtensionOwner(pi);
  registerTools(pi, owner);
  setupEventListeners(pi, owner);
}
