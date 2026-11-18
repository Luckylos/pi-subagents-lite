# Plugin Run Integrity Implementation Plan

> **For agentic workers:** Use the registered Fixer specialist for one bounded task at a time, then coordinator review; run independent verification after integration. Steps use checkbox syntax.

**Goal:** Fix cancellation, completion delivery, streaming display, and rejected Continue within this plugin.

**Architecture:** A Subagent retains its session while each accepted execution owns a distinct run and immutable terminal outcome. Public SDK adapters preserve cancellation intent, project conversation state, and observe parent history; unresolved host work remains visible rather than being treated as finished.

**Tech Stack:** TypeScript, installed pi SDK 1.5.2, Vite+ 1.3.0, Vitest.

**Spec:** `GLOSSARY.md`, `docs/adr/0014-run-ownership-and-sdk-cancellation.md`, `docs/adr/0015-observable-completion-delivery.md`, and the approved contracts below.

## Global Constraints

- Plugin only: no edits to CLI, pi-web, node_modules, installed plugin clone, dependencies or lockfiles; no installation, network, commit or push.
- Preserve all existing user changes, including display sanitization. Work serially in this checkout because required changes are uncommitted here; no parallel writers.
- Tool names and argument schemas remain compatible. `steer(id, message): Promise<boolean>` remains the compatibility adapter for boolean outcomes.
- Stop acceptance differs from settlement. Keep stopping work counted until it actually settles; the parent wait may finish independently. No private SDK fields, polling, or Promise.race that pretends work settled.
- Keep per-run outcomes until explicit Agent clear or owner end; do not duplicate the entire transcript.
- Notification receipt means observed entry in the captured parent session history. Unconfirmed submissions do not automatically retry; explicit retry warns about duplicate delivery/wake.
- Update CHANGELOG without claiming unimplemented behavior. Tests use real types and public rendering seams.

## Review Focus

1. Cancellation already requested before listener registration; deferred input/auth and callback self-deadlock (Task 1).
2. Ignored abort, delayed cleanup, and concurrency settings changing while a lease is active (Task 1).
3. Owner replacement with the same session ID, history branch changes, and send reentrancy (Task 2).
4. Stopping, settlement, and parallel tool completion while viewer remains open (Task 3).
5. Control-character sanitization of new status/rejection/notification display copies (all tasks).

## Task 1: Run ownership, truthful stop, and submission contract

**Files:** `src/types.ts`, `src/agents/agent-manager.ts`, `src/agents/session-run.ts`, directly connected lifecycle/concurrency helpers, and their tests. A focused new `src/agents/agent-run.ts` is allowed if it gives the run one owner.

**Interfaces:** Define and export `SubagentRun` and `AgentSubmissionResult` from the existing type boundary. `AgentManager.getRuns(id: string): readonly SubagentRun[]` exposes retained run history. `AgentManager.submitMessage(id: string, message: string): Promise<AgentSubmissionResult>` provides `accepted` plus acceptance delivery mode or a rejection reason/message; preserve `steer(id, message): Promise<boolean>` as an adapter. Stage 2 reads run identity and terminal snapshots; Stage 3 consumes structured submission results and phase.

- [x] Add failing regressions for pre-aborted signals and deferred input/auth canceled before actual execution; use the real SDK contract without network. Assert provider/tool invocations remain zero after preflight is released.
- [x] Add failing regressions for an abort-ignoring tool: stop returns to the parent, phase remains stopping, no continuation or replacement admission over the limit, eventual settlement releases exactly once. Include old callbacks attempting to mutate the next run and updated concurrency limits.
- [x] Run these tests and record the expected failures.
- [x] Implement independent run identity/controller/result/completion and centralized compatibility projections. Capture run identity in asynchronous callbacks. Keep existing first-run/continuation callback wiring.
- [x] Retain cancellation through preflight, including already-aborted signals; reapply at the public agent-start boundary without awaiting abort inside an awaited listener. Keep the subscription until real settlement. Do not wrap streamFunction unless authentication identity is demonstrably preserved.
- [x] Implement structured message admission and preserve the boolean adapter. Reject stopping/settling/unavailable/capacity cases without creating a new run.
- [x] Run lifecycle, stop, continuation, disposal, message, parent-message and concurrency regressions, then `vp check`; fix related failures without changing unrelated behavior.

The focused regressions reproduced preflight cancellation loss, premature terminal status, missing run ownership, and asynchronous steer failures. After correction, 810 tests across 53 related files passed. The coordinator independently reran 17 run lifecycle and real SDK cancellation tests. `vp check` and `git diff --check` passed.

## Task 2: Run snapshots and observable notification receipt

**Files:** `src/spawn/spawn-coordinator.ts`, `src/events.ts`, focused notification helper if needed, existing `/agents` detail/menu seam for explicit retry, and related tests.

**Interfaces:** Consume `getRuns` and the originating settled run snapshot. Coordinator exposes a readonly per-run notification state and explicit retry operation for the menu. A notification carries unique logical identity, run identity, captured owner generation/session and immutable result; retries keep the original outcome.

- [x] Add failing regression: settle run 1, continue before 200 ms, then assert notification still contains run 1 terminal status/result.
- [x] Cover send invocation without history receipt, synchronous reentrant observation, asynchronous failure without callback receipt, owner replacement/clear, and changed active branch.
- [x] Run and record expected failures.
- [x] Replace mutable-ID batching with per-run notification snapshots. Register state before calling the host. Confirm using public read-only history at appropriate post-insertion lifecycle boundaries; never confirm solely from message_end or a void return.
- [x] Keep unknown submissions unconfirmed, with no automatic retry. Add explicit retry through the existing management flow and warn that a retry can duplicate notification/wake. Keep result history independent from receipt.
- [x] Preserve foreground/background first-run rules and Parent message ordering. Owner teardown prevents new cross-generation submission/confirmation.
- [x] Run coordinator, owner/lifecycle, parent-message and affected menu tests, then `vp check`.

The red tests reproduced overwritten results and collapsed notifications when several runs settled inside the batching window. After implementation, 1,351 tests across 76 related files passed. The coordinator independently reran 57 coordinator and navigation tests. `vp check` and `git diff --check` passed.

## Task 3: SDK conversation projection and honest Continue feedback

**Files:** `src/ui/conversation-viewer.ts`, a focused conversation-state adapter if needed, `src/events.ts`, structured-message tool caller, display consumers of stopping phase, and related viewer/widget/tool tests.

**Interfaces:** Consume `AgentSubmissionResult`, run phase/history and notification state; keep existing visual hierarchy and controls. Viewer onSteer callback returns the structured outcome.

- [x] Correct the streaming fixture to match SDK 1.5.2: partial lives in streamingMessage, transcript gains it only at message_end. Add failing tests through render/handleInput/subscribe.
- [x] Assert text remains across block-end/message-end, opening mid-stream includes prior partial, aborted finalization has no duplicate content, and parallel tool state reconciles with later toolResult entries.
- [x] Add failing Continue test: capacity rejection keeps composer and exact input, shows a sanitized reason; accepted steer/continuation clears input.
- [x] Run and record expected failures.
- [x] Centralize SDK message/partial/tool-state projection; viewer holds view state without a conflicting transcript copy. Preserve existing sanitization and display widths.
- [x] Wire structured admission to viewer and tool response, and expose stopping consistently in existing widget/menu/status surfaces. Retained run outcomes and explicit notification retry are reachable through existing management flow.
- [x] Run viewer, streaming, widget, renderer, menu, terminal-display and message-tool tests, then `vp check`.

Viewer, composer, and stopping red regressions: 11 expected failures across five files, plus a separate foreground Stop failure. The scoped suite passed 1,025 tests across 43 files. A real SDK regression also reproduced a deferred turn-limit steer outliving its prompt; after waiting for it and clearing the SDK queue before continuation, 25 focused SDK and manager tests passed.

## Task 4: Integrated verification

- [x] Inspect the implementation diff against the refreshed baseline. Both checkout HEADs and the installed copy’s worktree fingerprint are unchanged. Of 22 saved terminal-display files, 16 are byte-identical; the six overlaps retain display sanitization before layout. The 51 focused display tests include retry warnings at 40, 80, and 120 columns.
- [x] Run `./node_modules/.bin/vp check` and `./node_modules/.bin/vp test run`; baseline was 114 files / 2135 tests. Probe changed TypeScript paths with active LSP diagnostics where available. The final suite passed all 2,204 tests across 117 files. `vp check` reported no formatting, lint, or type issues. Active LSP reported no diagnostics across 57 TypeScript paths in the first pass, eight after the first correction, and six after queue cleanup and the fixture update.
- [x] Complete independent review of lifecycle, delivery receipts, viewer SDK timing, owner isolation, and sanitization. The final follow-up passed all 49 focused tests in four files and verified cleanup failure with an offline probe against SDK 1.5.2.
- [x] Update CHANGELOG and record verification. Host integration remains untested. A stop request depends on SDK and operation settlement. A notification receipt confirms an entry in parent history. Explicit retry can deliver or wake twice.

First independent review: 858 focused tests across 33 files passed, but two installed-SDK probes reproduced material failures. While a completed SDK prompt was awaiting turn-limit input cleanup, Steer could be accepted even though the queue would be cleared. A foreground tool call row cached `stopping` after actual settlement because it did not register a row invalidation. The regression tests reproduced three failures. After correction, both files passed all 11 tests, and the related manager, SDK, registration, and UI suite passed 616 tests across 36 files. A fresh independent follow-up passed both corrected scenarios using SDK 1.5.2 and passed all 138 focused tests, but found that a Steer queued before Stop survived into Continue. Settlement now clears remaining SDK steering and follow-up input after in-flight callbacks finish and before releasing capacity or exposing Continue. A cleanup failure preserves the result and releases the lease while making the session ineligible for continuation. The SDK regression failed before the change and passed afterward. The related suite passed 413 tests in 27 files. The first full rerun exposed three notification tests using an SDK fixture without `clearQueue()`. Adding the typed public method to the fixture restored all 16 notification tests without changing their assertions.
