# F3 Output Transcript Privacy — Short Design

状态：用户已确认建议 A；F3 的 TDD 修复、全量检查与 fresh 独立验收已完成，证据见对应执行计划。F1、F2 和两个架构候选保持已验收状态。

## 问题与目标

`src/agents/output-file.ts` 的 `createOutputFilePath` 仅在新建目录时请求0700；既有0755/0777目录保持宽权限，目录symlink被跟随。`writeInitialEntry` 普通writeFile默认受umask影响，umask022时含完整prompt的日志为0644，且已有文件会被截断；`safeAppend` 也跟随文件symlink并可能创建新文件。

目标：Output transcript开启时，日志落入当前用户拥有的私有真实目录，日志本身私有；创建与后续写入均不得借symlink覆盖其它文件。保留现有日志路径、文本格式、tail -f、Thinking缓冲与AgentRun/实际settlement所有权。默认仍不开启日志。

## 选择与建议

**建议A：保留路径，在现有output-file模块落实私有创建和安全追加。** 默认仍为 `/tmp/pi-agent-outputs/<agentId>.log`，baseDir测试入口保留。对当前用户拥有的既有目录收紧到0700；对symlink、非目录、他人拥有的目录拒绝写入。初始日志以0600独占创建，已有普通文件、hardlink、symlink、dangling symlink均拒绝且保持原内容/权限。追加只打开已存在的私有普通文件，不跟随symlink，不以普通append隐式新建。

B：改为按UID或每实例新建输出目录。可绕开他人预先占用默认目录，但会改变公开输出路径、共享/查找方式及清理责任；此次缺陷不需要新目录配置或生命周期。

建议选择A。若默认路径已被他人占用，明确报错沿用原有日志初始化失败通道，不接管该目录，不静默关闭日志或选择其它路径。

## 边界与职责

- `output-file.ts` 继续同时承担路径准备、日志写入和stream事件格式化，无新module/配置/全局状态。既有exports和构造参数兼容；Manager继续拥有构造、attach和实际settlement时finalize。
- 最终日志目录必须是真实目录；POSIX下核对当前UID并在确认所有权后收紧到0700，验证真实打开对象，避免对symlink目标或他人目录chmod。拒绝风险对象优先于修改它。
- 初始文件使用exclusive create及明确0600。不得通过先exists再普通write实现保护。成功创建后才写prompt；初始化错误沿用原startup failure/清理通道。
- append以既有文件为前提，拒绝symlink、非普通文件、他人对象或权限变宽的文件；打开后的实际文件核对与写入要作用在同一对象上。不把lstat检查后普通pathname写入当作竞态保护。适用平台使用内核no-follow/exclusive能力。
- `safeAppend`继续best effort：不安全或不可写时跳过该次追加、不影响session/run；不得为恢复日志重新创建可能暴露内容的文件。保留原有finalize、buffer flush、DONE和unsubscribe顺序。
- 保护范围是输出目录和日志文件，非完整文件系统sandbox；不承诺防御同UID进程任意更换祖先目录或修改已打开文件。缺少 POSIX UID 或有效 NOFOLLOW/DIRECTORY/NONBLOCK 能力的平台，初始化必须在任何 FS 修改前明确抛出不支持私有日志的错误，append 仍 best-effort 跳过。不能用未生效的 flag 声称保证；Windows 本次不提供私有日志能力，尚未做真实 Windows 运行验证。此 fail-closed 处理落实已批准的保护要求，不改默认关闭日志的行为。

## 验证与范围

预期source只改 `src/agents/output-file.ts`；新增真实FS privacy测试优先独立文件，必要的既有output/mock测试适配必须先列明理由，不动Manager/run生命周期。主代理独占CHANGELOG/spec/plan。

TDD回归使用专属mktemp0700目录及其子目录，绝不探测真实 `/tmp/pi-agent-outputs` 或用户prompt/config/log。

1. 新目录0700、新日志0600；在umask022及已有0755/0777目录下验证真实mode、prompt内容与tail式追加。若修改umask必须恢复，不影响其它并发测试。
2. 当前用户目录可收紧且内容保留；目录symlink、文件占位、外部owner（真实FS无法安全制造时用明确边界mock）拒绝，symlink目标bytes/mode/inode不变。
3. 初始路径已有普通文件/hardlink/symlink/dangling symlink全部拒绝，非截断；不创建dangling目标。
4. 初始化之后换成symlink、删除文件或放入权限变宽对象时，stream/finalize不写其它目标、不隐式创建文件；正常TOOL/ASSISTANT/Thinking/USER/DONE格式与buffer/unsubscribe仍通过。
5. Manager启用/未启用transcript及构造失败/实际settlement现有测试通过；不增加第二个日志或run生命周期owner。
6. strict-offline定向与全量tests、vp check、diff/基线hash/index、fresh独立realFS验收；不执行跨UID真实正文读取、不安装、不联网、不真实provider，不执行Git写/版本/发布操作。清理所有任务自建tmp。

与ADR-0014既有run/settlement所有权兼容；此次是保护既有私有日志契约，不新增ADR。已按writing-plans执行计划完成TDD及验收。
