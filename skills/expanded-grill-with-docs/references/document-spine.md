# Document Spine

Use repository-native locations and formats when they exist. Select the lightest artifact depth that preserves decisions and enables safe delivery.

## Interview record

Use for lower-risk shaping that still benefits from a durable interview record. Record the selected direction, validated Evidence Recon packet/reference and limitations, canonical decision-state summary and representation rationale, question rounds, answers, recommendations, decisions, deferrals, and shared-understanding confirmation.

## Decision contract

Default lightweight documents:

- `design.md`: framing, outcome, scope, non-goals, evidence packet/reference and material limitations, mechanism, boundaries, behavior, invalid states, migration, failure behavior, verification, rollout, recovery, tradeoffs, and decision-state closure summary.
- `glossary.md`: canonical terms, forbidden synonyms, entities, states and transitions, invariants, ownership.
- `decisions.md`: decision, rationale, recommendation accepted or modified, alternatives, consequences, evidence, approver, and revisit trigger.
- `open-questions.md`: unresolved or deferred decision record, importance, dependencies, owner, blocking state, evidence route, consequence, and revisit trigger.

## Full design contract

Add formal proposal, delta specifications, ADRs, design comparison, walking skeleton, rollout contract, or delivery handoff only when warranted by scale, risk, repository convention, or destination-system requirements.

OpenSpec’s durable sequence is proposal → specs → design → tasks; this skill stops before tasks. When Spec Kit is active, use clarification and requirements-quality checks during shaping and reserve implementation convergence checks for later delivery.
