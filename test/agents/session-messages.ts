/**
 * session-messages.ts — Typed message factories for session tests.
 *
 * Pure: importing this file installs no module mocks, so run-policy tests can
 * build messages without loading agent-runner-mocks.ts.
 */
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

export function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

export function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 0 };
}
