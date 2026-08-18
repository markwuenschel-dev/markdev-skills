# Contradiction Reconciliation

Contradictions are first-class evidence, not prose inconveniences.

Typical shapes:

- an ADR says A while current code does B;
- tests expect C while runtime telemetry demonstrates D;
- two authoritative modules claim ownership;
- documentation and history describe different completion semantics.

## Procedure

1. Record each underlying claim separately with its own status, quality, coverage, and sources.
2. Create a contradiction record referencing all involved claim IDs.
3. State the authority order relevant to this question; do not assume one universal hierarchy.
4. Attempt reconciliation through version, scope, environment, temporal, or terminology differences.
5. Mark `resolved`, `partially-resolved`, or `unresolved`.
6. Preserve the remaining uncertainty and downstream consequence.

Resolution may establish that one source is stale. It does not erase the historical contradiction. Downstream consumers need the record to avoid reintroducing it.

Evidence Recon may identify `owner_intent_required` when evidence cannot choose between live competing policies. It must not invent the human decision.
