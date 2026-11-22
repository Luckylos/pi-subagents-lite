# 运行容量协议加深：短设计

## 意图与状态

用户已选择 B：把容量准入、run-owned lease、启动模型转移和 FIFO drain 收拢为深 module，以提高 testability 和 AI navigability，而非仅移动 Map/Set。本文已获用户确认；实现、全量验证及独立审计已完成，证据见对应执行计划。

这是一次范围受限、保持行为的内部重构。保留候选 1 的全部未提交改动。

## Approaches

- **A：只收拢 accounting / lease**。能隐藏池路由与计数，但 Manager 仍需理解同池比较、跨池重新占位、FIFO barrier 和 queue scan；不能满足此次深度目标。
- **B：收拢完整容量协议（用户选择）**。把相互依赖的容量政策与队列顺序放在一个 module，邻接 owner 只表达请求和生命周期授权。
- **C：连 execution / settlement lifecycle 一并搬走**。会与 AgentRun 重复拥有取消、cleanup 和 publication，超出范围，不采用。

## Module 与职责

主代理建议在 `src/agents/run-capacity.ts` 放置 `RunCapacity`，每个 AgentManager 实例拥有一个；这是实现位置的提案，不是新增配置或可替换 port。

该 module 拥有：

- model override → provider pool → default per-model pool 的路由与计数。default 不变成全局池。
- 与原 run 关联的 lease；动态配置更新不能替换 lease ownership，也不能停止超额运行。计数按当前 routing 和 lease 的实际 modelKey 计算。
- 已知模型的初始准入、startup-final model 的同池保留／跨池 transfer、Continuation 的 try-admission。
- 两类等待工作的同池 FIFO、异池推进、等待撤销和可重入的 drain/rescan。

AgentManager 继续拥有记录、acceptRun/history、错误呈现、phase 投影、watchdog、通知和 dispose orchestration。AgentRun 继续拥有 run identity、取消、SDK callback cleanup、结果以及 Subagent run settlement publication。Runner 继续拥有 SDK binding、startup gate 的调用位置和 late-session teardown。

容量 module 只接收不透明 run identity、modelKey、并发配置以及必要的激活/失败回调；不读取 AgentRecord、AgentRun phase、SDK session 或 generation。Manager 不再访问 slot running/limit、比较 pool、修改 lease 或扫描队列。

## Interface 的行为契约

具体类型与方法名在获批后的执行计划中确定；必须隐藏而非暴露“探测 slot → 占位”的协议。

1. **初始准入**：已知模型满额时接受初始 run 并排队，但不提前创建 child session；未知模型可先做 SDK setup，一旦 SDK 选出模型，须经现有 startup gate 准入才能执行首个请求。
2. **启动模型 reconciliation**：在绑定和 tool filtering 完成后使用最终模型。同池保留原 lease 和顺序，同时更新实际 modelKey；跨池释放旧占位，遵守目标池已有 waiter 的优先级，并给旧池推进机会。不得双占位或让旧池永久堵塞。
3. **Continuation**：复用准入资格仍由 AgentRun 判断。容量不足直接拒绝，不入队、不产生新 run 或 sequence；成功才接受新 run。try-admission 必须保证原子性，且创建/接线失败不能遗留半完成占位。
4. **队列激活**：占位和移除 queue entry 都发生在激活回调之前。回调可能同步改配置、取消其他 waiter、嵌套 drain 或关闭准入，因此激活后重扫，不能使用一次快照遍历，也不能重复启动。
5. **撤销等待**：known-model waiter 尚无执行/session；startup waiter 已有 in-flight Runner 和 parked session。撤销只终止等待，不释放正在执行的 lease；两类任务的生命周期处理留在原 owner。startup abort gate 与 teardown 仍遵循 Runner 的现有路径。
6. **异常**：初始 queued start 的同步异常仍进入 failStart/原通知路径；startup resume 的异常仍拒绝 admission promise，由现有 settlement chain 清理。不能把两者统一为双 settle、双 notify 或漏 release 的通道。
7. **release 与 advance 分离**：正常顺序保持 callback cleanup → SDK queue cleanup → finalize output → release lease → settle result → tally/notify → drain queue → publishSettlement。release 不能自动 drain，也不能通过 parentWait、SDK agent_settled 或 run.completion 订阅来提前释放。
8. **关闭准入**：dispose 禁止新的占位和激活，撤销等待；不抹去 active ownership。Manager 仍等待 in-flight runs / late-session teardown，实际 settlement 后释放原 lease。

## Goals、Non-goals 与 Anti-goals

- **Goals**：Manager 邻接代码不再掌握 pool equality、slot 计数、lease transfer 或 FIFO 扫描；可以通过容量 interface 独立验证组合协议，再用 Manager/SDK tests 验证接线。
- **Non-goals**：不改配置默认值/持久化/同步、模型选择、SDK gate、Thinking、Spawn/Restart、通知、状态文案或并发用户流程；不新增依赖、配置、ADR 或通用调度框架。
- **Anti-goals**：不创造第二个 lifecycle owner；不把 release 和队列推进合并；不以大量 callback port、重复状态镜像或浅层 getter 拼装来替代现有协议。若具体 interface 需要这些做法，先报告并重新评估。

## 验证与验收

- 先以新的容量 interface 编写红灯回归，再实现并迁移 Manager；保持现有 exported Manager 类型与方法、Runner 的 startup bridge 兼容。
- 独立协议测试覆盖 routing/动态 re-routing、同池 lease 保留和实际 modelKey 更新、跨池 FIFO/旧池推进、Continuation 拒绝无新 run、取消等待不释放 active lease、close 后 late release，以及同步 callback 重入/异常。
- 保留 `test/contract/sdk-model-capacity.test.ts`、`test/agents/agent-manager-runs.test.ts`、concurrency/disposal suites 和 `test/contract/sdk-steering.test.ts` 的真实接线回归；补 queued-start callback 同步改配置/取消 waiter/dispose/嵌套 drain 的缺口。
- **Deletion test**：Manager 不再包含 pool comparison、running/limit 判断、release-old/acquire-new 或 queue scan；保留 actual cleanup 后授权释放和通知后授权推进是必要 orchestration，不算知识泄漏。
- 最终严格断网运行 `vp test run --cache=false`、`vp check`、`git diff --check`，由独立 verifier 审查容量、生命周期接线和已有导出兼容性。主代理更新 CHANGELOG Unreleased。

## 已知依据与授权

依据 ADR-0002、ADR-0012、ADR-0014、ADR-0016 和当前 Manager/AgentRun/Runner 的实际顺序。源码发布可能被 deep import，不能因内部迁移删除既有导出名称。

用户已确认本文并授权进入执行计划和实现。没有提交、暂存、安装、更新版本、推送或清理既有 worktree 的授权。
