# Run Capacity Protocol Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. 在当前 checkout 串行执行，遵循实际 Agent registry；不执行通用模板中的 commit 步骤。

**Goal:** 将准入、run-owned lease、startup transfer、FIFO 与重入扫描隐藏在容量 interface 后，保持全部运行语义。

**Architecture:** 每个 Manager 拥有一个 RunCapacity。Manager 表达生命周期授权与错误呈现；AgentRun/Runner 的 cleanup、settlement、SDK gate 保持原 owner。

**Tech Stack:** TypeScript、现有 Node/Vite+ 1.3.0/Vitest；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-21-run-capacity-protocol-design.md`（已获用户确认）。

## Global Constraints

- 保留候选 1 的全部未提交改动；禁止安装、提交、暂存、版本更新、推送及既有 worktree 清理。串行单 writer，主代理维护 CHANGELOG。
- default 是 per-model pool；路由/限值应用沿用现有语义，不借机修正非法配置输入的旧行为。配置输入不能因外部对象后续 mutation 而隐式改变。
- lease 关联原 run；动态路由从实际 modelKey 计数，不撤销 lease、不 abort 超额运行。同池 transfer 保留占位及顺序。
- initial known-model waiter 尚无 session；startup waiter 已有 Runner/parked session。取消只撤销等待，cleanup 仍由原 owner 完成。
- Continuation 满额不排队、不创建新 run/sequence；保留最终模型和 AgentRun reuse admission。
- release 与 drain 分离；原顺序 callback cleanup → SDK queue cleanup → finalize → release → settle → tally/notify → drain → publish。close 不清空 active ownership。
- 不改 SDK/AgentRun/ConfigStore、Spawn/Thinking/通知措辞/配置、generation 或其它 lifecycle；保留旧 Manager exports、constructor/public methods、Runner startup bridge。
- typed fixtures，无 any；临时文件只在专属 chmod700 mktemp 目录，任务后清理。

## Review Focus

1. 实际模型更新后 provider pool 被 split：lease 按最终 modelKey 计数，不能漏算；外部 config object mutation 不隐式生效（Task 1）。
2. parked startup 在 resume/close 前取消：gate 完成但不得调用 resume，active lease 仅由 cleanup 后 release（Task 1、Task 2）。
3. queued callback 同步 setConcurrency/cancelWaiting/close/嵌套 drain：entry 移除、占位先提交、同步顺序和一次启动不变（Task 1、Task 2）。
4. initial start 与 startup resume 抛错：前者原 failStart/通知通道，后者 promise rejection，不双 settle/notify、不自动释放仍执行的 lease（Task 1、Task 2）。
5. release 后 notification 重入 spawn/Continuation：FIFO 不被绕过，publication 前不能新建 continuation，其他池不 head-of-line blocking（Task 1、Task 2）。

## Task 1：独立容量协议 module

**Files:** Create `src/agents/run-capacity.ts`; create `test/agents/run-capacity.test.ts`。

**Interfaces — produces（implementation body 留给实现者）:**

```ts
export interface ConcurrencyConfig { default: number; providers?: Record<string, number>; models?: Record<string, number>; }
export type RunCapacityToken = object;
export type CapacityAdmission = "started" | "queued" | "cancelled" | "closed";
export interface RunCapacityWork { canStart(): boolean; start(): void; onError(error: unknown): void; }
export interface StartupCapacityWork { signal: AbortSignal; canStart(): boolean; onWaiting(): void; onResume(): void; }
export class RunCapacity {
  constructor(config: ConcurrencyConfig);
  setConcurrency(config: ConcurrencyConfig): void;
  schedule(run: RunCapacityToken, modelKey: string | undefined, work: RunCapacityWork): CapacityAdmission;
  reconcile(run: RunCapacityToken, modelKey: string | undefined, work: StartupCapacityWork): void | Promise<void>;
  tryAccept<T extends RunCapacityToken>(modelKey: string | undefined, accept: () => T): T | undefined;
  cancelWaiting(run: RunCapacityToken): void;
  release(run: RunCapacityToken): void;
  drain(): void;
  close(): void;
}
```

- schedule 即刻启动时异常向原 caller 抛出；queued drain 异常调用 work.onError。canStart 由 owner 提供资格，不在 module 内重建 phase。占位和 entry removal 先于 start。
- reconcile 即刻同池/新池获准时不调用 onResume；需要等待才调用 onWaiting，并登记 shared FIFO。waiting callback 仅作 owner phase/投影，无外部激活。Abort/cancel/close 完成 gate 且不 resume；Runner 仍检查 signal 并 teardown。resume 抛错拒绝 promise，lease 保留到显式 release。旧池释放后的推进由本操作隐藏，不泄漏 pool 比较给 Manager。
- tryAccept 只有可准入才调用 accept；在该 callback 前提交临时占位，成功后关联返回的 run token，抛错回滚并保留错误。accept 只构建 run，不启动 SDK 或发送通知。
- release/cancelWaiting 幂等；release 不 drain。setConcurrency 同步 drain（包括原有同步嵌套行为）；close 禁止激活/tryAccept 并撤销等待，但不丢 active lease。

- [x] **Step 1: 写公共 interface 回归和 typed work factories**。使用 `{}` 作为 opaque token、真实 AbortController、vi.fn 的真实签名；不导入 Manager/SDK，不检查内部 Map/Set。
  - `preserves final-model lease across provider split`：provider p:1，a→b 同池无 onWaiting/onResume；split 后 a 可准入、b 满额拒绝。
  - `snapshots concurrency input`：修改原 config 对象不会启动 waiter；显式 setConcurrency 才同步启动。
  - `transfers across pools behind destination FIFO`：a→b 释放旧池，a waiter 先推进；b 原 waiter 先于 transfer waiter。
  - `counts acceptance before callback and rolls back throwing creation`：满额 `expect(accept).not.toHaveBeenCalled()`；accept 内嵌 tryAccept 被拒绝；accept 抛错后容量无泄漏。
  - `does not drain on release`：`expect(waiter.start).not.toHaveBeenCalled()`，drain 后一次启动；notification 模拟新 schedule 不越过旧 waiter，异池即时启动。
  - `rescans synchronously after nested concurrency update`：default:1，held+queued a/b，a.start 更新 default:2；`expect(events).toEqual(["a-before", "b", "a-after"])`。cancel 其他 waiter 不启动被取消项；close 中断扫描，active token 后续 release 安全。
  - `cancels parked gate without resuming`：`await gate; expect(onResume).not.toHaveBeenCalled()`；close 后 tryAccept 不调用 accept。
  - `keeps initial and startup error channels distinct`：immediate schedule 抛原错且无 onError；queued onError 一次；`await expect(gate).rejects.toThrow("resume failed")`，resume error 后仍占位直到显式 release。
- [x] **Step 2: 红灯**：严格断网 `vp test run --cache=false test/agents/run-capacity.test.ts`，失败应为缺失新 module/interface，不是 fixture、语法或环境问题。
- [x] **Step 3: 实现上述 interface**：只收拢路由、计数、lease 和 queue 协议；保留同步 rescan，不以新异步调度或 suppression guard 改变嵌套 callback 顺序。
- [x] **Step 4: 绿灯**：同一新套件通过；`vp check` 通过。若该 interface 无法遵守 spec，报告具体冲突，不添加 lifecycle port 或自行改变语义。

## Task 2：Manager 接线与真实 SDK 回归

**Files:** Modify `src/agents/agent-manager.ts`、`test/agents/agent-manager-concurrency.test.ts`；必要时补 `test/agents/agent-manager-runs.test.ts` 或 `test/contract/sdk-model-capacity.test.ts`，不削弱现有断言。

**Interfaces — consumes:** Task 1 的全部接口。Manager 从 `run-capacity.ts` re-export ConcurrencyConfig，保持原 import path；其余旧 exports 不变。

**Interfaces — private neighboring changes:**

- `startAgent(id: string, record: AgentRecord, args: SpawnArgs): void` 不接收 slot、不 acquire；schedule 已提交 lease，owner 回调负责 start/watchdog/SDK。
- `admitStartupModel(record: AgentRecord, run: AgentRun, modelKey: string | undefined): void | Promise<void>` 保留 abort guard 和 record.execution.modelKey 更新，委托 reconcile 的 owner projection/resume callbacks，不推导 pool。
- `continueSettledAgent(record: AgentRecord, session: AgentSession, message: string, run: AgentRun): AgentRun` 使用 tryAccept 已接受的 run，不再次 accept/acquire；parent notification 的 required=true 语义不变。

- [x] **Step 1: 补 queued start 同步重入的 Manager 回归**。使用现有 manager typed mocks；通过 public spawn/setConcurrency/abort/dispose 驱动，断言完整启动事件数组、被取消 waiter 不运行、其他 waiter 一次运行。先运行相同套件核对红灯/现有基线；这是保持行为迁移，不伪称已有通过场景为红灯。
- [x] **Step 2: 迁移 constructor/setConcurrency、initial schedule、startup reconcile 和 continuation tryAccept**。初始化记录可先保持等待，立即获准仍在同步 spawn 返回前 start；保留 parent 已 abort 的早退，不能先占位再通知已取消初始 run。immediate error 保持 failStart/delete/rethrow，queued error 保持原通知。
- [x] **Step 3: 在原 lifecycle 位置替换 release/drain/cancelWaiting/close**。stop 不释放 active run；failStart 的授权 release 保留；dispose 先阻止激活但仍由原 owner abort/等待 execution。删除 slot/lease/queue 私有实现和旧扫描，保留历史、结果、通知和 SDK cleanup。
- [x] **Step 4: 定向绿灯**：严格断网运行新容量套件、manager concurrency/runs/disposal、SDK model-capacity/steering、child-session 套件。特别保留 SDK-selected model、同池 split、跨池 FIFO、publication reentry、late session teardown、run-owned pending callbacks 和独立 follow-up 的断言。
- [x] **Step 5: deletion/source compatibility 检查**：Manager 无 pool equality、running/limit、queue scan 或 release-old/acquire-new；只有生命周期授权调用。旧 public 导出/constructor/method contracts 保留。

## Task 3：全量与独立验收（主代理）

- [x] 更新 CHANGELOG Unreleased；执行计划标记实际证据。
- [x] `. /root/.config/vite-plus/env` 后执行 `unshare -n env PI_OFFLINE=1 NODE_OPTIONS=--unhandled-rejections=strict vp test run --cache=false`，全量通过；`vp check`、`git diff --check` 通过。
- [x] 独立 verifier 通过容量 interface 检查五类 Review Focus，并通过真实 Manager/SDK seam 检查生命周期接线；不得以测试数量或 private map inspection 代替行为。
- [x] 核对 final diff/index，确认候选 1 未改变，清理本任务临时目录，报告通过/失败/限制；不提交、推送或发布。

## Self-review / Execution

协议、两类等待、lease 计数、callback 重入/异常由 Task 1 覆盖；owner sequencing、export 兼容和真实 SDK 由 Task 2 覆盖。五类 Review Focus 均有明确测试。

执行路径由主代理按现有 session 工作方式选择：单 Fixer 串行实现上述相关阶段，主代理核对，再由 fresh Verifier 独立审计。禁止并行 writer 和额外工作流/生命周期 owner。

## Execution evidence

- Fixer `1d4a3e69`：新 module 缺失导入的真实红灯；实现后 16 项公共 interface 测试通过。新增 Manager 回归的迁移前基线 22 项通过，未伪称红灯。
- Fixer 严格断网定向 7 文件 / 107 项通过，包含新 module、Manager concurrency/runs/disposal 和 SDK model-capacity/steering/child-session；vp check、diff check 通过。
- 主代理严格断网全量：129 文件 / 2443 项通过；vp check：229 formatted、227 lint/type files，无 warning/error。
- 主代理核对 actual reconciliation、atomic acceptance、sync drain 和 settlement source；release 不自动推进，既有 SDK/AgentRun/session-run/steering 和 package 文件无改动。候选 1 的 10 个源/测试文件 SHA256 全部相同；全量运行前后 20 个 dirty paths 的内容指纹相同，索引为空。
- 独立 verifier `df7b42d9`：PASS，无发现。严格断网定向 7 文件 / 107 项；另有 7 项公共协议组合及 2 项真实 SDK seam probe（2 文件 / 9 项）通过。五类 ReviewFocus、实例独立、FIFO/publication 重入均获独立证据；19 个 constructor/public method 签名文本相同，旧 exports 保留。Verifier 专属 probe 目录已清理；真实 SDK seam 仅实测安装的 1.0.3，未访问真实 provider。
- 主代理最终 vp check 再次通过，diff/index/HEAD 与 source/test fingerprint 检查通过；仅候选 2 文档注记发生后续变化。所有 13 项步骤已完成，`/tmp/pi-run-capacity.Uict6H` 已清理；未暂存、提交、更新版本或推送。
