# F2 Project Context Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 单 Fixer 串行实现，主代理全量检查 + fresh Verifier；禁止通用模板的 commit/worktree 操作。

**Goal:** 跨仓库 Spawn 的信任检测不再遗漏 worktreeRoot 之外随后被 SDK 加载的非 global context；保留继承。

**Architecture:** 既有 project-trust adapter 仅做 context metadata 检测，向文件系统祖先链上行，忽略显式 global agentDir 的 context。SDK 仍负责 context 正文加载。既有 SDK resource primitive、saved/default/sameRepo 和无资源分支不变。

**Tech Stack:** TypeScript、Node FS metadata、Pi SDK 1.0.3 public trust/resource/session APIs、Vite+ 1.3.0。

**Approved spec:** `docs/superpowers/specs/2026-11-21-project-context-trust-design.md`。

## Files / Responsibilities

- Modify `src/spawn/project-trust.ts`：context metadata ancestor range + global agentDir exception；旧导出签名兼容。
- Create `test/spawn/project-context-trust.test.ts`：isolated真实SDK deps及context-format契约/metadata检测；不替换现有fake-branch unit suite。
- Create `test/contract/sdk-project-context-trust.test.ts`：真实 createChildSession/systemPrompt 断言，复用typed边界helpers但不修改helpers或现有child-session suite。
- Read only：`src/spawn/spawn-target.ts`（生产deps创建）、`src/spawn/worktree-validator.ts`（root fallback）、`src/agents/agent-runner.ts`（projectTrusted实际消费）；现有 `test/spawn/project-trust.test.ts`、`test/spawn/spawn-target.test.ts`、`test/agents/restart-last-agents-trust.test.ts`，既有SDKchild契约及ADR-0008/0012/0016。
- Parent owns CHANGELOG、spec/plan，本阶段不改文档以外的额外path。

## Interfaces / Contracts

保留 `createSubagentTrustDeps(agentDir: string, parentCwd: string, worktreeRoot?: string): SubagentTrustDeps` 和 `resolveSubagentTrust` 签名；旧third arg可接受但不能作为context枚举边界。不改变primitive (hasTrustRequiringProjectResources) 的行为或将 context 读内容合并到deps。internal helper 可接收agentDir供global识别，不导出新API。候选五种名以真实SDKloadProjectContextFiles输入输出pin：`AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`。

context检查上行到dirname(dir)===dir的filesystemroot，不止在worktreeRoot，不截断SDKload；显式global目录context仍global-only而非信任资源，其它目录候选保守识别。插件 `.pi/agents`/`.pi/subagents-lite.json` 现有检测位置、SDKprimitive其它资源边界不扩展。不得为避SDK本文读取未信任正文而读取所有contextFiles再筛选；metadata/候选存在性检测，不是filesystemsandbox/TOCTOU安全快照。

## Constraints / Review Focus

- Current HEAD dfdb021 (1.17.5)、F1和候选1/2以及所有未提交docs必须保留。禁止install/network/真实provider、Git写操作/版本操作、worktree创建/删除。
- 真实fixtures仅mktemp700专属目录；不得真实home/agentDir/config/prompt/log读写，resource/fs边界对ownTmp之外守卫，不让全FS祖先扫描读取宿主指令或资源。不要改runnerHOME导致Vite+runtimelookup下载，source既有env。
- 真实SDKpublic types，objectshape interface，vi.fn真实signatures，不使用any；exec mock必须满足实际ExecResult(killed字段等)。
- ReviewFocus1：祖先P=context，target=P/R/sub，worktreeRoot=R；saved false/never不绕过，true/always仍trusted。
- ReviewFocus2：root=target fallback；R或P=context仍detect，第三参数省略同样工作。
- ReviewFocus3：explicit global agentDir同时为祖先时，只有global context不得触发项目context信任；sameRepo与真正无资源分支保持，saved/default不重新排序。
- ReviewFocus4：真实SDK5候选全部受覆盖，不在检测时读取未信任正文，非context SDK `.pi`/`.agents` 原逻辑不动。
- ReviewFocus5：真实production child systemPrompt，false排除nonglobal marker但global仍保留；true同一ancestor marker仍保留，不改Runner继承/SDK loader。

## Task 1：Public metadata / trust red regressions

- [x] **Step 1:** 读caller/SDK与规则，创建独立realSDKdeps临时fixture（P/R/sub、agentDir、parentCwd全部ownTmp），metadata守卫仅允许此fixture，记录当前接口/worktree fallback而非修改validator。
- [x] **Step 2:** 用例 `gates ancestor above worktree for saved false`：ProjectTrustStore(agentDir).set(target,false)，P/AGENTS.md；`expect(resolveSubagentTrust({targetPath:target,sameRepo:false,deps:createSubagentTrustDeps(agentDir,parentCwd,R)})).toBe(false)`。default never同case无saved，也expectfalse；defaultalways/true对照expecttrue。
- [x] **Step 3:** `detects ancestor with cwd root fallback`：root=target和第三arg省略，P或R/context，deps.hasTrustRequiringProjectResources(target)应true。`does not count global context ancestor`：target在agentDir下、globalcontext仅agentDir、其它SDKprimitive资源空，detectionfalse，无saved决策查询；sameRepo仍true。
- [x] **Step 4:** table-driven五种context names，realSDK loadProjectContextFiles({cwd:target,agentDir})包含candidate路径并且deps检测为true。测试检测阶段不调用readFile正文（先对actualSDK契约获取结果，再单独spy/guardmetadata阶段）。保留noresources/SDKprimitive对照。不通过bodyReader伪造承诺。
- [x] **Step 5:** 严格断网 `unshare -n env PI_OFFLINE=1 NODE_OPTIONS=--unhandled-rejections=strict vp test run --cache=false test/spawn/project-context-trust.test.ts`，记录真实red counts：应失败于祖先遗漏/global误判，不是harness/import错误。

## Task 2：Actual child session seam red + minimal green

- [x] **Step 1:** 新 `sdk-project-context-trust.test.ts` 参照现有child-session生产createChildSession组装typed owner/API/context；SDKcreate/loader是真实的、无provider请求。guard非tmp资源，不读真实user配置；abort/dispose每个session。通过实际trust deps结果传递projectTrusted（按RunOptions真实schema）到productionChild；false必须无nonglobalmarker且global保留，true相同marker被保留。修改前falsecase先red，再实施。
- [x] **Step 2:** 最小project-trust修改：context metadata祖先上行filesystemroot，显式agentDir context不计入nonglobal，保留exports/deps及其它resource检查，不新module/port，不改SDKloader/Runner/validator。
- [x] **Step 3:** 新metadata+SDKseam green，同时strict-offline现有project-trust、spawn-target、restart-last-agents-trust、child-session suites；记录files/tests，不将baseline已绿对照误称red。
- [x] **Step 4:** 只format自己的3个path（需要时），`vp check`/`git diff --check`通过、protected hashes/index不变、清理ownTmp、返回red/green以及所有5focus证据与限制。

## Task 3：主代理验收与交付

- [x] **Step 1:** 读actualdiff和baseline/hash，核对导出兼容、metadata不读未信任正文、global例外、worktree fallback独立和旧分支；fresh Verifier按信任风险独立source+realSDKprobes/public child验收，禁止修代码。
- [x] **Step 2:** CHANGELOG仅记录F2修复；full strict-offline `vp test run --cache=false` + `vp check` 通过（prefix见上），源/测试指纹在验证期间不变。
- [x] **Step 3:** finalscope/index/HEAD/文档空白检查，更新全部执行步骤和证据、清理taskTmp，交付F2；F3另设短设计，不扩大此次实现。

## Self-review

五类focus在Task1/2有明确可观察结果；noresources、sameRepo、saved/default对照避免过度gating；SDK实际body消费由Task2而不是mockloader证明。metadata与bodyReader职责分离；无新配置/抽象/所有权。用户确认spec，继续serialFixer，不重复问执行模式。无额外ADR（对齐既有契约，未选择新困难架构tradeoff）。

## Execution evidence

- Fixer `a2d59dc6`：metadata新suite红灯13 failed / 8 passed，child新suite红灯1 failed / 1 passed；产品行为断言失败（untrusted祖先marker被注入），harness/import修正不计红灯。
- 绿灯严格断网6文件/91项通过：两项新suite（metadata21、child2）及既有project-trust、spawn-target、restart-last-agents-trust、child-session。新child suite执行的red1轮/green2轮合计6个真实sessions，均teardown；SDKloader不mock。
- 生产源码仅project-trust.ts，+12/-6；内部helper改用agentDir、跳过global context层并继续向上，oldoptional第三参数保留。其它SDKprimitive、sameRepo/noresources/saved/default、warning、Runner/validator不动。五种候选真实SDK契约与metadata readFileSync零调用通过。
- 主代理fresh full strict-offline：132文件/2479项通过；vp check232formatted/230lint/type，无warning/error。全量前后31个dirtypath指纹一致，index为空、diff检查通过；开始268路径baseline仅source允许改动（后续另有父代理CHANGELOG/计划记录）。
- fresh Verifier `af52f177`：PASS，无发现。独立严格断网3文件/31项通过（新增两suite23项、独立8项realFS/SDKprobes）；后者经真实computeSpawnTarget→createChildSession覆盖validator fallback、symlink目标规范化、global祖先、saved false/true及never/ask/always；检测抵达filesystemroot且0正文读取。
- Verifier独立probes5/5真实sessions teardown，加contractsuite2个共7个真实sessions；provider和被阻止的外部正文读取均0。两次tmp Vitest import/hoist启动问题为0 tests，仅改ownTmp harness，不计产品失败或通过。
- Verifier baseline268paths中排除source与三份父文档，264/264protected哈希一致；其验收期间270path指纹未变，index为空/HEAD不动；其专属tmp/probes均已清理。主代理最终检查和清理记录随本计划步骤完成。未声称F3–F7修复。
