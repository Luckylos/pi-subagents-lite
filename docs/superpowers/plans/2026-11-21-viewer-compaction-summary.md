# F6 Viewer Summary Plan

对应specs/2026-11-21-viewer-compaction-summary-design.md，既定政策最小实现。串行writer/main验收，无commit/worktree。

- [x] 读Viewer/直接render调用、publicSDK entry/context类型及既有cache/Thinking/入口测试，建立baseline。
- [x] SDK真实compactionSummary公开render先red，保留旧cache控制；覆盖替换/顺序/width/控制字符/无mutation/Thinkingtoggle。
- [x] 最小role分派和显示，复用现有render/sanitize，不改变history/cache生命周期。
- [x] targetViewer及入口tests、vpcheck、diff/保护hash/index；记录red/green。
- [x] main全量/check/独立复核、CHANGELOG/docs/最终diff及tmpcleanup。

Source仅conversation-viewer.ts；tests原Viewer或必要新增summary独立test。其它source/helpers只读，mainownsdocs。后续F7在F6通过后串行修改，不并行写同一文件。

验收完成：writer gateway中断后main核实原snapshot匹配baseline、red3fail2pass全部摘要缺失；实际source仅2行case。target4/105、full135/2578；新test格式问题仅定向fmt修复，check235format233lint/type。freshVerifier47b1e003 PASS，无finding：隔离settings读取后4/90＋4独立probe（width6–24/Unicode/空summary/latestcompaction/historyleaf/frozen/scroll收缩），281protectedhash/index稳定。首次既有入口tests尝试默认settings路径，未输出内容，不能声称该次满足no-userpath；隔离后复验通过，F7将永久隔离相关tests。F6未改branchSummary/SDK/cache/history。main/中断writer/Verifier任务tmp清理。
