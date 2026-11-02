# Instance-owned Extension State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Keep each parent extension instance's state, subagents, and notifications independent when pi invokes extension factories repeatedly in one process.

**Architecture:** Retain the existing composition root, but create it per factory and inject its owner into every stateful callback and service. Give child loading a narrow async-context marker at the child loader's entry points. Make each ConfigStore save an explicit mutation against a fresh persisted layer.

**Tech Stack:** TypeScript, Node AsyncLocalStorage, existing pi SDK, Vite+ 1.3.0 / Vitest; no new runtime dependency.

**Spec:** [ADR-0012](../../adr/0012-instance-owned-extension-state.md), accepted interview decisions Q1–Q12, and the Extension instance term in CONTEXT.md.

## Global Constraints

- Work directly on fork main above 69e710579d60797f04b180c260218ebe974641e7. Preserve existing changes; coordinator owns commits and push, with no force push or new upstream PR.
- Keep coding-agent >=0.99.0, pi-ai/pi-tui >=0.82.0, typebox >=1.3.7, and the documented Node runtime >=22.19.0. Do not upgrade dependencies or change the lockfile to solve this refactor.
- Parent instances have independent queues and configured concurrency limits. Two limits of 4 can permit 8 total children.
- Before its own session_start an instance may register tools, events and renderers, but does not scan agents, create session services/timers, write config, or dispose another instance.
- Ordinary new/reload behavior remains, scoped to its owner. Unbound factory calls cannot replace a bound owner's API. Teardown disables its notifications before aborting its children.
- Agent, StopAgent, MessageAgent, AgentStatus must be absent from child Extension.tools, original runner registry, and session callable registry; retain allowed peer extension tools, including late/deferred registration.
- Third-party callbacks nested in a marked child-loading chain can inherit its marker; independently creating a parent from that nested chain is outside the agreed guarantee. Independent unmarked parent entry points remain covered.
- Config priority remains session > trusted project > global > defaults. Delete means inherit. No cross-process lock, cross-file transaction, or live broadcast is promised. Successful persistent saves preserve own session overrides; explicit reload keeps its existing reset behavior.
- Do not change global settings.json, production services, or the daily official extension source. Use temporary projects/auth/settings for runtime experiments, no production conversations or credentials.
- Missing compatibility SDK test dependencies may be installed only after review authorizes it, inside task temporary directories with lifecycle install scripts disabled and isolated package-manager cache/config; do not modify global packages or this checkout's dependency manifests.
- Use typed fixtures and test/pi-boundaries.ts; no new arbitrary any or hidden exceptions. Use meaningful behavior regressions, not tests that mirror implementation.
- Keep update_plan as the coordinator's progress anchor. Do not create a second compaction/session ledger.

## Review Focus

- Shutdown/new while discovery is awaiting must prevent stale initialization and input-listener leaks; cover in Task 1.
- Equal agent IDs in different owners must not share invalidation callbacks or notification destinations; cover in Task 1.
- An external later child reload and trust preloading must still suppress the plugin before factory registration; cover in Task 2.
- Two stale stores editing nested maps, deletes and conditional defaults must not resurrect or erase unrelated values; cover in Task 3.
- Unreadable/malformed files, rename failure and a later file failing during an all-target clear must not be represented as complete success; cover in Task 3.

## Task 1: Own state and callbacks per factory

**Files:** Modify src/shell.ts, index.ts, registration.ts, events.ts, agent-color.ts; agents/{agent-types,agent-manager,agent-runner,agent-status,restart-last-agents,tool-execution}.ts; spawn/{spawn-coordinator,spawn-target}.ts; ui/{format,renderer,agent-widget,conversation-viewer}.ts; ui/menu/{menus,menu-agent-settings,menu-concurrency,menu-debug,menu-model-settings,menu-running-agents,menu-spawn-wizard,menu-system-prompt,menu-widget-settings}.ts; ui/menu/submenus/model-select.ts.

**Tests:** Add test/instance-isolation.test.ts; update test/session-notifications.test.ts, fixtures.ts, agent-types-mock.ts, menu-mock-setup.ts and directly affected agent/widget/renderer/menu suites. Update shared mocks to construct distinct owners rather than returning one process-wide fake.

**Interfaces:**

- Produce export interface ExtensionOwner and createExtensionOwner(pi: ExtensionAPI): ExtensionOwner in src/shell.ts. It holds a readonly pi, its AgentRegistry, Map<string, () => void> renderer invalidations, nullable sessionCtx/store/manager/coordinator/widget, lifecycle generation, and terminal-input unsubscriber. Constructing it performs no session I/O or service construction.
- Produce createAgentRegistry(): AgentRegistry in src/agents/agent-types.ts. Existing discovery/lookup functions become instance methods with their existing arguments/results; parser and merge semantics stay unchanged.
- registerTools(pi: ExtensionAPI, owner: ExtensionOwner): void and setupEventListeners(pi: ExtensionAPI, owner: ExtensionOwner): void consume that owner. Stateful helpers/getters take an explicit owner; remove zero-argument singleton fallbacks and setPiInstance.
- Add owner as the first required argument to AgentManager, SpawnCoordinator, AgentWidget constructors; retain the other existing arguments. Their timers and callbacks capture that owner. Pure helpers stay pure; stateful formatting/menu helpers receive the same explicit owner.
- Keep existing caller-facing tool schemas. Tool/event/render fixed signatures are adapted with closures, not extra host arguments.

- [x] Write regressions: two actual factory calls A/B; a never-started B cannot change A's notification API or allocate services; started A/B have distinct managers/stores/registries and queues; A completion/timer delivers only to A; equal record IDs invalidate only their owner; closing/reloading/new A stops A only; B's callbacks still work. Drive the real coordinator notification path with typed SDK/runner boundary fixtures, not a mocked ownership decision.
- [ ] Reverse the old notification handoff test: creating/starting B must not transfer A's queued completion to B. Add delayed discovery followed by shutdown/new and assert stale discovery cannot create late services or retain input listeners.
- [x] Run ./node_modules/.bin/vp test run test/instance-isolation.test.ts test/session-notifications.test.ts; record the expected behavioral failures before implementation. Compile/import failures alone do not prove the existing notification defect.
- [x] Implement the owner/registry injection through every indirect consumer listed above; construct ConfigStore and timer-bearing services only for the owning session_start. Preserve explicitly justified pure caches and session-keyed WeakMap ownership; do not leave a hidden current-owner global.
- [x] Run the two targeted suites, all directly affected suites, then VP_DOWNLOAD_TIMEOUT=3 CI=1 ./node_modules/.bin/vp check and VP_DOWNLOAD_TIMEOUT=3 CI=1 ./node_modules/.bin/vp test run. All must pass. Coordinator inspects the complete diff and records the stage; commit only after required checks.

## Task 2: Bind the child marker to actual loading entry points

**Files:** Create src/child-load-context.ts. Modify src/index.ts, src/agents/agent-runner.ts, src/shell.ts and AGENTS.md lifecycle guidance. Add test/child-load-context.test.ts and extend test/contract/child-session.test.ts and runner loader/abort/notification suites.

**Interfaces:**

- Consume ExtensionOwner and AgentRegistry from Task 1.
- Produce isChildExtensionLoad(): boolean and withChildExtensionLoad<T>(marked: boolean, fn: () => T): T in the new helper. Internally use Symbol.for("pi-subagents-lite.child-extension-load.v1") containing only AsyncLocalStorage<boolean>; no parent references and no per-owner disable/delete of the shared container.
- Keep createResourceLoader's existing arguments and return contract. Before first loading, wrap that child loader instance's public reload and loadProjectTrustExtensions methods, preserving receiver, argument and return types. This covers SDK AgentSession.reload without wrapping an entire prompt/run.
- Factory checks isChildExtensionLoad before owner creation/registration. Remove the old enter/exit/depth protocol and its whole-run brackets.
- Keep known parent boundaries (created/bound announcements, onSessionCreated, error-to-parent activity callbacks) outside the child marker, including their asynchronous descendants. Preserve the current synchronous created-to-bind publication constraint.

- [ ] Add real-loader contract regressions using the formal plugin and four exact tool names: marked child has no own tools in Extension.tools, original runner and session registries; allowed peer late/deferred tools remain available and callable through normal SDK paths. Cover initial load, marked later session reload, and trust preload before callbacks.
- [ ] Add independent unmarked parent B while child A is suspended in loading and while its task is running; B registers normally. Cover success, factory/bind/reload rejection, module reevaluation/cwd changes, and unmarked parent callbacks. Keep the nested third-party callback limitation explicit rather than reporting it as a passing parent-isolation case.
- [x] Run ./node_modules/.bin/vp test run test/child-load-context.test.ts test/contract/child-session.test.ts and the existing loader-isolation suite; capture failures against the old depth protocol before changing it.
- [x] Implement the narrow helper and entry wrappers; no custom discovery framework, SDK private loader mutations, global environment flipping, or noExtensions workaround. Update AGENTS.md to remove the obsolete whole-run depth advice and correct session_start ownership from actual SDK behavior.
- [x] Run targeted contracts and the full required check/test commands from Task 1. Compare session and runner tool views explicitly; activeTools alone is insufficient. Coordinator reviews the stage before any commit.

## Task 3: Apply fresh configuration mutations and verify the combined result

**Files:** Modify src/config/{config-io,config-store,config-validation}.ts only as required. Update test/config/config-store-helpers.ts, existing config IO/store/layer tests and add test/config/config-store-concurrent-writes.test.ts. Update CHANGELOG.md Unreleased; retain the already recorded ADR-0004 partial supersession by accepted ADR-0012 and its historical closure-composition guidance.

**Interfaces:**

- Produce ConfigIO.updateLayer(target: "global" | "project", mutate: (latest: RawConfig) => void, options?: { createIfMissing?: boolean }): LoadedConfig in src/config/config-io.ts; keep load(): LoadedConfig. Remove old save-port usage from ConfigStore so it cannot persist a captured whole-layer snapshot.
- updateLayer rereads the target with strict ENOENT/error distinction, applies the mutation to a fresh candidate, validates, atomically saves with a distinct same-directory temporary file, then returns current persisted layers. Failed reads/validation/writes propagate without committing the candidate as effective state. Read-time tolerant configuration behavior must not turn write-time read failures into empty overwrites.
- ConfigStore's public setters keep their signatures. Route persisted edits through one private update helper, applying returned layers and own dependency sync after success, retaining own session overrides. Explicit session-target/all-target clear operations keep their intentional session semantics; do not accidentally clear overrides during an ordinary save.
- A missing project file is created only by an allowed trusted setter; clear does not create it. Invalid/untrusted project layers stay unwritable. All-target multi-file work reports partial failure honestly and never claims rollback of an already saved file.

- [x] Add two-store tests for model + concurrency edits, different/same nested map fields, deletes, clear-all, conditional compact defaults, session model/concurrency/showCost overrides, explicit own reload, and independent dependencies. Assert concrete persisted values after each interleaving; same-field last completed save may win.
- [ ] Add filesystem/error tests for malformed/non-object JSON, EACCES-like reads, validation failure, write/rename failure, distinct temporary names and own-temp cleanup. Assert original data survives unsuccessful replacement and no false success/widget-manager sync occurs. Cover absent project clear and later-file failure during all-target work.
- [x] Run ./node_modules/.bin/vp test run test/config/config-store-concurrent-writes.test.ts plus affected config suites; record stale overwrite/swallowed failure before production edits.
- [x] Implement the mutation port and store routing, preserving session > project > global > defaults and inheritance deletes. Do not introduce file watchers, cross-process locks, a new persistence service, or runtime dependencies.
- [ ] Run the required full check/test commands. Run the real child/instance contract matrix with SDK 0.99.0, 1.0.3 and 1.4.0 using isolated version fixtures; prepare any missing test dependencies only after the review authorizes local installation. Keep the lockfile/runtime support floor unchanged, and record exactly which suites each version ran.
- [ ] Start a temporary isolated installed pi-web server with only the repaired fork and controlled fixtures. Create two real bound parent sessions; validate unbound /api/models loading, A/B notification routing, per-parent queue limits, A-only teardown/new/reload, and B startup while A child runs. Use no production settings/auth/messages. Dispose all sessions and close listeners. Report any narrower evidence rather than declaring untested behavior passed.
- [ ] Coordinator inspects final diff, status, changelog and all acceptance criteria; a fresh Verifier checks the combined change and evidence. Address material findings with a fresh Fixer, then rerun only affected checks plus required commit checks. After success, additively commit/push fork main and verify remote contents. Daily official package configuration stays unchanged.

## Execution and evidence

Use serial implementation lanes in this checkout, preserving existing documentation edits; no concurrent writers. Coordinator owns integration, checks and publication. Separate task scopes above prevent config work from being hidden inside the ownership migration. Use current agent registry/extension-owner rules when applying the required execution skill; no second child-lifecycle or context manager.

Baseline on this checkout: package.json and package-lock.json byte-identical to the prior prepared checkout. Its existing node_modules is linked for reuse; no installation has run. Vite+ 1.3.0 and SDK 1.4.0 are available. VP_DOWNLOAD_TIMEOUT=3 CI=1 vp check passed (182 formatted, 180 lint/type clean); vp test run passed 104 files / 2008 tests. These are baseline results, not validation of the future refactor.

**Self-review:** Q1–Q12 map to Tasks 1–3 and Global Constraints. All five Review Focus cases have assigned regressions. Shared interface names are ExtensionOwner/createExtensionOwner, AgentRegistry/createAgentRegistry, isChildExtensionLoad/withChildExtensionLoad, and ConfigIO.updateLayer; no task may introduce a singleton fallback. No unresolved product choice remains in this plan. Missing old-version fixtures and runtime verification remain execution prerequisites, not claimed successes.
