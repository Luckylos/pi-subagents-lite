# F7 Parent Thinking Visibility Plan

依据对应specs/2026-11-21-viewer-thinking-scope-design.md，执行已定持久化父scope政策；F6验收后串行写同一Viewer。

- [x] 读取pi-settings/Viewer/opener/两个父入口、SDKpublicsettings/trust/context及对应测试，保存F6acceptedbaseline。
- [x] 真SDK/FS settings与公开父入口先red：customagentDir、父projectfalse/globaltrue、untrusted零projectbodyread、父/target相反、bad/missingJSON、CtrlT局部；已有controls保持。
- [x] 最小可选scope与初始布尔值传递，生产父cwd/trust明确，getHideThinkingBlock复用settingsFor，readPiSettings保API且用getAgentDir。
- [x] 定向settings/Viewer/navigation/openers/instance tests与vpcheck、保护hash/API/index，旧ctx共享helper无需改动。
- [x] Main全量/check、fresh独立scope验收、docs/CHANGELOG/最终diff与cleanup。

scope和禁止操作遵循设计，main ownsdocs，单writer。没有runtimeoverride镜像/effort变化/新全局owner/新module；F6摘要及F1–F5两候选保持。

## 完成证据

- fixer `a1ddaf2c-f696-456` 因 gateway concurrency limit 终止，baseline 核对确认无改动；Main 接管唯一 writer。
- 安全 guarded settings red：3 failed / 1 control passed；公共入口 red：3 failed / 49 controls passed；最小实现后 3 files / 56 tests passed。
- 扩展真实 opener/局部状态/公开 snapshot/conversation/兼容构造测试后，定向 8 files / 153 tests passed；补全双向 untrusted cases 后最终隔离全量 **136 files / 2589 tests passed**。
- 最终 `vp check`：**236 formatted / 234 lint and type checked**；`git diff --check` 通过。运行使用 `unshare -n`、`PI_OFFLINE=1`、strict unhandled rejections 和专属 0700 `PI_CODING_AGENT_DIR`，不覆盖 HOME。
- 初始未隔离的 red 读取默认 settings，是执行偏差，不作为 no-userpath 证据；敏感原日志未再次读取即删除。初期 module mock 没有拦到外部化 SDK 的 fs，parentReads 断言失败；修正 typed builtin default spy 和 named export 同步后，真实 SDK/FS reads 可观测，最终 untrusted 项目读取和越界读取均为零。
- 新鲜 verifier **2494add2-2875-495 PASS / no findings**：独立 10 files / 229 tests passed；真实 SDK FileSettingsStorage 与公开 render/input 探针完成 **202 assertions / 27 Viewers**，覆盖双向优先级、custom agentDir、父/目标相反、两入口、开时读取、Ctrl+T 不写盘和新实例隔离。越界/目标 settings/runtime-settings/provider 调用均为零。
- Viewer 的 F7 差异可精确反向重建到 F6 baseline hash；summary/cache/消息处理/Stop/Steer 未变。原 getter/opener/constructor 调用形式保留。
- 最终 274 个受保护 baseline 文件稳定，233 个 source/test 验证指纹匹配；仅获准 F7 源码/测试/文档差异及新增 visibility test。前序 Model、RunCapacity、trust、hidden、IO、Clear 边界未改写。
- README/CONTEXT 的项目 model-family、模型优先级和 Grace turns 文档已按实现核对；CHANGELOG 包含 F1–F7 与两个架构候选。`src/index.ts`、package/lock 保持 HEAD，版本 **1.17.5**；HEAD/index hash 不变，无 staging/commit/push。
- LSP 不足以声明所有路径 clean；`events.ts` 两处辅助 cast 规则发现与 HEAD 文本一致，非新引入；三处路径未确认 clean。编译/lint/tests 独立通过。
- Main 与 verifier 的专属 fixture/probe/loader/log/hostagent 目录均已清理；误置顶层 handle 已删除。历史 artifacts/worktrees 保留。
- 结论限 SDK 1.0.3/Linux；minimum peer、Windows、未持久化宿主 runtime visibility、真实交互宿主退出不在已验证范围。
