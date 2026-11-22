import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getManager, getStore, type ExtensionOwner } from "../shell.ts";
import type { AgentRecord } from "../types.ts";
import { ConversationViewer } from "./conversation-viewer.ts";
import { requestRunStop } from "./run-actions.ts";
import { getHideThinkingBlock } from "../pi-settings.ts";

export interface ConversationViewerSettingsScope {
  cwd: string;
  projectTrusted: boolean;
}

/** Prepare a viewer opener once a session is available, before the caller updates navigation. */
export function prepareConversationViewer(
  owner: ExtensionOwner,
  ui: Pick<ExtensionUIContext, "custom">,
  record: AgentRecord | null,
  presentation: "editor" | "overlay",
  parentScope?: ConversationViewerSettingsScope,
): (() => Promise<void>) | undefined {
  const session = record?.execution?.session;
  if (!record || !session) return;
  const manager = getManager(owner);
  if (!manager) return;

  return () =>
    ui.custom<void>(
      (tui, theme, kb, done) => {
        const viewer = new ConversationViewer(
          owner,
          tui,
          session,
          record,
          theme,
          done,
          (target) => requestRunStop(owner, record, target).text,
          kb,
          (message) => manager.submitMessage(record.id, message),
          parentScope
            ? getHideThinkingBlock(parentScope.cwd, { projectTrusted: parentScope.projectTrusted })
            : undefined,
        );
        viewer.setModelDisplayStyle(getStore(owner).agent.modelDisplayStyle);
        return viewer;
      },
      presentation === "overlay" ? { overlay: true } : undefined,
    );
}
