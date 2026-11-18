import type { ExtensionOwner } from "../../shell.ts";
/**
 * menu-spawn-wizard.ts — Spawn agent wizard and worktree picker.
 *
 * Extracted from menus.ts to own the multi-step spawn composition flow:
 * type selection → prompt → options sub-menu → spawn.
 *
 * The worktree picker (listWorktrees, isInGitRepo, parseWorktreeList, truncatePath)
 * is co-located here because it exists solely to feed the spawn wizard's worktree_path.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, type SettingItem } from "@earendil-works/pi-tui";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ThinkingChoice } from "../../types.ts";
import type { Theme } from "../types.ts";

import { parseThinkingChoice } from "../../utils.ts";
import { agentBulletPrefix } from "../format.ts";
import { formatDisplayedThinking, THINKING_CHOICE_TAIL } from "../../models/thinking-resolution.ts";
import {
  resolveSpawn,
  resolveSpawnChoices,
  resolveSpawnSelection,
  SpawnModelUnavailableError,
  type SpawnModelChoice,
  type SpawnSelection,
} from "../../spawn/spawn-resolution.ts";
import { SEPARATOR_ID, buildSettingsListTheme, buildSelectListTheme, createSearchableSelect } from "./helpers.ts";
import { plainText } from "../sanitize.ts";
import { DEFAULT_GRACE_TURNS } from "../../config/config-io.ts";
import { prepareSpawnIntent } from "../../spawn/spawn-preparation.ts";
import { createModelSelectSubmenu } from "./submenus/model-select.ts";
import { createNumericSubmenu, createInputSubmenu } from "./submenus/numeric-input.ts";
import { SettingsListWrapper } from "./wrappers/settings-list.ts";
import { getPiInstance, getSessionCtx, getWidget, getStore, getCoordinator } from "../../shell.ts";

// --- Worktree picker helpers ---

const WORKTREE_LIST_TIMEOUT_MS = 5000;

const WORKTREE_PATH_TRUNCATE_LEN = 60;

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isDetached: boolean;
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * Format (one block per worktree, separated by blank lines):
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<name>   (or: (detached))
 */
function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    let path = "";
    let branch: string | null = null;
    let isDetached = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length);
      } else if (line === "detached") {
        isDetached = true;
      }
    }
    if (path) {
      entries.push({ path, branch, isDetached });
    }
  }
  return entries;
}

function truncatePath(p: string): string {
  if (p.length <= WORKTREE_PATH_TRUNCATE_LEN) return p;
  return "..." + p.slice(p.length - WORKTREE_PATH_TRUNCATE_LEN + 3);
}

/**
 * Fetch worktrees via `git worktree list --porcelain`.
 * Returns null if git is unavailable or the command fails.
 */
async function listWorktrees(owner: ExtensionOwner, cwd: string): Promise<WorktreeEntry[] | null> {
  try {
    const result = await getPiInstance(owner).exec("git", ["worktree", "list", "--porcelain"], {
      cwd,
      timeout: WORKTREE_LIST_TIMEOUT_MS,
    });
    if (result.code !== 0) return null;
    return parseWorktreeList(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Check whether a directory is inside a git repository.
 * Uses `git rev-parse --git-common-dir` — the same strategy as the worktree validator.
 */
async function isInGitRepo(owner: ExtensionOwner, cwd: string): Promise<boolean> {
  try {
    const result = await getPiInstance(owner).exec("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      timeout: WORKTREE_LIST_TIMEOUT_MS,
    });
    return result.code === 0 && result.stdout.trim() !== "";
  } catch {
    return false;
  }
}

// --- Spawn agent wizard ---

/**
 * Build the thinking-level submenu for the model a spawn would use, resolved
 * through `resolveModel` when the picker opens: its supported levels, then
 * `parent` and `pi default`. A non-reasoning model lists only `off` as a level,
 * since every level clamps to `off` there; the tail stays offered whatever the
 * model supports, so any earlier pick can be reversed.
 */
function createThinkingLevelSubmenu(
  resolveModel: () => Model<any> | undefined,
  theme: Theme,
  onThinkingChoice: (choice: string) => void,
): (_currentValue: string, done: (v?: string) => void) => any {
  return (_currentValue, done) => {
    const model = resolveModel();
    if (!model) {
      done();
      return {} as any;
    }

    const supported = getSupportedThinkingLevels(model);
    const isReasoning = model.reasoning;

    const items: Array<{ value: string; label: string; description?: string }> = supported.map((level) => ({
      value: level,
      label: level === "off" ? "Off" : level.charAt(0).toUpperCase() + level.slice(1),
      description: !isReasoning ? "(not supported by this model)" : undefined,
    }));

    items.push(...THINKING_CHOICE_TAIL.map((choice) => ({ value: choice, label: choice })));

    const list = new SelectList(items, 10, buildSelectListTheme(theme));
    list.onSelect = (item) => {
      onThinkingChoice(item.value);
      done(item.value);
    };
    list.onCancel = () => done();

    return list;
  };
}

/**
 * Show the spawn agent flow as a multi-step wizard:
 *   Step 1: type selection (SelectList)
 *   Step 2: prompt entry (Input)
 *   Step 3: options sub-menu with spawn (SettingsList with submenus)
 */
export async function showSpawnAgentMenu(
  owner: ExtensionOwner,
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  // ---- Step 1: Type selection ----
  let selectedType: string;
  {
    const types = owner.registry.getAvailableTypes();
    if (types.length === 0) {
      ctx.ui.notify("No agent types available", "error");
      return;
    }

    const result = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const items: SettingItem[] = types.map((t) => ({
        id: t,
        label: `${agentBulletPrefix(owner, t)}${plainText(t)}`,
        currentValue: t,
        description: owner.registry.getAgentConfig(t)?.description ?? "Agent type",
        submenu: (_v: string, _subDone: (value?: string) => void) => {
          done(t);
          return undefined as any;
        },
      }));
      const list = new SettingsList(
        items,
        10,
        buildSettingsListTheme(theme),
        (_id, value) => {
          done(value);
        },
        () => done(undefined),
        { enableSearch: true },
      );
      return new SettingsListWrapper(list, { title: "Select Agent Type", theme, passthroughKeys: true });
    });
    if (result === undefined) return;

    const config = owner.registry.getAgentConfig(result);
    if (!config) {
      ctx.ui.notify(`Unknown agent type: ${result}`, "error");
      return;
    }
    selectedType = result;
  }

  const agentConfig = owner.registry.getAgentConfig(selectedType)!;

  // ---- Step 2: Prompt entry ----
  let prompt: string;
  {
    const result = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const input = createInputSubmenu(ctx, { required: true })("", done);
      return new SettingsListWrapper(input, { title: "Agent Prompt", theme, passthroughKeys: true });
    });
    if (result === undefined) return;
    prompt = result;
  }

  // ---- Step 3: Options sub-menu with spawn ----
  const session = getSessionCtx(owner);
  const parentCwd = session?.cwd ?? "";
  const inGitRepo = parentCwd ? await isInGitRepo(owner, parentCwd) : false;
  const worktrees = inGitRepo ? ((await listWorktrees(owner, parentCwd)) ?? []) : [];

  const store = getStore(owner);
  // Keep the resources that belong to this open wizard. A session replacement
  // may happen while the user is choosing options or discovery is awaiting.
  const menuGeneration = owner.generation;
  const menuSession = session;
  const menuCoordinator = getCoordinator(owner);
  const isCurrentMenu = () => owner.generation === menuGeneration && getCoordinator(owner) === menuCoordinator;
  let selection: SpawnSelection | undefined;
  try {
    selection = await resolveSpawnSelection(owner, ctx, selectedType, undefined, { preview: true });
  } catch (err) {
    ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    return;
  }
  if (!isCurrentMenu()) return;

  let modelChoice: SpawnModelChoice = { kind: "default" };
  let thinkingChoice: ThinkingChoice | undefined;
  const setThinkingChoice = (choice: string) => {
    thinkingChoice = parseThinkingChoice(choice);
  };
  const preview = () => {
    if (!selection) return undefined;
    try {
      return resolveSpawnChoices(store, ctx, selection, modelChoice, thinkingChoice);
    } catch {
      // The picker can still replace an unavailable selection. Launch reports its error.
      return undefined;
    }
  };

  const thinkingDisplay = (choices: ReturnType<typeof preview>): string => {
    if (!choices) return "";
    if (choices.explicitThinkingLevel !== undefined) {
      return thinkingChoice === "parent"
        ? formatDisplayedThinking({ level: choices.explicitThinkingLevel, source: "parent" })
        : choices.explicitThinkingLevel;
    }
    return formatDisplayedThinking(choices.displayThinking());
  };

  let currentMaxTurns: number | undefined = agentConfig.maxTurns ?? store.agent.defaultMaxTurns;
  let currentMaxTokens: number | undefined = agentConfig.maxTokens;
  let currentGraceTurns: number = store.agent.graceTurns ?? DEFAULT_GRACE_TURNS;
  let currentBackground: boolean = true;
  let currentWorktreePath: string | undefined;
  let currentWorktreeLabel = "Inherits parent cwd";
  let currentDescription = prompt.length > 50 ? prompt.slice(0, 50) : prompt;
  let optionsClosed = false;
  let launchPending = false;
  let previewSequence = 0;
  const updateTargetPreview = async (path: string | undefined) => {
    const sequence = ++previewSequence;
    selection = undefined;
    try {
      const updated = await resolveSpawnSelection(owner, ctx, selectedType, path, { preview: true });
      if (sequence !== previewSequence || !isCurrentMenu()) return;
      selection = updated;
    } catch {
      // Leave the preview empty when a target disappeared or fails validation.
      if (sequence !== previewSequence || !isCurrentMenu()) return;
    }
    rebuild?.(buildItems());
  };

  const buildItems = (): SettingItem[] => {
    const fmtNum = (v: number | undefined) => (v != null ? String(v) : "(not set)");
    const choices = preview();
    const displayModel =
      modelChoice.kind === "explicit"
        ? modelChoice.name
        : modelChoice.kind === "parent"
          ? "(inherits parent)"
          : (choices?.modelKey ?? "(inherits parent)");
    const items: SettingItem[] = [
      {
        id: "spawn",
        label: "Spawn",
        currentValue: "",
        description: "Spawn the agent with current settings",
        submenu: (_v, done) => {
          if (launchPending || optionsClosed) {
            done();
            return undefined as any;
          }
          launchPending = true;
          const gtItem = items.find((i) => i.id === "graceTurns");
          const bgItem = items.find((i) => i.id === "background");
          const descItem = items.find((i) => i.id === "description");
          const promptItem = items.find((i) => i.id === "prompt");

          const maxTurns = currentMaxTurns;
          const maxTokens = currentMaxTokens;
          const graceTurns = Number(gtItem?.currentValue ?? DEFAULT_GRACE_TURNS);
          const background = bgItem?.currentValue === "ON";
          const description = descItem?.currentValue ?? currentDescription;
          const spawnPrompt = promptItem?.currentValue ?? prompt;
          const worktreePath = currentWorktreePath;
          const worktreeLabel = currentWorktreeLabel;
          const chosenModel = modelChoice;
          const chosenThinking = thinkingChoice;
          const validateModelBeforeClosing = chosenModel.kind === "explicit";

          const doSpawn = async () => {
            if (!menuCoordinator || !menuSession) {
              ctx.ui.notify("Subagents session has not started", "error");
              return;
            }
            if (!isCurrentMenu()) {
              ctx.ui.notify("Subagents session changed before spawn", "warning");
              return;
            }
            try {
              const spawn = await resolveSpawn(owner, ctx, selectedType, worktreePath, chosenModel, chosenThinking);
              if (!isCurrentMenu()) {
                ctx.ui.notify("Subagents session changed during agent discovery", "warning");
                return;
              }
              if (validateModelBeforeClosing) {
                if (optionsClosed) return;
                doneRef();
              }
              const widget = getWidget(owner);
              if (widget) {
                widget.setUICtx(ctx.ui as unknown as import("../agent-widget.ts").UICtx);
                widget.ensureTimer();
              }
              await menuCoordinator.spawn(
                getPiInstance(owner),
                ctx,
                prepareSpawnIntent({
                  ...spawn,
                  prompt: spawnPrompt,
                  description,
                  maxTurns,
                  maxTokens,
                  graceTurns,
                  worktreeLabel: spawn.worktreePath ? worktreeLabel : undefined,
                  runInBackground: background,
                  parentMessages: store.agent.parentMessages,
                  includeRunModeInInvocation: true,
                }),
              );

              if (!background && isCurrentMenu()) getWidget(owner)?.update();
            } catch (err) {
              if (!isCurrentMenu()) {
                ctx.ui.notify("Subagents session changed during agent discovery", "warning");
                return;
              }
              if (err instanceof SpawnModelUnavailableError) {
                ctx.ui.notify(err.message, "error");
                return;
              }
              if (validateModelBeforeClosing) doneRef();
              ctx.ui.notify(`Spawn failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            }
          };

          done();
          if (!validateModelBeforeClosing) doneRef();
          void doSpawn()
            .finally(() => {
              launchPending = false;
            })
            .catch(() => {});
          return undefined as any;
        },
      },
      {
        id: SEPARATOR_ID,
        label: " ",
        currentValue: "",
      },
      {
        id: "model",
        label: "Model",
        currentValue: displayModel,
        description: "Override the default model for this agent",
        submenu: createModelSelectSubmenu(owner, {
          modelOptions,
          showClear: false,
          projectOffered: store.projectTargetOffered,
          theme,
          onSet: (_target, model) => {
            modelChoice =
              model === "(inherits parent)" || model === null ? { kind: "parent" } : { kind: "explicit", name: model };
            rebuild?.(buildItems());
          },
        }),
      },
      {
        id: "background",
        label: "Background",
        currentValue: currentBackground ? "ON" : "OFF",
        description: "Run the agent in the background",
        values: ["ON", "OFF"],
      },
      ...(inGitRepo
        ? [
            {
              id: "worktree",
              label: "Worktree",
              currentValue: currentWorktreeLabel,
              description: "Run in a linked git worktree instead of parent cwd",
              submenu: (_v: string, done: (v?: string) => void) => {
                const pickerItems = [
                  { value: "Inherits parent cwd", label: "Inherits parent cwd" },
                  ...worktrees.map((wt) => {
                    const branchLabel = wt.isDetached ? "detached" : (wt.branch ?? "detached");
                    const truncPath = truncatePath(plainText(wt.path));
                    return { value: wt.path, label: truncPath, provider: plainText(branchLabel) };
                  }),
                ];
                return createSearchableSelect(
                  pickerItems,
                  {
                    onSelect: (value) => {
                      const wt = value === "Inherits parent cwd" ? undefined : worktrees.find((w) => w.path === value);
                      currentWorktreePath = wt?.path;
                      currentWorktreeLabel = wt ? (wt.branch ?? "detached") : "Inherits parent cwd";
                      void updateTargetPreview(currentWorktreePath);
                      done(currentWorktreeLabel);
                    },
                    onCancel: () => done(),
                  },
                  theme,
                );
              },
            } as SettingItem,
          ]
        : []),
      {
        id: "thinkingLevel",
        label: "Thinking level",
        currentValue: thinkingDisplay(choices),
        description: "Set the reasoning effort level",
        submenu: createThinkingLevelSubmenu(() => preview()?.model, theme, setThinkingChoice),
      },
      {
        id: "maxTokens",
        label: "Max tokens",
        currentValue: fmtNum(currentMaxTokens),
        description: "Maximum tokens the agent can consume",
        submenu: createNumericSubmenu(
          ctx,
          (parsed) => {
            currentMaxTokens = parsed;
          },
          () => {
            currentMaxTokens = undefined;
          },
        ),
      },
      {
        id: "maxTurns",
        label: "Max turns",
        currentValue: fmtNum(currentMaxTurns),
        description: "Maximum conversation turns before hard stop",
        submenu: createNumericSubmenu(
          ctx,
          (parsed) => {
            currentMaxTurns = parsed;
          },
          () => {
            currentMaxTurns = undefined;
          },
        ),
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        currentValue: String(currentGraceTurns),
        description: "Extra turns after soft limit before abort",
        submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_GRACE_TURNS }, (parsed) => {
          currentGraceTurns = parsed;
        }),
      },
      { id: SEPARATOR_ID, label: " ", currentValue: "" },
      {
        id: "description",
        label: "Description",
        currentValue: currentDescription,
        description: "Short label shown in the agents list",
        submenu: createInputSubmenu(ctx),
      },
      {
        id: "prompt",
        label: "Prompt",
        currentValue: prompt,
        description: "The user message sent to the agent",
        submenu: createInputSubmenu(ctx, { required: true }),
      },
    ];

    return items;
  };

  let theme: Theme;
  let doneRef: () => void;
  let rebuild: ((items: SettingItem[]) => void) | undefined;

  await ctx.ui.custom((_tui, t, _kb, done) => {
    theme = t;
    doneRef = () => {
      optionsClosed = true;
      done(undefined);
    };

    const items = buildItems();
    const onChange = (id: string, newValue: string) => {
      switch (id) {
        case "thinkingLevel":
          setThinkingChoice(newValue);
          break;
        case "background":
          currentBackground = newValue === "ON";
          break;
        case "prompt":
          prompt = newValue;
          break;
      }
      // Rebuild items so displayed values stay in sync after any change
      rebuild?.(buildItems());
    };
    const settingsList = new SettingsList(items, 15, buildSettingsListTheme(theme), onChange, doneRef);
    return new SettingsListWrapper(settingsList, {
      title: "Spawn Options",
      theme,
      onCancel: () => doneRef(),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
