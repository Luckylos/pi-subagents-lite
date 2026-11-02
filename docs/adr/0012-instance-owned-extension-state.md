---
status: accepted
---

# Instance-owned extension state

Pi can invoke a cached extension factory more than once in one process, including for an unbound runtime. Each factory invocation therefore owns a composition root whose callbacks capture its API and whose session resources belong only to that extension instance. This retains the closure-based composition of [ADR-0004](0004-composition-root-over-shared-state.md) while replacing its process-singleton assumption.

## Consequences

- Configuration stores, subagent managers and queues, coordinators, widgets, agent-type registries and scan directories, and renderer invalidations have instance ownership. An instance that has not received its own session_start registers callbacks without scanning agents, constructing session services, starting timers, writing configuration, or disposing another instance's resources.
- New-session, reload, and shutdown operations affect only their owning instance. Completion delivery captures that instance's API; teardown disables its notifications before stopping its subagents. Concurrency limits apply per parent instance, so simultaneous parents can use the sum of their configured limits.
- Child loading uses an AsyncLocalStorage marker at this extension's child loader entry points, including trust preloading and subsequent reloads, instead of a process-wide depth counter around the entire subagent run. A namespaced, realm-global container preserves the marker protocol across module reevaluation without holding parent APIs or session state. Independent unmarked parent loading remains supported while a child is loading or running.
- A third-party callback invoked within a marked child-loading chain inherits the marker. Creating a semantically independent parent from that nested callback is outside this decision's support boundary; the marker identifies async lineage rather than session identity.
- Persistent configuration writes read the latest target layer, apply only the requested field changes or deletions, validate, and replace each file atomically using a distinct temporary file. Failures are reported rather than accepted as successful in-memory saves. This preserves different-field edits on the same JavaScript thread; it does not provide cross-process locking or a transaction across multiple files.
- Configuration changes are not broadcast to other instances. Each instance reads persisted changes through its own reload or save; persistent edits retain its session overrides, while explicit reload keeps the existing behavior of clearing that instance's overrides.

## Considered options

Moving the API assignment from factory load to session_start prevents an unbound factory from replacing the live API, but still shares state between two bound parents. A process-wide spawn-depth counter also suppresses independent parent factories while a child runs. Package filters do not uniformly cover all extension sources, and extensionsOverride executes after factories; tool exclusions alone leave the extension's original registrations intact. Owning state per factory and limiting the child marker to actual loading entry points preserves the existing extension-loading behavior without taking over SDK resource discovery.
