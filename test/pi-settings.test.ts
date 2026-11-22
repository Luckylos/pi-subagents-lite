/**
 * pi-settings.test.ts — readPiSettings / getHideThinkingBlock against real fs
 * with a private SDK agent directory, real JSON parsing and ENOENT handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readPiSettings, getHideThinkingBlock } from "../src/pi-settings.js";

describe("PiSettings", () => {
  let homeDir: string;

  beforeEach(() => {
    const mask = process.umask(0o022);
    try {
      homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-test-"));
    } finally {
      process.umask(mask);
    }
    expect(fs.statSync(homeDir).mode & 0o777).toBe(0o700);
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(homeDir, ".pi", "agent"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const writeSettings = (content: string): void => {
    const dir = path.join(homeDir, ".pi", "agent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), content);
  };

  describe("readPiSettings", () => {
    it("returns parsed settings from ~/.pi/agent/settings.json", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: true }));

      expect(readPiSettings()).toEqual({ hideThinkingBlock: true });
    });

    it("returns undefined when the file does not exist", () => {
      expect(readPiSettings()).toBeUndefined();
    });

    it("returns undefined when the JSON is invalid", () => {
      writeSettings("not json");

      expect(readPiSettings()).toBeUndefined();
    });
  });

  describe("getHideThinkingBlock", () => {
    it("returns true when hideThinkingBlock is true", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: true }));

      expect(getHideThinkingBlock()).toBe(true);
    });

    it("returns false when hideThinkingBlock is false", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: false }));

      expect(getHideThinkingBlock()).toBe(false);
    });

    it("returns false when the setting is missing", () => {
      writeSettings(JSON.stringify({}));

      expect(getHideThinkingBlock()).toBe(false);
    });

    it("returns false when the file cannot be read", () => {
      expect(getHideThinkingBlock()).toBe(false);
    });
  });
});
