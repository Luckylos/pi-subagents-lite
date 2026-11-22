import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { getHideThinkingBlock, readPiSettings } from "../src/pi-settings.ts";
import { AgentManager } from "../src/agents/agent-manager.ts";
import { prepareConversationViewer } from "../src/ui/open-conversation-viewer.ts";
import { ConversationViewer } from "../src/ui/conversation-viewer.ts";
import { createTestOwner } from "./owner-fixtures.ts";
import { createMockCtx, type ComponentFactory } from "./menu-test-helpers.ts";
import { asAgentSession } from "./pi-boundaries.ts";
import { makeAgentRecord } from "./fixtures.ts";
import { assistantMessage } from "./agents/session-messages.ts";

const access = vi.hoisted(() => ({ root: "", parentReads: 0, blocked: 0 }));
function guardedRead(actual: Pick<typeof fs, "readFileSync">) {
  return (...args: Parameters<typeof actual.readFileSync>) => {
    const file = typeof args[0] === "string" ? args[0] : "";
    if (file.endsWith("settings.json")) {
      if (!access.root || !file.startsWith(`${access.root}${path.sep}`)) {
        access.blocked++;
        throw new Error("Settings read outside owned fixture blocked");
      }
      if (file.includes(`${path.sep}parent${path.sep}`)) access.parentReads++;
    }
    return actual.readFileSync(...args);
  };
}
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: guardedRead(actual) };
});
// The SDK imports bare fs, while the extension uses node:fs. Guard both.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: guardedRead(actual) };
});

describe("persisted parent Thinking visibility", () => {
  let root: string;
  let agentDir: string;
  let parent: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-visibility-"));
    fs.chmodSync(root, 0o700);
    access.root = root;
    access.parentReads = 0;
    access.blocked = 0;
    agentDir = path.join(root, "agent");
    parent = path.join(root, "parent");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(path.join(parent, ".pi"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    // Externalized SDK modules bypass Vitest module mocks. Update the builtin
    // named export too, preserving the original function to avoid recursion.
    const original = fsDefault.readFileSync;
    vi.spyOn(fsDefault, "readFileSync").mockImplementation(guardedRead({ readFileSync: original }));
    syncBuiltinESMExports();
  });
  afterEach(() => {
    const blocked = access.blocked;
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
    access.root = "";
    expect(blocked).toBe(0);
  });
  const global = (value: boolean) =>
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ hideThinkingBlock: value }));
  const project = (value: boolean) =>
    fs.writeFileSync(path.join(parent, ".pi/settings.json"), JSON.stringify({ hideThinkingBlock: value }));
  it("uses the SDK custom agent directory for the compatible global reader", () => {
    global(true);
    expect(readPiSettings()).toEqual({ hideThinkingBlock: true });
    expect(getHideThinkingBlock()).toBe(true);
  });
  it("lets explicit parent false override global true and rereads on reopen", () => {
    global(true);
    project(false);
    expect(getHideThinkingBlock(parent, { projectTrusted: true })).toBe(false);
    project(true);
    expect(getHideThinkingBlock(parent, { projectTrusted: true })).toBe(true);
  });
  it.each([true, false])(
    "ignores an untrusted parent with global hidden=%s and never substitutes target settings",
    (hidden) => {
      global(hidden);
      project(!hidden);
      expect(getHideThinkingBlock(parent, { projectTrusted: false })).toBe(hidden);
      expect(access.parentReads).toBe(0);
      const target = path.join(root, "target");
      fs.mkdirSync(path.join(target, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(target, ".pi/settings.json"), JSON.stringify({ hideThinkingBlock: hidden }));
      expect(getHideThinkingBlock(parent, { projectTrusted: true })).toBe(!hidden);
      expect(access.parentReads).toBeGreaterThan(0);
    },
  );
  it("defaults safely for missing and malformed settings", () => {
    expect(getHideThinkingBlock(parent, { projectTrusted: true })).toBe(false);
    fs.writeFileSync(path.join(agentDir, "settings.json"), "{bad");
    expect(readPiSettings()).toBeUndefined();
    expect(getHideThinkingBlock(parent, { projectTrusted: true })).toBe(false);
    fs.writeFileSync(path.join(parent, ".pi/settings.json"), "{bad project");
    expect(getHideThinkingBlock(parent, { projectTrusted: true })).toBe(false);
  });

  it.each(["editor", "overlay"] as const)(
    "initializes %s at open time; toggles stay local and fresh viewers reread",
    async (presentation) => {
      global(true);
      project(false);
      const owner = await createTestOwner();
      const manager = new AgentManager(owner);
      owner.manager = manager;
      const viewers: ConversationViewer[] = [];
      const session = asAgentSession({
        messages: [
          assistantMessage({
            content: [
              { type: "thinking", thinking: "private reasoning" },
              { type: "text", text: "answer" },
            ],
          }),
        ],
        subscribe: vi.fn(() => () => {}),
        getContextUsage: () => undefined,
      });
      const messagesBefore = structuredClone(session.messages);
      const record = makeAgentRecord({ execution: { session } });
      const ctx = createMockCtx([], [], [], {
        ui: {
          custom: async (factory: ComponentFactory) => {
            const tui = { terminal: { rows: 40 }, requestRender: vi.fn() };
            const viewer = factory(tui, { fg: (_color, text) => text, bold: (text) => text }, undefined, vi.fn());
            if (!(viewer instanceof ConversationViewer)) throw new Error("Expected real viewer");
            viewers.push(viewer);
          },
        },
      });
      const open = prepareConversationViewer(owner, ctx.ui, record, presentation, {
        cwd: parent,
        projectTrusted: true,
      });
      expect(open).toBeDefined();
      try {
        project(true); // Reading is delayed until actual open, not prepare.
        await open?.();
        const first = viewers[0];
        expect(first.render(80).join("\n")).not.toContain("private reasoning");
        const globalBefore = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
        const projectBefore = fs.readFileSync(path.join(parent, ".pi/settings.json"), "utf8");
        first.handleInput("\x14");
        expect(first.render(80).join("\n")).toContain("private reasoning");
        expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(globalBefore);
        expect(fs.readFileSync(path.join(parent, ".pi/settings.json"), "utf8")).toBe(projectBefore);
        await open?.();
        expect(viewers[1].render(80).join("\n")).not.toContain("private reasoning");
        project(false);
        await open?.();
        expect(viewers[2].render(80).join("\n")).toContain("private reasoning");
        expect(session.messages).toEqual(messagesBefore);
      } finally {
        for (const viewer of viewers) viewer.dispose();
        await manager.dispose();
      }
    },
  );
});
