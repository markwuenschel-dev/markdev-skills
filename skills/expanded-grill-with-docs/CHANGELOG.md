# Changelog

## 3.2.0

- Added required `shared/evidence-recon` v1 integration as the canonical evidence packet and vocabulary.
- Added self-scaling inline and expedition evidence modes; heavy dispatch is proportional rather than mandatory.
- Added explicit negative-claim coverage receipts and prohibited unsupported absence claims from entering `safe_to_assume`.
- Updated specialist lanes to return validated expedition evidence fragments while preserving parent-only interview and lifecycle authority.
- Kept evidence coverage orthogonal to the mandatory decision-coverage sweep and flat-vs-graph topology analysis.
- Added durable evidence-packet references to flat and graph state plus migration guidance from v3.1.
- Expanded evaluation and release validation around evidence mode selection, negative claims, and evidence-versus-decision coverage.

## 3.1.0

- Separated mandatory decision discovery from optional dependency-graph materialization.
- Required a coverage sweep on every substantive grill before choosing flat or graph representation.
- Added `flat-decision-set.yaml` for rigorous single-round or topology-free interviews with stable IDs, evidence, recommendations, quality receipts, and state.
- Materialize the formal graph only for meaningful prerequisites, conditional branches, fact-gating, exclusions, invalidations, unlocks, or multi-round eligibility changes.
- Added dynamic flat-to-graph promotion without restarting the interview or losing settled decisions, evidence, recommendations, or question-quality receipts.
- Explicitly prohibited using expected diff size, line count, ticket label, or apparent implementation simplicity as a proxy for sweep depth.
- Required the adversarial final coverage sweep in both flat and graph modes.
- Expanded the evaluation suite to cover narrow-change sweeps, zero-edge flat mode, topology-triggered graph use, dynamic promotion, representation stability, and diff-size independence.

## 3.0.0

- Made the grilling interview the primary product and defaulted to exhaustive, maximum-coherent question batching with no fixed cap.
- Replaced answer-burden suppression with grouping, compression, and bulk-answer ergonomics.
- Added deliberate candidate-question overgeneration, cross-lane question discovery, deduplication, sharpening, and critique.
- Added a machine-readable eight-dimension question-quality gate with hard failures for weak interviewing behavior.
- Added consequential coverage lenses, including parallelism/concurrency, failure/recovery, migration, operations, proof, and irreversibility.
- Added one-level conditional subquestions to reduce unnecessary conversational rounds without violating graph dependencies.
- Added explicit `accept all recommendations` / `accept all except ...` handling while preserving omitted questions as unresolved.
- Required recommendation rationales to name concrete mechanisms and consequences instead of generic best-practice language.
- Expanded the evaluation suite around large batches, question craftsmanship, coverage gaps, rationale quality, bulk acceptance, partial answers, and conditional branches.
- Preserved the v2 decision graph, evidence-first research, parent-owned interview, adversarial closure, and no-implementation boundary.

## 2.0.0

- Replaced the flat interview core with a decision dependency graph.
- Added separate research and human-decision frontiers.
- Added nonblocking parallel fact research.
- Required a recommended answer, rationale, tradeoff, and confidence for every consequential user decision.
- Prevented dependent questions from appearing in the same round.
- Kept the parent as sole interview, synthesis, and lifecycle owner.
- Added explicit shared-understanding confirmation before approval or delivery handoff.
- Strengthened deferral rules, adversarial closure, graph-cycle handling, and evaluation coverage.
- Preserved the `expanded-grill-with-docs` package identity for overwrite compatibility.
