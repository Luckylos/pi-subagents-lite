# Configuration consolidation design

Status: approach selected; design for review. Baseline: `14139f8` (1.17.3).

## Goal and approaches

Consolidate the complete extension configuration in one delivery. A new setting's type, raw validation, defaults, permitted layers, and clearing behavior must have one authoritative definition. Preserve the current file format, behavior and per-parent ownership; no migration, presentation changes or dependency updates.

- **Selected: configuration domain modules.** Declare each setting once and use plain functions for resolution, projections and operations that need more than one key. Keep state and external effects with their existing owners.
- **Alternative: universal registry.** Drive the menus, setters and synchronization from one metadata engine. Rejected because distinct entry-point rules, stateful transitions and cross-key writes would become callbacks inside a shared framework rather than explicit behavior.

## Responsibilities

| Module | Owns | Does not depend on |
| --- | --- | --- |
| Configuration definitions (under `src/config/`) | Known setting types, raw validators and expectations, defaults or deliberate absence, layer permission, reset family and setting-specific input policy. Open per-type model and concurrency maps use their own rules. Move the config shape out of model precedence. | Store, files, menus, Pi, widget, manager |
| Pure configuration operations (under `src/config/`) | Validate and report diagnostics; merge layers; resolve values with session inputs; compute presence, reset scope and sync data; apply setting and multi-key mutations to a supplied raw layer. These operations use the definitions and preserve the distinctions between input entry points. Organize by responsibility, not one new file per setting. | Paths, I/O, instance state, dependencies or presentation |
| `ConfigIO` | Path and project status, load/write policy, lazy project creation, diagnostic emission, fresh reads and atomic replacement. Invoke configuration operations for parsing and validation; continue returning both current layers. | Menus, widget, manager or store state |
| `ConfigStore` | Owned raw layers, session overrides and transient UI state, persistence orchestration, reload/dispose, and execution of existing dependency synchronization. Preserve its domain-oriented reads and mutations. | Concrete menu implementation |
| Consumers | Menus render and navigate, collect input and carry out UI-only interactions. Spawn and model display keep their distinct decision contexts. Runtime code still owns admission, tools, registry queries, and child resources. Consume resolved configuration and shared configuration rules instead of keeping substitute defaults and policy lists. | Private configuration representation and other consumers |

Definitions and pure operations have no back references to their callers. Raw types and runtime validation must be derived from the same definitions, or statically linked so neither a missing definition nor an extra known key compiles. Project admission and model Reset/Clear classification must use the same key-family policy, not separately maintained key lists. Selecting a permitted setting and selecting a currently writable target are distinct: the former is pure; the latter depends on trust and file status. UI numeric policy is also distinct from raw validation and setter normalization. Menus own text, row order and rebuild behavior, not a second copy of configuration rules. Do not expose key metadata or raw snapshots merely to let consumers reconstruct those rules.

## Coverage ledger

The following groups cover all 39 named `agent` keys. The ledger is a review aid, not a second runtime declaration.

| Family | Named keys and additional input space |
| --- | --- |
| Model and turn defaults | `default`, `defaultThinking`, `defaultMaxTurns`; all dynamic per-type model keys |
| Agent behavior | `forceBackground`, `graceTurns`, `toolTimeoutMinutes`, `idleTimeoutMinutes`, `disableDefaultAgents`, `agentToolStrictMode`, `exposeDescriptions`, `parentMessages`, `agentStatusLimit` |
| Child resources and output | `systemPromptMode`, `includeContextFiles`, `loadSkillsImplicitly`, `loadExtensionsImplicitly`, `loadToolsImplicitly`, `outputThinkingBufferSize`, `outputTranscript` |
| Widget layout and display | `widgetMaxLines`, `widgetMaxLinesCompact`, `widgetCompact`, `widgetShortcut`, `widgetShowModel`, `widgetShowThinking`, `widgetNavHint`, `showCompletionCards`, `finishedRetentionMinutes`, `modelDisplayStyle`, `modelThinkingPlacement`, `statusBarFormat`, `showAgentColors` |
| Widget stats | `showCost`, `showTools`, `showTurns`, `showInput`, `showOutput`, `showContext`, `showTime` |
| Other configuration | `concurrency.default`, `concurrency.providers`, `concurrency.models`; session model/concurrency/showCost; top-level section and legacy-key policies |

Audit boot defaults and consumer fallbacks as well as persisted defaults. Do not replace a deliberate pre-store fallback with a different effective setting. Core model/Thinking precedence stays in its existing pure modules; rules for this extension's settings supply inputs to them. Pi settings, agent frontmatter schema, and launch-time resolution of target/type/model/Thinking remain independently owned. Existing settings display semantics, including which unavailable raw model IDs can be cleared, stay unchanged; the separate provenance redesign is not part of this candidate.

## Compatibility requirements

- **Layers and values.** Preserve [ADR-0008](../../adr/0008-project-config-as-override-layer.md). Project admits only the model family, dynamic model keys and concurrency. Model default and dynamic overrides may be session-scoped, but default Thinking and max turns cannot. Missing persisted keys inherit; project model `null` or an empty string shadows the corresponding global key before model resolution skips it. Setting an explicit null is distinct from deleting the key. Raw entry presence, resolved choice, and Clear availability remain distinct.
- **Defaults and entry points.** Preserve raw absent keys versus baked defaults, and existing setter/UI/effective distinctions. Hand-written watchdog negatives remain accepted, while setters clamp to zero; retention still clamps on set/read; automatic status limit stores zero and reads twice the effective default concurrency. Compact lines derive from full lines when absent; the full-lines setter materializes compact lines only if the fresh target layer does not already contain a value. Keep UI min, empty/unlimited and delete semantics per entry point and keep numeric edge behavior of validation, including the distinction between agent and concurrency validation. No blanket normalization or new key restrictions.
- **Validation and persistence.** Preserve silent legacy handling, dropped unknown top-level/concurrency keys, open per-type model keys, key warnings and project-specific rejection rules. Production update must read and validate the current target, apply its mutation, validate again, atomically replace and reload both layers. Keep existing direct-save compatibility where present; absent project Clear does not create a file. Loaded disallowed but valid project entries are not retroactively rewritten on reads.
- **Clear and errors.** Model Clear removes only the model family, dynamic keys and targeted session model overrides. Concurrency Clear does not affect agent settings; neither resets session showCost. Preserve session then global then project sequencing for all-target Clear, error reporting and partial success without rollback. Preserve unavailable-target and no-op behavior.
- **Ownership and effects.** Preserve [ADR-0012](../../adr/0012-instance-owned-extension-state.md): independent parent instances, no broadcast, no cross-file transaction, session override retention on save and reset on reload. Adopt both fresh layers before syncing widget/manager in the existing order, even if a setter touched only one field. Preserve call timing and repeat synchronization where observable. Registration/reload and child-launch effects remain in their current paths; manager lease/queue behavior and Ctrl+O transient state are not persisted settings.

## Acceptance and verification

1. Lock behavior before moving implementation. Add table-driven contract cases covering all 39 known keys, dynamic/null/empty/absent model keys and concurrency. Assert raw validation, defaults, project eligibility and Clear outcomes at observable entry points. Use independent fixtures/expectations for the pre-existing contract, not expectations computed from the new implementation.
2. Verify with the real local file adapter: valid and invalid values through load and update, original bytes unchanged by reads, fresh-write merge, warnings, file creation, atomic-write failure and all-target partial failure. Use the existing memory adapter for store/session cases, not as evidence of production validation. Prefer a real store in semantic menu tests over maintaining duplicate getters/setters in a fake.
3. Verify observable consumers: widget compact/max-lines, retention and status limit; session showCost and concurrency; project trust/permission; model/Thinking selection and Clear paths; Parent messages and first-load/reload distinctions. Preserve effect order and menu navigation. Prefer existing focused tests and add assertions only where the behavior is not already covered.
4. Audit the final diff for stale rule tables, effective fallback duplicates and cross-module dependency cycles. No known-setting families deferred. Run `vp check` and `vp test run`; spot-check real CLI/Web settings flows with isolated configuration where the runtime is available. Record the change in Unreleased. Any behavior issue found during characterization is reported separately, not silently fixed in the refactor.

Implementation may be staged internally for test feedback, but the delivered change covers the whole ledger. No new glossary entries are needed: this design uses existing Global config, Project config and Model override semantics. Existing ADRs already define the behavior and ownership decisions.
