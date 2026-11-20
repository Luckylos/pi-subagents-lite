# Subagent coordination

Terminology for coordinating subagent work and inspecting its conversations.

## Language

**Subagent**:
A child agent with an identity and conversation that can span multiple runs.
_Avoid_: run, task

**Subagent run**:
One independently identified execution of a Subagent, from its accepted initial or continuation request to its terminal outcome. A continuation is a new run of the same Subagent.
_Avoid_: agent lifetime, conversation

**Spawn target**:
The working directory selected for a new Subagent and the trust decision that governs its project resources.
_Avoid_: parent directory, agent type

**Restart**:
A request to create a new Subagent from a recorded Agent tool call.
_Avoid_: continuation, reopen

**Continuation**:
A request to start a new Subagent run within an existing Subagent conversation.
_Avoid_: new Subagent, reopened run

**Subagent run result**:
The terminal outcome and output of one Subagent run, with its statistics captured at settlement. Token and cost totals cover the Subagent through that run, and elapsed time covers that run alone.
_Avoid_: current agent state, latest result

**Completion notification (Nudge)**:
A message to the owning parent session reporting the result of a particular Subagent run.
_Avoid_: live status update, Parent message

**Completion notification receipt**:
Positive evidence that a completion notification has entered its owning parent conversation's history. It does not imply that the parent has acted on the result.
_Avoid_: send attempt, parent response

**Subagent stop request**:
A request to end a Subagent run, distinct from confirmation that the run has ended.
_Avoid_: stopped run, completed cancellation

**Settled Subagent run**:
A Subagent run whose execution and run-owned callbacks have finished.
_Avoid_: stop request accepted, final text received

**Subagent run settlement publication**:
The local handoff of a settled Subagent run's result that opens continuation admission for a reusable child session. The parent can record its completion notification receipt independently.
_Avoid_: completion notification receipt, stop request accepted

**Clear**:
An explicit request to remove a settled Subagent and its retained run history from the owning session.
_Avoid_: clear one run, stop

**ConversationViewer**:
A live, scrollable view of a subagent conversation, including its messages and tool calls. The Widget opens it in the editor area and the Running agents menu opens it as an overlay.
_Avoid_: ResultViewer, snapshot viewer
