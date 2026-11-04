/**
 * agent-runner-session-events.test.ts — Session-event wiring for agent-runner:
 * retry-classifier patching. Event forwarding is covered in session-run-events.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { mockModules, resetMocks, createMockSession } from "./agent-runner-mocks.js";

const fakePi = makeFakePi();

import { runAgent } from "../../src/agents/agent-runner.js";

/* ------------------------------------------------------------------ */
/*  runAgent — codex stream error retry wiring                         */
/* ------------------------------------------------------------------ */

describe("runAgent — codex stream error retry wiring", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("wraps the session's _isRetryableError classifier", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    const originalClassifier = vi.fn().mockReturnValue(false);
    session._isRetryableError = originalClassifier;
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    await runAgent(owner, fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(session._isRetryableError).not.toBe(originalClassifier);
    // Transient Codex stream errors are classified as retryable by our pattern...
    expect(
      session._isRetryableError!({ stopReason: "error", errorMessage: "stream disconnected before completion" }),
    ).toBe(true);
    // ...without calling the original (our pattern matches first).
    expect(originalClassifier).not.toHaveBeenCalled();
    // Other errors fall through to the original classifier.
    originalClassifier.mockClear();
    expect(session._isRetryableError!({ stopReason: "error", errorMessage: "rate limited" })).toBe(false);
    expect(originalClassifier).toHaveBeenCalled();
  });
});

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
