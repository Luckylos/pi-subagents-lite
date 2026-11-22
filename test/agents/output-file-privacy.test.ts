import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { PathLike } from "node:fs";
import { createMockSession } from "../fixtures.js";
import { asAgentSession } from "../pi-boundaries.js";
import { assistantMessage, userMessage } from "./session-messages.js";
import { AgentOutputLog, createOutputFilePath, writeInitialEntry } from "../../src/agents/output-file.js";

const boundary = vi.hoisted(() => ({
  fault: "",
  flag: "",
  flagValue: undefined as number | undefined,
  fsCalls: [] as string[],
  opened: [] as number[],
  closed: [] as number[],
  chmods: [] as number[],
  beforeOpen: undefined as (() => void) | undefined,
  afterOpen: undefined as (() => void) | undefined,
}));

// Only metadata/failure boundaries are faked. Opens, modes, links and writes use the real kernel.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    constants: {
      ...actual.constants,
      get O_NOFOLLOW() {
        return boundary.flag === "O_NOFOLLOW" ? boundary.flagValue : actual.constants.O_NOFOLLOW;
      },
      get O_DIRECTORY() {
        return boundary.flag === "O_DIRECTORY" ? boundary.flagValue : actual.constants.O_DIRECTORY;
      },
      get O_NONBLOCK() {
        return boundary.flag === "O_NONBLOCK" ? boundary.flagValue : actual.constants.O_NONBLOCK;
      },
    },
    mkdirSync: vi.fn<typeof actual.mkdirSync>((...args) => {
      boundary.fsCalls.push("mkdirSync");
      return actual.mkdirSync(...args);
    }),
    lstatSync: vi.fn((path: PathLike) => {
      boundary.fsCalls.push("lstatSync");
      return actual.lstatSync(path);
    }),
    openSync: vi.fn<typeof actual.openSync>((...args) => {
      boundary.fsCalls.push("openSync");
      const beforeOpen = boundary.beforeOpen;
      boundary.beforeOpen = undefined;
      beforeOpen?.();
      const fd = actual.openSync(...args);
      boundary.opened.push(fd);
      const afterOpen = boundary.afterOpen;
      boundary.afterOpen = undefined;
      afterOpen?.();
      return fd;
    }),
    closeSync: vi.fn<typeof actual.closeSync>((fd) => {
      boundary.fsCalls.push("closeSync");
      boundary.closed.push(fd);
      actual.closeSync(fd);
      if (boundary.fault === "close") throw new Error("injected close failure");
    }),
    fchmodSync: vi.fn<typeof actual.fchmodSync>((fd, mode) => {
      boundary.fsCalls.push("fchmodSync");
      boundary.chmods.push(fd);
      if (boundary.fault === "chmod") throw new Error("injected chmod failure");
      actual.fchmodSync(fd, mode);
    }),
    fstatSync: vi.fn((fd: number) => {
      boundary.fsCalls.push("fstatSync");
      if (boundary.fault === "stat") throw new Error("injected stat failure");
      const stats = actual.fstatSync(fd);
      if (boundary.fault === "foreign") stats.uid += 1;
      if (boundary.fault === "broad-opened" && stats.isFile()) stats.mode |= 0o044;
      return stats;
    }),
    writeFileSync: vi.fn<typeof actual.writeFileSync>((...args) => {
      boundary.fsCalls.push("writeFileSync");
      if (boundary.fault === "write") throw new Error("injected write failure");
      actual.writeFileSync(...args);
    }),
  };
});

const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
let root: string;
const stats = { turnCount: 1, toolUseCount: 1, totalTokens: 12 };
function snapshot(path: string) {
  const stat = fs.lstatSync(path);
  return { ino: stat.ino, dev: stat.dev, mode: stat.mode, nlink: stat.nlink };
}
function expectClosed() {
  expect(boundary.opened.length).toBeGreaterThan(0);
  expect(boundary.closed).toEqual(boundary.opened);
  for (const fd of boundary.opened) expect(() => fs.fstatSync(fd)).toThrow();
}
function sessionForStream() {
  const session = asAgentSession(createMockSession());
  Object.defineProperty(session, "messages", {
    get: () => [userMessage("prompt"), assistantMessage({ content: [{ type: "text", text: "answer" }] })],
  });
  return session;
}

beforeEach(() => {
  root = fs.mkdtempSync("/tmp/pi-f3-privacy-");
  fs.chmodSync(root, 0o700);
  boundary.fault = "";
  boundary.flag = "";
  boundary.flagValue = undefined;
  boundary.fsCalls = [];
  boundary.opened = [];
  boundary.closed = [];
  boundary.chmods = [];
  boundary.beforeOpen = undefined;
  boundary.afterOpen = undefined;
});
afterEach(() => {
  boundary.fault = "";
  if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
  fs.rmSync(root, { recursive: true, force: true });
});

interface UnsupportedCapability {
  name: string;
  flag?: string;
  flagValue?: number;
  uid?: number;
}

const unsupportedCapabilities: UnsupportedCapability[] = [
  { name: "missing getuid" },
  ...[-1, NaN, Infinity, 0.5].map((uid) => ({ name: `invalid UID ${uid}`, uid })),
  ...["O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK"].flatMap((flag) => [
    { name: `missing ${flag}`, flag },
    { name: `zero ${flag}`, flag, flagValue: 0 },
  ]),
];

function disableCapability(capability: UnsupportedCapability): void {
  if (capability.flag) {
    boundary.flag = capability.flag;
    boundary.flagValue = capability.flagValue;
  } else {
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: capability.uid === undefined ? undefined : () => capability.uid,
    });
  }
  boundary.fsCalls = [];
}

const unsupportedPrivacyError = /private output transcripts are unsupported on this platform/i;

describe("unsupported private output capabilities", () => {
  it.each(unsupportedCapabilities)("$name rejects directory preparation before any FS operation", (capability) => {
    const dir = join(root, "must-not-create");
    const before = snapshot(root);
    disableCapability(capability);
    expect(() => createOutputFilePath("agent", dir)).toThrow(unsupportedPrivacyError);
    expect(boundary.fsCalls).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  it.each(unsupportedCapabilities)("$name rejects initial prompt writes before any FS operation", (capability) => {
    const path = join(root, "must-not-create.log");
    disableCapability(capability);
    expect(() => writeInitialEntry(path, "private prompt")).toThrow(unsupportedPrivacyError);
    expect(boundary.fsCalls).toEqual([]);
    expect(fs.existsSync(path)).toBe(false);
  });

  it.each(unsupportedCapabilities)("$name skips stream/finalize before any FS operation", (capability) => {
    const log = new AgentOutputLog("agent", "prompt", root, 2);
    const session = sessionForStream();
    log.attach(session);
    const before = snapshot(log.path);
    const content = fs.readFileSync(log.path, "utf8");
    disableCapability(capability);
    expect(() => {
      session._fireThinkingDelta("private thought");
      session._fireTurnEnd();
      log.finalize(stats);
    }).not.toThrow();
    expect(boundary.fsCalls).toEqual([]);
    expect(fs.readFileSync(log.path, "utf8")).toBe(content);
    expect(snapshot(log.path)).toEqual(before);
    expect(session._getListeners()).toHaveLength(0);
  });
});

describe("output transcript privacy: real filesystem", () => {
  it("creates a current-owned 0700 directory and exclusive 0600 log", () => {
    const dir = join(root, "new", "outputs");
    const log = new AgentOutputLog("agent", "prompt", dir);
    expect(log.path).toBe(join(dir, "agent.log"));
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(dir).uid).toBe(process.getuid?.());
    expect(fs.statSync(log.path).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(log.path).uid).toBe(process.getuid?.());
    expect(fs.readFileSync(log.path, "utf8")).toContain("[USER] prompt\n");
  });

  it("keeps a newly initialized transcript writable under an owner-write masking umask", () => {
    const oldMask = process.umask(0o200);
    try {
      const log = new AgentOutputLog("agent", "prompt", root);
      expect(fs.statSync(log.path).mode & 0o7777).toBe(0o600);
      log.finalize(stats);
      expect(fs.readFileSync(log.path, "utf8")).toContain("[DONE]");
    } finally {
      process.umask(oldMask);
    }
  });

  it.each([0o755, 0o777])("tightens owned directory mode %s without changing existing content", (mode) => {
    const dir = join(root, "outputs");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, mode);
    const keep = join(dir, "keep");
    fs.writeFileSync(keep, "keep", { mode: 0o640 });
    const before = snapshot(keep);
    createOutputFilePath("agent", dir);
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o700);
    expect(fs.readFileSync(keep, "utf8")).toBe("keep");
    expect(snapshot(keep)).toEqual(before);
  });

  it.each(["symlink", "dangling", "file"])("rejects %s as directory without modifying its target", (kind) => {
    const target = join(root, "target");
    const dir = join(root, "outputs");
    if (kind === "file") fs.writeFileSync(dir, "keep", { mode: 0o640 });
    else {
      if (kind === "symlink") {
        fs.mkdirSync(target, { mode: 0o755 });
        fs.writeFileSync(join(target, "keep"), "keep");
      }
      fs.symlinkSync(target, dir);
    }
    const before = snapshot(dir);
    const targetBefore = kind === "symlink" ? snapshot(target) : undefined;
    expect(() => createOutputFilePath("agent", dir)).toThrow();
    expect(snapshot(dir)).toEqual(before);
    if (kind === "symlink") {
      expect(snapshot(target)).toEqual(targetBefore);
      expect(fs.readFileSync(join(target, "keep"), "utf8")).toBe("keep");
    }
    if (kind === "dangling") expect(fs.existsSync(target)).toBe(false);
    if (kind === "file") expect(fs.readFileSync(dir, "utf8")).toBe("keep");
  });

  it("rejects a directory symlink even with trailing path separators", () => {
    const target = join(root, "target");
    fs.mkdirSync(target, { mode: 0o755 });
    const link = join(root, "outputs");
    fs.symlinkSync(target, link);
    const before = snapshot(target);
    expect(() => createOutputFilePath("agent", `${link}/`)).toThrow();
    expect(snapshot(target)).toEqual(before);
  });

  it.each(["regular", "hardlink", "symlink", "dangling"])("exclusive init preserves existing %s", (kind) => {
    const path = createOutputFilePath("agent", root);
    const target = join(root, "target");
    if (kind !== "dangling") fs.writeFileSync(target, "keep", { mode: 0o640 });
    if (kind === "regular") fs.writeFileSync(path, "keep", { mode: 0o640 });
    else if (kind === "hardlink") fs.linkSync(target, path);
    else fs.symlinkSync(target, path);
    const before = snapshot(path);
    const targetBefore = kind !== "dangling" ? snapshot(target) : undefined;
    expect(() => writeInitialEntry(path, "must not write")).toThrow();
    expect(snapshot(path)).toEqual(before);
    if (kind !== "dangling") {
      expect(snapshot(target)).toEqual(targetBefore);
      expect(fs.readFileSync(target, "utf8")).toBe("keep");
      expect(fs.readFileSync(path, "utf8")).toBe("keep");
    } else expect(fs.existsSync(target)).toBe(false);
  });

  it.each(["symlink", "dangling", "deleted", "broad", "directory", "fifo", "hardlink"])(
    "stream and finalize skip a post-init %s without recreating or modifying targets",
    (kind) => {
      const log = new AgentOutputLog("agent", "prompt", root, 2);
      const session = sessionForStream();
      log.attach(session);
      const target = join(root, "target");
      if (kind === "broad") fs.chmodSync(log.path, 0o644);
      else if (kind === "hardlink") fs.linkSync(log.path, target);
      else {
        fs.unlinkSync(log.path);
        if (kind === "directory") fs.mkdirSync(log.path);
        if (kind === "fifo") execFileSync("mkfifo", [log.path]);
        if (kind === "symlink") fs.writeFileSync(target, "keep", { mode: 0o600 });
        if (kind === "symlink" || kind === "dangling") fs.symlinkSync(target, log.path);
      }
      const before = kind === "deleted" ? undefined : snapshot(log.path);
      const targetBefore = fs.existsSync(target) ? snapshot(target) : undefined;
      const bytesBefore = ["broad", "hardlink"].includes(kind) ? fs.readFileSync(log.path, "utf8") : "keep";
      expect(() => {
        session._fireThinkingDelta("private thought");
        session._fireTurnEnd();
        log.finalize(stats);
      }).not.toThrow();
      expect(session._getListeners()).toHaveLength(0);
      if (kind === "deleted") expect(fs.existsSync(log.path)).toBe(false);
      else expect(snapshot(log.path)).toEqual(before);
      if (targetBefore) {
        expect(snapshot(target)).toEqual(targetBefore);
        expect(fs.readFileSync(target, "utf8")).toBe(bytesBefore);
      }
      if (kind === "broad") expect(fs.readFileSync(log.path, "utf8")).toBe(bytesBefore);
      if (kind === "dangling") expect(fs.existsSync(target)).toBe(false);
    },
  );

  it("preserves public streaming, buffered thinking, final flush and unsubscribe", () => {
    const log = new AgentOutputLog("agent", "prompt", root, 100);
    const session = asAgentSession(createMockSession());
    const messages = [
      userMessage("prompt"),
      assistantMessage({ content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "file" } }] }),
      userMessage("follow up"),
      assistantMessage({ content: [{ type: "text", text: "answer" }] }),
    ];
    Object.defineProperty(session, "messages", { get: () => messages });
    log.attach(session);
    const inode = fs.statSync(log.path).ino;
    session._fireThinkingStart();
    session._fireThinkingDelta("buffered thought");
    expect(fs.readFileSync(log.path, "utf8")).not.toContain("buffered thought");
    log.finalize(stats);
    const output = fs.readFileSync(log.path, "utf8");
    expect(output).toContain("[USER] prompt\n");
    expect(output).toContain("[USER] follow up\n");
    expect(output).toContain('[TOOL] read("file")\n');
    expect(output).toContain("[THINKING] buffered thought\n");
    expect(output).toContain("[ASSISTANT] answer\n");
    expect(output.trim().split("\n").at(-1)).toContain("[DONE] 1 turns, 1 tool uses, 12 tokens");
    expect(fs.statSync(log.path).ino).toBe(inode);
    expect(session._getListeners()).toHaveLength(0);
  });
});

describe("actual-opened-object and descriptor failure boundaries", () => {
  it("rejects a FIFO substituted after preflight without blocking or writing", () => {
    const log = new AgentOutputLog("agent", "prompt", root);
    boundary.beforeOpen = () => {
      fs.unlinkSync(log.path);
      execFileSync("mkfifo", [log.path]);
    };
    expect(() => log.finalize(stats)).not.toThrow();
    expect(fs.lstatSync(log.path).isFIFO()).toBe(true);
    expect(fs.lstatSync(log.path).size).toBe(0);
  });

  it("the kernel rejects a symlink substituted after append preflight", () => {
    const log = new AgentOutputLog("agent", "prompt", root);
    const target = join(root, "target");
    fs.writeFileSync(target, "keep", { mode: 0o600 });
    const before = snapshot(target);
    boundary.beforeOpen = () => {
      fs.unlinkSync(log.path);
      fs.symlinkSync(target, log.path);
    };
    expect(() => log.finalize(stats)).not.toThrow();
    expect(snapshot(target)).toEqual(before);
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
  });

  it("rejects a different private regular inode substituted before open", () => {
    const log = new AgentOutputLog("agent", "prompt", root);
    boundary.beforeOpen = () => {
      fs.renameSync(log.path, join(root, "original"));
      fs.writeFileSync(log.path, "replacement", { mode: 0o600 });
    };
    log.finalize(stats);
    expect(fs.readFileSync(log.path, "utf8")).toBe("replacement");
    expectClosed();
  });

  it("writes only the validated FD when the pathname becomes a symlink after open", () => {
    const log = new AgentOutputLog("agent", "prompt", root);
    const target = join(root, "target");
    const original = join(root, "original");
    fs.writeFileSync(target, "keep", { mode: 0o600 });
    const before = snapshot(target);
    boundary.afterOpen = () => {
      fs.renameSync(log.path, original);
      fs.symlinkSync(target, log.path);
    };
    log.finalize(stats);
    expect(snapshot(target)).toEqual(before);
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
    expect(fs.readFileSync(original, "utf8")).toContain("[DONE]");
    expectClosed();
  });

  it("rejects foreign directory metadata without chmod or modifying real data", () => {
    const before = snapshot(root);
    boundary.fault = "foreign";
    expect(() => createOutputFilePath("agent", root)).toThrow();
    expect(boundary.chmods).toEqual([]);
    expect(snapshot(root)).toEqual(before);
    expectClosed();
  });

  it.each(["foreign", "broad-opened"])("append rejects %s metadata on the opened object", (fault) => {
    const log = new AgentOutputLog("agent", "prompt", root);
    const before = fs.readFileSync(log.path, "utf8");
    boundary.fault = fault;
    expect(() => log.finalize(stats)).not.toThrow();
    expect(fs.readFileSync(log.path, "utf8")).toBe(before);
    expectClosed();
  });

  it.each(["stat", "chmod"])("closes directory descriptor after %s failure", (fault) => {
    boundary.fault = fault;
    expect(() => createOutputFilePath("agent", root)).toThrow();
    expectClosed();
  });

  it.each(["stat", "write"])("closes initial file descriptor after %s failure without writing prompt", (fault) => {
    const path = createOutputFilePath("agent", root);
    boundary.fault = fault;
    expect(() => writeInitialEntry(path, "private prompt")).toThrow();
    expect(fs.readFileSync(path, "utf8")).toBe("");
    expectClosed();
  });

  it("propagates permission-setting failure before writing the prompt and closes the file", () => {
    const path = createOutputFilePath("agent", root);
    boundary.fault = "chmod";
    expect(() => writeInitialEntry(path, "prompt")).toThrow("injected chmod failure");
    expect(fs.statSync(path).size).toBe(0);
    expectClosed();
  });

  it("propagates initialization close failures after closing the FD", () => {
    const path = createOutputFilePath("agent", root);
    boundary.fault = "close";
    expect(() => writeInitialEntry(path, "prompt")).toThrow("injected close failure");
    expectClosed();
  });

  it("suppresses append close failures after closing the FD", () => {
    const log = new AgentOutputLog("agent", "prompt", root);
    boundary.fault = "close";
    expect(() => log.finalize(stats)).not.toThrow();
    expectClosed();
  });

  it.each(["stat", "write"])("closes append descriptor after %s failure and stays best-effort", (fault) => {
    const log = new AgentOutputLog("agent", "prompt", root);
    const before = fs.readFileSync(log.path, "utf8");
    boundary.fault = fault;
    expect(() => log.finalize(stats)).not.toThrow();
    expect(fs.readFileSync(log.path, "utf8")).toBe(before);
    expectClosed();
  });
});
