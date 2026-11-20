/**
 * config-io.ts — Config persistence (read/write) with override layers.
 *
 * Atomic writes: write to .tmp then rename.
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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RawConfig, SubagentsConfig } from "./types.ts";
import { isAgentModelKey } from "./agent-settings.ts";
import { mergeDefaults } from "./config-layers.ts";
import { isPlainObject, validateRawLayer } from "./config-validation.ts";

/** File name of the config in both the global agent dir and a project's .pi dir. */
const CONFIG_FILE_NAME = "subagents-lite.json";
const CONFIG_DIR = getAgentDir();
const CONFIG_PATH = path.join(CONFIG_DIR, CONFIG_FILE_NAME);
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
  const projectPath = projectDir ? path.join(projectDir, CONFIG_FILE_NAME) : null;
  let projectStatus: ProjectLayerStatus = projectDir ? "absent" : "untrusted";
  let projectRaw: RawConfig | null = null;
  let unknownKeysWarned = false;

  const io: ConfigIO = {
    load: () => {
      const global = readGlobalRaw();
      if (projectPath) {
        const read = readProjectRaw(projectPath);
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
      const filePath = target === "global" ? CONFIG_PATH : projectPath;
      if (!filePath) {
        throw new Error(`Cannot update ${target} config: no trusted project path`);
      }
      if (target === "project" && (projectStatus === "malformed" || projectStatus === "untrusted")) {
        throw new Error(`Cannot update project config: project layer is ${projectStatus}`);
      }
      const latest = readLayerForUpdate(filePath, target === "global" || options.createIfMissing === true);
      mutate(latest);
      const validated = validateRawLayer(latest, filePath);
      writeJsonAtomic(filePath, validated);
      return io.load();
    },
    saveGlobal: (config) => {
      writeJsonAtomic(CONFIG_PATH, config);
    },
    saveProject: (config) => {
      if (!projectPath || projectStatus === "malformed" || projectStatus === "untrusted") {
        console.warn(`[subagents] Refusing to write project config (${projectStatus}); change not saved`);
        return;
      }
      writeJsonAtomic(projectPath, config);
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
function readProjectRaw(projectPath: string): ProjectRead {
  if (!fs.existsSync(projectPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
  } catch (err) {
    console.warn(`[subagents] Ignoring malformed project config ${projectPath}: ${String(err)}`);
    return "malformed";
  }
  if (!isPlainObject(parsed)) {
    console.warn(`[subagents] Ignoring malformed project config ${projectPath}: not a JSON object`);
    return "malformed";
  }
  const raw = parsed as RawConfig;
  if (raw.agent !== undefined && !isPlainObject(raw.agent)) return malformedSection(projectPath, "agent");
  if (raw.concurrency !== undefined && !isPlainObject(raw.concurrency)) {
    return malformedSection(projectPath, "concurrency");
  }
  if (raw.concurrency?.providers !== undefined && !isPlainObject(raw.concurrency.providers)) {
    return malformedSection(projectPath, "concurrency.providers");
  }
  if (raw.concurrency?.models !== undefined && !isPlainObject(raw.concurrency.models)) {
    return malformedSection(projectPath, "concurrency.models");
  }
  // Per-value validation first so dropped keys warn once (type error), not
  // twice (type error plus unknown-key). Unknown keys are computed on the
  // cleaned layer; the file bytes stay untouched.
  const cleaned = validateRawLayer(raw, projectPath);
  const unknownKeys = Object.keys(cleaned.agent ?? {}).filter((key) => !isAgentModelKey(key));
  return { raw: cleaned, unknownKeys };
}

function malformedSection(projectPath: string, section: string): "malformed" {
  console.warn(`[subagents] Ignoring malformed project config ${projectPath}: "${section}" is not a JSON object`);
  return "malformed";
}

// ── Save ─────────────────────────────────────────────────────────────

/** Read a target layer for a mutation without collapsing errors into an empty config. */
function readLayerForUpdate(filePath: string, allowMissing: boolean): RawConfig {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (allowMissing && (err as NodeJS.ErrnoException).code === "ENOENT") return {};
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
  if (parsed.concurrency !== undefined && !isPlainObject(parsed.concurrency)) {
    throw new Error(`[subagents] Refusing to update malformed config ${filePath}: concurrency is not an object`);
  }
  return validateRawLayer(parsed, filePath);
}

/** Write JSON atomically with a unique same-directory temporary file. */
function writeJsonAtomic(filePath: string, config: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
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
