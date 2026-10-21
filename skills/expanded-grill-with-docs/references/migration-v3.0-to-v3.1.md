# Migration: v3.0 → v3.1

V3.1 preserves V3.0's exhaustive batching, coverage lenses, candidate overgeneration, question-quality gate, bulk-answer ergonomics, one-level conditional subquestions, adversarial closure, and no-implementation boundary.

The architectural correction is that **coverage discovery and dependency-graph materialization are now separate concerns**.

## Behavioral changes

- The coverage sweep is mandatory on every substantive grill, including narrow or apparently single-round work.
- Sweep depth is driven by decision uncertainty, consequence, and evidence surface—not expected diff size, line count, ticket label, or apparent implementation simplicity.
- The parent seeds stable decision records before choosing the representation.
- A formal graph is materialized only when meaningful topology exists.
- Independent decisions use `flat-decision-set.yaml` rather than a zero-edge graph.
- Meaningful topology includes prerequisites, conditional branches, fact-gating, mutual exclusion, invalidation, unlock relationships, or multi-round eligibility changes.
- Flat mode may promote to graph mode at any time without restarting the interview.
- Promotion preserves stable IDs, evidence, recommendations, question-quality receipts, answers, resolutions, and document history.
- Final adversarial coverage runs in both flat and graph modes. An empty graph frontier is not a sufficient stopping condition.

## Compatibility

The package name remains `expanded-grill-with-docs`.

Existing V3.0 graph state remains valid and resumable. Do not demote a persisted graph merely for cosmetic consistency. New work should use the automatic representation policy, and zero-edge new graphs should normally be replaced by a flat decision set.
