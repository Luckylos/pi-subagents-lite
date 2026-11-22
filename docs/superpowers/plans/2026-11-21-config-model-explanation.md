# ConfigStore 模型配置解释：执行计划

> 设计已获用户确认：docs/superpowers/specs/2026-11-21-config-model-explanation-design.md。
> 在当前 checkout 串行执行；保留用户改动，不提交、不暂存、不安装、不推送。

## 目标

让配置事实的读取 interface 由 ConfigStore 提供，菜单及清除反馈不再组装 merged config、session overrides 或 membership 回调。只做候选 1，不改容量协议。

## 文件职责

- `src/config/config-store.ts`：当前实例的模型配置解释，复用现有 resolveModelSource。结果包含 model、source、winning layer、请求键的 clearable levels 和现有显式 per-type 列出资格，不包含标签文字、模型可用性或 Thinking。
- `src/models/model-groups.ts`：消费配置解释，保留标签、分组、排序和 Thinking 展示。
- `src/ui/menu/menu-model-settings.ts`：从 store 读取解释，清除后重新读取最新状态；菜单布局和设置/清除路径不变。
- `test/config/config-store.test.ts`、`test/models/model-groups.test.ts`、`test/ui/menu/menu-model-settings.test.ts`：分别验证配置事实、展示规则和真实菜单行为。
- `test/menu-mock-setup.ts`：只提供新读取 interface 所需的接线，不复制配置算法或以 baked default 伪造原始 membership。
- `CHANGELOG.md`：主代理维护 Unreleased 记录。

## Global Constraints

- 六段 precedence、project 覆盖合并、安全写入、trust、同步及文件字节保持不变。
- persisted membership 是验证后的 layer 中 value !== undefined；session membership 是 value != null。空字符串存在但不能赢；project 空值会压掉 global 同键，模型链继续 default/frontmatter/parent，不重新尝试 global 同键。
- 现有 per-type 列出资格与 membership 不是同一件事：session 非 null 或 merged per-type 为 string 才参与分组；persisted null 不因此新增类型行。未知键仍由现有 Clear-all 处理。
- `default` 复用通用 resolver 时现有 source 名称不规范化；不得无意改变 source 语义。
- SDK 可用性、父模型对象、Pi Thinking、target-local registry 和动态 target 生命周期不进入 ConfigStore。其他 snapshot/membership 消费者保持兼容。
- 发布源码使 deep import 成为可能：保留已有导出名称的兼容性（可作共享实现上的兼容 adapter）；不得为迁移复制第二套 precedence 或配置解释。任何实质导出兼容变更须先报告。
- 若为了兼容产生多个空转 module 或循环依赖，先停下来报告取舍。

## Review Focus

1. 空文件与 baked default null：读取不能误称 global 文件携带 default，也不能写文件。
2. project 空类型值 + global 非空同键：winning default 层和非 winning Clear 资格均准确。
3. 被 session default 遮蔽的类型覆盖：仍列出；类型 Clear 不能删除 session default。
4. 未注册键和仅有 model-family setting：不新增类型行，Clear-all 仍出现并保留 non-model 设置。
5. Clear 与 rebuild：通知和菜单使用最新 store，目标不可用及部分失败保持原错误与数据保护。

## Task 1：配置解释的 interface 与回归

- [x] 在 ConfigStore 测试中通过新的模型解释读取口断言 model/source/layer、clearable 三层和显式类型资格；上述 Review Focus 1–4 逐项加回归。方法命名采用 `describeModelSetting` 或等价现有风格，结果是纯数据。
- [x] 运行 `vp test run test/config/config-store.test.ts`，记录红灯：新读取口缺失，而不是 fixture 或语法错误。
- [x] 在 ConfigStore 实现读取口，调用唯一的 resolveModelSource 并使用实例的原始 membership；保留其他读取口与 writer。
- [x] 跑同一组测试至绿，另保留 file-backed validation / concurrent write 回归，不用 memIO 宣称覆盖文件验证。

## Task 2：迁移分组与菜单 adapter

- [x] 迁移 model-groups 配置决策 fixture，保留分组、空值、遮蔽、provenance、Thinking、Pending 断言；菜单通过新读取口而不是重建 layers。
- [x] 新增或补足真实菜单在位 Clear/rebuild 回归，验证完整 item 数组、separator 数量、继承通知、清除非 winning 层。
- [x] 运行 `vp test run test/models/model-groups.test.ts test/ui/menu/menu-model-settings.test.ts`，先记录接线失败再完成迁移至绿。
- [x] 保留导出 helper 的廉价兼容路径，共享配置解释；纯展示留在 model-groups，ConfigStore 不生成 TUI 标签。
- [x] 验证生产菜单没有 ModelSettingsLayers/session override 重建或 winning source 推断；替换重复 fixture 接线，不删除语义覆盖。

## Task 3：集成和独立复核

- [x] 跑配置、model-groups、模型菜单、`test/ui/menu/model-settings-spawn.test.ts`、`test/spawn/spawn-resolution.test.ts` 以及对应配置 validation/concurrent write 套件。
- [x] 更新 CHANGELOG.md Unreleased（主代理）。
- [x] 运行 `. /root/.config/vite-plus/env` 后 `unshare -n env PI_OFFLINE=1 NODE_OPTIONS=--unhandled-rejections=strict vp test run --cache=false`、`vp check` 和 `git diff --check`。
- [x] 独立 verifier 复核所有 Review Focus、导出兼容路径和 no-UI/no-SDK ownership，必要时做断网真实 adapter 验证。
- [x] 检查实际最终 diff、索引和工作区，报告证据与剩余限制。版本/提交/推送另行授权。

## Execution evidence

- 新 Store 读取回归红：7 failed / 71 passed（缺少新方法）；实现后 78 passed。分组入口迁移前红 40 项，迁移后绿。
- 实现者严格断网定向：17 文件 / 418 项通过；主代理严格断网全量：128 文件 / 2,421 项通过。
- `vp check`：227 文件格式、225 文件 lint/TypeScript 检查通过；`git diff --check` 通过，索引为空。
- 独立 verifier：PASS，7 文件 / 236 项通过；4,096 组配置组合产生 16,384 个完整解释断言；与 HEAD 旧 helper/legacy builder 的 32,768 次比较一致。
- 无模块 mock 的生产菜单 probe：禁用旧 snapshot/session 读口后，在位 Clear/rebuild、session default 保留及最新通知通过。
- ConfigStore mutation/lifecycle/private-writer 后缀与 HEAD 逐字不变；未改 Agent/Spawn、precedence、Thinking、容量或依赖。
- 全量验证后仅补写本执行记录；未提交、暂存、更新版本或推送。候选 2 未开始。
