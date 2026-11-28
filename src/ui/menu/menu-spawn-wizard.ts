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
import { SettingsList, SelectList, type SelectItem, type SettingItem } from "@earendil-works/pi-tui";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
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
import { DEFAULT_GRACE_TURNS } from "../../config/agent-settings.ts";
import { prepareSpawnIntent } from "../../spawn/spawn-preparation.ts";
import { resolveSpawnLimits } from "../../agents/run-limits.ts";
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

/** Offer supported levels for a known model and keep follow/reset available while Pi's choice is pending. */
function createThinkingLevelSubmenu(
  resolveChoices: () => ReturnType<typeof resolveSpawnChoices> | undefined,
  theme: Theme,
): (_currentValue: string, done: (v?: string) => void) => any {
  return (_currentValue, done) => {
    const choices = resolveChoices();
    if (!choices) {
      done();
      return undefined;
    }

    const { model } = choices;
    const items: SelectItem[] = model
      ? getSupportedThinkingLevels(model).map((level) => ({
          value: level,
          label: level === "off" ? "Off" : level.charAt(0).toUpperCase() + level.slice(1),
          description: model.reasoning ? undefined : "(not supported by this model)",
        }))
      : [];

    items.push(...THINKING_CHOICE_TAIL.map((choice) => ({ value: choice, label: choice })));

    const list = new SelectList(items, 10, buildSelectListTheme(theme));
    list.onSelect = (item) => done(item.value);
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
  menuCoordinator = getCoordinator(owner),
): Promise<void> {
  // Bind the draft before the first UI or Git probe can outlive its parent.
  if (!menuCoordinator?.isCurrentParent(ctx)) return;
  const isCurrentMenu = () => menuCoordinator.isCurrentParent(ctx);
  const parentCwd = getSessionCtx(owner)?.cwd ?? ctx.cwd;

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
    if (result === undefined || !isCurrentMenu()) return;

    const config = owner.registry.getAgentConfig(result);
    if (!config) {
      ctx.ui.notify(`Unknown agent type: ${result}`, "error");
      return;
    }
    selectedType = result;
  }

  // ---- Step 2: Prompt entry ----
  let initialPrompt: string;
  {
    const result = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const input = createInputSubmenu(ctx, { required: true })("", done);
      return new SettingsListWrapper(input, { title: "Agent Prompt", theme, passthroughKeys: true });
    });
    if (result === undefined || !isCurrentMenu()) return;
    initialPrompt = result;
  }

  // ---- Step 3: Options sub-menu with spawn ----
  const inGitRepo = parentCwd ? await isInGitRepo(owner, parentCwd) : false;
  if (!isCurrentMenu()) return;
  const worktrees = inGitRepo ? ((await listWorktrees(owner, parentCwd)) ?? []) : [];
  if (!isCurrentMenu()) return;

  const store = getStore(owner);
  let selection: SpawnSelection | undefined;
  try {
    selection = await resolveSpawnSelection(owner, ctx, selectedType, undefined, {
      preview: true,
      coordinator: menuCoordinator,
    });
  } catch (err) {
    if (isCurrentMenu()) ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    return;
  }
  if (!isCurrentMenu()) return;

  const draft: {
    prompt: string;
    description: string;
    modelChoice: SpawnModelChoice;
    thinkingChoice?: ThinkingChoice;
    maxTurns?: number;
    maxTokens?: number;
    graceTurns: number;
    background: boolean;
    worktreePath?: string;
    worktreeLabel: string;
  } = {
    prompt: initialPrompt,
    description: initialPrompt.slice(0, 50),
    modelChoice: { kind: "default" },
    graceTurns: store.agent.graceTurns ?? DEFAULT_GRACE_TURNS,
    background: true,
    worktreeLabel: "Inherits parent cwd",
  };
  const preview = () => {
    if (!selection) return undefined;
    try {
      return resolveSpawnChoices(store, ctx, selection, draft.modelChoice, draft.thinkingChoice);
    } catch {
      // The picker can still replace an unavailable selection. Launch reports its error.
      return undefined;
    }
  };

  const previewValues = () => {
    const choices = preview();
    const { modelChoice } = draft;
    let model = "";
    if (modelChoice.kind === "explicit") model = modelChoice.name;
    else if (choices) {
      if (!choices.modelKey) model = "Pi selects on spawn";
      else model = modelChoice.kind === "parent" ? "(inherits parent)" : choices.modelKey;
    }
    let modelDescription = "Override the default model for this agent";
    if (choices?.unavailableModel) {
      const fallback = choices.modelKey
        ? `Spawn uses parent model ${plainText(choices.modelKey)}.`
        : "Pi selects the model on spawn.";
      modelDescription = `Configured model ${plainText(choices.unavailableModel)} is unavailable. ${fallback}`;
    }
    const limits = resolveSpawnLimits(
      draft,
      selection?.agentConfig,
      selection ? store.agent.defaultMaxTurns : undefined,
    );
    const fmtNum = (v: number | undefined) => (v ? String(v) : "(not set)");
    return {
      model,
      modelDescription,
      thinking: choices ? formatDisplayedThinking(choices.displayThinking()) : "",
      maxTurns: fmtNum(limits.maxTurns),
      maxTokens: fmtNum(limits.maxTokens),
    };
  };

  let optionsClosed = false;
  let launchPending = false;
  let previewRequest: AbortController | undefined;
  let refreshPreview: () => void;
  const updateTargetPreview = async (path: string | undefined) => {
    if (optionsClosed || !isCurrentMenu()) return;
    previewRequest?.abort();
    const request = new AbortController();
    previewRequest = request;
    selection = undefined;
    refreshPreview();
    let updated: SpawnSelection;
    try {
      updated = await resolveSpawnSelection(owner, ctx, selectedType, path, {
        preview: true,
        coordinator: menuCoordinator,
        signal: request.signal,
      });
    } catch {
      // Leave the preview empty when the current target fails validation.
      return;
    }
    if (request.signal.aborted || !isCurrentMenu()) return;
    selection = updated;
    refreshPreview();
  };

  const buildItems = (theme: Theme): SettingItem[] => {
    const values = previewValues();
    return [
      {
        id: "spawn",
        label: "Spawn",
        currentValue: "",
        description: "Spawn the agent with current settings",
        submenu: (_v, done) => {
          if (launchPending || optionsClosed || !isCurrentMenu()) {
            done();
            return undefined as any;
          }
          launchPending = true;
          const {
            prompt,
            description,
            maxTurns,
            maxTokens,
            graceTurns,
            background,
            worktreePath,
            worktreeLabel,
            modelChoice,
            thinkingChoice,
          } = draft;
          const validateModelBeforeClosing = modelChoice.kind === "explicit";

          const doSpawn = async () => {
            if (!isCurrentMenu()) return;
            try {
              const spawn = await resolveSpawn(
                owner,
                ctx,
                selectedType,
                worktreePath,
                modelChoice,
                thinkingChoice,
                menuCoordinator,
              );
              if (!isCurrentMenu()) return;
              if (validateModelBeforeClosing) {
                if (optionsClosed) return;
                doneRef();
              }
              if (!isCurrentMenu()) return;
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
                  prompt,
                  description,
                  maxTurns,
                  maxTokens,
                  defaultMaxTurns: store.agent.defaultMaxTurns,
                  graceTurns,
                  worktreeLabel: spawn.worktreePath ? worktreeLabel : undefined,
                  runInBackground: background,
                  includeRunModeInInvocation: true,
                }),
              );

              if (!background && isCurrentMenu()) getWidget(owner)?.update();
            } catch (err) {
              if (!isCurrentMenu()) return;
              if (err instanceof SpawnModelUnavailableError) {
                ctx.ui.notify(err.message, "error");
                if (!optionsClosed) refreshPreview();
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
        currentValue: values.model,
        description: values.modelDescription,
        submenu: createModelSelectSubmenu(owner, {
          modelOptions,
          showClear: false,
          projectOffered: store.projectTargetOffered,
          theme,
          onSet: (_target, model) => {
            draft.modelChoice =
              model === "(inherits parent)" || model === null ? { kind: "parent" } : { kind: "explicit", name: model };
          },
        }),
      },
      {
        id: "background",
        label: "Background",
        currentValue: draft.background ? "ON" : "OFF",
        description: "Run the agent in the background",
        values: ["ON", "OFF"],
      },
      ...(inGitRepo
        ? [
            {
              id: "worktree",
              label: "Worktree",
              currentValue: draft.worktreeLabel,
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
                      draft.worktreePath = wt?.path;
                      draft.worktreeLabel = wt ? (wt.branch ?? "detached") : "Inherits parent cwd";
                      void updateTargetPreview(draft.worktreePath);
                      done(draft.worktreeLabel);
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
        currentValue: values.thinking,
        description: "Set the reasoning effort level",
        submenu: createThinkingLevelSubmenu(preview, theme),
      },
      {
        id: "maxTokens",
        label: "Max tokens",
        currentValue: values.maxTokens,
        description: "Maximum tokens the agent can consume",
        submenu: createNumericSubmenu(
          ctx,
          {},
          (parsed) => {
            draft.maxTokens = parsed;
          },
          () => {
            draft.maxTokens = 0;
          },
        ),
      },
      {
        id: "maxTurns",
        label: "Max turns",
        currentValue: values.maxTurns,
        description: "Maximum conversation turns before hard stop",
        submenu: createNumericSubmenu(
          ctx,
          {},
          (parsed) => {
            draft.maxTurns = parsed;
          },
          () => {
            draft.maxTurns = 0;
          },
        ),
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        currentValue: String(draft.graceTurns),
        description: "Extra turns after soft limit before abort",
        submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_GRACE_TURNS }, (parsed) => {
          draft.graceTurns = parsed;
        }),
      },
      { id: SEPARATOR_ID, label: " ", currentValue: "" },
      {
        id: "description",
        label: "Description",
        currentValue: draft.description,
        description: "Short label shown in the agents list",
        submenu: createInputSubmenu(ctx),
      },
      {
        id: "prompt",
        label: "Prompt",
        currentValue: draft.prompt,
        description: "The user message sent to the agent",
        submenu: createInputSubmenu(ctx, { required: true }),
      },
    ];
  };

  let doneRef: () => void;

  await ctx.ui.custom((tui, theme, _kb, done) => {
    doneRef = () => {
      optionsClosed = true;
      previewRequest?.abort();
      done(undefined);
    };

    const items = buildItems(theme);
    const onChange = (id: string, newValue: string) => {
      switch (id) {
        case "model":
          // SettingsList writes the raw picker value before this callback.
          refreshPreview();
          break;
        case "thinkingLevel":
          draft.thinkingChoice = parseThinkingChoice(newValue);
          refreshPreview();
          break;
        case "background":
          draft.background = newValue === "ON";
          break;
        case "description":
          draft.description = newValue;
          break;
        case "prompt":
          draft.prompt = newValue;
          break;
      }
    };
    const settingsList = new SettingsList(items, 15, buildSettingsListTheme(theme), onChange, doneRef);
    refreshPreview = () => {
      // Keep the SettingsList and its active editor intact while updating derived rows.
      const values = previewValues();
      const modelItem = items.find((item) => item.id === "model");
      if (modelItem) modelItem.description = values.modelDescription;
      settingsList.updateValue("model", values.model);
      settingsList.updateValue("thinkingLevel", values.thinking);
      settingsList.updateValue("maxTurns", values.maxTurns);
      settingsList.updateValue("maxTokens", values.maxTokens);
      tui.requestRender();
    };
    return new SettingsListWrapper(settingsList, {
      title: "Spawn Options",
      theme,
      onCancel: doneRef,
    });
  });
}
