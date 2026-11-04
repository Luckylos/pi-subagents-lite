# pi-subagents-lite（Luckylos 二开版）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

给 [pi](https://pi.dev) 用的子代理（Subagent）扩展。本仓库是 [AlexParamonov/pi-subagents-lite](https://github.com/AlexParamonov/pi-subagents-lite) 的二次开发版本，基于上游 v1.17.1 之后的 `0a3fb57`，包名仍是 `pi-subagents-lite`。

二开的目标是让它在 [pi-web](https://github.com/agegr/pi-web) 这类“一个进程里同时跑多个父会话”的环境下行为正确，并补上子代理主动联系父会话的通道。

- 设计决策记录：[docs/adr/](docs/adr/)，术语表：[CONTEXT.md](CONTEXT.md)，变更记录：[CHANGELOG.md](CHANGELOG.md)

## 与上游的区别

| 方面 | 上游 | 本仓库 |
|---|---|---|
| 多父会话 | 扩展状态（manager、队列、注册表、widget、定时器、通知）在同一进程的多个父会话之间共享，会互相覆盖 | 每个扩展实例各持一份状态（ADR-0012） |
| 后台完成通知 | SDK 用未初始化的运行时重载扩展工厂后，通知可能丢失或发错会话 | 通知 API 只在父会话 `session_start` 后发布，并绑定到该父会话 |
| 子会话里的子代理工具 | 依赖全局标记排除 | 只在资源加载边界用 async-local 状态标记，子会话里没有 `Agent` 等四个工具，其他扩展的工具照常可用 |
| 配置写入 | 并发写可能丢字段 | 写前重读目标层，同目录原子写，失败会报错；每次写入后按生效配置同步 widget 和并发限制 |
| 子代理 → 父会话 | 上游 v1.18.0 用全局状态实现了另一套 | 新增 `MessageParent` 工具（ADR-0013），见下文 |
| 停止与会话交接 | 启动中被停止的子代理可能仍持有已销毁的会话 | 先做中止检查，再交出子会话 |

本仓库**没有**合并上游 v1.18.0：两边的子代理通信实现结构上冲突，评估记录见 ADR-0013。

验证情况：`vp check` 和 `vp test run`（112 个测试文件，2074 个测试）通过；多父会话通知路由、空闲父会话唤醒和 `MessageParent` 在真实 pi-web 0.14.1 和真实模型上测过。没验证过的：旧版 pi SDK、长时间高负载、外部扩展（如权限系统）订阅事件的兼容性。

## 安装

需要 Node.js >= 22.19.0、pi >= 0.99.0。npm 上的 `pi-subagents-lite` 是上游版本，装本仓库要用 git 源或本地路径。**先卸掉上游版本**，同一个扩展装两份会重复注册同名工具：

```bash
pi remove npm:pi-subagents-lite            # 装过上游才需要
pi install git:github.com/Luckylos/pi-subagents-lite          # 跟随 main
pi install git:github.com/Luckylos/pi-subagents-lite@<提交哈希>  # 固定到某个提交（推荐生产环境）
pi install /path/to/pi-subagents-lite      # 本地克隆，适合二次修改
pi list                                     # 确认只有一份
```

## 用法

模型像调用其他工具一样调用 `Agent`。前台子代理执行完才返回，并附带统计；后台子代理立即返回，完成后自动把结果通知给父会话。

```
◈ Agents
  ⠧ builder  Bump all gpu_inference_proxy deps to latest  6⟳ ·↑7k↓2k 2%·$0.00·54s
  │ MiMo V2.5 • high
  └ running command…
  ⠧ scout  Explore keepalive events config  25⟳ ·↑79k↓5k 8%·$0.01·2m 39s
  │ MiMo V2.5 • high
  └ Now I have enough information to provide a comprehensive answer.
```

终端 pi 里，编辑器上方的 widget 显示运行中和刚结束的子代理。`↓`/`↑` 选中，`Enter` 打开会话查看器，`Esc` 退出。查看器实时显示思考块、工具调用和压缩摘要；工具结果不展开，每次调用显示为一行带状态颜色的记录。

`/agents` 菜单可以查看、引导（steer）、续跑、停止和清理子代理，手动启动子代理（不经过模型），以及设置模型、并发、子代理行为、系统提示词、widget 和诊断。

### 工具

主会话里有四个工具，工具描述都只有一个点，以减少 schema 开销；工具名和参数名本身就是 schema 的一部分：

- `Agent`：启动子代理，参数见[Agent 参数](#agent-参数)。
- `StopAgent`：按 ID 停止运行中或排队中的子代理。ID 来自启动结果、停止报错或 `/agents`。
- `MessageAgent`：按 ID 给已有子代理追加输入。运行中的在下一个回合边界收到；已结束的如果会话还在、且有空闲并发名额，会带着原上下文续跑。
- `AgentStatus`：列出所有运行中、排队中的子代理，以及最近结束的若干个（默认是默认并发数的两倍）。它会提醒模型不要轮询。

后台子代理自己有一个工具 `MessageParent`（二开新增）：

- 子代理运行中可以给父会话发一条简短消息，比如卡住时的提问或改变计划的发现。子代理继续工作，不等回复；父会话需要回复时用 `MessageAgent`。
- 父会话空闲时会被唤醒；父会话正在运行时，消息作为 steer 插入。消息总是先于完成通知到达。
- 每次运行最多 5 条，续跑后额度恢复。父会话不可用时，工具返回 `Not delivered: the parent session is unavailable.`，这次不计入额度。
- 前台子代理没有这个工具。frontmatter 里显式写了 `tools` 或 `registeredTools` 的，必须把 `MessageParent` 列进去。
- 关闭：`/agents` > Settings > Agent behavior > Parent messages，或配置 `agent.parentMessages: false`。

前台子代理会一直占着 `Agent` 工具调用，父会话中断时一起停止。后台子代理立即返回，不跟随父会话中断，但仍可通过 UI 或工具引导、停止。

### 引导与续跑

运行中的子代理可以中途改方向：在会话查看器里按 `Enter`、在 `/agents` 菜单里选 `Steer`，或由主会话调用 `MessageAgent`。已结束的子代理（完成、触达回合上限、中止、停止、出错）可以从会话查看器、`/agents` 菜单或 `MessageAgent` 续跑。

### 权限网关等感知子代理的扩展

每个子代理会话在创建、扩展绑定完成、销毁时，会在 pi 的扩展事件总线上发出通知。和本扩展一起安装的网关（例如 `@gotgenes/pi-permission-system`）用这些通知把子代理里的 `ask` 决定升级到父会话，而不是在子会话里直接拒绝。没装这类扩展时没有可见效果；pi 没有事件总线时跳过通知；如果父会话在子代理运行期间被替换、重载或销毁，pi 会拒绝通知，本扩展会给出警告并指出是哪个子代理。通知失败不会让启动或销毁失败。事件名和载荷由该外部集成文档定义，本仓库不改动。

## 内置子代理

- `general-purpose`：通用任务，使用会话配置的工具。
- `Explore`：用于只读地探索代码。它的提示词禁止修改文件，但带有 `bash` 且没有沙箱，所以“只读”不是强制的。默认加载扩展，除非关闭了 `loadExtensionsImplicitly` 或 frontmatter 过滤了扩展。

内置子代理可以被同名自定义子代理覆盖，也可以在 `/agents` > Settings > Agent behavior 里禁用。

## 自定义子代理

把 `.md` 文件放进 `.pi/agents/`（项目）、`.agents/agents/`（共享）或 `~/.pi/agent/agents/`（全局）。frontmatter 是配置，正文是系统提示词。重名时优先级：项目 > 共享 > 全局 > 内置。类型名先精确匹配，再做唯一的大小写不敏感匹配；大小写有歧义时必须写准确名字。

```markdown
---
name: security-review
description: Review code for security issues
tools: [read, bash, grep]
extensions: false
skills: false
model: zai/glm-5.2
thinking: high
max_turns: 80
---

You are a security review specialist. Analyze code for vulnerabilities,
focusing on injection flaws, auth bypasses, and insecure defaults.
```

只写 `name` 和 `description` 的子代理，拿到的工具、扩展和技能与 `general-purpose` 相同，名字会出现在 `Agent` 工具的 `agent` 参数说明里。需要限制时再加限制。

### frontmatter 字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | string | — | 类型名，必须唯一；没有它的文件会被跳过。 |
| `display_name` | string | `name` | UI 里显示的名字。 |
| `color` | string | 无 | 图标颜色。命名色：`red`、`blue`、`green`、`yellow`、`purple`、`orange`、`pink`、`cyan`；调色板别名：`amber`、`teal`、`indigo`、`gold`、`violet`、`rose`、`lime`、`gray`、`slate`、`navy` 等；也接受 `#RRGGBB`。 |
| `description` | string | `""` | 一句话描述。 |
| `tools` | 列表或逗号分隔字符串 | pi 的 `defaultTools`；隐式工具关闭时为空 | 工具白名单，空列表表示没有工具。与 `exclude_tools` 互斥。 |
| `exclude_tools` | 列表或逗号分隔字符串 | 无 | 工具黑名单。与 `tools` 互斥。 |
| `extensions` | `true` \| `string[]` \| `false` | `true` | 加载哪些扩展（包括它们的工具、钩子和命令）。工具能否使用另由 `tools` 决定。 |
| `exclude_extensions` | `string[]` | 无 | 扩展黑名单。 |
| `skills` | `true` \| `string[]` \| `false` | `true` | 技能白名单（系统提示词里只放元数据）。 |
| `preload_skills` | `string[]` \| `false` | `false` | 把完整的 SKILL.md 写进系统提示词，开销大。 |
| `model` | string | 继承父会话 | `"provider/model-id"`，见[模型解析](#模型解析)。 |
| `thinking` | string | 见[思考级别解析](#思考级别解析) | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，或 `parent`（跟随父会话）。 |
| `max_turns` | number | 不限 | 软回合上限，之后还有宽限回合，再硬中止。 |
| `max_tokens` | number | 不限 | 每次模型响应的最大输出 token。 |
| `hidden` | boolean | `false` | 不出现在 `Agent` 工具的类型列表里，但仍可按名字调用。 |
| `output_transcript` | boolean | 继承全局 | 把流式记录写到 `/tmp/pi-agent-outputs/<agentId>.log`（frontmatter 优先）。 |
| `include_context_files` | boolean | 继承全局 | 把 AGENTS.md 作为 `<project_context>` 放进系统提示词。`true` 加载，`false` 不加载，不写则用全局的 “Include AGENTS.md” 设置。 |
| `include_system_prompt` | boolean | 继承全局 | 是否继承父会话的系统提示词。`true` 继承，`false` 替换模式，不写则用全局模式。全局模式为 `custom` 时，自定义提示词优先于 `true`。 |

frontmatter 没写 `tools`、且该类型没有显式的已注册工具集时，由配置 `loadToolsImplicitly`（默认开）决定：开启时交给 pi 处理，`defaultTools` 和普通会话一样生效，未激活的工具仍保持注册，供调度类工具按名字调用；关闭时这类子代理没有工具。显式 frontmatter 总是优先。

`tools` 和 `exclude_tools` 接受内置工具名（`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`）和扩展工具名（`codemode`、`web_search`）。用 `tavily/*` 或 `tavily/all` 表示某个扩展的全部工具。排除工具不会阻止扩展加载；要阻止加载用 `exclude_extensions: [tavily]`。

`loadSkillsImplicitly`、`loadExtensionsImplicitly`、`loadToolsImplicitly`（配置，默认开）分别决定 frontmatter 没写 `skills`、`extensions` 或工具字段时子代理拿到什么。三个开关互相独立：比如单独关掉隐式扩展来停止加载扩展，再在需要的子代理里显式开启。

内置扩展：子会话会加载 pi 内置的 codemode、tool-search 和 mcp 扩展（不含 llama.cpp），在 `defaultTools`、设置里的 `extensions` 和 frontmatter 里用裸名（如 `codemode`）引用，和普通会话一样。用户扩展注册同名工具、命令或参数时，会替换内置的。

子代理里用 codemode 需要两件事：加载 codemode 扩展，并激活 codemode 工具。默认设置下，在 `.pi/settings.json` 里写一行即可：

```json
{ "defaultTools": ["+codemode"] }
```

之后 frontmatter 没写 `tools` 的子代理都会和主会话一样启用 codemode。显式写了 `tools` 的子代理会忽略 `defaultTools`，需要把 `codemode` 加进列表。如果关闭了 `loadExtensionsImplicitly`，还要在 frontmatter 里写 `extensions: codemode`。

## Agent 参数

`Agent` 接受：

- `prompt`（必填）：任务内容。
- `description`：widget 上的短标签，默认取 prompt 第一行。
- `agent`：子代理类型，默认 `general-purpose`。
- `run_in_background`：立即返回，完成后通知父会话。
- `worktree_path`：磁盘上任意 git 仓库内的目录，相对路径以父会话工作目录为基准。见[工作树路径与信任](#工作树路径与信任)。

`model`、`thinking`、`max_turns`、`max_tokens` 由配置和 frontmatter 注入，模型不能传。设置一次即可。

子代理不能再启动子代理。

### 工作树路径与信任

`worktree_path` 可以是父仓库的关联工作树、它的主检出，或者完全不同的仓库。子代理以该目录为工作目录运行。

跨仓库目标受 pi 现有信任机制约束：采用目标已保存的信任决定（最近的上级目录优先），未决定时采用全局 `defaultProjectTrust`，除 “always” 以外都视为不信任。不受信任的目标仍会启动，但会忽略它的项目资源（`.pi/` 设置、扩展、技能、提示词、主题、系统提示词文件、`.agents/skills`），不发现它的 `.pi/agents` 类型，不加载它的 `.pi/subagents-lite.json`，并由 pi 给出警告。同仓库路径不受限制。`/agents` 的启动向导仍只列出同仓库的工作树。

## 模型解析

优先级从高到低：

1. 会话内按类型覆盖（`/agents` > Model settings）
2. 会话内全局默认
3. 配置文件按类型覆盖（`~/.pi/agent/subagents-lite.json`）
4. 配置文件全局默认
5. frontmatter `model`
6. 父会话模型

## 思考级别解析

优先级从高到低：

1. 启动时的选择（`/agents` 启动向导）
2. frontmatter `thinking`
3. pi 对所解析模型的单独设置（`modelThinkingLevels`）
4. 子代理默认思考级别（`defaultThinking`，项目优先于全局）
5. pi 自身默认（`defaultThinkingLevel`，否则 `medium`）

最后按模型支持的级别裁剪；不支持推理的模型只有 `off`。

frontmatter `thinking` 或子代理默认思考级别可以设为 `parent`，跟随父会话当前级别。解析发生在子代理启动前，所以每次运行都报告真实级别；没有父会话可读时，`parent` 视为未设置。

模型设置和启动向导会在括号里注明决定来源，例如 `high (frontmatter)`、`medium (pi default)`、`minimal (parent)`。`pi default` 表示这里没有配置，由 pi 自己决定；在启动向导里选它则不发送任何级别。

## 并发

`concurrency` 限制并行子代理数量，默认每个模型 4 个。按模型的限制优先于按 provider 的限制，后者优先于 `default`。超出的启动请求排队等待。

## 设置

全局设置在 `~/.pi/agent/subagents-lite.json`，可通过 `/agents` 管理，也可以直接编辑。

`/agents` 的设置包括模型覆盖、并发、子代理行为（回合限制、后台投递、看门狗、记录、工具 schema、Parent messages）、系统提示词模式，以及 widget 的布局和显示。

```
Settings

→ Model overrides                Set global default and per-type model overrides
  Concurrency limits              Set default, per-provider, and per-model limits
  Agent behavior                  Configure limits, delivery, watchdog, and tools
  System prompt                   Configure prompt mode, context, skills, and extensions
  Widget                          Configure layout, display, and stats
```

### 项目级配置

项目可以提交自己的 `.pi/subagents-lite.json`（与全局文件同名）。它是覆盖层，只能包含模型和并发设置（`agent.default`、按类型的模型覆盖、`concurrency`），写了的键覆盖全局值。其他设置（widget、看门狗、启动默认值）始终来自全局文件。每个键的生效值：会话覆盖 > 项目文件 > 全局文件 > 内置默认。

### 系统提示词模式

`systemPromptMode`（默认 `replace`）：

- `replace`：极简通用提示词加子代理自己的指令。成本最低，隔离最好。
- `inherit`：父会话的系统提示词加子代理指令。
- `custom`：`~/.pi/agent/subagents-lite-prompt.md` 加子代理指令。

`includeContextFiles` 为 `true`（默认）时，AGENTS.md 作为共享上下文放在子代理指令之前，有利于 KV 缓存前缀命中。

### 看门狗

看门狗会停止卡住的子代理。两项检查互相独立，默认都是 45 分钟，设为 `0` 关闭：

- `toolTimeoutMinutes`：单次工具调用超过这个时长就停止子代理。
- `idleTimeoutMinutes`：这么久没有任何活动（工具事件或流式回复文本）就停止子代理。

看门狗停止子代理时会通知主会话。

### 输出记录

输出记录默认关闭。全局用配置 `outputTranscript` 开启，单个子代理用 frontmatter `output_transcript` 开启。开启后记录流式写入 `/tmp/pi-agent-outputs/<agentId>.log`（只追加，可 `tail -f`），widget 会显示对应的 `tail -f` 命令。会话重载（`/reload`、扩展重载）后文件仍保留，但重载会停止运行中的子代理。

## 开发

```bash
npm ci
./node_modules/.bin/vp check      # 格式、lint、类型检查
./node_modules/.bin/vp test run   # 全部测试
```

开发约定见 [AGENTS.md](AGENTS.md)：每次提交前跑 `vp check` 和 `vp test run`，行为或文档变更要写进 `CHANGELOG.md` 的 Unreleased。

## 许可证

MIT。原作者 AlexParamonov，二开部分同样以 MIT 发布。
