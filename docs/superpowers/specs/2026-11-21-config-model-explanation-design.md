# ConfigStore 模型配置解释：设计

## 目标与范围

完成 1.17.5 架构报告的候选 1：让拥有配置状态的 ConfigStore module 同时拥有模型配置事实的解释，减少菜单及清除反馈重建配置层的知识。候选 2 的容量协议不在本次范围。

## Approaches

- **A：ConfigStore 直接拥有解释（已选）。** 复用配置读取 seam，隐藏值的 precedence、生效来源和原始 membership 的组合规则，增加 interface 的 depth、locality 和 leverage。
- **B：另建消费侧解释 module（未选）。** 它从 ConfigStore 重新拼装层结构，改动可能较少，但容易只迁移复杂度，无法通过 deletion test。

## 职责

- ConfigStore 提供来自当前实例状态的纯配置解释：选中的配置值、生效来源以及每层是否仍携带所请求的键。Clear 资格来自原始 membership，而不是当前 winning value。
- 默认模型和按类型覆盖遵循同一已有 precedence 规则；不增加第二套 resolver。具体类型和方法命名由实现者结合现有调用契约确定。
- Model settings adapter 消费解释后负责标签、分组、菜单布局和清除后的反馈；不再重新组装 config/session 层或推导 source 到层的关系。
- Spawn adapter 仍在选定 Spawn target 和 canonical agent type 后解析模型可用性、回退及 Thinking；ConfigStore 不依赖 SDK model registry、TUI 或 target-local agent registry。
- 不缓存跨菜单操作或跨 Spawn 的解释。Clear 后从更新后的 ConfigStore 重新读取事实。

## 保持不变

- 配置文件及字节、默认值、项目信任、安全写入和同步行为不变；不迁移配置、不新增设置或依赖。
- 生效顺序不变：session per-type → session default → config per-type → config default → frontmatter → parent。
- 空字符串、未知按类型键和非 winning 覆盖仍保持现有可观察性及 Clear 行为。来源标签只表示 winning layer，不用 membership 假冒 winning provenance。
- SDK 可用性与父模型回退、Pending Thinking、实际模型的能力限制、菜单布局和文字含义不变。
- 遵守 ADR-0008、ADR-0011、ADR-0012 和 ADR-0016。状态继续归属于 Extension instance。

## 验收与测试

1. 菜单构建和 Clear 反馈不再拼装 ModelSettingsLayers 或复制配置层解释；配置事实有一个 owner。
2. ConfigStore 的读取 interface 回归覆盖默认键、按类型键、空值、被遮蔽覆盖、未知键、各层 membership、清除后即时继承。
3. Model groups 保留纯展示规则；真实菜单 adapter 验证完整行顺序、来源标签、分组、Clear 与 rebuild。
4. 注册 Agent / Spawn wizard 的回归继续验证 configured-default fallback、显式不可用模型和 Pending Thinking。
5. 只有配置 interface 的等价回归建立后，才替换重复的浅层 precedence mock 测试；不删除真实 adapter 契约或削弱断言。
6. 运行定向测试、严格断网全量测试、vp check 与 git diff --check；再做一次独立复核。

## 非目标与交付

不新增外部 port，不把模型可用性、Thinking、TUI 布局或容量调度搬入 ConfigStore；不以新增转发层冒充加深。独立探索负责核对现有导出和兼容约束，不改变上述设计。

实现包含必要源码与回归测试，以及 CHANGELOG.md 的 Unreleased 记录。保留用户改动；提交、版本更新和推送需要另外授权。
