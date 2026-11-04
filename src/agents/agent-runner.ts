import type { ExtensionOwner } from "../shell.ts";
/**
 * Core execution engine: creates sessions, runs agents, collects results.
 *
 * Tool visibility policy is owned by agent-types.ts (resolveVisibleTools).
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  loadProjectContextFiles,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveSessionToolOptions, resolveVisibleTools } from "./agent-types.ts";
import { resolveThinkingLevel } from "../models/thinking-resolution.ts";
import { findModelInRegistry, GIT_EXEC_TIMEOUT_MS } from "../utils.ts";
import { DEFAULT_AGENTS } from "./default-agents.ts";
import { buildAgentPrompt, type PromptExtras } from "../prompt/prompts.ts";
import { preloadSkills, loadSkillMeta } from "../prompt/skill-loader.ts";
import { type EnvInfo, type RunCallbacks, type RunTunables, SHORT_ID_LENGTH } from "../types.ts";
import type { SubagentType, SystemPromptMode } from "./types.ts";
import { getStore } from "../shell.ts";
import { withChildExtensionLoad } from "../child-load-context.ts";
import { BUILTIN_EXTENSION_FACTORIES } from "./builtin-extensions.ts";
import { disposeChildSession } from "./session-teardown.ts";
import { announceChildSessionBound, announceChildSessionCreated } from "./child-announcements.ts";
import { CUSTOM_PROMPT_PATH } from "../config/config-io.ts";
import { patchRetryClassifier } from "./stream-retry.ts";
import { runSessionPrompt, type SessionPromptOptions, type SessionRunResult } from "./session-run.ts";

export { subscribeToSessionEvents, type SessionPromptOptions } from "./session-run.ts";
import { applyOutputLimit, resolveOutputLimit } from "./max-tokens-field.ts";

// Cache: extension path → unscoped package name (lowercased), or undefined if not found
const packageNameCache = new Map<string, string | undefined>();

function extensionPackageName(extPath: string): string | undefined {
  // Presence check distinguishes a cached undefined (not-found) from a miss,
  // so each path's package.json is read at most once per process.
  if (packageNameCache.has(extPath)) return packageNameCache.get(extPath);
  const result = resolvePackageShortName(extPath);
  packageNameCache.set(extPath, result);
  return result;
}

/**
 * The unscoped, lowercased npm short name of the pi package that declares
 * `extPath` as an extension entry — or undefined if the entry doesn't belong
 * to such a package.
 *
 * Climbs from the entry's directory looking for package.json, stopping at
 * node_modules boundaries. The name is taken only when that package's
 * `pi.extensions` manifest actually lists this entry. Returns at the first
 * package.json (whether or not it declares the entry) so a loose extension
 * is never misattributed to a co-located project's name.
 */
function resolvePackageShortName(extPath: string): string | undefined {
  const entry = path.resolve(extPath);
  let dir = path.dirname(entry);

  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (path.basename(dir) === "node_modules") return undefined;

    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }

    // First package.json found — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && path.resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/** Clear the package name cache. Exposed for test isolation. */
export function resetPackageNameCache() {
  packageNameCache.clear();
}

interface RunOptions extends RunTunables, RunCallbacks {
  /** ExtensionAPI instance — used for pi.exec() for git detection. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  cwd?: string;
  /**
   * Trust state for the target project. False = ignore the target's project
   * resources (untrusted cross-repo target). Absent/true = load them.
   */
  projectTrusted?: boolean;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

/** A settled run against a real child session. */
export type RunResult = SessionRunResult<AgentSession>;

/** Path prefix pi gives its built-in extensions (not exported by pi's SDK). */
const BUILTIN_PATH_PREFIX = "builtin:";

/** Extension name from its install path (git/npm/local/direct); independent of dist/lib/src internals. */
function extractExtensionName(extPath: string): string {
  // Pi built-ins are synthetic paths (builtin:<name>): they name themselves.
  if (extPath.startsWith(BUILTIN_PATH_PREFIX)) {
    return extPath.slice(BUILTIN_PATH_PREFIX.length);
  }

  const parts = extPath.split(path.sep);

  // 1. Git package: .../git/github.com/<user>/<pkg>/...
  //    Package name is 3 dirs after 'git' (github.com/user/pkg)
  const gitIdx = parts.indexOf("git");
  if (gitIdx !== -1 && gitIdx + 3 < parts.length) {
    return parts[gitIdx + 3];
  }

  // 2. npm package: .../node_modules/[...]pkg/...
  const nmIdx = parts.lastIndexOf("node_modules");
  if (nmIdx !== -1 && nmIdx + 1 < parts.length) {
    const next = parts[nmIdx + 1];
    if (next.startsWith("@") && nmIdx + 2 < parts.length) {
      return parts[nmIdx + 2]; // @scope/pkg → pkg
    }
    return next;
  }

  // 3. Local extension: .../extensions/<name>/... or .../extensions/<name>.ts
  const extIdx = parts.lastIndexOf("extensions");
  if (extIdx !== -1 && extIdx + 1 < parts.length) {
    const afterExt = parts[extIdx + 1];
    // Subdirectory: extensions/tavily/index.ts → tavily
    if (afterExt && !afterExt.includes(".")) {
      return afterExt;
    }
    // Direct file: extensions/review.ts → review
    const file = parts[parts.length - 1];
    return path.basename(file, path.extname(file));
  }

  // Fallback: parent dir name
  return path.basename(path.dirname(extPath));
}

async function execGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", args, { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Inline replacement for upstream's detectEnv — uses pi.exec for git detection. */
async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  const gitRoot = await execGit(pi, ["rev-parse", "--is-inside-work-tree"], cwd);
  const isGitRepo = gitRoot === "true";
  const branch = isGitRepo ? await execGit(pi, ["branch", "--show-current"], cwd) : null;

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}

// ── runAgent phases ────────────────────────────────────────────────

/**
 * Effective system prompt mode for an agent: the global mode overridden by
 * the agent's include_system_prompt frontmatter field.
 *
 * - false → replace (never inherit or custom)
 * - true → inherit, except when the global mode is custom (custom wins)
 * - undefined → global mode
 */
export function resolveEffectiveSystemPromptMode(
  globalMode: SystemPromptMode,
  includeSystemPrompt: boolean | undefined,
): SystemPromptMode {
  if (includeSystemPrompt === false) return "replace";
  if (includeSystemPrompt === true && globalMode !== "custom") return "inherit";
  return globalMode;
}

function resolveSystemPromptSources(
  owner: ExtensionOwner,
  ctx: ExtensionContext,
  cwd: string,
  notify: (msg: string) => void,
  agentConfig: ReturnType<ExtensionOwner["registry"]["getAgentConfig"]>,
): {
  mode: SystemPromptMode;
  extras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles">;
} {
  const store = getStore(owner);
  // Per-agent frontmatter overrides win; unset fields follow the global config.
  const mode = resolveEffectiveSystemPromptMode(store.agent.systemPromptMode, agentConfig?.includeSystemPrompt);
  const includeContextFiles = agentConfig?.includeContextFiles ?? store.agent.includeContextFiles;
  const extras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"> = {};

  if (mode === "inherit") {
    try {
      extras.parentSystemPrompt = ctx.getSystemPrompt();
    } catch (err) {
      notify(`Failed to get parent system prompt: ${String(err)}. Falling back to replace mode.`);
    }
  }

  if (mode === "custom") {
    try {
      const content = fs.readFileSync(CUSTOM_PROMPT_PATH, "utf-8").trim();
      if (content) {
        extras.customSystemPrompt = content;
      } else {
        notify(`Custom prompt file is empty: ${CUSTOM_PROMPT_PATH}. Falling back to replace mode.`);
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        notify(`Custom prompt file not found: ${CUSTOM_PROMPT_PATH}. Falling back to replace mode.`);
      } else {
        notify(`Failed to read custom prompt file: ${err.message}. Falling back to replace mode.`);
      }
    }
  }

  if (includeContextFiles) {
    try {
      extras.contextFiles = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
    } catch {
      // Non-fatal: context files are supplementary
    }
  }

  return { mode, extras };
}

function buildPrompt(
  type: SubagentType,
  agentConfig: ReturnType<ExtensionOwner["registry"]["getAgentConfig"]>,
  config: ReturnType<ExtensionOwner["registry"]["getConfig"]>,
  cwd: string,
  env: EnvInfo,
  systemPromptMode: SystemPromptMode = "replace",
  resolverExtras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"> = {},
): string {
  const extras: PromptExtras = { ...resolverExtras };
  if (Array.isArray(agentConfig?.preloadSkills)) {
    extras.skillBlocks = preloadSkills(agentConfig.preloadSkills, cwd);
  }
  if (Array.isArray(config.skills)) {
    extras.skillMetas = loadSkillMeta(config.skills, cwd);
  }
  if (agentConfig) {
    return buildAgentPrompt(agentConfig, cwd, env, extras, systemPromptMode);
  }
  const fallback = DEFAULT_AGENTS.get("general-purpose");
  if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
  return buildAgentPrompt({ ...fallback, name: type }, cwd, env, extras, systemPromptMode);
}

function buildExtToolMap(extensions: Array<{ path: string; tools: Map<string, unknown> }>) {
  const map = new Map<string, string[]>();
  for (const ext of extensions) {
    const name = extensionPackageName(ext.path) ?? extractExtensionName(ext.path);
    const tools = [...ext.tools.keys()];
    if (tools.length > 0) {
      map.set(name, [...new Set([...(map.get(name) ?? []), ...tools])]);
    }
  }
  return map;
}

/** Filter extensions by name; invert=true removes matches (blacklist), false keeps them (whitelist). */
function filterExtensions(
  extensions: Array<{ path: string }>,
  names: Set<string>,
  invert: boolean,
): { filtered: Array<{ path: string }>; matched: Set<string> } {
  const matched = new Set<string>();
  const filtered = extensions.filter((ext) => {
    const pathName = extractExtensionName(ext.path).toLowerCase();
    const pkgName = extensionPackageName(ext.path);
    const hit = names.has(pathName) || (pkgName !== undefined && names.has(pkgName));
    if (hit) {
      matched.add(pathName);
      if (pkgName) matched.add(pkgName);
    }
    return hit !== invert;
  });
  return { filtered, matched };
}

/** Extension filter override; warns for requested names that matched nothing. */
function filterOverride(names: Set<string>, invert: boolean, notify?: (msg: string) => void) {
  return (result: any) => {
    const { filtered, matched } = filterExtensions(result.extensions, names, invert);
    for (const name of names) {
      if (!matched.has(name)) {
        notify?.(`extension "${name}" not found in loaded extensions`);
      }
    }
    return { ...result, extensions: filtered };
  };
}

export function buildExtOverride(
  extensions: true | string[] | false | undefined,
  excludeExtensions?: string[],
  notify?: (msg: string) => void,
) {
  if (Array.isArray(extensions)) {
    // Whitelist entries may carry a /tool suffix; match on the extension name only.
    const allowedNames = new Set(
      extensions.map((ext) => {
        const slashIdx = ext.indexOf("/");
        return (slashIdx !== -1 ? ext.slice(0, slashIdx) : ext).toLowerCase();
      }),
    );
    return filterOverride(allowedNames, false, notify);
  }

  if (excludeExtensions) {
    const excludeSet = new Set(excludeExtensions.map((n) => n.toLowerCase()));
    return filterOverride(excludeSet, true, notify);
  }

  return undefined;
}

function createResourceLoader(
  config: ReturnType<ExtensionOwner["registry"]["getConfig"]>,
  agentConfig: ReturnType<ExtensionOwner["registry"]["getAgentConfig"]>,
  cwd: string,
  systemPrompt: string,
  settingsManager: SettingsManager,
  notify?: (msg: string) => void,
) {
  const extensions = config.extensions;
  const noSkills = config.skills === false || Array.isArray(config.skills) || Array.isArray(agentConfig?.preloadSkills);
  const agentDir = getAgentDir();
  const loaderOpts: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd,
    agentDir,
    settingsManager,
    // Pi's built-ins (codemode, tool-search, mcp) for child sessions. Passed
    // unconditionally: the loader applies settings selection, replaceability,
    // and its own gating (noExtensions skips them entirely).
    extensionFactories: BUILTIN_EXTENSION_FACTORIES,
    noExtensions: extensions === false,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionsOverride: buildExtOverride(extensions, agentConfig?.excludeExtensions, notify),
  };
  const loader = new DefaultResourceLoader(loaderOpts);

  // Mark only actual SDK resource loading. Parent announcements, bind callbacks
  // and the child prompt stay outside this async context.
  const reload = loader.reload.bind(loader);
  loader.reload = (options) => withChildExtensionLoad(true, () => reload(options));
  const loadProjectTrustExtensions = loader.loadProjectTrustExtensions?.bind(loader);
  if (loadProjectTrustExtensions) {
    loader.loadProjectTrustExtensions = () => withChildExtensionLoad(true, loadProjectTrustExtensions);
  }

  return {
    loader,
    reloadAndMap: async () => {
      await loader.reload();
      const extResult = loader.getExtensions();
      return { extResult, extToolMap: buildExtToolMap(extResult.extensions) };
    },
  };
}

function hasOpenAIResponsesOutputLimit(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Object.prototype.hasOwnProperty.call(payload, "max_output_tokens")
  );
}

/** Everything child-session setup needs for one spawn; assembled once by createChildSession. */
interface SessionSetup {
  ctx: ExtensionContext;
  options: RunOptions;
  agentConfig: ReturnType<ExtensionOwner["registry"]["getAgentConfig"]>;
  type: SubagentType;
  cwd: string;
  loader: DefaultResourceLoader;
  extToolMap: Map<string, string[]>;
  settingsManager: SettingsManager;
}

async function initSession(owner: ExtensionOwner, setup: SessionSetup): Promise<AgentSession> {
  const { ctx, options, agentConfig, cwd, loader, extToolMap, settingsManager } = setup;
  const model = options.model ?? findModelInRegistry(agentConfig?.model, ctx.modelRegistry, ctx.model);
  // Per-model comes from the same trust-gated instance the session is created
  // with, so the project-trust gate applies to the read identically. When
  // every source is unset nothing is passed and pi's own fallback applies
  // (defaultThinkingLevel setting → medium, clamped to the model).
  const perModelLevel = model ? settingsManager.getModelThinkingLevel(model.provider, model.id) : undefined;
  const thinkingLevel = resolveThinkingLevel({
    explicit: options.thinkingLevel,
    frontmatter: agentConfig?.thinkingLevel,
    perModel: perModelLevel,
    defaultThinking: getStore(owner).agent.defaultThinking,
    parentLevel: ctx.thinkingLevel,
  });
  const agentDir = getAgentDir();
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    model,
    // Explicit frontmatter gates the registry; a silent config delegates to pi
    // (defaultTools activation, complete registry) or starts tool-less.
    ...resolveSessionToolOptions({
      registeredTools: agentConfig?.registeredTools,
      tools: agentConfig?.tools,
      extToolMap,
      loadToolsImplicitly: getStore(owner).agent.loadToolsImplicitly,
    }),
    resourceLoader: loader,
  };
  if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;
  const result = await createAgentSession(sessionOpts);
  const session = result.session;
  patchRetryClassifier(session);

  // Inject the output-limit field into provider payloads; spawn-time value wins
  // over agent config. Location per request, per pi's per-API algorithm:
  // openai-completions follows the compat chain (explicit
  // model.compat.maxTokensField, else provider/URL detection, else
  // max_completion_tokens); the OpenAI Responses family uses max_output_tokens
  // clamped to pi's minimum of 16 (openai-responses only when the model
  // hasn't disabled compat.supportsMaxOutputTokens); anthropic uses
  // top-level max_tokens; bedrock nests the cap at inferenceConfig.maxTokens;
  // both google APIs nest it at config.maxOutputTokens; mistral uses
  // top-level maxTokens; pi-messages nests it at options.maxTokens.
  const maxTokens = options.maxTokens ?? agentConfig?.maxTokens;
  if (maxTokens != null && maxTokens > 0 && model) {
    const origOnPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, m) => {
      const applied = origOnPayload ? ((await origOnPayload(payload, m)) ?? payload) : payload;
      // Resolved per request so a mid-run setModel stays in sync with pi
      // instead of desyncing on a captured field. Undefined means pi sends
      // no output-limit field for this model; the hook must not inject one.
      // Post-build overwrite by design (as in the prior fix): pi's context
      // clamp and thinking-budget adjust already ran on the model default.
      const limit = resolveOutputLimit(m, maxTokens);
      // Pi omits this for ChatGPT sign-in, so preserve that auth-specific decision.
      if (!limit || (m.api === "openai-responses" && !hasOpenAIResponsesOutputLimit(applied))) return applied;
      return applyOutputLimit(applied, limit);
    };
  }

  return session;
}

async function createAndConfigureSession(
  owner: ExtensionOwner,
  setup: SessionSetup,
  notify: (msg: string) => void,
): Promise<AgentSession> {
  const session = await initSession(owner, setup);
  const { agentConfig, ctx, options, type, extToolMap } = setup;
  const baseName = agentConfig?.name ?? type;
  session.setSessionName(options.agentId ? `${baseName}#${options.agentId.slice(0, SHORT_ID_LENGTH)}` : baseName);
  try {
    announceChildSessionCreated(session, options.pi.events, ctx.sessionManager.getSessionId());
    await session.bindExtensions({
      onError: (err) =>
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:${err.extensionPath}`,
        }),
    });

    const filteredTools = resolveVisibleTools({
      activeTools: session.getActiveToolNames(),
      tools: agentConfig?.tools,
      excludeTools: agentConfig?.excludeTools,
      extToolMap,
      notify,
    });
    if (filteredTools) session.setActiveToolsByName(filteredTools);
  } catch (err) {
    // Setup failed with a live session: terminate it through the shared
    // teardown so built-in extension resources never outlive the failure.
    await disposeChildSession(session);
    throw err;
  }
  announceChildSessionBound(session);
  return session;
}

/**
 * Prompt an existing session after its original run settled (the fork's
 * continueAgentSession() shape).
 *
 * Unlike runAgent, the session already exists: onSessionCreated is never
 * called, and there is no session setup (model resolution, resource loader,
 * tool filtering). The result keeps the runAgent shape (including
 * modelError) so the manager classifies the continuation exactly like the
 * first run.
 */
export async function continueAgentSession(
  session: AgentSession,
  prompt: string,
  options: SessionPromptOptions = {},
): Promise<RunResult> {
  return runSessionPrompt(session, prompt, options);
}

// ── main entry ─────────────────────────────────────────────────────

export async function runAgent(
  owner: ExtensionOwner,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  return runAgentImpl(owner, ctx, type, prompt, options);
}

async function runAgentImpl(
  owner: ExtensionOwner,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const { session, warnings, agentConfig } = await createChildSession(owner, ctx, type, options);
  const result = await runSessionPrompt(session, prompt, {
    ...options,
    maxTurns: options.maxTurns ?? agentConfig?.maxTurns,
  });

  // Flush buffered warnings now that tool_result is in the session tree.
  flushWarnings(ctx, warnings);

  return result;
}

/** Surface buffered setup warnings without splitting tool_use from tool_result. */
function flushWarnings(ctx: ExtensionContext, warnings: string[]): void {
  for (const msg of warnings) {
    if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
    else console.warn(`[pi-subagents-lite] ${msg}`);
  }
}

/**
 * The full child-session setup, prompt-free: settings, tool resolution, the
 * resource loader with pi's built-in factories, session creation, extension
 * binding, and tool visibility. The child loader marks only its own SDK loading
 * calls, so parent announcements and bind callbacks remain unmarked. The contract
 * suite drives this directly against the real SDK; runAgentImpl adds only the
 * prompt and warning flush. Returns the buffered warnings (flush after the
 * run's tool_result lands) and the agent config (for maxTurns).
 */
export async function createChildSession(
  owner: ExtensionOwner,
  ctx: ExtensionContext,
  type: SubagentType,
  options: RunOptions,
): Promise<{
  session: AgentSession;
  warnings: string[];
  agentConfig: ReturnType<ExtensionOwner["registry"]["getAgentConfig"]>;
}> {
  const store = getStore(owner);
  const effectiveCwd = options.cwd ?? ctx.cwd;

  // One SettingsManager for the whole spawn: its trust state gates both the
  // resource loader (project extensions/skills/prompts/themes/system prompt
  // files) and the session context (ctx.isProjectTrusted). pi reads
  // defaultTools and the extension selection from this same instance.
  const settingsManager = SettingsManager.create(effectiveCwd, getAgentDir(), {
    projectTrusted: options.projectTrusted !== false,
  });

  const config = owner.registry.getConfig(type, store.agent.loadSkillsImplicitly, store.agent.loadExtensionsImplicitly);
  const agentConfig = owner.registry.getAgentConfig(type);

  // Buffer warnings during setup to avoid inserting custom_message entries
  // between tool_use and tool_result in the session tree (causes Anthropic 400).
  // Flushed after runTurnLoop completes.
  const warnings: string[] = [];
  const bufferNotify = (msg: string) => {
    warnings.push(msg);
  };
  if (agentConfig?.excludeTools && Array.isArray(agentConfig.tools)) {
    bufferNotify(`agent "${type}": both tools and exclude_tools set — tools (whitelist) wins`);
  }
  if (agentConfig?.excludeExtensions && Array.isArray(agentConfig.extensions)) {
    bufferNotify(`agent "${type}": both extensions and exclude_extensions set — extensions (whitelist) wins`);
  }

  const env = await detectEnv(options.pi, effectiveCwd);

  // The parent interrupt can land mid-setup; every await below re-checks so a
  // stopped spawn either skips session creation or tears the session down.
  const throwIfAborted = (stage: string): void => {
    if (options.signal?.aborted) throw new Error(`agent "${type}": aborted during setup (${stage})`);
  };
  throwIfAborted("before resource load");

  const { mode, extras: promptExtras } = resolveSystemPromptSources(
    owner,
    ctx,
    effectiveCwd,
    bufferNotify,
    agentConfig,
  );

  const systemPrompt = buildPrompt(type, agentConfig, config, effectiveCwd, env, mode, promptExtras);
  const { loader, reloadAndMap } = createResourceLoader(
    config,
    agentConfig,
    effectiveCwd,
    systemPrompt,
    settingsManager,
    bufferNotify,
  );
  const { extToolMap } = await reloadAndMap();
  throwIfAborted("before session creation");
  const session = await createAndConfigureSession(
    owner,
    { ctx, options, agentConfig, type, cwd: effectiveCwd, loader, extToolMap, settingsManager },
    bufferNotify,
  );
  if (options.signal?.aborted) {
    await disposeChildSession(session);
    throwIfAborted("after session creation");
  }
  // Only after the abort check: the caller keeps this handle for steering and
  // continuation, so it must never see a session this setup disposed.
  options.onSessionCreated?.(session);
  return { session, warnings, agentConfig };
}
