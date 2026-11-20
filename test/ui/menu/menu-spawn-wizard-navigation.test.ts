import { emit, parent, services } from "../../instance-fixtures.js";
import { scanAgentFilesInDir } from "../../../src/agents/agent-discovery.js";
import { runAgent } from "../../../src/agents/agent-runner.js";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component, type TUI } from "@earendil-works/pi-tui";
import { validateWorktreePath, type WorktreeValidationResult } from "../../../src/spawn/worktree-validator.js";
import { getPiModelThinkingLevels } from "../../../src/pi-settings.js";
import { fakeCtx } from "../../fixtures.js";
import { asCommandContext, asTui } from "../../pi-boundaries.js";

vi.mock("../../../src/spawn/worktree-validator.js", () => ({ validateWorktreePath: vi.fn() }));
vi.mock("../../../src/pi-settings.js", () => ({
  getPiDefaultThinkingLevel: () => undefined,
  getPiModelThinkingLevels: vi.fn((cwd: string) => ({
    "test/model": cwd === "/feature" ? "high" : cwd === "/other" ? "low" : "medium",
  })),
}));

const DOWN = "\x1b[B";
const BACK = "\x1b[D";
const ENTER = "\r";
const ESC = "\x1b";
const END = "\x05";
const CLEAR = "\x15";

function deferTarget(path: string) {
  let complete!: (target: WorktreeValidationResult) => void;
  const pending = new Promise<WorktreeValidationResult>((resolve) => (complete = resolve));
  return { pending, finish: () => complete(validTarget(path)) };
}

function validTarget(path: string): WorktreeValidationResult {
  return { ok: true, resolvedPath: path, worktreeRoot: path, sameRepo: true };
}

async function openWizard() {
  const fixture = parent();
  fixture.api.api.exec.mockImplementation(async (_cmd: string, args: string[]) => ({
    code: 0,
    stdout:
      args[0] === "worktree"
        ? "worktree /feature\nbranch refs/heads/feature\n\nworktree /other\nbranch refs/heads/other"
        : "/parent/.git",
    stderr: "",
  }));
  vi.mocked(validateWorktreePath)
    .mockReset()
    .mockImplementation(async (_pi, path) => validTarget(path));
  vi.mocked(getPiModelThinkingLevels).mockClear();
  const requestRender = vi.fn();
  const tui = asTui({ requestRender });
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
  let component: Component | undefined;
  const custom: ExtensionUIContext["custom"] = <T>(
    factory: (
      tui: TUI,
      theme: Theme,
      kb: KeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>,
  ) =>
    new Promise<T>((resolve, reject) => {
      Promise.resolve(
        factory(tui, theme, getKeybindings() as KeybindingsManager, (result) => {
          component = undefined;
          resolve(result);
        }),
      ).then((next) => (component = next), reject);
    });
  const base = fakeCtx({ hasUI: false });
  const ctx = await emit(
    fixture,
    "session_start",
    fakeCtx({
      cwd: "/parent",
      hasUI: false,
      model: { ...base.model!, reasoning: true },
      ui: { ...base.ui, custom },
    }),
  );
  const command = fixture.api.commands.find(({ name }) => name === "agents")!;
  const running = command.handler("", asCommandContext(ctx));
  const render = () => component?.render(100).join("\n") ?? "";
  const press = (...keys: string[]) => {
    for (const key of keys) component?.handleInput?.(key);
  };
  const title = (name: string) => vi.waitFor(() => expect(render().split("\n")).toContain(`  ${name}`));

  await title("Agents");
  press(DOWN, ENTER);
  await title("Select Agent Type");
  press(ENTER);
  await title("Agent Prompt");
  press("original", ENTER);
  await title("Spawn Options");

  function selectRow(label: string) {
    for (let step = 0; step < 11; step++) {
      if (
        render()
          .split("\n")
          .find((line) => line.startsWith("→ "))
          ?.slice(2)
          .trimStart()
          .startsWith(label)
      )
        return;
      press(DOWN);
    }
    throw new Error(`Could not select ${label}`);
  }

  return {
    render,
    press,
    selectRow,
    requestRender,
    manager: services(fixture).manager,
    worktree(path: string) {
      selectRow("Worktree");
      press(ENTER, path, ENTER);
    },
    async close() {
      await title("Agents");
      press(ESC);
      await running;
    },
  };
}

describe("Spawn wizard with the registered command and Pi TUI", () => {
  it.each([
    { row: "Prompt", before: "check ", after: "queue", final: { prompt: "check queue" } },
    { row: "Description", before: "review ", after: "run", final: { description: "review run" } },
    { row: "Max turns", before: "1", after: "7", final: { maxTurns: 17 } },
    { row: "Max tokens", before: "3", after: "20", final: { maxTokens: 320 } },
    { row: "Grace turns", before: "2", after: "1", final: { graceTurns: 21 } },
  ])(
    "keeps the $row editor and keyboard selection when the target preview resolves",
    async ({ row, before, after, final }) => {
      const wizard = await openWizard();
      const target = deferTarget("/feature");
      vi.mocked(validateWorktreePath).mockReturnValueOnce(target.pending);
      wizard.worktree("/feature");
      wizard.selectRow(row);
      wizard.press(ENTER, END, CLEAR, before);
      expect(wizard.render()).toContain(before.trim());

      target.finish();
      await vi.waitFor(() =>
        expect(getPiModelThinkingLevels).toHaveBeenCalledWith("/feature", { projectTrusted: true }),
      );
      wizard.press(after);
      expect(wizard.render()).toContain(before + after);
      wizard.press(ENTER);
      expect(wizard.render()).toMatch(new RegExp(`^→ ${row}\\s+${before + after}$`, "m"));
      expect(wizard.render()).toContain("high (pi per-model)");

      wizard.selectRow("Spawn");
      wizard.press(ENTER);
      await wizard.close();
      await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
      const [, , , prompt, options] = vi.mocked(runAgent).mock.calls[0];
      expect({ prompt, ...options, description: wizard.manager.listAgents()[0].display.description }).toMatchObject({
        cwd: "/feature",
        ...final,
      });
    },
  );

  it("applies the latest worktree preview without moving the selected row", async () => {
    const wizard = await openWizard();
    const first = deferTarget("/feature");
    const latest = deferTarget("/other");
    vi.mocked(validateWorktreePath).mockReturnValueOnce(first.pending).mockReturnValueOnce(latest.pending);
    wizard.worktree("/feature");
    wizard.worktree("/other");
    wizard.selectRow("Description");
    wizard.requestRender.mockClear();

    latest.finish();
    await vi.waitFor(() => expect(wizard.render()).toContain("low (pi per-model)"));
    expect(wizard.requestRender).toHaveBeenCalled();
    expect(wizard.render()).toMatch(/→ Description\s+original/);

    first.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(wizard.render()).toContain("low (pi per-model)");
    expect(wizard.render()).toMatch(/→ Description\s+original/);
    wizard.press(ENTER, END, CLEAR, "discard this", ESC);
    expect(wizard.render()).toMatch(/→ Description\s+original/);
    wizard.press(BACK);
    await wizard.close();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("preserves a model picker's search while the worktree preview resolves", async () => {
    const wizard = await openWizard();
    const target = deferTarget("/feature");
    vi.mocked(validateWorktreePath).mockReturnValueOnce(target.pending);
    wizard.worktree("/feature");
    wizard.selectRow("Model");
    wizard.press(ENTER, ENTER, "inherits ");
    expect(wizard.render()).toContain("> inherits ");

    target.finish();
    await vi.waitFor(() => expect(getPiModelThinkingLevels).toHaveBeenCalledWith("/feature", { projectTrusted: true }));
    wizard.press("parent");
    expect(wizard.render()).toContain("> inherits parent");
    wizard.press(ENTER);
    expect(wizard.render()).toMatch(/→ Model\s+\(inherits parent\)/);
    expect(wizard.render()).toContain("high (pi per-model)");
    wizard.press(BACK);
    await wizard.close();
  });

  it.each([ESC, BACK])("ignores a pending preview after leaving Spawn Options with %j", async (key) => {
    const wizard = await openWizard();
    const target = deferTarget("/feature");
    vi.mocked(validateWorktreePath).mockReturnValueOnce(target.pending);
    wizard.worktree("/feature");
    wizard.press(key);
    await wizard.close();

    wizard.requestRender.mockClear();
    target.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(getPiModelThinkingLevels).not.toHaveBeenCalledWith("/feature", expect.anything());
    expect(scanAgentFilesInDir).not.toHaveBeenCalledWith("/feature/.pi/agents", "project");
    expect(wizard.requestRender).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("launches with freshly resolved choices while the preview is still pending", async () => {
    const wizard = await openWizard();
    const target = deferTarget("/feature");
    vi.mocked(validateWorktreePath).mockReturnValueOnce(target.pending);
    wizard.worktree("/feature");
    wizard.selectRow("Spawn");
    wizard.press(ENTER);
    await wizard.close();
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(runAgent).mock.calls[0]?.[4]).toMatchObject({ cwd: "/feature", thinkingLevel: "high" });

    vi.mocked(getPiModelThinkingLevels).mockClear();
    target.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(getPiModelThinkingLevels).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});
