import { Input, matchesKey } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentSubmissionResult } from "../types.ts";
import type { RunActionTarget } from "./run-actions.ts";
import { plainText } from "./sanitize.ts";

export type MessageIntent = "steer" | "continue";
export const STALE_RUN_REASON = "The run changed while you were composing. Reopen the action and try again.";

export function messageIntent(record: AgentRecord): MessageIntent | undefined {
  const { phase, status } = record.lifecycle;
  if (phase === "running" || (!phase && status === "running")) return "steer";
  if (record.execution.session && (phase === "settled" || (!phase && status !== "queued"))) return "continue";
  return undefined;
}

export function submitToRun(
  record: AgentRecord,
  target: RunActionTarget,
  intent: MessageIntent,
  submit: (message: string) => Promise<AgentSubmissionResult>,
): (message: string) => Promise<AgentSubmissionResult> {
  return (message) => {
    if (!target.isCurrent() || messageIntent(record) !== intent) {
      return Promise.resolve({ accepted: false, reason: "unavailable", message: STALE_RUN_REASON });
    }
    return submit(message);
  };
}

/** One input and its cursor/draft, retained across Esc within the same action. */
export class MessageComposer {
  readonly input = new Input();
  pending = false;
  feedback: string | undefined;
  private active = false;
  private activation = 0;

  constructor(
    readonly intent: MessageIntent,
    submit: (message: string) => Promise<AgentSubmissionResult>,
    private leave: () => void,
    private refresh: () => void,
  ) {
    this.input.onEscape = () => this.dismiss();
    this.input.onSubmit = async (value) => {
      if (!this.active || this.pending || !value.trim()) return;
      const activation = this.activation;
      this.pending = true;
      this.feedback = undefined;
      this.refresh();
      let result: AgentSubmissionResult;
      try {
        result = await submit(value);
      } catch {
        result = {
          accepted: false,
          reason: "delivery_failed",
          message: "The message could not be submitted. Try again.",
        };
      }
      this.pending = false;
      if (result.accepted) {
        this.input.setValue("");
        if (this.active && activation === this.activation) this.dismiss();
      } else {
        const reason = plainText(result.message).trim() || "The message could not be submitted. Try again.";
        this.feedback = `${intent === "continue" ? "Continue" : "Message"} not accepted: ${reason}`;
      }
      if (this.active) this.refresh();
    };
  }

  open(): void {
    this.activation++;
    this.active = true;
    this.input.focused = true;
  }

  hide(): void {
    this.active = false;
    this.input.focused = false;
  }

  handleInput(data: string): void {
    if (!this.active) return;
    if (!this.pending) this.input.handleInput(data);
    else if (matchesKey(data, "escape")) this.dismiss();
  }

  private dismiss(): void {
    this.hide();
    this.leave();
    this.refresh();
  }
}
