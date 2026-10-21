# Migrations

Newest first. Package versions (5.x) and health island schema versions (v3–v5) are separate numbering; the island schema has been v5 since the v4 → v5 entry below.

## v5.6 → v5.7: SEI criterion citations (composite-scoring-v3 §5.3) — 2026-10-16

Health island schema remains **v5**; candidate spine remains **v3**. Additive: every island valid under 5.6 stays valid, and grade arithmetic, lanes and caps are unchanged.

- Claim `evidence[]` accepts a third closed shape, `{ "kind": "sei-criterion", "criterion_id": "...", "metric_id": "..." }` (`health.schema.json`, `health-verify.js`). It must not be mixed with `path` or `architecture_level` in the same entry.
- Under `--ria-envelope`, `write-health-artifact.js` checks every such citation against the **bound assessment bytes** through `repository-improvement-assessment/engineering-intelligence-reader.js` (`readSeiEvidence`, `seiCitationProblems`), using only the envelope and `--repo`. A criterion that exists in the rubric but not in the bound assessment, or a metric under the wrong criterion, fails with `FAIL-SEI-CITATION-INVALID`. RIA repeats the check authoritatively in its owner-artifact verification node (`FAIL-RIA-SEI-CITATION`).
- A citation of SEI evidence held by Health is *adopted* evidence for RIA's dependence rule (§6.2): a lane whose evidence is at least half SEI citations is dependent on SEI in that dimension.

## v5.5 → v5.6: judgment evidence, RIA candidate namespace

Health island schema remains **v5**; candidate spine remains **v3**; Evidence Recon packet remains **v1** (shared package 1.1.0). One previously accepted input now fails closed.

**`review_source.proof_basis` is required.** Every claim carrying `review_source` must now include `proof_basis: "mechanical" | "judgment"`. An island written by 5.5 with `review_source` and no `proof_basis` is rejected (`claim-review-source`). Migration: regenerate the claims with the 5.6 `assets/review-to-claims.js`. To hand-migrate a 5.5 island, set `proof_basis: "mechanical"`: 5.5 consumed only v1 reports, which have no judged rules.

**Review reports v1.1.** The review runtime now emits `review-fitness-report/v1.1`: mechanical sub-rules plus one judged baseline per dimension, with the judged rules listed in `coverage.judged_rules`. `review-to-claims.js` accepts v1 and v1.1. It sets `proof_basis: "judgment"` for a judged rule (or `model-judgment` proofs) and writes that claim's text to `observation.inferred`; otherwise it sets `mechanical` and writes `observation.confirmed`. Review runs on real repositories now produce claims, not only limitations ([REVIEW-LANES.md](REVIEW-LANES.md)).

**Judgment rules (verifier and, for R1, schema).** See [HEALTH-GRADING.md](HEALTH-GRADING.md#judgment-evidence).

| Rule | Rejected | Problem code |
| --- | --- | --- |
| R1 | a judgment claim with `observation.confirmed` | `claim-judgment-confirmed` |
| R2 | level 4 whose only `pass` is a judgment claim | `level4-needs-mechanical-pass` |
| R3 | level ≥ 3 resting only on judgment claims | `level-judgment-only` |
| R5 | a `strong` surface whose only deterministic references are judgment claims | `surface-strong-judgment-only` |
| R6 | `uncontained_critical_failure` naming a judgment claim; the D cap does not fire | `uncontained-critical-judgment` |

No confidence factor was added. R1 already lowers `determinism_ratio`.

**RIA candidate namespace.** The RIA envelope may carry `candidate_namespace` (always `"health"` for this owner). [RIA-MODE.md](RIA-MODE.md) lists it as an allowed field, so an agent no longer fails closed on RIA's real envelope. Under it, newly minted candidate ids are `health:<local>`. Standalone runs stay unprefixed, and a candidate carried over from `previous` keeps its id. `MANIFEST.json` (`input_profiles.ria`) and `RUNTIME-CONTRACT.json` list it as optional input.

**Evidence Recon binding.** The sidecar carries `producer.artifact_refs: [{kind: "health-artifact", artifact_id, sha256}]` beside the legacy `health_artifact_ref` consumer note, for one release. `write-health-artifact.js --evidence-recon` accepts either form, and requires them to agree when both are present (`EVIDENCE_RECON_SIDECAR_UNBOUND`).

## v5.4 → v5.5: review lanes, RIA mode, contract fixes

Health island schema remains **v5**; candidate spine remains **v3**; Evidence Recon packet remains **v1**. New island fields are additive, but several previously accepted inputs now fail closed.

**Review skills connected (Option A).**

- The ten `review-*` skills are dispatched per [REVIEW-LANES.md](REVIEW-LANES.md). Their `review-fitness-report/v1` reports become lane claims through `assets/review-to-claims.js`; each claim carries `review_source: {domain, report_sha256, rule_id, dimension}`. A review report never replaces or scores a lane.
- `review-testing` no longer replaces `verification-readiness` under RIA, and RIA no longer substitutes a testing-fitness score. `write-health-artifact.js --testing-fitness` is deprecated.
- Until a production proof analyzer is registered in `shared/review-fitness-runtime`, review runs on real repositories contribute limitations, not claims.

**New island fields.**

- `evidence_workers[]`: `{worker_id, lane, status, limitations[]}`, one per dispatched worker; `status` is `complete | partial | failed | blocked | timeout`. Sidecar lane receipts now take their status from it instead of a hard-coded `complete`.
- `uncontained_critical_failure` is `null` or `{claim_id, statement}` resolving to a `fail` claim. A string or boolean is rejected. Before, the string `"false"` fired the D cap.

**Grading changes.**

- An `uninspected` core surface is Not gradable, the same as `unavailable`.
- Coverage thresholds compare the unrounded `weighted_coverage`; 79.96% no longer passes as ≥ 80.
- Persisted artifacts carry the computed `grade` block; the writer injects it and re-verifies, so `cap-undeclared` fires on stored artifacts too.
- `candidate_lifecycle` is read first for continuity; top-level `lifecycle_status`/`resolution` are read only for migration.
- Handoffs route by `rollup.execution_mode` first, then `recommended_action`; `prototype` routes to architecture.
- Negative-claim detection covers "nothing", "not", "n't", "lacks", "zero", and "cannot".

**Writers and commands.**

- `write-health-artifact.js` requires `--input` (exit 2 without it), restricts outputs to `.project-intelligence/` or `RIA_RUNTIME_ROOT` unless `--allow-path-outside`, and `--return-out` refuses to overwrite.
- `write-evidence-recon-sidecar.js` verifies the island first. The one sidecar path is `.project-intelligence/evidence/health/`. In SKILL.md, the sidecar step now follows island validation (step 7a).
- `build-report.js --input <report-input.json> --repo <root>` defaults to `.project-intelligence/reports/health/`.

**Handoffs.**

- The old named health-to-architecture return packet is gone. Architecture receives the bare spine-v3 candidate plus an optional `health_context`.
- The integrity "input packet" and its caller-copied mutation and merge authority flags are gone. Candidates reach integrity as ledger rows; mutation authority exists only in integrity's signed handoff.

**RIA mode.** RIA mode is now explicit, triggered by a supplied envelope ([RIA-MODE.md](RIA-MODE.md)). It skips the report election and the §9 packets. `presentation_policy` is the string `"inherit"`. `assessment-verification-baseline@2` is rejected. The sidecar is returned as `specialist_refs` kind `evidence-recon`. `RUNTIME-CONTRACT.json` splits inputs into `standalone` and `ria` profiles.

## v5.3 → v5.4: RIA owner contract and shared verification

*Reconstructed from the 5.4.0 package contents; no entry was written at the time.*

- `RUNTIME-CONTRACT.json` became the compact parent-facing interface RIA reads instead of the whole skill.
- Under RIA, the skill consumes the immutable `assessment-verification-baseline` and adopts `health_verification.commands` verbatim instead of rerunning the suite.
- `assets/write-health-artifact.js` persists the health artifact under `.project-intelligence/assessments/health/` and, with `--ria-envelope`, returns `ria.owner-return@1`.
- Durable state moved to `shared/project-intelligence-workspace` (`.project-intelligence/`).
- Optional `review-testing` testing-fitness specialist reference on the owner return (superseded in v5.5).

## v5.2 → v5.3: user-elected reports

The validated health island, candidate ledger, and Evidence Recon sidecar are now complete before presentation. Direct runs use `shared/report-election`; nested RIA runs inherit the parent report owner. Skipping HTML no longer affects grading or handoff semantics.

## v5.1 → v5.2: shared Evidence Recon sidecar

Health island schema remains **v5** and candidate spine remains **v3**. This is an additive package integration, not a grading-schema migration.

- Install `shared/evidence-recon` v1 beside the skill.
- A full health run projects its validated health island through `assets/evidence-recon-projection.js`.
- Preserve RHA's eleven-surface inventory, criticality weights, weighted-coverage formula, lane scorecards, caps, and confidence exactly as before.
- Treat projected negative observations conservatively. They remain unresolved unless the current run supplies an explicit negative-claim receipt with scope, methods, completeness, exclusions, sources, and sufficient coverage/evidence quality.
- Emit the generic packet under `.project-intelligence/evidence/health/`; do not write it into tracked repository paths.
- Downstream skills may consume `handoff.safe_to_assume`, `unresolved_facts`, `owner_intent_required`, and `possible_decision_surfaces`, but must retain their own decision-coverage or assessment-coverage sweep.

Existing v5 health islands remain valid. A missing Evidence Recon dependency now blocks the generic sidecar and package release check; it never licenses local reimplementation or hand-edited health arithmetic.

## Health island v4 → v5

v5 is a breaking contract revision. It keeps the health grade formula and shared candidate scoring formula unchanged — `HEALTH_SPINE_VERSION` stays 3, the shared candidate spine is untouched — but closes a sprawl-visibility gap: an island could report clean lane scores while stale, duplicated, or unowned reachable code sat unmentioned anywhere in the evidence.

1. Set `health_schema_version: 5`. `spine_version` stays `3`.
2. Add the required top-level `sprawl_pressure` object: five evidence arrays — `stale_reachable_paths`, `competing_authoritative_implementations`, `duplicated_contract_representations`, `unowned_compatibility_layers`, `abandoned_reachable_experiments` — plus two enums, `automated_sprawl_checks` (`none | partial | enforced`) and `assessment` (`low | moderate | high`). Empty arrays are valid; the key itself is not optional.
3. Every `sprawl_pressure` evidence entry carries a `claim_id` that must resolve to a claim in `claims[]` belonging to the `architecture-fitness` or `maintainability-and-ownership` lane (`sprawl-claim-unknown`, `sprawl-claim-foreign`). This is evidence, not a new lane: it carries no `criticality_weight`, contributes nothing to `overall_raw`, and triggers no cap.
4. `competing_authoritative_implementations[].members` and `duplicated_contract_representations[].locations` each require at least two entries — a single implementation cannot compete with itself, and a contract represented once is not duplicated.
5. Add the `[data-sprawl]` placeholder to custom report shells, immediately after `[data-lanes]`. `runHealth` renders it from the same island via `renderSprawlInto`; a report missing it fails binding (`binding-missing`).
6. If the repository genuinely has no sprawl findings, that is `assessment: "low"` with empty arrays and `automated_sprawl_checks` stating what (if anything) would catch one — never an omitted block.

The grade thresholds, dimension weights, lane weights, baseline ceilings, and priority formula did not change. `sprawl_pressure` informs the `architecture-fitness` and `maintainability-and-ownership` lane claims; it does not add a thirteenth lane or a seventh dimension. See [HEALTH-GRADING.md](HEALTH-GRADING.md#code-sprawl-pressure-as-lane-evidence).

## Health island v3 → v4

v4 is a breaking contract revision. It keeps the health grade formula and shared candidate scoring formula unchanged, but closes report-integrity and handoff gaps.

1. Set `health_schema_version: 4` and `spine_version: 3`.
2. Add top-level `generated`.
3. Add `repository.name`, `repository.revision`, and `repository.freshness_evidence` with `assessment_revision`, `head_revision`, `working_tree_clean`, and `observed_at`.
4. Add a stable `command_id` to every verification command.
5. Add one or more `{kind, ref}` `evidence_refs` to every coverage surface.
6. Emit complete shared-spine v3 candidates: `summary`, `root_cause`, complete `rollup`, `effort`, `depends_on`, `unlocks`, `status`, and `dedup`, in addition to health provenance.
7. For prior candidates that disappear, record a status-specific terminal resolution:
   - `completed`: `completed_at` and non-empty `verification_refs`
   - `superseded`: `superseded_by`
   - `rejected`, `deferred`, or `out-of-scope`: `reason`
8. Replace static lane cards in custom report shells with one `[data-lanes]` host.
9. Fill every `data-prose-required` block. Empty prose turns verification red.

The grade thresholds, dimension weights, lane weights, baseline ceilings, and priority formula did not change.
