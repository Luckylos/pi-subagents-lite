# F1：Create prompt file 非覆盖创建（短设计）

## 意图

用户同意按审计顺序修复；先处理 F1。菜单打开后外部创建文件，或创建成功后编辑再按 Enter，目前均可覆盖真实 custom prompt。本文已获用户确认；F1 的 TDD 修复、全量验证和独立验收已完成，证据见对应执行计划。

## 唯一合理方向

沿用审计已确定的最小方向：原子非覆盖创建 + 操作后刷新菜单。不能以再次 existsSync 后普通写入替代原子性，也不新增覆盖确认、编辑器或文件管理流程。

## 范围与职责

- `src/ui/menu/menu-system-prompt.ts` 的 createPromptFile 分支负责创建、用户反馈和当前列表刷新。
- Node fs 的 exclusive-create 负责是否成功创建，不让 UI 的早期存在性检查承担写入保护。
- 现有 SettingsListWrapper 的 rebuild seam 负责当前列表更新；不修改 shared wrapper 或其余菜单。
- `src/agents/agent-runner.ts` 继续读取原 CUSTOM_PROMPT_PATH；不改调用方、路径、prompt mode、模板字节或 ConfigStore 设置语义。

## 行为契约

1. 初次无文件时创建原有 starter template，成功通知只有真实创建成功才发出。
2. 文件在菜单打开后出现时，创建原子失败；原内容与权限不变，不发虚假的 Created 通知。
3. 操作结束后按当前存在性重建完整列表：文件已存在时移除 Create 行，其他行、值和排序不变，焦点保持有效。
4. 创建后编辑文件，再经当前 wrapper 输入，不会通过旧 Create action 覆写文件。
5. 其它 I/O 失败继续明确反馈错误，菜单不关闭；文件仍不存在时保留重试入口。catch 使用 unknown 与安全 narrowing/既有 errorMessage，不以 any 读取错误。

## 验证

- 保留现有 `test/ui/menu/menu-system-prompt.test.ts` 单次创建/模式/错误回归，按真实 Node write schema 更新断言。
- 新增真实 SettingsList + wrapper 公共输入、真实专属临时 FS 回归：打开后文件出现、成功后编辑再输入、失败重试、完整 item array/分隔线及创建模板字节。先红后绿。
- 禁止写真实 CUSTOM_PROMPT_PATH/home 配置，mock 到 mktemp700 目录，结束清理；不改已验收候选 1/2 的源码/测试/fixture。
- 定向严格断网测试、vp check、diff/index/实际 scope 检查通过后交付 F1，再进入 F2。

## 非目标与授权

不扩展到 F2–F7、不改 SDK/run lifecycle、配置默认值、依赖、菜单文案/视觉风格或其它类型重构。保持现有未提交工作，不安装、暂存、提交、推送或更新版本。设计确认后调用 writing-plans，随后串行 TDD 实施。
