# Document Spine

Use repository-native locations and formats when they exist.

Default lightweight documents:

- `design.md`: framing, outcome, scope, non-goals, mechanism, boundaries, behavior, invalid states, migration, failure behavior, verification, rollout, recovery, tradeoffs.
- `glossary.md`: canonical terms, forbidden synonyms, entities, states and transitions, invariants, ownership.
- `decisions.md`: decision, rationale, alternatives, consequences, evidence, revisit trigger.
- `open-questions.md`: question, importance, owner, blocking or deferred status, evidence route, current state.

Add formal proposal, delta specifications, ADRs, walking skeleton, rollout contract, or delivery handoff only when warranted. OpenSpec’s durable sequence is proposal → specs → design → tasks; this skill stops before tasks. When Spec Kit is active, use clarification and requirements-quality checks during shaping and reserve implementation convergence checks for later delivery.
