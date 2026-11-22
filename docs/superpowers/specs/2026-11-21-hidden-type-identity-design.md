# F4 Hidden Subagent Type Identity

状态：产品政策已在审计 Q3 及修复顺序中由用户确认；本设计把既定政策落实为最小配置解释修复，没有新的产品选项。按本轮“继续剩余工作”授权实施，TDD、全量与fresh独立验收已完成，详见对应执行计划。F1–F3 与两个架构候选保留已验收状态。

## Problem and contract

Hidden Subagent type 仅从 selection/schema listing 隐藏，仍能按名字显式调用自己的角色定义。当前 `AgentRegistry.resolveType/getAgentConfig` 已保留这种身份；但 `resolveConfig` 的 `selected.hidden` 分支及 `findActiveConfig` 又改用 general-purpose。Runner同时使用原agentConfig构造prompt/tools、使用转换后的config加载extensions/skills，造成同一个child混用两种角色配置。审计已用真实child复现：hidden定义禁用资源，却继承general-purpose的资源true。

必须保留显式选中类型的displayName/description/tools/registeredTools/extensions/skills和原始agentConfig。false/true/list以及undefined的全局默认规则与可见类型完全相同。选择列表仍隐藏它；大小写/歧义、target项目类型、discovery、unknown类型既有default行为和instance隔离不变。模型/Thinking/limits仍在target/type之后解析（ADR-0016），project trust门槛和resource加载机制不变。

## Approaches

A（采用）：移除配置转换层的visibility回退，选中config优先，其次registry显式查找；只在既有visible-list入口过滤hidden。删除`findActiveConfig`及selected的hidden分支，避免两处重复身份规则。无需新接口/module/配置。

B：在Runner每个资源调用处特殊传递hidden原配置，保留转换层回退。会让registry与Runner继续持有冲突解释并增加调用方负担，不采用。

Unknown类型当前在没有匹配定义时使用绝对默认和全局implicit开关；本修复不新增general-purpose fallback。注释应描述真实行为，不能顺手改变unknown语义。`agent-types.ts`顶部“excluded from spawning”也改为列表隐藏、显式可调用。

## Scope and validation

生产改动仅`src/agents/agent-types.ts`。保留public exports/参数；Runner/Manager/SDK/ConfigStore/RunCapacity/trust及所有已验收source不改。既有registry resolver/type-resolution测试可最小补回归，新增独立SDK hidden-resource contract测试；尽量不扩写旧contract文件或共享helpers。主代理独占CHANGELOG/spec/plan。

TDD覆盖四类：1.hidden显式registry查找与selected参数，两路径own metadata/resources，GP不同值防误通过；2.false/true/list/undefined与全局defaults、unknown行为；3.列表完整数组/大小写/target-selected/instance隔离对照；4.production createChildSession真实SDK资源加载，hidden false拒绝extension/skill、同配置visible对照及明确允许的hidden资源仍可加载，prompt/tools保持同一角色，trusted/untrusted边界不被绕过。必要FS guards只允许自有fixture资源，不能mock掉loader/用options断言冒充实际资源验收。

全部fixtures/probes/logs使用自建0700专属tmp，禁止真实用户资源/defaultoutputdir访问、HOME覆盖、联网/provider/install/Git写/版本操作。strict-offline targeted/full、vpcheck、actualdiff/API/protectedhash/index、fresh独立资源边界验收与cleanup。无需新ADR或改glossary：定义已在Q3记录。
