/**
 * run-session-harness.ts — Typed in-memory RunSession for run-policy tests.
 *
 * Drives runSessionPrompt() without the SDK or module mocks: the test holds
 * the prompt open, emits session events, and controls steer/abort results.
 */
import { vi, type Mock } from "vite-plus/test";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RunSession } from "../../src/agents/session-run.js";

type Listener = (event: AgentSessionEvent) => void;

export interface RunSessionHarness {
  session: RunSession;
  steer: Mock<RunSession["steer"]>;
  abort: Mock<RunSession["abort"]>;
  /** Resolves once prompt() is awaited by the run. */
  promptStarted: Promise<void>;
  /** Settle the pending prompt() so the run returns. */
  finishPrompt: () => void;
  emit: (event: AgentSessionEvent) => void;
  endTurns: (count: number) => void;
  listenerCount: () => number;
}

/** A minimal turn_end; the run policy reads only its type. */
const TURN_END = { type: "turn_end", message: {}, toolResults: [] } as unknown as AgentSessionEvent;

export function createRunSessionHarness(messages: AgentSession["messages"] = []): RunSessionHarness {
  const listeners = new Set<Listener>();
  let finishPrompt: () => void = () => {};
  let markStarted: () => void = () => {};
  const promptStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const steer = vi.fn<RunSession["steer"]>(async () => "queued");
  const abort = vi.fn<RunSession["abort"]>(async () => {});
  const session: RunSession = {
    messages,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: () =>
      new Promise<void>((resolve) => {
        finishPrompt = resolve;
        markStarted();
      }),
    steer,
    abort,
  };
  const emit = (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  return {
    session,
    steer,
    abort,
    promptStarted,
    finishPrompt: () => finishPrompt(),
    emit,
    endTurns: (count) => {
      for (let i = 0; i < count; i++) emit(TURN_END);
    },
    listenerCount: () => listeners.size,
  };
}

/** A rejected promise already marked handled, with a spy on the guard's .catch. */
export function handledRejection<T = void>(message: string): { promise: Promise<T>; catchSpy: Mock } {
  const promise = Promise.reject<T>(new Error(message));
  // Mark handled before spying: the guard attaches its handler a few ticks
  // later. spyOn installs an own `catch`, so the guard still hits the spy.
  promise.catch(() => {});
  const catchSpy = vi.spyOn(promise, "catch") as unknown as Mock;
  return { promise, catchSpy };
}
