# F3 Output Transcript Privacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 单 Fixer 串行实现，主代理全量验证与 fresh Verifier；不得执行模板中的 commit/worktree 操作。

**Goal:** 按用户确认的建议 A 保护既有输出目录与完整 prompt/response 日志，不改变路径、格式和 run 生命周期。

**Approved design:** `docs/superpowers/specs/2026-11-21-output-transcript-privacy-design.md`。

**Architecture:** 既有 `output-file.ts` 内部隐藏安全目录/文件操作。POSIX 下用内核 exclusive/no-follow 和打开对象的 metadata 验证实现保护，不能先检查 pathname 再普通写入。目录只允许当前用户拥有的真实目录，可收紧权限；日志独占创建，追加只写已存在的私有普通文件。保留 `safeAppend` best-effort 与所有公开函数/构造参数。

**Tech Stack:** TypeScript、Node builtin FS sync API、Vite+ tests、真实专属临时 FS。不添加依赖或新模块。

## Scope / invariants

- Source write scope only `src/agents/output-file.ts`。不改 Manager、AgentRun、SDK、run-capacity、ConfigStore、trust 或其它所有权。
- Create `test/agents/output-file-privacy.test.ts`。既有 `test/agents/output-file.test.ts` 未出现 fixture 冲突，保持不动。允许 `test/agents/output-transcript.test.ts` 的旧全量 FS mock 做最小新增 API 适配：两项启用 transcript 测试因缺少 openSync 失败，必须继续隔离真实默认路径 I/O，不得削弱原有断言。其它旧测试/helpers只读。
- Parent owns CHANGELOG/spec/plan。保留 F1/F2/候选1和2以及所有现存 dirty 工作。开始前保存 exact source/test/docs/build hashes，empty index/HEAD/version不变。
- 不读取真实 `/tmp/pi-agent-outputs`、用户配置/prompt/logs。所有新 fixtures/probes/logs 使用自建 mktemp0700 directory，清理；不 override runner HOME，不 install/network/provider/Git写/版本/发布/worktree操作。
- AGENTS：real types/no any、object shape interfaces、通过 public `createOutputFilePath`、`writeInitialEntry`、`streamToOutputFile`、`AgentOutputLog` 测试，不通过私有方法。内置 ESM FS 边界仅必要 partial import mock，主要保证来自真实 FS 不是 mock flags。

## Review Focus

1. 新目录0700，新日志0600；已有 current-user 0755/0777目录收紧0700且不删除内容。不要对 symlink 目标/foreign-owned对象 chmod。拒绝目录文件占位与symlink，包括dangling。
2. 初始普通文件/hardlink/symlink/dangling symlink拒绝，bytes/inode/mode保持，不创建link目标。明确0600 exclusive创建，禁止普通write截断或以exists检查充当保护。
3. 初始化后 symlink/nonregular/foreign-owned/权限变宽/丢失文件不得被追加或隐式重建；打开对象核对后对同对象写入。考虑 hardlink private-file alias 对日志保护的影响，以不写他人目标为准；不新增文件身份/运行生命周期owner。
4. 每次操作FD异常关闭，目录与文件核验在实际打开对象上；POSIX owner+mode、no-follow能力真实验证，无 POSIX getuid 或有效 NOFOLLOW/DIRECTORY/NONBLOCK 时，初始化在 FS 修改前明确失败、append best-effort 跳过。Windows 不提供私有日志能力，报告未跑真实 Windows；此 fail-closed 是既有保护要求的落实。不得为未测平台引入复杂ACL/第三方库。
5. 现有 USER/TOOL/ASSISTANT/Thinking/DONE、stream fallback/buffer/finalize/unsubscribe、启用/禁用 transcript、startup failure、actual settlement 不变。安全拒绝时init沿用throw，append沿用best-effort不影响session。

## Task 1 — Read & true-red public FS regressions

- [x] **Step 1:** Read target、Manager构造/attach/finalize及失败路径，既有output-file/output-transcript/thinking-streaming/Manager tests、AGENTS和ADR-0014。检查真实Node FS constants/type合同，确定不跟随symlink和descriptor cleanup方法；不扩大source写scope。
- [x] **Step 2:** 新privateFS suite写用例：0700/0600、current-owned0755/0777保内容收紧、目录symlink/file/foreign-owner拒绝、已有日志regular/hardlink/symlink/dangling不覆盖。foreign UID测试只能必要边界fake metadata或专属fixture可逆操作，禁止跨UID读取真实文件。不要globalumask并发污染；优先明确mode断言，若改umask序列化且finally恢复。
- [x] **Step 3:** Publicstream/AgentOutputLog真实FS替换路径：symlink/删除/宽mode/非regular，finalize或session事件不得修改目标/新建日志；正常buffer与DONE对照。检查真实inode/mode/内容，constructor失败不返回输出路径的假成功。
- [x] **Step 4:** 修改source前 strict-offline run新suite，记录真实行为red数量，harness/import失败不计red；原本绿的正常流对照不伪称red。

## Task 2 — Minimal green and compatibility

- [x] **Step 1:** 在既有output-file模块实现scope内安全目录准备、0600 exclusive初始化与安全append。保持exports/参数、defaultpath、format和Manager调用兼容。文件写完/失败均关闭FD，私有目录拒绝接管他人，append安全失败继续best-effort。当前目录被其它用户占用应按设计明确失败，不换UID目录或静默禁用日志。
- [x] **Step 2:** 跑新privacy+output-file+output-transcript+thinking-streaming，以及相关Manager runs/concurrency/steer-continuation/watchdog测试；strict-offline `unshare -n env PI_OFFLINE=1 NODE_OPTIONS=--unhandled-rejections=strict vp test run --cache=false ...`，source `/root/.config/vite-plus/env`。故障先定位，不通过降低保证或弱化测试修绿。
- [x] **Step 3:** 只格式化授权paths（必要时），vp check、git diff --check、protected hashes/index检查，清理writer自有fixtures/logs。返回red/green、5focus、平台未测范围、actualdiff、FD cleanup与helper/所有权不变证据。

## Task 3 — Parent acceptance

- [x] **Step 1:** 核对actualdiff/source/tests/API和protected hashes；按FS隐私风险委派fresh只读Verifier，重复target并加独立真实FS probes（需验证不跟随/不截断/不隐式create与private mode），不修代码。
- [x] **Step 2:** Parent CHANGELOG记录F3；fresh full strict-offline tests与vp check，capture source/test fingerprints before/after，同一code验收；独立结果不代替全量检查。
- [x] **Step 3:** Final HEAD/index/path/hash/文档空白与10步骤记录，清理所有task自建tmp，交付F3；F4–F7不在本阶段，旧报告/worktree不清理、不commit。

## Self-review

5focus覆盖真实行为、原分支/格式对照及风险边界；exclusive/no-follow和same-FD写是保证不是rename/move包装。无新配置/接口/owner。Spec A已明确确认；single Fixer串行，main独占docs+fresh验证。不新增ADR；实施涉及平台能力发现若与获批保证冲突先报告，不擅自改设计。

## Execution evidence

- 初始 Fixer `f599eecc`：修改源码前 privacy 真红22 failed / 4 passed（26项，其中realFS13failed/4passed）；正常stream对照原本绿。后续目录symlink尾slash补红1failed/31passed，使用open时resolve修复。privacy最终34/34通过，privacy/output-file/thinking-streaming3files81通过。
- 首轮完整定向8filespassed/1failed、167passed/2failed，失败都为旧output-transcript全量FS mock缺openSync；没有误标完成。主代理授权仅该mock API适配，并明确无UID/有效NOFOLLOW DIRECTORY NONBLOCK时init before FS fail-closed、append best-effort跳过。
- 补齐 Fixer：新平台真红32failed/35passed（67总项），旧34项仍全绿、新无UIDappend原本绿；补分支后9files202项严格断网green。旧mock保持所有assertions并新增FDwrite/close断言，所有FS操作仍mock，无真实默认目录I/O。首轮lstatmock重载type error修正并复验，不属于产品red。
- 主代理fresh full strict-offline133files2546tests PASS，vpcheck233formatted/231lint/type，无warning/error；前后36dirtypaths指纹相同。Streaming/Thinkingbuffer/AgentOutputLog生命周期suffix与HEAD字节相同，旧output-file.test.ts也不变，Manager/run-capacity/config/trust/F1/F2不改。
- fresh Verifier `772c44d7` PASS，无发现：strict-offline定向9files202项，独立无mock真实FS24/24探针。覆盖umask022/private modes、既有宽权限目录、尾部路径symlink、专属foreign-owner目录仅metadata、初始regular/hardlink/symlink/dangling保护、post-init不安全对象与FIFO；各后置变更重复200次FD数量稳定。
- 独立实际FIFO无reader的NONBLOCK打开立即ENXIO，文件大小限制实际EFBIG验证init抛错/append吞错与两路close；normalbuffer/ASSISTANT/DONE/unsubscribe通过public seam与真实SDK类型事件。实际Linux flags NOFOLLOW/DIRECTORY/NONBLOCK=131072/65536/2048。
- Verifier确认9条旧transcript断言保留并新增2条，F3三文件指纹不变、267protected baseline hashes不变；baseline外3个既有tracked文件亦与HEAD一致。其自建tmp/probes/fixtures均已清理。Windows没有真实运行验证，Linux真实FS证据来自UID0，foreignowner仅专属fixturemetadata无跨UID正文读；缺所需能力的平台明确拒绝私有日志，不宣称ACL支持。F4–F7未修复。
