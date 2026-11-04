/**
 * parent-message.ts — The MessageParent tool bound into a background Subagent's
 * child session (ADR-0013).
 *
 * Owns the tool contract only: trimming, the per-run cap, and result text.
 * Delivery is injected so the caller (SpawnCoordinator) keeps the owner-bound
 * path a Nudge uses. The tool never names a recipient.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const PARENT_MESSAGE_TOOL_NAME = "MessageParent";
/** Delivered Parent messages allowed per Subagent run. */
export const PARENT_MESSAGE_LIMIT = 5;

// Unlike the parent-side tools (ADR-0009 dot descriptions), this tool lives only
// in the child session, where the description is its sole usage guidance.
const DESCRIPTION =
  "Send a short message to the parent agent while you keep working. Use it only for what the parent needs " +
  "before you finish, such as a blocking question or a finding that changes its plan. You do not get a reply " +
  "here; the parent may answer with a new message to you. Your final answer is delivered automatically, so " +
  "never repeat it with this tool.";

const parameters = Type.Object({ message: Type.String() });

export interface ParentMessageToolOptions {
  /** Deliver the trimmed text to the parent session; false when it could not be delivered. */
  deliver: (text: string) => boolean;
  /** Identifies the current Subagent run; a new value restores the allowance. */
  runKey: () => number;
  limit?: number;
}

export function createParentMessageTool(opts: ParentMessageToolOptions): ToolDefinition<typeof parameters> {
  const limit = opts.limit ?? PARENT_MESSAGE_LIMIT;
  let countedRun = opts.runKey();
  let delivered = 0;

  return {
    name: PARENT_MESSAGE_TOOL_NAME,
    label: PARENT_MESSAGE_TOOL_NAME,
    description: DESCRIPTION,
    parameters,
    async execute(_toolCallId, params) {
      const text = typeof params.message === "string" ? params.message.trim() : "";
      if (!text) throw new Error("message is required");

      const run = opts.runKey();
      if (run !== countedRun) {
        countedRun = run;
        delivered = 0;
      }
      if (delivered >= limit) {
        throw new Error(`Parent message limit (${limit}) reached for this run; put the rest in your final answer.`);
      }
      if (!opts.deliver(text)) throw new Error("Not delivered: the parent session is unavailable.");

      delivered++;
      return { content: [{ type: "text", text: "Delivered to the parent session." }], details: undefined };
    },
  };
}
