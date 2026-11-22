# 交付审计修复计划

目标是让类型模型操作只影响所选配置、关闭操作等待已接纳的 run，并落实信任、日志和测试夹具的边界。验收通过真实菜单输入、真实文件、SDK 1.0.3 的持久化设置与子会话，以及独立控制的 run 完成信号。实现采用现有 TypeScript、Node、Vitest 和 Vite+。执行时可按任务逐个使用 executing-plans 或 subagent-driven-development。

基线是 1.17.5（dfdb021）加上待交付的 61 个改动路径。审计时全量为 136 个文件、2589 项通过。此次编制计划时在 Linux 独立重跑下方 11 个文件，195 项通过。这些数字记录修复前的对照组。以下复选框均属于实施阶段。

## 1. 防止模型操作误删行为设置

- [x] 在 `test/config/config-validation-io.test.ts` 创建真实全局文件，写入 `systemPromptMode: "custom"`、一个正常类型的模型和其他行为设置。注册同名类型，通过 `test/ui/menu/menu-model-settings-inplace.test.ts` 的公开菜单输入尝试设置及清除。断言行为设置和其他键保留。补测从未设置和显式设置过的 `toString`，分别断言列表、胜出来源、可清除层级和清除后的状态。先观察错误的删除或成员判断。
- [x] 在 `src/config/agent-settings.ts` 复用已有已知键表，明确区分动态类型键、专用 default 入口及其他内建字段。现有 `isAgentModelKey` 表示整个模型配置家族，含 Thinking 等键，不能单独作为类型模型的写许可。建议在现有平面文件格式下保留内建键的含义，重名角色仍可显式调用、使用 frontmatter 模型。凡无法独立表示的持久化层级，在菜单中不给出此操作，直接写入口也要保护。单独核对 session 的独立命名空间以及名为 default 的角色，避免误伤普通 session 覆盖。
- [x] 贯通 `src/config/config-store.ts` 的原始成员、描述、set/clear、全层清除，`src/models/model-precedence.ts` 的实际 Spawn 读取及 `src/ui/menu/menu-model-settings.ts` 的可选操作。逐键读取使用自身属性判定，兼容适配器消费同一规则。用真实 Store 验证普通、未知、空值和被遮蔽的覆盖仍可按层清除，默认、Thinking、maxTurns 的专用入口仍能工作。对拒绝的单层操作比较原文件字节。

## 2. 等待排队启动中的实际 run 结算

- [x] 在 `test/agents/agent-manager-concurrency.test.ts` 为两个 run 提供独立的 deferred。第二个排队 run 的 onStart 同步调用 dispose；只完成第一个，等其完成和回调运行后，断言第二个 run 的 completion 与 dispose 均仍 pending。再完成第二个，断言 finalize、结算、teardown 和 dispose 的先后顺序。第一次运行预期暴露提前返回。
- [x] 在 `src/agents/agent-manager.ts` 把已接纳 run 的完成信号在可重入回调前纳入 Manager 的关闭等待。优先复用 run 已有 completion，并核对它是否覆盖实际执行及清理的整个窗口。信号若过早，追踪实际 settlement chain 完成；启动同步抛错时也要结束这次追踪。只给 dispose 增加遍历循环不能覆盖首次枚举时尚未登记的工作。
- [x] 运行 Manager 并发、disposal、RunCapacity 和 SDK model-capacity 测试。覆盖立即启动失败、排队失败、startup 等待中 Stop、回调重入与队列关闭，核对 release、notify、drain、publish 的既定顺序及计数。

## 3. 对部分 Clear 提供可重试的准确反馈

- [x] 在 `test/ui/menu/menu-model-settings-inplace.test.ts` 用公开输入打开 All levels 确认，随后把原先可读的项目文件写为坏 JSON，再确认。分别覆盖单类型和 Clear-all。断言只有一条说明 Global 已成功且 Project 未完成的错误，项目坏文件逐字保留，Global 的成功保留，当前菜单刷新。恢复有效项目文件后从同一菜单重试。
- [x] 在 `src/config/config-store.ts` 的 clearAtTarget 保存操作开始时要处理的层级，根据 ConfigIO 写后返回的最新 projectStatus 区分 malformed、absent、untrusted 与 loaded。对仍待清除而受保护的文件明确报告部分完成；文件已删除、开始时只有 Global，以及第一次写 Global 就失败，各设对照。复用原子逐文件写入和现有菜单错误反馈。若恢复文件后 Store 仍只见过期状态，补公开重读接线并验证重试。

## 4. 用全局设置读取跨仓信任默认值

- [x] 在 `test/spawn/project-context-trust.test.ts` 构造无已存决定、目标有资源、父项目未信任的场景。用自有 agentDir、父和目标目录，观察 SDK 实际文件读取。全局默认查找对父项目 settings 正文的读取次数应为零，并用已知夹具读取作为计数器阳性对照。
- [x] 在 `src/spawn/project-trust.ts` 的 getDefaultProjectTrust 使用 SDK 全局设置来源。当前 SDK 可显式传 `{ projectTrusted: false }` 跳过 project storage。检验全局 always、never、ask 和已存项目决定；比较 `test/contract/sdk-project-context-trust.test.ts` 的真实 child session 接收的上下文。

## 5. 保证成功初始化的日志具有 0600 权限

- [x] 在 `test/agents/output-file-privacy.test.ts` 的独立进程设置 `umask 0200`，调用生产初始化函数，通过 fstat 验证实际 0600。在允许的普通 UID 环境，用自己的合成数据验证追加到 [DONE]。特权运行只算 mode 和 FD 证据，既有用户日志不作为夹具。
- [x] 在 `src/agents/output-file.ts` 初始化已独占打开的同一 FD 上验证对象身份、设置 0600、复验，再写首条记录。权限调整失败须在返回成功路径前报错，并保证关闭 FD。保留对已存在文件、链接、设备和不安全目录的保护，以及追加时的对象身份检查。
- [x] 更新 `README.md` 的 output_transcript 设置表与使用段落，写明启用条件、初始化失败会导致本次 Spawn 启动失败、关闭记录时的行为。对照真实 Manager 启动顺序，检查包中 README 可独立说明限制。

## 6. 使真实 SDK 测试在开发机上只读取自有资源

- [x] 在 `test/contract/sdk-model-capacity.test.ts` 的 setup 中隔离与容量无关的隐式技能、祖先上下文及用户资源发现。用自有祖先指令和技能文件作标记，观测 SDK 实际使用的读取接口，区分目录探测与正文读取。即使在外层 mount 隔离中，测试也应能捕捉对模拟宿主标记的意外读取。保留真实容量调和、resume 抛错、teardown 与离线测试模型。
- [x] 在 `test/pi-settings.test.ts` 用原子 mkdtemp 创建专属 0700 目录并实际断言 mode，保持 SDK agentDir 指向该夹具。优先局部替换，只有查到更多相同约束的调用方才改共享 `test/fixtures.ts`。用常见 umask 022 验证，避免仅因外层使用 077 而通过。
- [x] 本任务可提前与配置修复并行准备。第 2 项的真实 SDK 验收在本任务完成后再跑一次。两个任务对 `sdk-model-capacity.test.ts` 的写入串行执行。

## 7. 大摘要与面向用户的说明

- [x] 在 `test/ui/conversation-viewer-summary.test.ts` 用公开 SDK 消息投影和真实 Viewer 构造多行长摘要。用公开 render/input 检查首尾可达、保留消息顺序、窄视口及重复渲染。先观察分页前异常。修复 `src/ui/conversation-viewer.ts` 中把整段缓存展开为函数实参的位置，逐行汇合缓存即可；保留已有截取和滚动语义。
- [x] 在 `src/ui/menu/menu-model-settings.ts` 更正全局默认模型的帮助文字，通过菜单展示和 resolver 测试验证配置默认模型优先于 frontmatter。在 `GLOSSARY.md` 明确 hidden 对 Spawn 类型选择和显式调用的含义，保留 Model Settings 中配置隐藏角色的既有入口。对照 Spawn 向导与模型选择器实际呈现的类型。
- [x] 在 `CHANGELOG.md` 的 Unreleased 记录实际修复结果。

## 验证命令与交付条件

以下 Bash 函数适用于本次具有 mount namespace 权限的 Linux 环境。在仓库根目录定义后执行。临时文件系统随命名空间退出而释放，Vite+ 使用原来的 HOME。

```bash
repair_tests() {
  unshare -mn --propagation private bash -s -- "$@" <<'RUN'
set -eu
for d in /root/.pi /root/.agents /.pi /.agents; do
  if test -d "$d"; then mount -t tmpfs -o mode=700 tmpfs "$d"; fi
done
for f in /AGENTS.override.md /AGENTS.md /AGENTS.MD /CLAUDE.md /CLAUDE.MD; do
  if test -f "$f"; then mount --bind /dev/null "$f"; fi
done
mount -t tmpfs -o mode=1777,size=1G tmpfs /tmp
umask 077
fixture=$(mktemp -d /tmp/pi-repair.XXXXXXXX)
mkdir "$fixture/agent" "$fixture/temp"
export PI_CODING_AGENT_DIR="$fixture/agent" TMPDIR="$fixture/temp" PI_OFFLINE=1 NODE_OPTIONS=--unhandled-rejections=strict
. /root/.config/vite-plus/env
vp test run --cache=false "$@"
RUN
}
```

本轮已运行的定向基线命令如下。

```bash
repair_tests \
  test/config/config-validation-io.test.ts \
  test/models/model-precedence.test.ts \
  test/ui/menu/menu-model-settings-inplace.test.ts \
  test/agents/agent-manager-concurrency.test.ts \
  test/agents/agent-manager-disposal.test.ts \
  test/contract/sdk-model-capacity.test.ts \
  test/spawn/project-context-trust.test.ts \
  test/contract/sdk-project-context-trust.test.ts \
  test/agents/output-file-privacy.test.ts \
  test/pi-settings.test.ts \
  test/ui/conversation-viewer-summary.test.ts
```

- [x] 每次先保留能解释失败的 red，再做最小修复并运行该任务定向用例。门槛是旧问题用例转绿、阳性对照仍能发现错误。计数、顺序和文件内容均通过公开接口断言。
- [x] 执行 `repair_tests` 跑隔离全量，再执行 `. /root/.config/vite-plus/env`、`vp check`、`git diff --check`。按清单核对新增文件并离线 dry-pack 确认源码模块及 README 入包。
- [x] 独立复核原审计的 5 项行为阻塞、3 项夹具与文档门槛、4 项其他发现。每项列出真实用例、源码位置与结果；普通 UID、最低 peer、Windows 仅按实际运行环境报告覆盖。集成结论以全部阻塞项的复验结果为准。

## 实施与复核结果

- 原有 12 项发现均已处理。配置回归覆盖内建键同名角色、独立 Session 模型、继承属性、兼容适配器、公开菜单及真实项目文件恢复。
- 独立复核额外复现了只有 Session 和 Project 时的两条问题。确认前删除文件会使菜单停留在旧状态，嵌套结构损坏的文件可能被替换。修正后，Store 刷新缺失状态，ConfigIO 在项目加载、更新与保存时采用同一结构校验。新增八条菜单和文件回归全部通过。最终复核覆盖 55 项定向测试。
- 两个独立 run 的回归验证了关闭等待到实际结算和 teardown。真实 UID/GID 65534、umask 0200 下实测日志权限为 0600，最后一条 [DONE] 成功追加。16 万行摘要通过公开按键在窄视口可达首尾。
- 真实 SDK 读取探针包含阳性对照。全局信任默认值查询对父项目 settings 正文的读取计数为零，容量测试可观测合成技能和祖先指令的隐式加载开关。该部分独立复核 48 项通过。
- 最终 Linux / SDK 1.0.3 隔离全量 136 个文件、2618 项通过。Vite+ 格式检查 236 个文件，lint 和类型检查 234 个文件，通过。离线打包预演包含全部 81 个源码文件及 README，共 84 个文件。
- 项目文件保护覆盖最终复读观察到的损坏或删除。复读与原子替换是两个系统调用，二者之间的跨进程竞争仍依 ADR-0012 的并发约定处理。
