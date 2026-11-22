# F5 Model Clear Recovery Plan

设计：对应specs/2026-11-21-model-clear-recovery-design.md。按已确认partialClear政策与继续授权执行；主代理维护文档，单Fixer串行TDD。

- [x] 读取menu、直接调用的target/model/confirm/wrapper、Store Clear和直接测试，建立baseline。
- [x] 用真实SettingsList公开input先复现单项/default/Clearall的完整失败与partial失败；保留既有值保护断言并核对完整菜单数组/clear层级/重试。
- [x] 最小修复menu回调catch/errorMessage/errornotify，复用现有completion/rebuild，无Store/sharedcomponent改动。
- [x] strict-offline定向菜单与StoreIO验证、vpcheck、保护hash/diff/index；记录真red/green与实际行为。
- [x] 主代理核对实际diff、fresh独立复核、全量/check、CHANGELOG/最终文档/临时文件清理。

生产scope仅src/ui/menu/menu-model-settings.ts；测试test/ui/menu/menu-model-settings-inplace.test.ts和menu-model-settings.test.ts，必要新增独立test/ui/menu/menu-model-clear-recovery.test.ts。其它源码/共享helpers只读。无Git写/版本/install/network/provider/worktree；tmp700，禁止overrideHOME/真实用户资源/defaultoutputdir访问。

验收：true-red8fail/8pass→inplace16pass；writer11files272target；main134files2573full、check234format232lint/type；freshVerifier20d3e99b PASS无发现，自选11files273＋2files23复跑＋独立6realOS ENOTDIR公开input探针。default/pertype/clearall×global/project失败，原文件字节/partial保留/Project-only层级/同菜单retry/非模型设置/无tmp残留全部通过。探针首轮错误要求cursor不变，改为完整行内容后6/6；不算产品失败。未做fullhostexit。279writer保护hash、main/Verifier278保护hash（另CHANGELOG），HEAD/index保持。所有任务tmp/fixtures清理。
