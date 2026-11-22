# F6 Viewer SDK Compaction Summary

已确认审计政策：README承诺显示compaction摘要，只补真实SDK compactionSummary；branchSummary不在范围。

SDK消息shape为role:compactionSummary、summary、tokensBefore、timestamp，Viewer当前switch只render user/assistant，default忽略。既有compaction测试将摘要当assistant，只验证cache替换。最小方案在既有renderMessage分派增加该role，使用已有文本render/sanitize/wrap构件显示明确摘要label与summary；不把原始messages改写成assistant，不改变SDK/session/Runner/消息历史、Thinking toggle或分页/cache生命周期。无需新module/API/配置。

真实SDK package根没有导出createCompactionSummaryMessage；使用根公开CompactionEntry + sessionEntryToContextMessages或buildSessionContext构造真实messages。类型用真实AgentSession消息union narrowing；不要deep import或any。

验证：公共Viewer.render显示真实摘要一次，旧压缩消息消失、保留消息顺序、真实entry/context替换及cache失效；不同width/换行/controlchars安全显示、原summary不变、Thinking隐藏不隐藏摘要。现有assistant-cache测试保留，branchSummary仍原行为。仅src/ui/conversation-viewer.ts和test/ui/conversation-viewer.test.ts，必要新test/ui/conversation-viewer-summary.test.ts；main拥有CHANGELOG/spec/plan。

沿既定授权TDD、目标Viewer/入口测试、vpcheck、全量和独立验收。临时文件700清理，无真实用户资源/defaultoutputdir、HOME覆盖、网络/provider/install/Git写/版本/worktree。
