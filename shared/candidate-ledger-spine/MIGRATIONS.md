# Candidate-ledger spine migration

This package is the sole physical owner of spine version 3. It consolidates the written scoring contract formerly under `codebase-integrity-audit-loop/REPORT-SCORING.md` and the executable verifier formerly under `improve-codebase-architecture-mwdev/assets/ledger-verify.js`.

Consumers resolve `shared/candidate-ledger-spine/ledger-verify.js` repository-relatively, or use the explicit `LEDGER_VERIFY_PATH` override. Missing or incompatible code is a hard failure; consumers must not score, rank, or render an empty candidate panel locally.

New outputs attach `candidate_lifecycle`. Historical top-level `lifecycle_status` and `resolution` may be read only to establish continuity; they are not emitted by new reports.

## Spine v3 additive fields: RIA composite v2 (composite-scoring-v3 §6.4, §7.2) — 2026-10-16

`spine_version` stays `3`. Three optional candidate fields are added to `candidate.schema.json` and validated by `ledger-verify.js` only when present; ledgers without them (including every Health ledger) verify exactly as before.

- `ria_dimensions`: non-empty unique subset of `correctness | contracts | security | reliability`.
- `defect_class`: `logic-error | contract-drift | missing-validation | security-exposure | failure-handling | concurrency | data-integrity | stale-or-dead-path | other`.
- `ria_proof`: `{ failure_predicate: {predicate_id, statement}, input_binding: {repository_id, root_id, revision}, proofs: [{kind, ...}], containment? }` where `kind` is `reproduction | analyzer | sei-metric | observation | judgment | counter-evidence | resolution`.

New problem codes: `ria-dimensions`, `defect-class`, `ria-proof-shape`. Shape only: whether a proof is admissible and which evidentiary state it yields is computed by `shared/ria-scoring/evidence-model.js`, never by the spine and never from `status`, `rollup` or `candidate_lifecycle`. Integrity's RIA-mode writer makes the first two required for Integrity-minted rows (see `codebase-integrity-audit-loop/MIGRATIONS.md`).
