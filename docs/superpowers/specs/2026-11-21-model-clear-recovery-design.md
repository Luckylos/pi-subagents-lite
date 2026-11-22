# F5 Model Clear Error Recovery

状态：依据已确认审计Q6的部分Clear政策与继续剩余工作的授权准备。没有新增产品政策；F5现已完成TDD、全量与fresh独立验收；证据见对应执行计划。

## Contract / root cause

ConfigStore有意允许跨层Clear部分成功：如Global已写成功而Project失败，Global保持清除，Project覆盖保留，并抛出包含部分成功信息的错误。这是保护策略，不回滚，也不增加多文件事务。当前Model Settings直接调用clearModelOverride/clearAllModelOverrides；异常沿SettingsList Enter传播，成功通知未触发、现有submenu completion/onChange也未执行，导致当前picker旧可清理层级继续显示。

用户必须立即看到error通知，包含原始部分失败信息且不出现成功提示；当前菜单基于实际Store重新构建，剩余覆盖及clearable层级、display provenance准确。用户能继续选择剩余层级或退出，不用重开菜单；完全失败不丢值，成功继续原有效模型反馈。单项default/per-type和Clear all均覆盖。

## Approaches

A（采用）：在Model Settings的两个业务Clear回调捕获错误，用既有errorMessage单行化并notify(error)，使原有nested picker完成和onChange rebuild正常返回。如果既有completion不足以保证即时刷新，只在该menu复用现有onRebuild seam。该菜单拥有反馈和有效配置解释，无需共享组件决定Store事务语义。

B：给所有target/confirm/SettingsList包装器增加通用异常拦截。scope过宽，会影响其它设置的错误语义，不采用。Store吞错或rollback也不采用，违背已确认保护策略。

## Scope and acceptance

生产写范围首选仅src/ui/menu/menu-model-settings.ts；Store、shared target/model/confirm/wrapper、ConfigIO及已验收源保持不动。如果实际公开输入回归证明必须扩scope，先提供证据。复用utils.errorMessage，不新建层/module/config/API。

测试通过真实SettingsListWrapper公开handleInput，不私有方法，不把expectThrow当正确UI结果。已存在menu-model-settings-inplace的两项throw断言改为菜单安全返回+error通知+数据保护；保留全部Store值/partial保护断言，并增加精确完整items/clear-level arrays与separator计数、新选择/重试成功及Clear-all覆盖。必要真实filebackedIO故障契约保留，不mockawayatomicwrite。

四focus：完整失败无成功通知且不丢值；partial成功保留remainingProject并刷新当前picker；default/pertype/clearall与成功有效模型/provenance一致；公开键盘交互继续可用、ownerStore/trust/instance保护不变。

计划后TDD真red（未修复异常）再最小green，targeted菜单/StoreIO、strict-offlinefull/vpcheck、实际diff/protectedhash/index/fresh可复现UI独立验收。main独占CHANGELOG/spec/plan；专属tmp700并清理，禁止用户路径/defaultoutput、HOME覆盖、install/network/provider/Gitwrite/version/worktree。无需ADR：仍遵守既有Clear保护，glossary无新概念。
