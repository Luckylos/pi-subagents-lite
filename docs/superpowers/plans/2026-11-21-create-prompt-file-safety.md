# F1 Prompt File Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 本阶段单 Fixer 串行实施，主代理核对；不执行通用模板中的 Git commit 步骤。

**Goal:** Create prompt file 永不覆写已有内容，操作后菜单立即反映当前文件状态。

**Architecture:** 原创建分支使用 Node exclusive-create，UI 在明确反馈后通过现有 rebuild seam 更新列表。无新 module/port，不改 shared wrapper、Runner 或 ConfigStore。

**Tech Stack:** TypeScript、Node fs、现有 Pi SettingsList/SettingsListWrapper、Vite+ 1.3.0/Vitest。

**Spec:** `docs/superpowers/specs/2026-11-21-create-prompt-file-safety-design.md`（已批准）。

## Global Constraints

- 保留当前所有未提交工作，尤其候选1/2的source/tests/fixtures及审计术语；禁止安装、网络/真实provider、Git写操作、版本更新、worktree创建/清理。
- 本阶段只有F1；不修F2–F7，不改SDK、lifecycle、ConfigStore、菜单其它设置、模板/path/mode/现有文件权限。
- 专属 mktemp700 中间产物；mock CUSTOM_PROMPT_PATH 到该目录，禁止触碰实际home/config/prompt。不要覆盖 runner HOME 破坏 Vite+ runtime 定位。
- 保持模板字节（含无末尾换行）；Creation action 不改变Store设置。错误使用 unknown 与现有 errorMessage，不使用 any。
- 真实 SettingsList/wrapper 公共输入，full item array 与 separator count；不凭私有方法/仅membership证明刷新。

## File Responsibilities / Interfaces

- Modify `src/ui/menu/menu-system-prompt.ts`：仅 createPromptFile action 的原子创建、错误处理与刷新。
- Modify `test/ui/menu/menu-system-prompt.test.ts`：保留旧模式/单次创建/失败测试，更新真实 Node write options 断言。
- Create `test/ui/menu/menu-system-prompt-inplace.test.ts`：真实 library 和临时 fs 场景；独立于旧 suite 的 mocked SettingsList，复用已有typed helpers，不修改候选1 fixtures/pi-boundaries。
- Main owns CHANGELOG、spec/plan；`src/agents/agent-runner.ts:238–251` 的 reader保持不动。

**Consumes:**

```ts
fs.writeFileSync(CUSTOM_PROMPT_PATH, unchangedTemplate, { encoding: "utf-8", flag: "wx" });
errorMessage(err: unknown): string; // src/utils.ts
rebuild: ((newItems: SettingItem[]) => void) | null; // existing Wrapper seam
```

**Produces:** existing `showSystemPromptMenu(owner: ExtensionOwner, ctx: ExtensionCommandContext): Promise<void>`，无signature变更。Create branch结束后调用既有buildItems/rebuild，从实时存在性获取列表，不引入文件watcher或覆盖流程。

## Review Focus

1. 菜单打开后另一个actor创建文件：原bytes保存、无虚假Created、Create行移除。
2. 创建后外部编辑，再输入/旧action重入：编辑内容保存，不能再普通写入。
3. mkdir/write失败且文件仍不存在：明确error notification，菜单未关闭、仍可重试。
4. 未知/非Error thrown value：安全格式化错误，不再由err.message触发异常或undefined反馈。
5. 成功模板、custom/noncustom条件、其余items和值/顺序保持；完整数组、separator count、有效焦点。

## Task 1：红灯 public seam 回归

- [x] **Step 1:** 新suite使用真实SettingsList+wrapper，typed UI factory/owner、真实fs（仅TMP路径）；不继承旧suite的MockSettingsList。
- [x] **Step 2:** 写下面测试并断言具体结果：
  - `preserves file created after menu opens`：外部写 `USER-EXTERNAL-CONTENT`，选择Create+Enter；`expect(fs.readFileSync(CUSTOM_PROMPT_PATH, "utf-8")).toBe("USER-EXTERNAL-CONTENT")`，无Created通知，complete item IDs等于不含createPromptFile的完整原数组。
  - `preserves edits after successful creation and later input`：初次创建后写 `USER-EDIT-AFTER-CREATE`，再驱动wrapper输入或已捕获action；`expect(fs.readFileSync(CUSTOM_PROMPT_PATH, "utf-8")).toBe("USER-EDIT-AFTER-CREATE")`，Create行不再存在，不出现第二次Created。
  - `keeps creation retry available after write failure`：guardedfs抛 Error("disk unavailable")；error notify一次、无Created、done未调用、完整array仍有Create；撤掉fail后同一菜单可创建。
  - `formats unknown creation errors`：write边界抛string "write blocked"；通知含此text，无外抛或undefined message。
  - `writes exact starter and preserves remaining menu`：新文件严格等于source现有双行模板；custom/noncustom完整array、其余值、separator count及焦点有效。
- [x] **Step 3:** `. /root/.config/vite-plus/env` 后严格断网 `unshare -n env PI_OFFLINE=1 NODE_OPTIONS=--unhandled-rejections=strict vp test run --cache=false test/ui/menu/menu-system-prompt-inplace.test.ts`。记录真实失败，应是覆写/陈旧列表/错误反馈，不是fixture、imports或harness失败。

## Task 2：最小实现与绿灯

- [x] **Step 1:** 创建使用上面的真实Node options；`catch (err: unknown)`调用既有errorMessage，保留成功/失败通知语义。尝试结束后重建items并触发现有rebuild，无成功通知假报。
- [x] **Step 2:** 更新旧creation options断言，保留其余已有测试，不删除或削弱失败保护。
- [x] **Step 3:** 严格断网运行 `test/ui/menu/menu-system-prompt.test.ts`、新inplace、`test/agents/agent-runner-context-prompt.test.ts`；全通过。
- [x] **Step 4:** `vp check`、`git diff --check`通过；源码scope仅F1，所有其它受保护路径/hash保持，临时目录清理。

## Task 3：主代理验收

- [x] 读actual diff，核对exclusive create+rebuild，按风险补独立真实fs/public input验证；更新CHANGELOG Fixed，不声称其它F问题已修。
- [x] 全量严格断网 `unshare -n env PI_OFFLINE=1 NODE_OPTIONS=--unhandled-rejections=strict vp test run --cache=false` 和 `vp check`通过。
- [x] 最终scope/index/hash/文档空白检查，记录红绿证据、清理主目录，交付F1；下一阶段F2按独立设计推进。

## Self-review / Execution

5项ReviewFocus均落在Task1具体用例；source+unit migration由Task2负责，caller/full integration由Task3负责。无未定义的新interface或泛化helper，模板body从当前source读取，不重写。用户已确认spec并要求实施；主代理选择沿用串行Fixer+主代理验收，不再重问执行方式。

## Execution evidence

- Fixer `c1227751`：新公共输入 suite 真红 10 failed / 3 passed，均为覆写、陈旧列表/值或错误格式化；无 fixture/import 失败。最小实现后严格断网定向 3 文件 / 54 项通过（新 inplace 13、旧 unit 6、Reader 35），vp check/diff check 通过。
- 主代理 full strict-offline：130 文件 / 2456 项通过；vp check：230 formatted、228 lint/type files，无warning/error。全量前后26个dirty paths指纹相同。
- fresh Verifier `578aadda`：PASS，无发现。严格断网同3文件/54项，以及1文件/4项独立未mock node:fs的探针通过，涵盖hardlink、dangling symlink、真实mkdir失败重试和0400文件旧action重入；bytes/inode/mode保留。
- starter与HEAD逐字节相同：102 UTF-8 bytes，无末尾换行；原新建文件mode语义不变。Reader、path、API、mode、sharedwrapper和265路径baseline中的260个protected路径均未改，index为空。仅F1验收，不声称F2–F7已修。
- final vp check再次通过；26路径scope、protected hashes、index/HEAD和文档空白检查通过，源码/测试在fullsuite后未变化。主代理`/tmp/pi-f1-create.drfq5v`与子代理所有自有probe目录已清理；10项步骤全部完成，没有暂存、提交、版本更新或推送。
