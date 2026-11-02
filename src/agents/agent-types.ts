/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .md files
 * (user, shared, and project dirs). Precedence: default < user < shared < project.
 * Hidden agents are kept registered but excluded from spawning.
 */

import { scanAgentFilesInDir, mergeAgents } from "./agent-discovery.ts";
import { DEFAULT_AGENTS } from "./default-agents.ts";
import type { AgentConfig } from "./types.ts";

/**
 * All pi built-in tool names for validation/warning suppression.
 *
 * This set contains ALL built-in tools (including grep, find, ls)
 * and is used ONLY for name recognition in agent configs.
 * It is not a gate: the session tool options own what registers.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export type TypeResolution =
  | { kind: "resolved"; key: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "not-found" };

export interface VisibleAgentInfo {
  name: string;
  description: string;
}

export interface RegisterAgentsOptions {
  disableDefaultAgents?: boolean;
}

/** A factory's registry, including its discovery directories and pending-scan epoch. */
export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();
  private userAgentDir = "";
  private projectAgentDir = "";
  private sharedAgentDir = "";
  private generation = 0;

  reset(): void {
    this.generation++;
    this.agents.clear();
    this.userAgentDir = this.projectAgentDir = this.sharedAgentDir = "";
  }

  registerAgents(userAgents: Map<string, AgentConfig>, options?: RegisterAgentsOptions): void {
    this.agents.clear();
    if (!options?.disableDefaultAgents) {
      for (const [name, config] of DEFAULT_AGENTS) this.agents.set(name, config);
    }
    for (const [name, config] of userAgents) this.agents.set(name, config);
  }

  setAgentScanDirs(userDir: string, projectDir: string, sharedDir?: string): void {
    this.generation++;
    this.userAgentDir = userDir;
    this.projectAgentDir = projectDir;
    this.sharedAgentDir = sharedDir ?? "";
  }

  async scanAndMerge(options?: RegisterAgentsOptions): Promise<Map<string, AgentConfig>> {
    const [userAgents, sharedAgents, projectAgents] = await Promise.all([
      scanAgentFilesInDir(this.userAgentDir, "user"),
      scanAgentFilesInDir(this.sharedAgentDir, "project"),
      scanAgentFilesInDir(this.projectAgentDir, "project"),
    ]);
    const defaults = options?.disableDefaultAgents ? new Map<string, AgentConfig>() : DEFAULT_AGENTS;
    return mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
  }

  async discoverNewAgents(worktreeDir?: string, options?: RegisterAgentsOptions): Promise<number> {
    const generation = this.generation;
    const merged = await this.scanAndMerge(options);
    const worktreeAgents = worktreeDir ? await scanAgentFilesInDir(worktreeDir, "project") : [];
    if (generation !== this.generation) return 0;
    let count = 0;
    for (const [name, config] of merged) {
      if (!this.agents.has(name)) {
        this.agents.set(name, config);
        count++;
      }
    }
    if (worktreeDir) {
      const wtMerged = mergeAgents(new Map(), [], [], worktreeAgents);
      for (const [name, config] of wtMerged) {
        if (!this.agents.has(name)) {
          this.agents.set(name, config);
          count++;
        }
      }
    }
    return count;
  }

  resolveType(name: string): TypeResolution {
    if (!name) return { kind: "not-found" };
    if (this.agents.has(name)) return { kind: "resolved", key: name };
    const lower = name.toLowerCase();
    const candidates = [...this.agents.keys()].filter((key) => key.toLowerCase() === lower);
    if (candidates.length === 1) return { kind: "resolved", key: candidates[0] };
    if (candidates.length > 1) return { kind: "ambiguous", candidates };
    return { kind: "not-found" };
  }

  async resolveTypeOrDiscover(type: string, worktreeDir?: string): Promise<TypeResolution> {
    let resolution = this.resolveType(type);
    if (resolution.kind === "not-found") {
      await this.discoverNewAgents(worktreeDir);
      resolution = this.resolveType(type);
    }
    return resolution;
  }

  getAgentConfig(name: string): AgentConfig | undefined {
    const resolution = this.resolveType(name);
    return resolution.kind === "resolved" ? this.agents.get(resolution.key) : undefined;
  }

  getVisibleAgentInfos(): VisibleAgentInfo[] {
    return [...this.agents.entries()]
      .filter(([, config]) => config.hidden !== true)
      .map(([name, config]) => ({ name, description: config.description }));
  }

  getAvailableTypes(): string[] {
    return this.getVisibleAgentInfos().map((info) => info.name);
  }

  getAllTypes(): string[] {
    return [...this.agents.keys()];
  }

  getConfig(type: string, loadSkillsImplicitly = true, loadExtensionsImplicitly = true): ResolvedAgentConfig {
    return resolveConfig(this, type, loadSkillsImplicitly, loadExtensionsImplicitly);
  }
}

export function createAgentRegistry(): AgentRegistry {
  return new AgentRegistry();
}

/** The enabled-mode Agent schema's name/description listing. */
export function formatAgentTypeDescriptions(infos: VisibleAgentInfo[]): string {
  const lines = infos.map(({ name, description }) => {
    const trimmed = description.trim();
    return trimmed ? `${name}: ${trimmed}` : name;
  });
  return ["Available agent types:", ...lines].join("\n");
}

/** Names of tools that subagents must NOT inherit (no sub-subagent policy, ADR 0001). */
export const EXCLUDED_TOOL_NAMES = ["Agent"];

function resolveToolEntries(
  entries: string[],
  extToolMap: Map<string, string[]> | undefined,
  notify?: (msg: string) => void,
): Set<string> {
  const resolved = new Set<string>();

  for (const entry of entries) {
    const slashIdx = entry.indexOf("/");
    if (slashIdx !== -1) {
      // ext/*, ext/all, or ext/tool syntax
      const extName = entry.slice(0, slashIdx);
      const toolPart = entry.slice(slashIdx + 1);
      if (toolPart === "*" || toolPart === "all") {
        const extTools = extToolMap?.get(extName);
        if (extTools && extTools.length > 0) {
          for (const t of extTools) resolved.add(t);
        } else {
          notify?.(`extension "${extName}" is not loaded, "${entry}" will have no effect`);
        }
      } else if (toolPart === "none") {
        // ext/none: acknowledge extension exists without adding any tools
      } else {
        // ext/tool syntax: e.g. "tavily/web_search"
        resolved.add(toolPart);
      }
    } else {
      // Bare tool name
      resolved.add(entry);
    }
  }

  return resolved;
}

/**
 * Resolve the visible tool set for an agent type from its config.
 *
 * Single owner of tool visibility policy. Handles:
 *   - `tools: true` → all active tools (minus excluded)
 *   - `tools: string[]` → allowlist (minus excluded, with ext/* expansion)
 *   - `tools: false` → no tools
 *   - `tools: undefined` + `excludeTools` → denylist (minus excluded, with ext/* expansion)
 *   - `tools: undefined` → all active tools (minus EXCLUDED_TOOL_NAMES if any are present)
 *
 * `tools` and `excludeTools` are mutually exclusive. If both set, `tools` wins.
 *
 * Returns null when no filtering is needed, otherwise the filtered tool list.
 */
export function resolveVisibleTools(opts: {
  activeTools: string[];
  tools?: true | string[] | false;
  excludeTools?: string[];
  extToolMap?: Map<string, string[]>;
  notify?: (msg: string) => void;
}): string[] | null {
  const { activeTools, tools, excludeTools, extToolMap, notify } = opts;

  // Blacklist mode: excludeTools set and tools not set as whitelist
  if (excludeTools && !Array.isArray(tools)) {
    const excludeSet = resolveToolEntries(excludeTools, extToolMap, notify);
    const filtered = activeTools.filter((t) => !EXCLUDED_TOOL_NAMES.includes(t) && !excludeSet.has(t));
    return filtered.length !== activeTools.length ? filtered : null;
  }

  if (Array.isArray(tools)) {
    const allBuiltinSet = new Set(BUILTIN_TOOL_NAMES);
    const allowedTools = resolveToolEntries(tools, extToolMap, notify);

    for (const entry of tools) {
      const slashIdx = entry.indexOf("/");
      if (slashIdx === -1 && !allBuiltinSet.has(entry)) {
        // Bare name, not a known built-in — check if it's an extension tool
        let foundInExt = false;
        for (const [, extToolNames] of extToolMap ?? []) {
          if (extToolNames.includes(entry)) {
            foundInExt = true;
            break;
          }
        }
        if (!foundInExt) {
          notify?.(`tool "${entry}" not found in any loaded extension`);
        }
      }
    }

    const visibleSet = new Set<string>();
    for (const t of activeTools) {
      if (EXCLUDED_TOOL_NAMES.includes(t)) continue;
      if (allowedTools.has(t)) {
        visibleSet.add(t);
      }
    }

    if (extToolMap) {
      // Build set of extensions explicitly acknowledged with ext/none
      const acknowledgedExts = new Set<string>();
      for (const entry of tools) {
        const slashIdx = entry.indexOf("/");
        if (slashIdx !== -1 && entry.slice(slashIdx + 1) === "none") {
          acknowledgedExts.add(entry.slice(0, slashIdx));
        }
      }

      for (const [extName, extTools] of extToolMap) {
        const hasAny = extTools.some((t) => allowedTools.has(t));
        if (!hasAny && !acknowledgedExts.has(extName)) {
          notify?.(`extension "${extName}" is loaded but none of its tools are in tools: [${tools.join(", ")}]`);
        }
      }
    }

    return [...visibleSet];
  }

  if (tools === false) {
    return [];
  }

  // tools: true or undefined — all tools visible (except excluded)
  const hasExcluded = activeTools.some((t) => EXCLUDED_TOOL_NAMES.includes(t));
  if (!hasExcluded) return null;
  return activeTools.filter((t) => !EXCLUDED_TOOL_NAMES.includes(t));
}

/**
 * The tool-related createAgentSession options resolved for a child session.
 * An empty object means "no override": pi reads its defaultTools setting from
 * the session's own SettingsManager (activation selection, registry stays
 * complete so dispatchers can reach inactive tools).
 */
export interface SessionToolOptions {
  /** Registry allowlist: only these tool names register. */
  tools?: string[];
  /** "all" starts the child with no tools (implicit loading OFF). */
  noTools?: "all";
}

/**
 * Resolve the session tool gate for an agent type.
 *
 * Explicit frontmatter always wins (invariant 1):
 *   - tools: false → empty registry
 *   - tools: string[] → the whitelist expansion (builtins + ext tools)
 *   - registeredTools → the listed set unioned with loaded extension tools
 *   - tools: true → pi's standard selection (the explicit "standard set")
 * When the frontmatter omits tool fields entirely, the implicit mode decides:
 * ON delegates to pi (no override), OFF passes noTools: "all". The Agent tool
 * never enters the registry in any path (no-sub-subagent policy).
 */
export function resolveSessionToolOptions(opts: {
  registeredTools?: string[];
  tools?: true | string[] | false;
  extToolMap?: Map<string, string[]>;
  loadToolsImplicitly: boolean;
}): SessionToolOptions {
  const notAgent = (t: string) => !EXCLUDED_TOOL_NAMES.includes(t);

  if (opts.tools === false) return { tools: [] };

  if (Array.isArray(opts.tools)) {
    return { tools: [...resolveToolEntries(opts.tools, opts.extToolMap)].filter(notAgent) };
  }

  if (opts.registeredTools) {
    const names = new Set(opts.registeredTools);
    for (const t of opts.extToolMap ? [...opts.extToolMap.values()].flat() : []) {
      if (notAgent(t)) names.add(t);
    }
    return { tools: [...names] };
  }

  if (opts.tools === true) return {};

  return opts.loadToolsImplicitly ? {} : { noTools: "all" };
}

export interface ResolvedAgentConfig {
  displayName: string;
  description: string;
  /** Explicit frontmatter registeredTools, absent when the frontmatter is silent. */
  registeredTools?: string[];
  /** Controls tool schema visibility. true = all, string[] = listed, false = none. */
  tools?: true | string[] | false;
  extensions: true | string[] | false;
  skills: true | string[] | false;
}

/**
 * Apply global implicit defaults to skills/extensions.
 * undefined means "not explicitly set" → resolve from global default.
 * Concrete values (true, false, string[]) pass through unchanged.
 */
function applyGlobalDefaults(
  skills: true | string[] | false | undefined,
  extensions: true | string[] | false | undefined,
  loadSkillsImplicitly: boolean,
  loadExtensionsImplicitly: boolean,
): { skills: true | string[] | false; extensions: true | string[] | false } {
  return {
    skills: skills === undefined ? loadSkillsImplicitly : skills,
    extensions: extensions === undefined ? loadExtensionsImplicitly : extensions,
  };
}

/** Find the first non-hidden config: resolved type, then general-purpose, then undefined. */
function findActiveConfig(registry: AgentRegistry, type: string): AgentConfig | undefined {
  const config = registry.getAgentConfig(type);
  if (config?.hidden !== true) return config;
  return registry.getAgentConfig("general-purpose");
}

/** Get config for a type (case-insensitive). Falls back to general-purpose. */
function resolveConfig(
  registry: AgentRegistry,
  type: string,
  loadSkillsImplicitly: boolean = true,
  loadExtensionsImplicitly: boolean = true,
): ResolvedAgentConfig {
  const config = findActiveConfig(registry, type);
  if (config) {
    const { skills, extensions, registeredTools, ...rest } = config;
    const defaults = applyGlobalDefaults(skills, extensions, loadSkillsImplicitly, loadExtensionsImplicitly);
    return {
      displayName: rest.displayName ?? rest.name,
      description: rest.description,
      registeredTools,
      tools: rest.tools,
      ...defaults,
    };
  }

  // Absolute fallback — no config found at all. Tool setup delegates to pi.
  const defaults = applyGlobalDefaults(undefined, undefined, loadSkillsImplicitly, loadExtensionsImplicitly);
  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    ...defaults,
  };
}
