# Parent message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give background Subagents a `MessageParent` tool that sends a one-way Parent message to the session a Nudge would reach.

**Architecture:** A pure tool factory (`src/agents/parent-message.ts`) owns trimming, the per-run cap, and result text, and calls an injected `deliver`. `SpawnCoordinator` decides eligibility from the intent, builds the tool with a `deliver` bound to its own owner, and passes it down as `customTools` through `SpawnOptions` → `RunOptions` → `createAgentSession`. The per-run count keys on `record.execution.settlementCount`, so continuations reset it without touching the manager.

**Tech Stack:** TypeScript, typebox, pi SDK `ToolDefinition` / `customTools`, vite-plus test.

Design: [2026-11-03-parent-message-design.md](../specs/2026-11-03-parent-message-design.md). ADR: [0013](../../adr/0013-parent-message-channel.md).

Deviation from the design doc: `resetRun()` is replaced by a `runKey()` callback reading `settlementCount` (each continuation increments it), so the manager needs no new hook. The eligibility row for `registeredTools` is settled by Task 4's contract test.

---

### Task 1: Tool factory

**Files:** create `src/agents/parent-message.ts`, `test/agents/parent-message.test.ts`

- [x] Write failing tests: delivers trimmed text and returns "Delivered to the parent session."; blank/whitespace throws `message is required` and does not deliver; the 6th call within one run key throws the limit message and does not deliver; a new run key restores 5 calls; `deliver` returning false throws `Not delivered: the parent session is unavailable.` and does not consume the allowance (only delivered messages count).
- [x] Run `vp test run test/agents/parent-message.test.ts` → fails (module missing).
- [x] Implement:

```ts
export const PARENT_MESSAGE_TOOL_NAME = "MessageParent";
export const PARENT_MESSAGE_LIMIT = 5;
export function createParentMessageTool(opts: {
  deliver: (text: string) => boolean;
  runKey: () => number;
  limit?: number;
}): ToolDefinition
```

- [x] Run tests → pass.

### Task 2: Coordinator delivery and binding

**Files:** `src/spawn/spawn-preparation.ts` (`SpawnIntent.parentMessages?: boolean`), `src/spawn/spawn-coordinator.ts`, `src/agents/agent-manager.ts` (`SpawnOptions.customTools`), `test/spawn/spawn-coordinator.test.ts`

- [x] Failing tests in a new `describe("parent messages")`:
  - background + `parentMessages: true` → `options.customTools` has one tool named `MessageParent`
  - foreground + true, background + false/absent → no `customTools`
  - executing the tool with idle parent → `sendMessage` with `customType: "subagent-message"`, `display: true`, content `[Subagent "<type>" <8-char id> message]\n\n<text>`, details `{agentId,type,description}`, `{deliverAs:"followUp", triggerTurn:true}`
  - running parent → `deliverAs: "steer"`
  - disposed coordinator / no pi / `sendMessage` throws → tool throws "Not delivered…", no UI toast
  - delivery is immediate (no timer advance needed)
- [x] Implement `deliverParentMessage(agentId, text): boolean` with the `emitIndividualNudge` guards; strip `parentMessages` from the intent before spreading into `SpawnOptions`.
- [x] Run tests → pass.

### Task 3: Runner pass-through

**Files:** `src/agents/agent-runner.ts` (`RunOptions.customTools`, `sessionOpts.customTools`), `src/agents/agent-manager.ts` (forward to `runAgent`)

- [x] Failing test (manager or runner unit): `customTools` from spawn reach `createAgentSession`.
- [x] Implement; run → pass.

### Task 4: Real-SDK contract

**Files:** `test/contract/child-session.test.ts`

- [x] Tests with `customTools: [tool]` passed to `createChildSession`: present in registry+active for silent frontmatter; absent with `loadToolsImplicitly` OFF, `tools: false`, `tools: ["read"]`; present for `tools: ["read","MessageParent"]`; record the `registeredTools` outcome. Own four tools stay absent.
- [x] If the SDK behaves otherwise, stop and report before changing gating.

### Task 5: Config, menu, renderer, call sites

**Files:** `src/config/{types,config-io,config-validation,config-store}.ts`, `src/models/model-precedence.ts`, `src/ui/menu/menu-agent-settings.ts`, `src/agents/tool-execution.ts`, `src/ui/menu/menu-spawn-wizard.ts`, `src/registration.ts`, matching tests

- [x] Failing tests: default `parentMessages` true; persisted false read back; setter writes global layer; tool-execution and wizard pass `parentMessages: store.agent.parentMessages`; renderer registered for `subagent-message`.
- [x] Implement following the `outputTranscript` pattern; run → pass.

### Task 6: Docs and final verification

- [x] `CONTEXT.md` relationship line on Subagent tools; README tools section; CHANGELOG Unreleased/Added; ADR-0013 → `accepted`; design doc eligibility table updated with the Task 4 result.
- [x] Mutation check in a `/tmp` copy: drop the cap, drop the disposed guard, bind for foreground — each must fail a test.
- [x] `vp check` and `vp test run` pass. No commit until the user approves.
