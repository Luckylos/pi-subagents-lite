import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-config-lock-global-"));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => agentDir }));
const { createConfigIO } = await import("../../src/config/config-io.js");
const configModule = new URL("../../src/config/config-io.ts", import.meta.url).href;
const runFile = promisify(execFile);

let root: string;
let projectDir: string;
const globalFile = join(agentDir, "subagents-lite.json");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-config-lock-project-"));
  projectDir = join(root, ".pi");
  mkdirSync(projectDir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(globalFile, { force: true });
});
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

const holdAfterRead = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [moduleUrl, projectDir, control, target] = process.argv.slice(1);
const { createConfigIO } = await import(moduleUrl);
const io = createConfigIO(projectDir);
io.load();
io.updateLayer(target, layer => {
  writeFileSync(join(control, "ready"), "");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + 7000;
  while (!existsSync(join(control, "release"))) {
    if (performance.now() >= deadline) throw new Error("holder was not released");
    Atomics.wait(wait, 0, 0, 10);
  }
  layer.concurrency = { ...layer.concurrency, default: 8 };
});
`;

it.each(["global", "project"] as const)("serializes concurrent %s writes across processes", async (target) => {
  const configFile = target === "global" ? globalFile : join(projectDir, "subagents-lite.json");
  writeFileSync(configFile, "{}");
  const io = createConfigIO(projectDir);
  io.load();
  const holder = runFile(
    process.execPath,
    ["--input-type=module", "-e", holdAfterRead, configModule, projectDir, root, target],
    {
      env: { PI_CODING_AGENT_DIR: agentDir },
      timeout: 9000,
    },
  );
  try {
    await vi.waitFor(() => expect(existsSync(join(root, "ready"))).toBe(true), { timeout: 4000 });
    const mutate = vi.fn(() => {});
    expect(() => io.updateLayer(target, mutate)).toThrow(/timed out waiting for config lock/i);
    expect(mutate).not.toHaveBeenCalled();
    expect(readFileSync(configFile, "utf-8")).toBe("{}");
  } finally {
    writeFileSync(join(root, "release"), "");
    await holder;
  }
  io.updateLayer(target, (layer) => {
    layer.agent = { defaultThinking: "low" };
  });
  expect(JSON.parse(readFileSync(configFile, "utf-8"))).toEqual({
    agent: { defaultThinking: "low" },
    concurrency: { default: 8 },
  });
});

it("releases the lock when the mutation throws", () => {
  const io = createConfigIO();
  const error = new Error("mutation failed");
  expect(() =>
    io.updateLayer("global", () => {
      throw error;
    }),
  ).toThrow(error);
  expect(existsSync(globalFile)).toBe(false);
  io.updateLayer("global", (layer) => {
    layer.concurrency = { default: 8 };
  });
  expect(io.load().global.concurrency).toEqual({ default: 8 });
});
