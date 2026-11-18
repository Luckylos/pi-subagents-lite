# Resolve Spawn choices after target and agent type

Agent tool calls, the Spawn menu, and Restart resolve the model and Thinking after validating the Spawn target and resolving the canonical agent type. Menu previews use the same rules and launch resolves the choices against current inputs. Resolving defaults early and putting them into tool arguments gives them explicit-choice precedence and can apply defaults for the wrong type, project, or model.

A model picked explicitly must be available. An unavailable configured default falls back to the parent model. The menu's explicit `inherits parent` choice uses the parent model directly. Pi's per-model Thinking is read for the model actually selected. The Thinking order and the meaning of `parent` follow [ADR-0011](./0011-parent-is-a-thinking-value.md).

Restart uses the original choices recorded in the parent session and recomputes omitted choices from the current inputs. Legacy records retain their existing interpretation when the stored values cannot establish their provenance.

A target-local agent definition participates in lookup only for that target while it is trusted. An untrusted target remains eligible as a working directory. The target's settings, agent definitions, automatically injected project instructions, and skills are excluded, while trusted sources remain available. This applies the project resource boundary in [ADR-0003](./0003-worktree-path-naming.md) and [ADR-0007](./0007-project-level-config.md) to resources read by the plugin as well as those loaded by Pi.
