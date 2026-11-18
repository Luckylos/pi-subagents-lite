# Subagent coordination

Terminology for coordinating subagent work and inspecting its conversations.

## Language

**Subagent**:
A child agent with an identity and conversation that can span multiple runs.
_Avoid_: run, task

**Subagent run**:
One independently identified execution of a Subagent, from its accepted initial or continuation request to its terminal outcome. A continuation is a new run of the same Subagent.
_Avoid_: agent lifetime, conversation

**Continuation**:
A request to start a new Subagent run within an existing Subagent conversation.
_Avoid_: new Subagent, reopened run

**Subagent run result**:
The terminal outcome and output of one Subagent run, distinct from the Subagent's current activity.
_Avoid_: current agent state, latest result

**Completion notification (Nudge)**:
A message to the parent reporting the terminal outcome of a particular Subagent run.
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

**ConversationViewer overlay**:
A live, scrollable view of a subagent conversation, including its messages and tool calls.
_Avoid_: ResultViewer, snapshot viewer
