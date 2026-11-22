# F4 Hidden Type Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans。单 Fixer 串行TDD，主代理全量与fresh独立验收。禁止模板中的commit/worktree操作。

**Goal:** hidden显式Spawn使用自己的完整角色资源配置，visibility只影响列表。

**Design:** `docs/superpowers/specs/2026-11-21-hidden-type-identity-design.md`，执行已确认Q3政策与继续剩余工作的授权；无新增产品选择。

**Architecture / Stack:** 既有registry配置解释去除hidden回退，保持Runner和SDK消费流程。TypeScript、realFS/SDK、Vite+严格断网tests，无新module/dependency/API。

## Scope / focus

- Source仅`src/agents/agent-types.ts`；删除findActiveConfig及selectedhidden回退，不改变unknown绝对默认、implicitdefault、tools/资源数据形状。修正顶部及resolveConfig不准确的注释。
- Tests授权`test/agents/agent-types-resolver.test.ts`、`test/agents/agent-type-resolution.test.ts`及新增`test/contract/sdk-hidden-type-resources.test.ts`。其它旧tests/helpers只读，尤其`child-session.test.ts`、protected fixtures、F1–F3和两个候选。若必要scope扩大先提供证据。
- Main拥有CHANGELOG/spec/plan。无安装/联网/provider/Git写/版本/发布/worktree；所有ownTmp700，guard realFS只读ownfixtures，禁止用户资源/defaultoutput访问和overrideHOME，结束清理。AGENTS realtypes/interfaces/noany，SDKcontract通过productioncreateChildSession与实际loader，非mockloadoptions。
- 四focus：显式lookup/selected同角色；false/true/list/undefined/globaldefaults/unknown；listing完整数组/大小写/target/instance；真实childextension/skill/prompt/tools与trust边界。

## Task 1 — Red and minimal green

- [x] **Step 1:** 读AGENTS、ADR-0016、design、agent-types所有相关入口、Runner配置/资源加载、spawn选中类型传递、直接tests和现有SDKcontract guard；保存baseline/HEAD/index/currentdirtyhashes。
- [x] **Step 2:** 公有registry测试hidden ownmetadata与resource false/true/list/default、selected target/大小写/list完整数组和unknown/instance对照；真实childcontract使用专属extension/skill fixtures，先以true-red复现hidden资源false被GPtrue替换，正常visible/trust对照先绿。记录行为red，不把harness/import错误算red。
- [x] **Step 3:** 最小移除配置解释hidden分支/多余helper并更正注释；保持其它原始角色数据及unknown/default语义，禁止Runner旁路/新owner/API。
- [x] **Step 4:** strict-offline targeted新/相关registry/Runner/child-session/project-context-trust契约；vpcheck及diffcheck/protectedhash/API/index，收集四focus证据并清理writer临时物。

## Task 2 — Acceptance

- [x] **Step 1:** Parent读actualdiff/tests/API/hash，fresh只读Verifier重复proportiontarget并独立验证hidden/visible真实资源边界；不允许修代码或跳过不确定项。
- [x] **Step 2:** Parent CHANGELOG记录，freshfull `unshare -n env PI_OFFLINE=1 NODE_OPTIONS=--unhandled-rejections=strict vp test run --cache=false` 与`vp check`（先source `/root/.config/vite-plus/env`），对code/fixtures保持同一指纹。
- [x] **Step 3:** 最终protectedhash/实际36+新增dirtypaths/HEAD/index/docwhitespace/全部步骤检查；清理全部taskownTmp，不动旧报告/worktrees，诚实记录平台/SDK未测范围。

## Self-review

修复复用既有配置入口，删除两处错误visibility解释而非增加adapter或给Runner分支。四focus覆盖公开interface与实际资源loader；保留禁用资源/信任/implicitdefault/unknown对照，避免只测方法返回值。无新产品政策或ADR，F5–F7不在本轮source写范围。

## Acceptance evidence

- Writer true-red3files15failed/78passed（93total），四个visibleSDK对照先绿，八个hiddenSDK资源行为失败；green93/93。相关7files175tests严格断网PASS；每轮新contract12created/12disposed，provider0/越界bodyread0。
- 实际生产仅+3/-14：selected优先、lookup保hidden、删除privatehelper与修正两处注释。Public exports/signatures/defaultparams、unknownabsolute/globalimplicit保持，Runner/trust/Manager/两候选/F1–F3不改。
- 主代理fresh full严格断网134files2567tests PASS；vpcheck234formatted/232lint/type PASS，source/test指纹稳定。
- Fresh Verifier7b8bdeab PASS无发现：7files175targetrepeat；独立8realFS/SDKprobes8created/8teardown/8dispose、5extensionstart/5shutdown、实际工具执行入口调用5次、provider0/越界resourcebodyread0。targetdiscoveryselected/hiddenfalse/true/undefined/list与realProjectTrustStore边界通过。探针无any且typecheckpass，重复teardown不重复dispose。
- 独立探针中间路径类型/lazyimportguard harness失败只修自有harness，最终预载SDKloader代码、未放宽resourceguard，不计产品red。仅Linux/已装SDK离线资源证据，无provider或其它平台运行验证。
- Writer/VerifierownTmp/probes/fixtures/logs均清理；main最终protectedhash/HEAD/index/diff/docwhitespace与本次tmp清理检查完成，旧报告/worktrees保留。
