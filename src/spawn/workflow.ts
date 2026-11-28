import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { formatTerminalContent } from "../agents/agent-result.ts";
import { getCoordinator, getPiInstance, getStore, type ExtensionOwner } from "../shell.ts";
import type { SubagentParentReport } from "../types.ts";
import { prepareSpawnIntent } from "./spawn-preparation.ts";
import { resolveSpawn } from "./spawn-resolution.ts";

const workflowStep = Type.Object(
  {
    agent: Type.String({ pattern: "\\S", description: "Agent type to spawn in the current project." }),
    prompt: Type.String({ pattern: "\\S", description: "Self-contained task for this step." }),
  },
  { additionalProperties: false },
);

export const workflowParameters = Type.Object(
  {
    steps: Type.Array(workflowStep, {
      minItems: 1,
      maxItems: 8,
      description: "Run these foreground steps in order. A later step starts only if the previous step completed.",
    }),
  },
  { additionalProperties: false },
);

interface StepResult {
  agentId: string;
  runId?: string;
  status: SubagentParentReport["status"] | "unavailable";
}

export async function executeWorkflow(
  owner: ExtensionOwner,
  _toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
) {
  if (!Check(workflowParameters, params)) throw new Error("Invalid Workflow steps: specify 1 to 8 agent/prompt pairs");
  const coordinator = getCoordinator(owner);
  if (!coordinator) throw new Error("Subagents session has not started");
  coordinator.assertCurrentParent(ctx);
  const store = getStore(owner);
  const checkCanStart = () => {
    if (signal?.aborted) throw new Error("Parent interrupted the workflow");
    coordinator.assertCurrentParent(ctx);
    if (store.agent.forceBackground) throw new Error("Workflow requires foreground runs; Force Background is enabled");
  };
  checkCanStart();

  const steps: StepResult[] = [];
  const output: string[] = [];
  const finish = (reason?: string) => ({
    content: [{ type: "text" as const, text: [reason ?? "Workflow completed.", ...output].join("\n\n") }],
    details: { status: reason ? "stopped" : "completed", steps },
  });

  for (const [index, { agent, prompt }] of params.steps.entries()) {
    const step = index + 1;
    try {
      checkCanStart();
      const spawn = await resolveSpawn(
        owner,
        ctx,
        agent,
        undefined,
        { kind: "default" },
        undefined,
        coordinator,
        signal,
      );
      checkCanStart();
      const { agentId, foregroundReport: report } = await coordinator.spawn(
        getPiInstance(owner),
        ctx,
        prepareSpawnIntent({
          ...spawn,
          prompt,
          description: (prompt.split("\n", 1)[0] || prompt).slice(0, 80),
          defaultMaxTurns: store.agent.defaultMaxTurns,
          graceTurns: store.agent.graceTurns,
          runInBackground: false,
          signal,
        }),
      );
      const status = report?.status ?? "unavailable";
      const terminal = report && report.status !== "stopping" ? report : undefined;
      steps.push({ agentId, status, ...(terminal && { runId: terminal.runId }) });
      const text = terminal ? formatTerminalContent(terminal) : "";
      output.push(`Step ${step} (${report?.type ?? agent}, ${agentId}): ${status}${text ? `\n${text}` : ""}`);
      if (status !== "completed") return finish(`Workflow stopped at step ${step}: ${status}.`);
      if (signal?.aborted) return finish(`Workflow stopped after step ${step}: parent interrupted.`);
      if (!coordinator.isCurrentParent(ctx))
        return finish(`Workflow stopped after step ${step}: parent session changed.`);
    } catch (error) {
      const message = signal?.aborted ? "parent interrupted" : error instanceof Error ? error.message : String(error);
      return finish(`Workflow stopped at step ${step}: ${message}`);
    }
  }
  return finish();
}
