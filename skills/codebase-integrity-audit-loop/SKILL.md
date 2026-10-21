---
name: codebase-integrity-audit-loop
description: Read-only integrity assessment and candidate-reconciliation owner. Use to scan bugs, wiring drift, schema or contract failures, stale paths, and enforceable-check opportunities; emit a verified candidate ledger, select one candidate, and prepare an exact authorized handoff. It never edits tracked source, creates implementation worktrees, commits, or claims completion.
---

# Codebase Integrity Audit Loop

This skill owns integrity evidence, candidate reconciliation, deterministic ranking through `shared/candidate-ledger-spine`, and integrity report projections. It is an assessment owner, not a source-mutation owner.

The active path is:

```text
scan and reconcile evidence
→ verified candidate ledger
→ select exactly one candidate
→ require exact authorization
→ hash-bound handoff to production-flywheel
→ opaque execution receipt and canonical independent-verification evidence
→ ledger update
```

## Authority boundary

- Writes are limited to declared `.project-intelligence/assessments/integrity/`, `.project-intelligence/reports/integrity/`, and related local evidence/cache artifacts.
- Never modify tracked source, create an implementation branch or worktree, run mutating repair steps, commit, publish, or merge.
- `production-flywheel` owns any authorized source mutation. Under exact authorization it owns repair of a selected defect and uses `/adaptive-causal-debugging` for the diagnostic protocol.
- `independent-verification` is the completion authority. This skill consumes the canonical packet/verdict files and records only the validated receipt reference.
- One selected candidate is the unit of handoff and execution. A ledger, rank, recommendation, design approval, `--max-turns`, or generated report is not mutation authorization.

## Modes

### Assessment (default)

Read [PERFORMANCE.md](PERFORMANCE.md) for bounded evidence collection and [LENSES.md](LENSES.md) only for relevant lenses. Reconcile claims into the v3 shared candidate ledger, using `shared/candidate-ledger-spine/canonical-ledger.json` as the example and `shared/candidate-ledger-spine/ledger-verify.js` as the validator. Persist it through `assets/write-ledger.js`. Under RIA, pass `--ria-envelope <exact-input-envelope.json>` — the closed `{ baseline_ref, engineering_intelligence_ref, sei_assessment_ref?, verification_baseline_ref, presentation_policy: "inherit", candidate_namespace: "integrity" }` envelope from `shared/ria-owner-return/owner-return.schema.json` — with `RIA_RUNTIME_ROOT` set when RIA names a return path outside `.project-intelligence/`; the writer returns `ria.owner-return@1` without adding orchestration fields to the ledger. Prefix every `candidate_id` you mint with `integrity:`. **Adopt upstream candidates:** a Health ledger row routed here (`recommended_action` `direct-fix`, `fitness-check`, or `triage`) enters this ledger as a row that keeps its `candidate_id` (e.g. `health:CONTRACT-007`), `lane_sources`, and `claim_refs` unchanged; reconcile it, never re-mint it. RIA rejects a `candidate_id` that two owners minted independently. The assessment-only interface is `RUNTIME-CONTRACT.json`; mutation/handoff-only fields live separately in `MUTATION-RUNTIME-CONTRACT.json`. The ledger remains canonical whether HTML is generated or skipped.

### RIA mode: coverage receipt and negative claims

Under `--ria-envelope` the writer also requires a top-level `coverage` receipt (`integrity.coverage@2`) and verifies it with `assets/integrity-coverage.js` before storing anything; `assets/canonical-ria-ledger.json` is the worked example. Composite-scoring-v3 §7.1 is the contract.

- **One receipt per dimension.** `coverage.dimensions` holds exactly `correctness`, `contracts`, `security` and `reliability`. Record every surface the RIA config maps to that dimension (`shared/ria-scoring/composite-v2.config.json` `integrity_surface_map`): correctness → runtime-code, domain-libraries, data-lifecycle; contracts → contracts-and-wiring, generated-surfaces; security → runtime-code, contracts-and-wiring, specialized-paths; reliability → runtime-code, operational-behavior. A surface inspected for correctness gives security nothing; record a security entry with security methods (authorization review, secret scan, input-validation review) and its own evidence.
- **Surface entries** are `{surface_id, criticality_weight, state, evidence_quality, methods, scope, evidence_refs, reason, weight_rationale}`. Use Health's default weights (`repository-health-assessment/COVERAGE-MODEL.md`); a different weight needs `weight_rationale`. `inspected`, `sampled` and `inventory-only` need `evidence_refs` (`{kind: candidate|claim|path|command|inventory|rationale, ref, revision?}`); `inspected` needs strong or moderate evidence; core surfaces are never `not-applicable`. Never write a coverage number: the verifier computes it and rejects any declared one.
- **"No findings" needs a negative claim.** A dimension with no confirmed defect scores only if `negative_claims` holds an Evidence Recon receipt with `supports_absence: true` whose `search_scope` lists `surface:<id>` for every applicable mapped surface, whose `search_methods` list `defect-check:<class>` for every configured check (`integrity_defect_checks`: correctness → logic-error, data-integrity, concurrency, stale-or-dead-path; contracts → contract-drift, missing-validation; security → security-exposure, missing-validation; reliability → failure-handling, concurrency), and whose `exclusions` remove no graded surface or row. Sampling alone never yields a clean score.
- **Minted rows** (`integrity:` ids) carry `ria_dimensions`, `defect_class` and `ria_proof` `{failure_predicate {predicate_id, statement}, input_binding, proofs[]}`. Bind proofs to `{repository_id: <envelope baseline_ref.artifact_id>, root_id: "root-0", revision: <envelope baseline_ref.repository_revision>}`. A reproduction proof records `expected`, `actual`, `exit_code`, `check_id` and `receipt_sha256`; an exit code alone, a harness error or a missing dependency is not a reproduction. Name `predicate_id` as `<dimension>:<defect-class>:<subject>` so the same failure from another owner can be matched. **Adopted rows** keep their upstream id, `lane_sources` and `claim_refs`; RIA derives their dimensions from `lane_sources` and records any ambiguity as a limitation, returned in the owner return's `warnings`.

### `--parallel-report`

Read [PARALLEL-REPORT.md](PARALLEL-REPORT.md). This is read-only assessment and always stops at the candidate gate. It cannot select, authorize, or execute a candidate. If combined with `--auto`, assessment wins and nothing mutates.

### Selected candidate handoff

Ask the user to select exactly one current candidate unless an authorized caller already supplied its exact identity. Before creating a handoff, require:

- candidate ID and complete canonical candidate envelope;
- repository identity and current base revision;
- sorted relative scope paths;
- hash-bound evidence references;
- acceptance criteria with exact commands and expected outcomes;
- an independent-verification strategy;
- an authorization record binding the same candidate, repository, base revision, candidate hash, scope hash, and evidence hash with `permitted_mutation: true`, signed by the configured Flywheel authority key through `signAuthorization`.

Use `scripts/candidate-handoff.js` and `contracts/candidate-handoff.schema.json`. The HMAC secret never enters the handoff; only `authority_key_id` and `authority_mac` are persisted. Reject stale base revisions, substituted candidates, changed evidence, broadened scope, mismatched or unauthenticated authorization, or more than one candidate. Persist the immutable handoff only under `.project-intelligence/assessments/integrity/handoffs/`, then return it to `production-flywheel`.

### `--auto`

Read [AUTO-MODE.md](AUTO-MODE.md). Compatibility auto mode may process only a supplied list of separately pre-authorized, hash-bound handoffs, one candidate at a time. It never turns a discovered ledger into blanket authorization. Unsafe legacy use returns a structured deprecation/redirect result without source mutation.

## Receipt and closure rule

After Flywheel returns, validate that its opaque execution receipt binds the exact handoff hash. A candidate may be marked completed only when Independent Verification's read-only consumer validates the canonical packet, receipt chain, PASS verdict, and locked `completion_binding` for that handoff and execution-receipt hash. Store only the derived receipt reference in the ledger; never accept a caller-manufactured verification object or infer success from prose, cached PASS, or worker self-report.

## Verification

```bash
node scripts/candidate-handoff.test.js
node scripts/authority-contract.test.js
```

Failure codes are stable: `EXACT_MUTATION_AUTHORIZATION_REQUIRED`, `STALE_BASE_REVISION`, `CANDIDATE_HASH_MISMATCH`, `SCOPE_HASH_MISMATCH`, `EVIDENCE_HASH_MISMATCH`, `AUTHORIZATION_*`, `BOUND_EXECUTION_RECEIPT_REQUIRED`, and `FRESH_INDEPENDENT_VERIFICATION_REQUIRED`.
