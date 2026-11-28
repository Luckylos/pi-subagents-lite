/**
 * config-io.ts — Config persistence (read/write) with override layers.
 *
 * Serialize writers per file; write to .tmp then rename for lock-free readers.
 * Loaded at session_start; saved on every /agents menu mutation.
 *
 * Two layers (ADR-0008): the global file ~/.pi/agent/subagents-lite.json and a
 * trusted project's .pi/subagents-lite.json. The project layer may carry only
 * model and concurrency keys; the effective config merges project over global
 * over built-in defaults. Each file stores only its own keys; the merged
 * config is never written back. Unknown project keys are ignored with a
 * warning; a malformed project file is never overwritten. See
 * docs/adr/0008-project-config-as-override-layer.md.
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RawConfig, SubagentsConfig } from "./types.ts";
import { isAgentModelKey } from "./agent-settings.ts";
import { mergeDefaults } from "./config-layers.ts";
import { isPlainObject, validateRawLayer } from "./config-validation.ts";

/** File name of the config in both the global agent dir and a project's .pi dir. */
const CONFIG_FILE_NAME = "subagents-lite.json";
const CONFIG_DIR = getAgentDir();
const CONFIG_PATH = path.join(CONFIG_DIR, CONFIG_FILE_NAME);
const CONFIG_LOCK_TIMEOUT_MS = 500;
const CONFIG_LOCK_RETRY_MS = 25;
const lockWait = new Int32Array(new SharedArrayBuffer(4));
/** Path to custom prompt file for subagent system prompts. */
export const CUSTOM_PROMPT_PATH = path.join(CONFIG_DIR, "subagents-lite-prompt.md");
export { DEFAULT_AGENT, DEFAULT_GRACE_TURNS } from "./agent-settings.ts";

export { DEFAULT_CONCURRENCY, mergeDefaults, mergeLayers } from "./config-layers.ts";
export type { RawConcurrency, RawConfig } from "./types.ts";

/** A layer a persisted mutation can target. */
export type ConfigTarget = "session" | "global" | "project";

/** State of the project layer for the current IO instance. */
export type ProjectLayerStatus = "untrusted" | "absent" | "loaded" | "malformed";

/** Result of a load: the two raw layers plus the project layer's status. */
export interface LoadedConfig {
  global: RawConfig;
  project: RawConfig | null;
  projectStatus: ProjectLayerStatus;
}

/** Persistence port consumed by ConfigStore. */
export interface ConfigIO {
  load(): LoadedConfig;
  updateLayer(
    target: "global" | "project",
    mutate: (latest: RawConfig) => void,
    options?: { createIfMissing?: boolean },
  ): LoadedConfig;
  /** Legacy direct saves retained for narrow integrations; ConfigStore uses updateLayer. */
  saveGlobal(config: RawConfig): void;
  saveProject(config: RawConfig): void;
}

/** Read + validate the project file. null = absent, "malformed" = invalid. */
type ProjectRead = { raw: RawConfig; unknownKeys: string[] } | "malformed" | null;

/**
 * Create a ConfigIO. With a trusted project's `.pi` directory the project file
 * (when present and valid) is an override layer over the global file; each
 * save touches only its own layer. Mutations reread and validate the target
 * file before an atomic replacement. A malformed project file is never
 * written; without a project dir the project layer is untrusted and unavailable.
 */
export function createConfigIO(projectDir?: string): ConfigIO {
  const projectPath = projectDir ? path.resolve(projectDir, CONFIG_FILE_NAME) : null;
  const resolveProjectPath = () => (projectPath ? resolveProjectConfigPath(projectPath) : null);
  let projectStatus: ProjectLayerStatus = projectDir ? "absent" : "untrusted";
  let projectRaw: RawConfig | null = null;
  let unknownKeysWarned = false;

  const io: ConfigIO = {
    load: () => {
      const global = readGlobalRaw();
      if (projectPath) {
        const read = readProjectRaw(projectPath, () => resolveProjectConfigPath(projectPath));
        if (read === null) {
          projectRaw = null;
          projectStatus = "absent";
        } else if (read === "malformed") {
          projectRaw = null;
          projectStatus = "malformed";
        } else {
          projectRaw = read.raw;
          projectStatus = "loaded";
          if (read.unknownKeys.length > 0 && !unknownKeysWarned) {
            unknownKeysWarned = true;
            console.warn(
              `[subagents] Ignoring unknown keys in project config ${projectPath}: ${read.unknownKeys.join(", ")}`,
            );
          }
        }
      } else {
        projectRaw = null;
        projectStatus = "untrusted";
      }
      return { global, project: projectRaw, projectStatus };
    },
    updateLayer: (target, mutate, options = {}) => {
      const filePath = target === "global" ? CONFIG_PATH : resolveProjectPath();
      if (!filePath) {
        throw new Error(`Cannot update ${target} config: no trusted project path`);
      }
      if (target === "project" && (projectStatus === "malformed" || projectStatus === "untrusted")) {
        throw new Error(`Cannot update project config: project layer is ${projectStatus}`);
      }
      const mayCreate = target === "global" || options.createIfMissing === true;
      if (!mayCreate && !fs.lstatSync(filePath, { throwIfNoEntry: false })) return io.load();
      withConfigLock(filePath, () => {
        if (target === "project") ensureSameProjectPath();
        const latest = target === "project" ? readProjectForWrite(filePath) : readLayerObject(filePath, target);
        if (latest === null && !mayCreate) return;
        const layer = validateRawLayer(latest ?? {}, filePath);
        mutate(layer);
        const validated = validateRawLayer(layer, filePath);
        if (target === "project") ensureSameProjectPath();
        writeJsonAtomic(
          filePath,
          validated,
          target === "project"
            ? () => {
                ensureSameProjectPath();
                return readProjectForWrite(filePath) !== null || mayCreate;
              }
            : undefined,
        );
      });

      function ensureSameProjectPath(): void {
        if (resolveProjectPath() !== filePath) {
          throw new Error("Cannot update project config: the config path changed");
        }
      }
      return io.load();
    },
    saveGlobal: (config) => {
      withConfigLock(CONFIG_PATH, () => writeJsonAtomic(CONFIG_PATH, config));
    },
    saveProject: (config) => {
      if (!projectPath || projectStatus === "malformed" || projectStatus === "untrusted") {
        console.warn(`[subagents] Refusing to write project config (${projectStatus}); change not saved`);
        return;
      }
      try {
        const filePath = resolveProjectConfigPath(projectPath);
        const ensureSameProjectPath = () => {
          if (resolveProjectConfigPath(projectPath) !== filePath) {
            throw new Error("Cannot save project config: the config path changed");
          }
        };
        withConfigLock(filePath, () => {
          ensureSameProjectPath();
          readProjectForWrite(filePath);
          writeJsonAtomic(filePath, config, () => {
            ensureSameProjectPath();
            readProjectForWrite(filePath);
            return true;
          });
        });
      } catch (err) {
        console.warn(`[subagents] Refusing to write project config: ${String(err)}`);
      }
    },
  };
  return io;
}

/**
 * Read config from disk (global file only). Merges loaded values over
 * defaults so the result is always a complete SubagentsConfig. Used outside
 * the store (events.ts); the store loads both layers via ConfigIO.
 */
export function loadConfig(): SubagentsConfig {
  return mergeDefaults(readGlobalRaw());
}

// ── Load ─────────────────────────────────────────────────────────────

/** Read the global file; any failure (missing, malformed) reads as {} — as today. */
function readGlobalRaw(): RawConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
  // Per-value validation: drop bad values with a warning, keep valid keys.
  return validateRawLayer(parsed, CONFIG_PATH);
}

/** Read the project file; missing = absent, unreadable/invalid = malformed + warning. */
function readProjectRaw(projectPath: string, resolveProjectPath: () => string): ProjectRead {
  let raw: Record<string, unknown> | null;
  try {
    raw = readLayerObject(resolveProjectPath(), "project");
  } catch (err) {
    console.warn(`[subagents] Ignoring malformed project config ${projectPath}: ${String(err)}`);
    return "malformed";
  }
  if (raw === null) return null;
  // Per-value validation first so dropped keys warn once (type error), not
  // twice (type error plus unknown-key). Unknown keys are computed on the
  // cleaned layer; the file bytes stay untouched.
  const cleaned = validateRawLayer(raw, projectPath);
  const unknownKeys = Object.keys(cleaned.agent ?? {}).filter((key) => !isAgentModelKey(key));
  return { raw: cleaned, unknownKeys };
}

// ── Save ─────────────────────────────────────────────────────────────

/** Resolve .pi and the file inside the project, including when either is absent. */
function resolveProjectConfigPath(projectPath: string): string {
  const projectDir = path.dirname(projectPath);
  const root = fs.realpathSync.native(path.dirname(projectDir));
  const directory = resolveEntry(path.join(root, path.basename(projectDir)));
  if (directory.exists && !fs.statSync(directory.path).isDirectory()) {
    throw new Error(`Project config directory ${directory.path} is not a directory`);
  }
  const file = resolveEntry(path.join(directory.path, CONFIG_FILE_NAME));
  if (file.exists && !fs.statSync(file.path).isFile()) {
    throw new Error(`Project config ${file.path} must be a regular file`);
  }
  return file.path;

  function resolveEntry(entry: string): { path: string; exists: boolean } {
    try {
      fs.lstatSync(entry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path: entry, exists: false };
      throw err;
    }
    const resolved = fs.realpathSync.native(entry);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Project config path ${entry} points outside the project`);
    }
    return { path: resolved, exists: true };
  }
}

function readProjectFile(filePath: string): string {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(filePath, O_RDONLY | (O_NONBLOCK ?? 0) | (O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`Project config ${filePath} must be a regular file`);
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Project loads and every write guard share the same structural contract. Only ENOENT means absent. */
function readLayerObject(filePath: string, target: "global" | "project"): Record<string, unknown> | null {
  let text: string;
  try {
    text = target === "project" ? readProjectFile(filePath) : fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`[subagents] Failed to read config ${filePath}: ${String(err)}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`[subagents] Failed to parse config ${filePath}: ${String(err)}`, { cause: err });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`[subagents] Refusing to update malformed config ${filePath}: not a JSON object`);
  }
  if (parsed.agent !== undefined && !isPlainObject(parsed.agent)) {
    throw new Error(`[subagents] Refusing to update malformed config ${filePath}: agent is not an object`);
  }
  if (parsed.concurrency !== undefined) {
    if (!isPlainObject(parsed.concurrency)) {
      throw new Error(`[subagents] Refusing to update malformed config ${filePath}: concurrency is not an object`);
    }
    if (target === "project") {
      for (const section of ["providers", "models"] as const) {
        const entries = parsed.concurrency[section];
        if (entries !== undefined && !isPlainObject(entries)) {
          throw new Error(
            `[subagents] Refusing to update malformed project config ${filePath}: concurrency.${section} is not an object`,
          );
        }
      }
    }
  }
  return parsed;
}

/** mkdir excludes other writers without following an existing lock entry. */
/** Refuse to normalize away existing data when replacing a project file. */
function readProjectForWrite(filePath: string): Record<string, unknown> | null {
  const raw = readLayerObject(filePath, "project");
  if (!raw) return null;
  const comparable = { ...raw };
  if (isPlainObject(raw.concurrency)) {
    const concurrency = { ...raw.concurrency };
    for (const section of ["providers", "models"]) {
      if (isPlainObject(concurrency[section]) && Object.keys(concurrency[section]).length === 0) {
        delete concurrency[section];
      }
    }
    comparable.concurrency = concurrency;
  }
  for (const section of ["agent", "concurrency"]) {
    const value = comparable[section];
    if (isPlainObject(value) && Object.keys(value).length === 0) delete comparable[section];
  }
  // Compare the persisted JSON shape rather than the validator's object prototypes.
  const cleaned: unknown = JSON.parse(JSON.stringify(validateRawLayer(raw, filePath)));
  if (!isDeepStrictEqual(comparable, cleaned)) {
    throw new Error(
      `[subagents] Refusing to write project config ${filePath}: existing fields would be discarded; change not saved`,
    );
  }
  return raw;
}

function withConfigLock(filePath: string, write: () => void): void {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = performance.now() + CONFIG_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error(`[subagents] Timed out waiting for config lock ${lockPath}; change not saved`);
      }
      Atomics.wait(lockWait, 0, 0, Math.min(CONFIG_LOCK_RETRY_MS, remaining));
    }
  }
  try {
    write();
  } finally {
    try {
      fs.rmdirSync(lockPath);
    } catch (err) {
      console.warn(`[subagents] Failed to release config lock ${lockPath}: ${String(err)}`);
    }
  }
}

/** Write JSON atomically with a unique same-directory temporary file. */
function writeJsonAtomic(filePath: string, config: unknown, canReplace?: () => boolean): void {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: "utf-8", flag: "wx" });
    if (!canReplace || canReplace()) fs.renameSync(tmpPath, filePath);
  } catch (err) {
    throw new Error(`[subagents] Failed to save config ${filePath}: ${String(err)}`, { cause: err });
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Preserve the original read/write/rename failure.
    }
  }
}
