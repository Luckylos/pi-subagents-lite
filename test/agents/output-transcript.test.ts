/**
 * output-transcript.test.ts — Tests for outputTranscript setting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { closeSync, writeFileSync, type Stats } from "node:fs";
import { AgentManager } from "../../src/agents/agent-manager.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentOutputLog } from "../../src/agents/output-file.js";

import type { AgentConfig } from "../../src/agents/types.js";

// Mock modules
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "agent-00000001"),
}));

interface TranscriptMetadata extends Pick<Stats, "uid" | "mode" | "nlink" | "dev" | "ino" | "isDirectory" | "isFile"> {}

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const directoryFd = 41;
  const logFd = 42;
  const metadata = (fd: number): TranscriptMetadata => ({
    uid: process.getuid?.() ?? 0,
    mode: fd === directoryFd ? 0o40700 : 0o100600,
    nlink: 1,
    dev: 1,
    ino: fd,
    isDirectory: () => fd === directoryFd,
    isFile: () => fd === logFd,
  });

  // Keep every FS operation mocked: enabled transcript tests must never touch the default output directory.
  return {
    constants: actual.constants,
    openSync: vi.fn<typeof actual.openSync>((_path, flags) =>
      typeof flags === "number" && (flags & actual.constants.O_DIRECTORY) !== 0 ? directoryFd : logFd,
    ),
    fstatSync: vi.fn((fd: number) => metadata(fd)),
    lstatSync: vi.fn(() => metadata(logFd)),
    fchmodSync: vi.fn<typeof actual.fchmodSync>(),
    closeSync: vi.fn<typeof actual.closeSync>(),
    writeFileSync: vi.fn<typeof actual.writeFileSync>(),
    readFileSync: vi.fn<typeof actual.readFileSync>(),
    mkdirSync: vi.fn<typeof actual.mkdirSync>(),
    appendFileSync: vi.fn<typeof actual.appendFileSync>(),
    existsSync: vi.fn<typeof actual.existsSync>(),
  };
});

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: vi.fn().mockResolvedValue({
    responseText: "done",
    session: { subscribe: vi.fn(), messages: [], dispose: vi.fn() },
    aborted: false,
    turnLimited: false,
  }),
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  getAgentConfig: vi.fn(),
}));

// Mock getStore
const mockStore = {
  agent: {
    outputTranscript: true,
    toolTimeoutMinutes: 0,
  },
};

vi.mock("../../src/shell.js", async () =>
  (await import("../owner-fixtures.js")).ownerShellMock(
    await (() => ({
      getStore: vi.fn(() => mockStore),
    }))(),
  ),
);

describe("outputTranscript setting", () => {
  let manager: AgentManager;

  let mockPi: ExtensionAPI;
  let mockCtx: ExtensionContext;

  beforeEach(() => {
    mockStore.agent.outputTranscript = true;

    // Reset getAgentConfig mock to return undefined by default (no agent-level override)
    vi.mocked(owner.registry.getAgentConfig).mockReturnValue(undefined);

    manager = new AgentManager(owner, undefined, undefined, undefined);

    mockPi = {} as ExtensionAPI;
    mockCtx = { ui: { notify: vi.fn() } } as unknown as ExtensionContext;
  });

  afterEach(() => {
    void manager?.dispose().catch(() => {});
    vi.clearAllMocks();
  });

  describe("global config outputTranscript", () => {
    it("should create output log when outputTranscript is true", () => {
      const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test prompt", {
        description: "test",
      });

      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeDefined();
      expect(record?.execution.outputLog).toBeInstanceOf(AgentOutputLog);
      expect(writeFileSync).toHaveBeenCalledWith(42, expect.stringContaining("[USER] test prompt\n"), "utf-8");
      expect(closeSync).toHaveBeenCalledWith(42);
    });

    it("should not create output log when outputTranscript is false in global config", () => {
      mockStore.agent.outputTranscript = false;

      const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test prompt", {
        description: "test",
      });

      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeUndefined();
      expect(record?.execution.outputLog).toBeUndefined();
    });
  });

  describe("agent-level output_transcript override", () => {
    it("should not create output log when frontmatter output_transcript is false, even if global is true", () => {
      vi.mocked(owner.registry.getAgentConfig).mockReturnValue({ outputTranscript: false } as AgentConfig);
      mockStore.agent.outputTranscript = true;

      const id = manager.spawn(mockPi, mockCtx, "test-agent", "test prompt", { description: "test" });
      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeUndefined();
      expect(record?.execution.outputLog).toBeUndefined();
    });

    it("should create output log when frontmatter output_transcript is true, even if global is false", () => {
      vi.mocked(owner.registry.getAgentConfig).mockReturnValue({ outputTranscript: true } as AgentConfig);
      mockStore.agent.outputTranscript = false;

      const id = manager.spawn(mockPi, mockCtx, "test-agent", "test prompt", { description: "test" });
      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeDefined();
      expect(record?.execution.outputLog).toBeInstanceOf(AgentOutputLog);
    });

    it("should use global setting when agent frontmatter does not specify output_transcript", () => {
      vi.mocked(owner.registry.getAgentConfig).mockReturnValue({} as AgentConfig);
      mockStore.agent.outputTranscript = false;

      const id = manager.spawn(mockPi, mockCtx, "test-agent", "test prompt", { description: "test" });
      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeUndefined();
    });
  });
});

import { createTestOwner } from "../owner-fixtures.js";
const owner = await createTestOwner();
