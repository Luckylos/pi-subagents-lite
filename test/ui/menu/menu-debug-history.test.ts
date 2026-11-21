import { expect, it, vi } from "vite-plus/test";
import type { SelectList } from "@earendil-works/pi-tui";
import type { JsonObject } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { emit, parent, services } from "../../instance-fixtures.js";
import { runAgent } from "../../../src/agents/agent-runner.js";
import { assistantMessage } from "../../agents/session-messages.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { registerAgentTool } from "../../../src/registration.js";
import { showDebugMenu } from "../../../src/ui/menu/menu-debug.js";

const { SessionManager } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
  "@earendil-works/pi-coding-agent",
);
let select: (value: string) => Promise<void>;
vi.mock("@earendil-works/pi-tui", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-tui")>();
  return {
    ...actual,
    SelectList: class extends actual.SelectList {
      constructor(...args: ConstructorParameters<typeof SelectList>) {
        super(...args);
        select = async (value) => {
          const item = args[0].find((entry) => entry.value === value);
          if (!item || !this.onSelect) throw new Error(`Menu action not found: ${value}`);
          await this.onSelect(item);
        };
      }
    },
  };
});

async function openDebug() {
  const fixture = parent();
  const session = SessionManager.inMemory();
  const ctx = { ...createMockCtx(), sessionManager: session };
  await emit(fixture, "session_start", ctx);
  await showDebugMenu(fixture.owner, ctx);
  return { fixture, ctx, session };
}

it("restarts only valid calls in a mixed Debug menu replay, including nullable and legacy arguments", async () => {
  const { fixture, ctx, session } = await openDebug();
  const schema = () => fixture.api.tools.filter((tool) => tool.name === "Agent").at(-1)!.parameters;
  const current = { prompt: "", run_in_background: false };
  expect(Check(schema(), current)).toBe(true);
  const { store } = services(fixture);
  vi.spyOn(store, "agent", "get").mockReturnValue({ ...store.agent, agentToolStrictMode: true });
  registerAgentTool(fixture.owner.pi, fixture.owner);
  const nullable = { prompt: "  \nnext", description: null, agent: null, run_in_background: null, worktree_path: null };
  expect(Check(schema(), nullable)).toBe(true);
  // Persisted JSON can violate even Pi's static ToolCall.arguments object type.
  const malformed: JsonObject[] = JSON.parse(
    '[{},null,[],"bad",{"description":"missing prompt"},{"prompt":7},{"prompt":"bad","agent":[]},{"prompt":"bad","max_turns":"7"}]',
  );
  const legacy = { prompt: "legacy", model: "old/retired", _modelOverride: "retired", max_turns: 7 };
  session.appendMessage(
    assistantMessage({
      content: [...malformed, current, nullable, legacy].map((args, i) => ({
        type: "toolCall",
        id: `tc-${i}`,
        name: "Agent",
        arguments: args,
      })),
    }),
  );

  await select("restart-last-agents");

  expect(vi.mocked(runAgent).mock.calls.map(([, , type, prompt]) => [type, prompt])).toEqual([
    ["general-purpose", current.prompt],
    ["general-purpose", nullable.prompt],
    ["general-purpose", legacy.prompt],
  ]);
  expect(vi.mocked(runAgent).mock.lastCall?.[4]).toMatchObject({ maxTurns: 7, model: ctx.model });
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`Skipped ${malformed.length} agent(s):`), "info");
});

it("briefs only the parameters accepted by the registered Agent tool", async () => {
  const { fixture } = await openDebug();
  const { store } = services(fixture);
  vi.spyOn(store, "agent", "get").mockReturnValue({ ...store.agent, loadToolsImplicitly: false });
  await select("agent-briefing");
  const briefing: string = fixture.api.api.sendUserMessage.mock.calls[0][0];
  const names = Array.from(briefing.matchAll(/^\| `([^`]+)` \|/gm), ([, name]) => name);
  const schema = fixture.api.tools.find((tool) => tool.name === "Agent")!.parameters;
  expect(names.sort()).toEqual(Object.keys(schema.properties).sort());
  expect(briefing).not.toMatch(/\| `description` \|[^\n]*\(required\)/);
});
