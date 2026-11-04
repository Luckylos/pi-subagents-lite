# Parent message — design

Status: approved and implemented. Decisions recorded in [ADR-0013](../../adr/0013-parent-message-channel.md); glossary term **Parent message** in `CONTEXT.md`.

## Behavior

A background Subagent gets a `MessageParent` tool with one parameter, `message` (string, required, non-blank after trim).

| Situation | Tool result to the Subagent | Parent session |
|---|---|---|
| Delivered | `Delivered to the parent session.` | Visible `subagent-message`; wakes it when idle |
| Blank message | error `message is required` | nothing |
| 6th call in one Subagent run | error `Parent message limit (5) reached for this run; put the rest in your final answer.` | nothing |
| Owner disposed, no API, or `sendMessage` throws | error `Not delivered: the parent session is unavailable.` | nothing |

Parent session message:

- `customType: "subagent-message"`, `display: true`
- content: `[Subagent "<type>" <8-char id> message]\n\n<message>`
- details: `{ agentId, type, description }` only (no stats, so it never looks like a result card)
- delivery: `deliverAs: parentIdle ? "followUp" : "steer"`, `triggerTurn: true`; not batched

Tool description (the only usage guidance; system prompts are unchanged):

> Send a short message to the parent agent while you keep working. Use it only for what the parent needs before you finish, such as a blocking question or a finding that changes its plan. You do not get a reply here; the parent may answer with a new message to you. Your final answer is delivered automatically, so never repeat it with this tool.

## Eligibility

The tool is bound when all hold at spawn: the spawn is background (`run_in_background` or `forceBackground`), and `agent.parentMessages` is ON. Frontmatter then gates it through the existing `resolveSessionToolOptions` paths with no new branch:

| Frontmatter | Has `MessageParent` |
|---|---|
| silent, implicit tool loading ON | yes |
| silent, implicit tool loading OFF (`noTools: "all"`) | no |
| `tools: true` | yes |
| `tools: [..., "MessageParent"]` | yes |
| `tools: [...]` without it / `tools: false` | no |
| `registeredTools: [...]` without it | no |
| `registeredTools: [..., "MessageParent"]` | yes |

## Structure

- `src/agents/parent-message.ts` (new): `createParentMessageTool({ deliver, runKey, limit? })` returns a `ToolDefinition`. Pure apart from the injected `deliver(text) => boolean`; owns trimming, the per-run cap, and result text. `runKey` reads the record's `settlementCount`, so a continuation restores the allowance without a manager hook (replaces the earlier `resetRun()` idea).
- `SpawnCoordinator.deliverParentMessage(agentId, text): boolean`: same guards as `emitIndividualNudge` (`disposed`, record lookup, idle check) but returns false instead of falling back to a UI toast. `getPiInstance` always returns the owner's API, so there is no null-API branch.
- Spawn path: callers put `parentMessages: store.agent.parentMessages` on the intent; when the spawn is background and that flag is set, the coordinator creates the tool and passes it as `SpawnOptions.customTools` → `RunOptions.customTools` → `createAgentSession({ customTools })`.
- Config: `agent.parentMessages` (boolean, default true) in `config-io` defaults, `CONFIG_AGENT_NON_MODEL_KEYS`, `ConfigStore`, and an ON/OFF row in `menu-agent-settings`.
- Rendering: `pi.registerMessageRenderer("subagent-message", …)` in `registration.ts`, a compact header plus the message text.
- Docs: `CONTEXT.md` relationship line 144 becomes "A **Subagent** never holds **MessageAgent**, `StopAgent` or `AgentStatus`; its only parent-ward tool is `MessageParent`"; README tool section; CHANGELOG Unreleased/Added; ADR-0013 status → accepted.

## Tests (written first)

1. `test/agents/parent-message.test.ts` (unit): delivers trimmed text; rejects blank; 6th call errors and does not deliver; `resetRun()` restores the allowance; `deliver` returning false yields "Not delivered".
2. `test/spawn/spawn-coordinator.test.ts`: idle parent → `followUp` + `triggerTurn`; running parent → `steer`; disposed coordinator → false and no send; `sendMessage` throws → false and no toast; content/details shape.
3. Eligibility: background + ON binds the tool; foreground, OFF, and `forceBackground` cases.
4. `test/agents/agent-manager-steer-continuation.test.ts`: a continuation resets the count.
5. `test/contract/child-session.test.ts` (real SDK): `MessageParent` present in registry and active set for silent frontmatter; absent for `tools: false`, for a list without it, and with implicit loading OFF; present for a list naming it; the four own tools stay absent; and the `registeredTools` row.
6. Instance isolation: two owners, a child of owner A delivers only through A's API.

Each new test must fail before the code exists; a mutation check (drop the cap, drop the disposed guard, bind for foreground) must fail at least one test.

## Resolved checks

- **`registeredTools`**: excluded unless listed, kept as is (it is an explicit list). Verified by the child-session contract test.
- The pinned SDK's `tools` allowlist filters `customTools` by name; verified by the same contract test.

## Out of scope

Replies or blocking waits, child-to-child messaging, foreground eligibility, a configurable cap, upstream's mouse-wheel commit (separate decision).
