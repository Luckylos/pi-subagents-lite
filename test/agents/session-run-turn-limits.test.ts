/**
 * session-run-turn-limits.test.ts — Turn limits and abort forwarding.
 *
 * Drives runSessionPrompt() against an in-memory RunSession: steer at the
 * soft limit, hard-abort after the grace turns, and swallow rejections from
 * steer/abort fired inside event and signal listeners.
 */
import { describe, it, expect } from "vite-plus/test";
import { runSessionPrompt } from "../../src/agents/session-run.js";
import { DEFAULT_GRACE_TURNS } from "../../src/config/config-io.js";
import { createRunSessionHarness, handledRejection } from "./run-session-harness.js";

describe("runSessionPrompt — turn limits", () => {
  it.each([
    { maxTurns: 1, graceTurns: undefined, abortAt: 1 + DEFAULT_GRACE_TURNS },
    { maxTurns: 2, graceTurns: 3, abortAt: 5 },
    { maxTurns: 2, graceTurns: 0, abortAt: 3 },
  ])("steers at maxTurns=$maxTurns and aborts at turn $abortAt (graceTurns=$graceTurns)", async (c) => {
    const h = createRunSessionHarness();
    const run = runSessionPrompt(h.session, "do something", { maxTurns: c.maxTurns, graceTurns: c.graceTurns });
    await h.promptStarted;

    h.endTurns(c.maxTurns);
    expect(h.steer).toHaveBeenCalledTimes(1);
    // graceTurns=0 still allows the one turn already in flight after the steer.
    h.endTurns(Math.max(c.abortAt - c.maxTurns - 1, 0));
    expect(h.abort).not.toHaveBeenCalled();
    h.endTurns(1);
    expect(h.abort).toHaveBeenCalledTimes(1);

    h.finishPrompt();
    const result = await run;
    expect(result).toMatchObject({ aborted: true, turnLimited: true });
    expect(h.listenerCount()).toBe(0);
  });

  it("reports turnLimited without abort when the agent wraps up within grace", async () => {
    const h = createRunSessionHarness();
    const run = runSessionPrompt(h.session, "do something", { maxTurns: 1, graceTurns: 5 });
    await h.promptStarted;

    h.endTurns(3);
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.abort).not.toHaveBeenCalled();

    h.finishPrompt();
    expect(await run).toMatchObject({ aborted: false, turnLimited: true });
  });

  it("attaches rejection handlers to steer and abort", async () => {
    // Both calls fire from inside a subscribe callback, so a rejection would
    // escape the run (fatal under --unhandled-rejections=throw). Asserted via a
    // .catch spy: vitest intercepts unhandled rejections, so a leak would pass.
    const h = createRunSessionHarness();
    const steerRejection = handledRejection<Awaited<ReturnType<typeof h.steer>>>("session closing");
    const abortRejection = handledRejection("already aborting");
    h.steer.mockImplementation(() => steerRejection.promise);
    h.abort.mockImplementation(() => abortRejection.promise);

    const run = runSessionPrompt(h.session, "do something", { maxTurns: 1, graceTurns: 1 });
    await h.promptStarted;
    h.endTurns(2);

    expect(steerRejection.catchSpy).toHaveBeenCalled();
    expect(abortRejection.catchSpy).toHaveBeenCalled();
    h.finishPrompt();
    // A rejected abort() must not change the reported outcome.
    expect((await run).aborted).toBe(true);
  });

  it("handles a rejected abort fired from the parent signal", async () => {
    const h = createRunSessionHarness();
    const abortRejection = handledRejection("already aborting");
    h.abort.mockImplementation(() => abortRejection.promise);
    const controller = new AbortController();

    const run = runSessionPrompt(h.session, "do something", { signal: controller.signal });
    await h.promptStarted;
    controller.abort();

    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(abortRejection.catchSpy).toHaveBeenCalled();
    h.finishPrompt();
    await run;
  });
});
