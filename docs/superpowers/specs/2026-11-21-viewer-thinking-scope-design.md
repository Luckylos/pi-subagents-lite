# F7：父 scope 的持久化 Thinking 可见性

## 已确认政策与缺陷

Viewer 初始 Thinking block visibility 遵循父 scope 的有效持久化 Pi 设置；不采用未持久化 runtime overrides，不改变 Thinking effort、模型优先级或局部 Ctrl+T。

Widget 与 Running agents 菜单都有父 `ctx`，但原 `prepareConversationViewer` 只接收 `ctx.ui`，丢失 cwd/trust；Viewer 随后通过固定 home/global 路径读取设置，忽略 `PI_CODING_AGENT_DIR` 和 trusted 父项目。

SDK 公共 `SettingsManager.create(cwd, agentDir, { projectTrusted }).getHideThinkingBlock()` 已提供所需持久化层叠；复用既有 `settingsFor`，不引入新的配置 owner/module。

## 最小接口与所有权

- `prepareConversationViewer` 增加可选末尾 `ConversationViewerSettingsScope { cwd, projectTrusted }`，保留原位置参数和导出调用形式。两个生产调用方明确传父 `ctx.cwd` 与必需的 `ctx.isProjectTrusted()` 同步 snapshot。
- opener 在实际打开时读取 scoped 布尔值，再传给 `ConversationViewer` 的可选末尾 `hideThinkingBlock` 参数。cwd/trust 身份在 prepare 时捕获；不从 child/target 或 process cwd 推断。
- `getHideThinkingBlock(cwd?, scope?)`：有 cwd 时走 `settingsFor`；无 cwd 保持 global-only 兼容。`readPiSettings` 仍在缺失/坏 JSON 时返回 undefined，其路径改为 SDK `getAgentDir()`。
- 未传 scope 的旧 direct constructor/opener 仍保留 global 兼容，不用该分支迁就生产调用方的缺失 trust。既有 `PiSettingsScope` 的 agentDir 注入能力保留。
- Viewer 只持有初始布尔值；Ctrl+T 仅改变该实例的可见性与缓存，不写 settings、不同步其他实例。

不采用 `ExtensionAPI.getSettings()`，因为其包含 runtime overrides 且不属于父 ctx 持久化政策；不增加私有宿主 API。SDK `getAgentDir()` 支持 `PI_CODING_AGENT_DIR`；任意宿主私下传入且不暴露的 agentDir 不在此次支持范围。

## 验收与兼容

真实 SDK/FS fixture 验证 custom agentDir、父 project false 覆盖 global true、缺失/坏 JSON、父/target 相反，以及 global true/false 下 untrusted 父项目零读取。公开 Widget 与菜单 conversation/snapshot 入口验证父 cwd/trust，真实 opener/render 验证延迟读取、Ctrl+T 不写磁盘、新 Viewer 重新读取和消息不变。

原构造形式与全局 getter tests 保留；显式初值绕开 global getter。F6 真实摘要与缓存、Stop/Steer、模型/Thinking effort、run/lease/settlement、Store/IO/trust/隐藏类型规则不改。

源码范围：`src/pi-settings.ts`、`src/ui/open-conversation-viewer.ts`、`src/ui/conversation-viewer.ts`、`src/events.ts`、`src/ui/menu/menu-running-agents.ts`。测试范围为对应 settings/Viewer/navigation；新增真实 settings/opener fixture。共享 ctx helpers 已具备 required trust API，无需修改。Main owns docs/CHANGELOG。

## 验证安全与执行记录

只使用专属 0700 临时 fixture；禁止 HOME override、用户 settings/prompt/log/output 读取、网络/provider/install/Git 写/version/worktree 操作。全量设置专属 `PI_CODING_AGENT_DIR`。

首次 red 未先拦截旧 fixed-home getter，错误读取默认 settings；对话只出现字段名，没有展示值。原测试日志按敏感数据处理，未再次读取即删除。随后 guarded red 有效复现行为缺陷。外部化 SDK 的 bare fs 导入绕过普通 Vitest module mock，守卫改为真实 builtin default 对象的 typed spy，并用 `syncBuiltinESMExports` 同步 named exports，afterEach 恢复。最终 tests 验证无越界读取，不能把首次执行描述为 no-userpath。

完成状态与计数见对应执行计划；SDK 1.0.3/Linux 的实测不代表 minimum peer/Windows/真实宿主退出已验证。
