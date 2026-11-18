import { describe, it, expect, beforeEach } from "vite-plus/test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { assistantMessage, userMessage } from "./session-messages.js";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { mockModules, resetMocks, createMockSession } from "./agent-runner-mocks.js";
import { runAgent } from "../../src/agents/agent-runner.js";

const fakePi = makeFakePi();

describe("runAgent — model error detection", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  function sessionWithMessages(messages: AgentSession["messages"]) {
    const session = createMockSession();
    Object.defineProperty(session, "messages", { get: () => messages, configurable: true });
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    return session;
  }

  it("returns the provider error when the final assistant message has stopReason 'error'", async () => {
    const messages: AgentSession["messages"] = [];
    const session = sessionWithMessages(messages);
    session.prompt.mockImplementation(async () => {
      messages.push(
        userMessage("task"),
        assistantMessage({ stopReason: "error", errorMessage: "model failed to load into memory" }),
      );
    });

    const result = await runAgent(owner, fakeCtx(), "test-agent", "do something", { pi: fakePi });
    expect(result.modelError).toBe("model failed to load into memory");
  });
});

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
