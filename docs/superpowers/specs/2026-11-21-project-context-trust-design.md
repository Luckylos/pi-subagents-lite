# F2：项目上下文信任枚举范围（短设计）

## 意图与状态

用户已确认审计政策：保留 SDK 祖先指令继承，信任枚举覆盖实际消费的非 global 上下文资源。F1 已验收；本文已获用户确认；F2 的 TDD 修复、全量检查与独立验收已完成，证据见对应执行计划。

## 已选择的方向

扩大 context 文件的 metadata 检查范围至文件系统祖先链，独立于 worktreeRoot；不截断实际加载范围，不以另一个 loader 或新 port 替代 SDK。检测不读取未信任文件的指令内容。

## 范围和职责

- `src/spawn/project-trust.ts`：保留 SDK resource primitive 与现有分支，修正插件 context 文件检测的上行范围，并区分显式 global agentDir 的 context。
- SDK `loadProjectContextFiles()`：继续负责实际读取/注入；Runner 不改。SDK 当前候选文件名为 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`，以真实库契约验证而非地方假设。
- `createSubagentTrustDeps(agentDir, parentCwd, worktreeRoot?)` 和 `resolveSubagentTrust` 的既有调用接口保持；worktreeRoot 不再限制 context 祖先检查，但不重构 worktree validator 或其它资源发现。

## 行为契约

1. 跨仓库目标上方、非 global 的 context 文件会被识别为需信任资源；saved false 或 global never 不再被此范围遗漏绕过。
2. validator 在 top-level 失败时给出 cwd fallback，也不再漏掉祖先 context。该 fallback 本身保持不动。
3. 无新权限授予：明确不信任时，实际 child prompt 保持 global-only；明确信任时，现有祖先继承仍保留。
4. 显式 global agentDir 的 context 不因祖先链扩大而被误当项目 context。
5. sameRepo、真正无资源目标、saved decision、默认值分支及原 warning 保持。检测可以保守识别候选，不能遗漏随后可能加载的非 global context。

## 验证

- 先红灯：真实 SDK trust deps/ProjectTrustStore/SettingsManager，专属临时 P/R/nested，仅 P 有 context；saved false 和 default never 均应 false。
- Root fallback 对照：R/context + root=cwd 仍可检测，与真实 SDK context 返回范围对照。
- 五种候选文件名的 metadata 检测、global-only 祖先目录例外、真正无资源和 sameRepo 对照。
- 真实 production child-session/public systemPrompt seam：untrusted marker 不进入；trusted 的同一 marker 仍进入。不运行真实 provider、不创建 Git 仓库，validator 的 exec 按既有 mock schema。
- 检测阶段不调用 context readFile 来取得正文；库格式/查找规则使用真实 SDK 契约验证。
- 严格断网定向/全量 tests、vp check、diff/index/protected hash，以及按信任风险的独立验收。

## 非目标与授权

不把 project trust 当 filesystem sandbox；不增加锁、事务、文件内容快照或改变信任决定后的文件变更语义。不修 F3–F7、Parent 配置/模型/类型优先级、SDK loader、warning UX 或 run lifecycle。保持既有未提交修复；不安装、网络、真实 provider、暂存/提交/推送/版本操作。

已按 writing-plans 和 TDD 完成本独立阶段；原信任契约对齐不需要新 ADR。
