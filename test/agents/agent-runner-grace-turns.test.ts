/**
 * agent-runner-grace-turns.test.ts — runAgent wiring for turn limits.
 *
 * The turn-limit policy itself is covered against an in-memory session in
 * session-run-turn-limits.test.ts. This file only proves runAgent hands its
 * maxTurns/graceTurns options to that policy.
 */
import { describe, it, expect, beforeEach } from "vite-plus/test";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { mockModules, resetMocks, createPendingPromptSession } from "./agent-runner-mocks.js";
import { runAgent } from "../../src/agents/agent-runner.js";

const fakePi = makeFakePi();

describe("runAgent — grace turns", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("passes maxTurns and graceTurns to the run's turn tracking", async () => {
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=2, graceTurns=1 → steer at turn 2, abort at turn 3
    const promise = runAgent(owner, fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 2,
      graceTurns: 1,
    });
    await promptStarted;

    for (let i = 0; i < 2; i++) session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
    expect(session.abort).toHaveBeenCalled();

    resolvePrompt();
    expect((await promise).aborted).toBe(true);
  });
});

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
