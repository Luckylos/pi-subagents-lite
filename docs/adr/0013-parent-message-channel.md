---
status: accepted
---

# Parent message channel

A background Subagent may need its parent to know something before it settles: a blocking question, or a finding that changes the parent's plan. Until now the only parent-ward channel was the **Nudge**, which fires on settlement. We give a background Subagent one narrow upward channel: a `MessageParent` tool bound to its child session through the SDK's `customTools` at creation. It sends a one-way **Parent message** to the session a Nudge would reach, through the same owner-captured delivery path, and never accepts a recipient. A Subagent still never holds `MessageAgent`, `StopAgent` or `AgentStatus`, so cross-Subagent messaging and stopping stay unreachable.

## Considered options

- **Upstream v1.18.0 (rejected).** Upstream registers `MessageAgent` and `AgentStatus` inside the child by letting the child load this extension, passes the parent through a realm-global `AsyncLocalStorage`, treats an omitted `agent_id` as "message the parent", and silently promotes a foreground child to background. That reverses our child-load inertness (contract test "does not register its four tools…"), reintroduces cross-instance state that [ADR-0012](0012-instance-owned-extension-state.md) removed, lets a child see and address other agents, and overrides the requested run mode.
- **Blocking ask-and-wait (rejected).** A reply-waiting tool needs timeouts and handling for a parent that never answers or is replaced, and deadlocks a foreground child whose parent is blocked inside the Agent call. The parent answers a Parent message, if at all, with `MessageAgent`.
- **Prompt-section guidance (rejected).** Upstream appends usage guidance to every child's system prompt. The tool description alone carries when to use it, leaving prompts unchanged.

## Consequences

- Only background Subagents receive the tool, decided once at session creation; a foreground agent never gains it, even when later continued.
- Explicit frontmatter gates it like any other tool: an explicit `tools` or `registeredTools` list must name `MessageParent`, and `tools: false` or implicit tool loading OFF exclude it (verified against the real SDK in the child-session contract test). A global `agent.parentMessages` setting (default ON) disables it everywhere.
- Each **Subagent run** may send at most 5 Parent messages; a continuation starts a new count. The cap bounds how often a chatty child can wake the parent.
- Delivery matches a Nudge (`followUp` + `triggerTurn` when the parent is idle, `steer` while it runs) but is immediate rather than batched, so a Parent message sent before settlement always precedes that run's Nudge. When the owner is disposed or delivery fails, the tool reports "not delivered" to the Subagent instead of dropping silently.
