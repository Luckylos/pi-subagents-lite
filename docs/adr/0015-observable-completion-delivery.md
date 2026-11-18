---
status: accepted
---

# Observable completion delivery

A completion notification is an independently identified snapshot of one Subagent run, owned by one parent session and extension generation. Receipt is confirmed through positive evidence in that parent's public conversation history: the installed SDK's void-returning send API hides asynchronous failure, and message lifecycle events can precede history insertion. Submitted notifications without observed receipt remain unconfirmed and are not automatically resent; an explicit retry warns that the host may deliver or wake twice because it provides no notification deduplication or per-send receipt.

## Consequences

- Confirmed receipt establishes entry into conversation history. Model consumption and disk durability are outside the receipt contract.
- Each attempt retains the original run outcome and ownership. A different active conversation branch does not justify resending a notification already observed in that session's history.
- Owner teardown or generation replacement ends new submissions and cross-generation confirmation, following [ADR-0012](0012-instance-owned-extension-state.md). Already submitted host queues cannot be retracted through the installed ExtensionAPI.
- Receipt does not remove the run's retained result. Delivery preserves the Parent message ordering of [ADR-0013](0013-parent-message-channel.md) and the run ownership of [ADR-0014](0014-run-ownership-and-sdk-cancellation.md).
