import { afterEach, beforeEach, vi } from "vite-plus/test";
import type { LoadedConfig } from "../src/config/config-io.js";
import type { RunResult } from "../src/agents/agent-runner.js";
import { createMockExtensionAPI, fakeCtx, type MockExtensionAPI } from "./fixtures.js";
import { asAgentSession, asExtensionAPI } from "./pi-boundaries.js";
import factory from "../src/index.js";
import { createExtensionOwner, type ExtensionOwner } from "../src/shell.js";

// Keep ownership, registry, services, lifecycle and timer delivery real. Only
// resource IO and the runner boundary are controlled; no settings/model IO.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/test/instance-isolation/agent",
  DynamicBorder: class {},
}));
vi.mock("../src/config/config-io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/config-io.js")>();
  return {
    ...actual,
    createConfigIO: vi.fn(() => ({
      load: vi.fn((): LoadedConfig => ({ global: {}, project: null, projectStatus: "untrusted" })),
      updateLayer: vi.fn(() => ({ global: {}, project: null, projectStatus: "untrusted" })),
      saveGlobal: vi.fn(),
      saveProject: vi.fn(),
    })),
  };
});
vi.mock("../src/agents/agent-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/agent-discovery.js")>()),
  scanAgentFilesInDir: vi.fn(async () => []),
}));
vi.mock("../src/agents/agent-runner.js", () => ({
  runAgent: vi.fn<(typeof import("../src/agents/agent-runner.js"))["runAgent"]>(),
  continueAgentSession: vi.fn<(typeof import("../src/agents/agent-runner.js"))["continueAgentSession"]>(),
}));
vi.mock("../src/shell.js", { spy: true });

import { createConfigIO } from "../src/config/config-io.js";
import { runAgent } from "../src/agents/agent-runner.js";
import { scanAgentFilesInDir } from "../src/agents/agent-discovery.js";
export { runAgent, scanAgentFilesInDir, createConfigIO };

export interface ParentFixture {
  api: MockExtensionAPI;
  owner: ExtensionOwner;
}
const parents: ParentFixture[] = [];

export function parent(): ParentFixture {
  const api = createMockExtensionAPI();
  factory(asExtensionAPI(api.api));
  const result = vi.mocked(createExtensionOwner).mock.results.at(-1);
  if (!result || result.type !== "return") throw new Error("factory did not create owner");
  const fixture = { api, owner: result.value };
  parents.push(fixture);
  return fixture;
}

export async function emit(
  parent: ParentFixture,
  event: "session_start" | "session_shutdown" | "turn_start",
  ctx = fakeCtx({ hasUI: false }),
) {
  const listener = parent.api.listeners.find((listener) => listener.event === event);
  if (!listener) throw new Error(`${event} handler missing`);
  await listener.handler({ type: event }, ctx);
  return ctx;
}

export function services(parent: ParentFixture) {
  const { owner } = parent;
  if (!owner.manager || !owner.coordinator || !owner.widget || !owner.store)
    throw new Error("session services missing");
  return { manager: owner.manager, coordinator: owner.coordinator, widget: owner.widget, store: owner.store };
}

export async function spawn(parent: ParentFixture, ctx = fakeCtx({ hasUI: false })) {
  const { coordinator } = services(parent);
  const result = await coordinator.spawn(asExtensionAPI(parent.api.api), ctx, {
    type: "general-purpose",
    prompt: "controlled execution",
    description: "A's agent",
    graceTurns: 6,
    runInBackground: true,
  });
  await result.record.execution.promise;
  return result;
}

export function finishedRun(): RunResult {
  return {
    responseText: "A finished work",
    aborted: false,
    turnLimited: false,
    session: asAgentSession({
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      messages: [],
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(scanAgentFilesInDir).mockResolvedValue([]);
  vi.mocked(runAgent).mockResolvedValue(finishedRun());
});
afterEach(async () => {
  for (const fixture of parents) await emit(fixture, "session_shutdown");
  parents.length = 0;
  vi.useRealTimers();
});
