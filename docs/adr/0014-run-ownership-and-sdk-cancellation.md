---
status: accepted
---

# Run ownership within host SDK boundaries

Each accepted initial or continuation request owns a distinct Subagent run, including its identity, cancellation state, result, and completion notification; the Subagent retains the conversation across runs. The extension owns run admission, cancellation intent, state presentation, and parent delivery, adapting the installed SDK through public APIs while leaving pi CLI, pi-web, and their SDK dependencies unchanged and preserving the instance ownership of [ADR-0012](0012-instance-owned-extension-state.md). Run ownership prevents continuation from overwriting an earlier result and preserves cancellation intent across startup, while actual settlement remains constrained by the SDK and operations already executing.

## Consequences

- The implementation targets the public APIs of the SDKs loaded by pi CLI and pi-web. Regression tests exercise the installed SDK with local provider and tool stubs.
- An accepted stop request does not establish settlement. Work that cannot yet finish cancellation remains stopping; its concurrency capacity remains occupied until execution actually ends. Existing terminal status names remain compatible, with execution phase distinguishing active stopping from the eventual stopped outcome.
- Results and notifications belong to their originating run. Each run's terminal outcome and result remain available until the user clears the Subagent or its owning session ends, extending the retention principle of [ADR-0006](0006-settled-agent-retention.md) across continuations without duplicating conversation history.
- Parent notification scope remains limited to the owning session's lifetime, retaining the ownership and Parent message ordering constraints of [ADR-0013](0013-parent-message-channel.md); receipt and retry semantics are recorded in [ADR-0015](0015-observable-completion-delivery.md).
- The installed SDK's void-returning `sendMessage` API does not acknowledge asynchronous acceptance. A successful invocation alone cannot establish successful delivery.
