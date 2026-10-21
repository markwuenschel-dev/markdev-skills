# RIA Composite Scoring — Specification v3.1

Status: **revised design for implementation review (2026-10-16)** · Supersedes `composite-scoring-v2.md` (all versions) · Targets: `repository-improvement-assessment`, `shared/ria-scoring`, `shared/candidate-ledger-spine`, `shared/software-engineering-intelligence`, `architecture-improvement-intelligence`, `codebase-integrity-audit-loop`, `repository-health-assessment` (RIA-mode inputs and existing vocabulary exports only), `shared/report-presentation`, `shared/ria-owner-return`, `shared/evidence-recon` (validator exports only)

**Revision boundary.** This update changes the two design documents only. Implementation, installation, calibration runs and promotion each need the authority described in the agent instructions.

**Numerical authority.** RIA-owned weights, shares, thresholds and ceilings live in `shared/ria-scoring/composite-v2.config.json`. Owner-owned factors and internal weights remain in their existing canonical exports; the scoring binding records their digests. Tables marked *(config v1)* describe the initial configuration. Validate the config against this contract before using it; a config cannot silently disable a decision or a gate.

**Independent arithmetic checks.** Production code reads policy through the config loader. Tests also use small, hand-authored configurations with literal, independently calculated expected results. Expected values must not be calculated by the production reducer under test. One initial-config golden test pins the approved matrix and its calculated influence.

**Separate presentation policy.** `composite-v2.policy.json` holds `reported_composite` and the calibration-gate reference. It contains no scoring weights. Changing which composite is displayed must not change the scoring config hash or invalidate an otherwise matching calibration receipt.

## 1. Decisions

| # | Decision |
|---|---|
| D1 | Option B: fixed dimensions, each scored by every eligible owner that measures it. |
| D2 | Disagreement lowers confidence only. Agreement never raises confidence. |
| D3 | Caps come from **confirmed failures** (§9.2) plus one evidence-backed **critical-dimension floor** (D7). |
| D4 | Missing evidence is never entered as an observed zero. The point estimate may move as evidence changes; missing applicable evidence makes the result provisional or not gradable and widens its bounds (§8). |
| D5 | Within-dimension owner shares are set so nominal influence falls in a design band of **20–30% per owner** (§4.2). |
| D6 | **Calibration gate first.** v1 stays the reported grade. v2 is computed on every run and shown as an uncalibrated shadow until it passes the gate (§11) and the user approves promotion. |
| D7 | Health's `weakest-critical-lane` cap is not carried into the composite. It is replaced by the critical-dimension floor (§9.3). |
| D8 | Any unscored applicable dimension, or unscored applicable owner within a dimension, prevents a `final` verdict. |
| D9 | Workflow status (`ready`, `blocked`, `needs-human-decision`, `rejected`, `completed`) never affects scoring. Evidentiary state does (§7.2). |

## 2. Review resolution

| Finding | Resolution |
|---|---|
| 1. Influence requirements contradict | One matrix in config; design band 20–30%; tests compute from config (§4.2, §12) |
| 2. Omitting a bad dimension raises a "final" grade | D8 plus score bounds (§8.3) |
| 3. Integrity receipt doesn't show what each dimension inspected | Per-dimension receipts with methods, quality and evidence; "no findings" requires a negative claim with `supports_absence` (§7.1, §7.4) |
| 4. Workflow status used as confirmation | Separate verifier-computed evidentiary state (§7.2) |
| 5. Deduplication incomplete and gameable | Canonical defect groups; strength-weighted dependence threshold (§6) |
| 6. Confidence arithmetic undefined | Per-owner normalization and aggregation (§5.2, §8.4) |
| 7. Failure and cap gaps | Run state, command outcomes, common severity contract (§9) |
| 8. Wrong integration seam | Rendezvous contract built in `scripts/ria.js`; one reader for snapshot and assessment; citations validated against bound bytes (§5.3) |
| 9. Phase dependency | Instructions create the config in Phase 1 and move fixtures forward |
| 10. Architecture unavailable reasons | `architecture.fitness@2` per-dimension state (§5.1) |
| 11. Live installs not isolated | Candidate copy, backup and promotion (instructions Phase 0 and 12) |
| 12. Verification proves too little | Evidence-grounded fixture, adversarial cases, calibration gate (§11, §12) |
| Weakest-critical-lane removal | Critical-dimension floor (§9.3) |

## 3. Prerequisites

| ID | Prerequisite |
|---|---|
| P1 | `finiteOrNull`: missing, `null`, empty or whitespace-only strings, booleans, arrays and objects never become `0`. Finite numbers and non-empty decimal numeric strings are accepted; malformed or out-of-range scores are rejected by the input validator, not silently clamped. Fix `shared/ria-scoring/scoring.js` and `architecture-improvement-intelligence/assets/architecture-fitness.js`. Converge the three guarded copies on the shared helper. Applies to v1 too, since v1 stays reported. |
| P2 | SEI root-commit crash: `trend-baseline.js` `significantHistoryRecord` skips parentless commits; the `parent_count ≥ 1` schema is unchanged. |

## 4. Dimensions, mapping and shares

### 4.1 Dimensions and sources *(config v1)*

| Dimension | Weight | Critical | Health lane | Architecture fitness sub-scores | Integrity | SEI dimension(s) |
|---|---:|:---:|---|---|---|---|
| `correctness` | 20 | ● | `correctness-and-integrity` | — | canonical defects tagged `correctness` | — |
| `architecture` | 15 | ● | `architecture-fitness` | `boundary_integrity`, `dependency_direction_cycle_control`, `cohesion_locality` | — | `architecture` |
| `contracts` | 12 | ● | `contracts-and-integration` | `interface_contract_clarity`, `state_data_ownership` | canonical defects tagged `contracts` | — |
| `verification` | 15 | ● | `verification-readiness` | `architectural_testability_observability` | — | `verification` |
| `delivery` | 8 | | `build-and-delivery` | — | — | `delivery` |
| `maintainability` | 10 | | `maintainability-and-ownership` | `change_containment_evolvability`, `duplication_competing_implementations` | — | `maintainability` |
| `security` | 8 | ● when applicable | `security-and-production-safety` (optional lane) | — | canonical defects tagged `security` | `security` |
| `reliability` | 7 | | — | — | canonical defects tagged `reliability` | `reliability` |
| `change_and_docs` | 5 | | — | — | — | `change_discipline` (10), `documentation` (10), `developer_experience` (6) |

When one owner supplies several sub-scores to a dimension, they combine by that owner's own internal weights, renormalized over eligible sub-scores. Ineligible sub-scores widen that contribution's bounds (§8.3), exactly as a missing owner does.

A dimension is **applicable** unless every mapped owner supplies a validated `not_applicable` declaration with rationale and bound evidence. Missing owners cannot declare absence by omission. A conflict between declarations keeps the dimension applicable and records a limitation. `security` is applicable whenever Health activates its security lane or any owner holds an admissible security-tagged defect. An omitted optional lane is `not_assessed` unless an explicit absence declaration verifies.

Remove verified `not_applicable` owners and sub-scores before normalizing their original shares. If applicable weight is zero, return `not_gradable` with `NO_APPLICABLE_DIMENSIONS`, null point and grade, null bounds and confidence, and zero influence. Core-surface prohibitions still apply.

### 4.2 Owner shares *(config v1)*

| Dimension | Health | Architecture | Integrity | SEI |
|---|---:|---:|---:|---:|
| correctness | 0.35 | — | 0.65 | — |
| architecture | 0.20 | 0.60 | — | 0.20 |
| contracts | 0.20 | 0.55 | 0.25 | — |
| verification | 0.35 | 0.20 | — | 0.45 |
| delivery | 0.50 | — | — | 0.50 |
| maintainability | 0.33 | 0.34 | — | 0.33 |
| security | 0.33 | — | 0.34 | 0.33 |
| reliability | — | — | 0.50 | 0.50 |
| change_and_docs | — | — | — | 1.00 |

**Constraints the config must satisfy**, validated at load:
- Each dimension's shares sum to 1.
- Every share in a multi-owner dimension is ≥ 0.20.
- Architecture's share of `verification` is ≤ 0.20 and of `maintainability` is ≤ 0.34.
- Nominal influence, computed with every owner eligible, is within **[20, 30]** for every owner.

The config v1 values give Health 27.6, SEI 28.2, Integrity 22.2 and Architecture 22.0. A generated script (`shared/ria-scoring/print-influence.js`) prints these from the config. Docs quote the script's output; tests call the computation.

**Renormalization.** When an owner's contribution is not `scored`, or is `dependent` (§6.3), the remaining scored, independent owners' shares are scaled proportionally to sum to 1. That gives the dimension's **point** score. Bounds use the original shares (§8.3).

## 5. Contributions

### 5.1 Contribution states

Each owner × dimension cell has exactly one state:

| State | Produces a score | Effect |
|---|:---:|---|
| `scored` | yes | Contributes its share |
| `dependent` | yes, displayed | Requires an admissible scored origin; redistribute as §8.3 defines. An unresolved origin instead becomes missing evidence. |
| `not_applicable` | no | Removed from the dimension with its share; requires rationale and evidence refs |
| `insufficient_evidence` | no | Widens bounds; dimension cannot be `final` |
| `not_assessed` | no | Widens bounds; dimension cannot be `final` |
| `failed` | no | Widens bounds; run is `degraded` (§9.1) |

`0` is a legal score only when evidence demonstrates absence or failure.

**`architecture.fitness@2`.** Each of the eight dimensions is:

```json
{ "score": null, "state": "unavailable", "reason_code": "NOT_INSPECTED", "detail": "Mapped evidence was not inspected." }
```

- States are `scored`, `unavailable`, or `not_applicable`. A scored value is a finite number in [0, 100]. `reason_code` and non-empty `detail` are required for either other state; absence claims also need bound evidence refs.
- `score` is non-null if and only if `state` is `scored`.
- The writer, normalizer, stored artifact, report model and validator all preserve this structure.
- `architecture.fitness@1` artifacts are read through a migration: a number becomes `scored`, and `null` becomes `unavailable` with reason `LEGACY_NULL`. They are never rewritten in place.

### 5.2 Owner normalization

| Owner | Score (0–100) | Confidence (0–1) | Eligible (`scored`) when |
|---|---|---|---|
| Health | Lane score | `confidence_index / 100` | Lane present and scored; Health not `Not gradable`; `weighted_coverage ≥ 60`. Coverage below 80 makes the contribution provisional. |
| Architecture | Mapped sub-scores combined (§4.1) | Fitness `confidence` in [0, 1]; invalid values are rejected. | ≥ 1 mapped sub-score scored; mapped coverage ≥ 0.6; confidence present. Coverage uses this RIA dimension's mapped sub-scores, not unrelated fitness sub-scores. Any missing mapped sub-score makes the contribution provisional. |
| Integrity | §7.3 | §7.5 | §7.4 |
| SEI | Dimension score | Categorical: `HIGH` 0.90, `MODERATE` 0.65, `LOW` 0.40 | Dimension maturity `provisional` or `established`, and confidence not `NOT_ESTABLISHED`. Otherwise `insufficient_evidence`. A `provisional` maturity makes the dimension provisional. |

Normalized contributions record `maturity: established | provisional | unavailable`. It is established only when eligibility is met, all applicable mapped sub-scores are established and no known evidence limitation makes the contribution provisional. Health coverage of at least 80 is necessary for established maturity. Integrity needs full mapped coverage and admissible evidence for established maturity. This classification does not change any owner's own grade.

For `change_and_docs`, each SEI sub-dimension is evaluated as above. The contribution is `scored` if at least one sub-dimension is eligible. It is provisional if any sub-dimension is ineligible or `provisional`. Its confidence is the weight-weighted mean of eligible sub-dimension confidences.

### 5.3 SEI evidence access

- **Producer.** The rendezvous contract is built in `repository-improvement-assessment/scripts/ria.js` (`collectOwnerRendezvous`, ≈ line 90). It gains a `sei` block naming one canonical reader module and export, the bound `engineering_intelligence_ref` (snapshot), and the bound `sei_assessment_ref` (scored criterion assessment, with its hash).
- **Envelope and schema.** Preserve the exact existing closed `input_binding_echo` shape; `contract` is not an owner-return field. Reuse the existing complete `sei_assessment_ref` contract, including `assessment_id`, snapshot/rubric/standard/config bindings, `artifact_path` and `artifact_sha256`. Do not substitute an invented `{artifact_id, sha256}` reference.
- **Reader.** One export returns both verified artifacts. Preserve `readEngineeringIntelligenceArtifact` for its existing callers; implement the combined reader alongside it or as an additive export. Reuse `assertSeiAssessmentRef` and enforce path containment before reading. Re-hash before parsing and check exact repository, revision, snapshot ID and digest, baseline, scope, mission and available rubric/config bindings. A same-revision assessment from another snapshot is not interchangeable. Owners call the reader with the bound envelope and repository context; writer correctness must not depend on a separate rendezvous object being supplied on its CLI.
- **Missing versus corrupt.** An absent legacy assessment may produce a visible degraded shadow when authorized. Hash mismatch, malformed bytes, path escape or a conflicting binding is a typed blocker. Never turn tampered evidence into an ordinary missing contributor.
- **Citations.** An evidence entry `{ "kind": "sei-criterion", "criterion_id": "", "metric_id": "" }` is valid only if that criterion **and** metric exist in the **bound assessment bytes**, not merely in the rubric. This is checked twice:
  - in the owner's writer (fail fast)
  - authoritatively in RIA's owner-artifact verification node

## 6. Evidence identity, dependence and canonical defects

### 6.1 Evidence keys

| Kind | Key | Match rule |
|---|---|---|
| Code | `repository_id : root_id : revision : normalized_relative_path : [start, end]` | Same binding/path and overlap ≥ 50% of the shorter inclusive range. Whole-file evidence is a discovery match only. Match candidates are not automatically the same defect (§6.4). |
| SEI metric | `assessment_sha256 : criterion_id : metric_id` | Exact, with criterion-to-metric membership verified against the bound assessment |
| Command | `verification_baseline_sha256 : command_id` | Exact. A shared receipt is one source, not independent corroboration for every owner citing it. |

Claim IDs and candidate IDs are records, not evidence. Resolve them to bound evidence before matching. Normalize separators and dot segments, reject path escape and inverted/invalid line ranges, and use the assessed root's case policy. A reproduction or analyzer key also includes its check ID and input/output receipt digest. Deduplicate identical keys before strength arithmetic so copying a citation cannot alter independence.

### 6.2 Origin and strength

- **Origin.** Each evidence key an owner holds is `original` or `adopted`. It is `adopted` when:
  - it arrives through an explicit adoption link (a candidate held under another owner's namespace, or Architecture's `health_context`), or
  - it is an `sei-criterion` entry held by a non-SEI owner.
- **Strength.** Each key carries the Evidence Recon quality (`strong`, `moderate`, `weak`). Quality names come from Evidence Recon; numerical factors come from Health's existing `HEALTH_EVIDENCE_FACTOR` export, imported rather than copied.

### 6.3 Contribution dependence

Use only unique, rubric-relevant primary facts actually consumed by the score. Let A be the sum of imported quality factors for adopted facts, and O the sum for strong/moderate original facts; weak original facts have zero independence credit. Compute A / (A + O), with a zero denominator giving insufficient evidence. The strong-original requirement still applies. Unrelated observations, splitting one fact into several keys and adding weak original citations cannot buy an independent vote. A contribution with adopted strength of at least 50% is `dependent` only if its adopted facts resolve to an admissible scored origin in this dimension. Record those origin links. Evidence without a strong original source is not independent: if it has no scored origin, classify it `insufficient_evidence`, not an ignorable dependency. Resolve origin links as a graph; cycles or orphaned origins cannot remove uncertainty.

A shared verification command is attributed once, to Health for the verification or delivery dimension as appropriate. Another owner relying only on that receipt is dependent, not an additional independent measurement. Strong original structural or test evidence may still support a separate assessment. Zero total evidence strength is `insufficient_evidence`.

Redistribution follows §8.3 and preserves the mass of missing owners. Adding weak original keys or repeated citations cannot rehabilitate an adopted contribution. Agreement never raises confidence. Disagreement includes scored and dependent judgments, including disagreement over a shared source; shared-source agreement is explicitly labeled dependent agreement.

### 6.4 Canonical defects

Findings from all owners are merged into **canonical defect groups** by the union of:
1. explicit links (`dedup.duplicate_group`, `dedup.merged_from`, adoption of another owner's `candidate_id`)
2. the same normalized, evidence-backed failure predicate and input binding, the same RIA dimension and defect class, and matching primary evidence keys (§6.1). Code location overlap alone is insufficient. Validate explicit duplicate links as well; a generic group label cannot merge unrelated assertions.

Each group has:
- **severity:** the maximum severity among its members with a confirmed evidentiary state (§7.2)
- **evidentiary state:** the strongest admissible positive proof, with refutation and contradiction handled under §7.2 rather than by a simple max
- **discovering owners:** all members' owners, with origin

Group IDs and member order are deterministic under input permutation. Potential duplicates lacking enough evidence for reconciliation are recorded as unresolved and prevent a final Integrity contribution; they cannot silently inflate the count or erase a defect. A group counts **once** for caps (§9) and once in each Integrity dimension score. Integrity's score uses the groups Integrity holds (original or adopted). Integrity's contribution then goes through §6.3 like any other, so a ledger made mostly of adopted Health findings is dependent.

**New fields** (optional in the spine, required for Integrity-minted findings in RIA mode):
- `ria_dimensions`: a non-empty subset of `correctness`, `contracts`, `security`, `reliability`
- `defect_class`: `logic-error`, `contract-drift`, `missing-validation`, `security-exposure`, `failure-handling`, `concurrency`, `data-integrity`, `stale-or-dead-path` or `other`

Normalization derives the dimension tags of adopted findings from validated upstream `lane_sources` using a config mapping. Preserve their original ID and provenance; do not invent a new finding. Missing or ambiguous tags yield an explicit limitation and insufficient evidence for affected contributions, not silent exclusion. The normalized failure predicate and provenance are derived evidence fields, not workflow status.

## 7. Integrity

### 7.1 Per-dimension coverage receipt (`integrity.coverage@2`)

```json
"coverage": {
  "schema_version": "integrity.coverage@2",
  "dimensions": {
    "correctness": {
      "surfaces": [{
        "surface_id": "runtime-code",
        "criticality_weight": 5,
        "state": "inspected | sampled | inventory-only | uninspected | unavailable | not-applicable",
        "evidence_quality": "strong | moderate | weak | none",
        "methods": ["..."],
        "scope": "...",
        "evidence_refs": ["..."],
        "reason": null,
        "weight_rationale": null
      }],
      "negative_claims": []
    }
  }
}
```

**Vocabularies.** Use the 11-surface default inventory and the criticality weights from `repository-health-assessment/COVERAGE-MODEL.md`. Use the coverage states and credits, evidence quality, and negative-claim receipt from `shared/evidence-recon`. Import states and negative-claim validation from Evidence Recon, and `HEALTH_DEFAULT_SURFACES`, `HEALTH_COVERAGE_CREDIT` and `HEALTH_EVIDENCE_FACTOR` from Health's existing exports. Evidence Recon does not own the numerical credits or factors. Add only a thin exported validation wrapper if needed; preserve the generic validator's semantics.

**Rules:**
1. **Inspection is per dimension.** A surface entry counts only for the dimension it is recorded under. Inspecting `runtime-code` for correctness gives security no coverage unless a security entry records security-specific methods (for example, authorization review or a secret scan) and its own evidence.
2. **Evidence refs.** `evidence_refs` is non-empty for `inspected`, `sampled` and `inventory-only`. `inspected` cannot pair with `weak` (Evidence Recon rule).
3. **Completeness.** Every surface mapped to the dimension (config `integrity_surface_map`) must appear. A core surface may never be `not-applicable`.
4. **Computed coverage.** Dimension coverage = Σ(criticality × state credit × quality factor) ÷ Σ criticality over applicable mapped surfaces. Duplicate surface IDs, unresolved refs, cross-revision refs and missing mapped entries fail validation. Zero applicable denominator requires a verified absence declaration. A declared coverage number is rejected.
5. **Absence scope.** A generic negative-claim receipt alone is insufficient. Its search inventory must cover every applicable mapped surface and recorded scope, exclusions must not remove any claim being graded, and methods must address the dimension's configured defect checks. A receipt about one file or one defect class cannot establish repository-wide absence. Treat a 100 as no confirmed defects under this inspected rubric, not proof of no possible defects.

### 7.2 Evidentiary state (computed, never declared)

| State | Requires | Confirmed? |
|---|---|:---:|
| `reproduced` | A failing test, command or runtime reproduction receipt | ✔ |
| `mechanical` | A deterministic analyzer or bound SEI metric | ✔ |
| `observed` | Bound `strong` direct evidence verifies the exact failure predicate recorded in a non-empty confirmed observation | ✔ |
| `inferred` | `moderate` or `weak` evidence, or any judgment-only basis (`review_source.proof_basis: "judgment"`) | ✘ |
| `refuted` | A counter-evidence receipt | excluded |

The verifier checks the source receipt and its exact assessed binding; naming an evidence kind or supplying `observation.confirmed` text is not sufficient. A failing reproduction must demonstrate the asserted expected/actual mismatch; harness errors, missing dependencies and an unconditional non-zero exit are not reproductions. A bound metric confirms only the proposition it actually measures. Numerical severity is a separately justified assessment, not proof supplied by the metric.

Workflow status is never an input (D9). A `refuted` result requires admissible counter-evidence resolving the same failure predicate at the assessed baseline. Conflicting confirmed and counter-evidence is `contested` until an auditable resolution receipt explains the contradiction. It is not resolved by selecting the newest record or the workflow word `rejected`. Contested groups cannot support absence, final scoring or a new critical-failure cap. Preserve their limitations and admissible positive evidence for review.

### 7.3 Integrity dimension score *(config v1)*

The score comes from confirmed canonical defect groups in the dimension. It is worst-dominated and never divided by inspected volume:

| Worst confirmed severity | Ceiling | Each further confirmed group | Floor |
|---:|---:|---:|---:|
| 5 | 40 | −3 | 25 |
| 4 | 60 | −3 | 45 |
| 3 | 75 | −2 | 60 |
| 2 | 90 | −2 | 80 |
| 1 | 97 | −1 | 90 |

**No confirmed defects** scores 100 **only** if the dimension has a negative claim with `supports_absence: true`. Evidence Recon already requires such a claim to have inspected coverage, `strong` or `moderate` evidence, `bounded-exhaustive` or `repository-exhaustive` completeness, and non-empty scope, methods and sources, scoped over the dimension's mapped surfaces. Without that claim the contribution is `insufficient_evidence`, not 100. Sampling every surface therefore cannot produce a 100.

### 7.4 Integrity eligibility *(config v1)*

| Dimension coverage | State |
|---|---|
| ≥ 0.60 | `scored` (subject to §7.3's negative-claim rule) |
| 0.40 – < 0.60 | `scored`, and the dimension is provisional |
| < 0.40 | `insufficient_evidence` |

### 7.5 Integrity confidence

Let Q_surface be the criticality-weighted mean quality factor of applicable mapped surface entries. Let Q_defect be the severity-weighted mean quality factor of unique confirmed groups' primary evidence; when there are none, use the validated negative-claim evidence quality. Confidence = dimension coverage × min(Q_surface, Q_defect). Every denominator and deduplication rule is explicit; absent required evidence yields null confidence and insufficient evidence, not a default 1. This is a conservative rubric index, not a probability.

## 8. Verdicts, missing data, bounds and confidence

### 8.1 Dimension verdicts

| Verdict | Condition |
|---|---|
| `not_applicable` | §4.1 |
| `not_scored` | No contribution `scored` (dependent contributions alone do not count) |
| `provisional` | Any applicable owner is missing; any scored contribution has incomplete sub-scores, provisional maturity or unresolved contradictions; or exactly one independent owner scored where multiple applicable, non-dependent owners remain |
| `scored` | Otherwise |

### 8.2 Composite status

| Status | Condition |
|---|---|
| `not_gradable` | Any applicable critical dimension is `not_scored`, **or** scored weight < 70% of applicable weight |
| `provisional` | Not `not_gradable`, **and** (any applicable dimension is `not_scored` or `provisional`, **or** run state is `degraded`) |
| `final` | Otherwise. Every applicable dimension is `scored`, and the run is `complete`. |

### 8.3 Point score and bounds

Apply the same reduction at each level: owner sub-scores, owners within a dimension, then dimensions within the composite.

1. Remove only validated `not_applicable` entries and normalize their configured weights. Resolve dependence first. A dependent entry can leave the denominator only when its scored origin verifies. Redistribute that mass proportionally across **all** remaining applicable entries, including missing entries. Call the resulting weights b; they sum to 1.
2. For scored entries S and missing entries M, point = Σ_S(b × point) / Σ_S b. If S is empty, point is null. Use each scored entry's already-computed interval [lower, upper]; a fully assessed scalar has [score, score].
3. Lower = Σ_S(b × lower). Upper = Σ_S(b × upper) + 100 × Σ_M b. Thus missing sub-scores propagate their intervals rather than being replaced by their owner's renormalized point.

At the top level, use dimension weights divided by total applicable weight. Composite point renormalizes over dimensions with a point; composite bounds retain every applicable dimension. A dimension with no point has [0, 100]. Report original, bound and point-effective weights separately; never use point-effective weights to calculate missing mass. Dependent-only cycles become missing, not an empty denominator that appears fully covered.

**Worked examples:**
- Delivery 0 and everything else 100: point 92, bounds [92, 92], final.
- Delivery unassessed: point 100, bounds [92, 100], provisional.
- Two owner shares [0.5, 0.5], scores [80, missing]: point 80, bounds [40, 90].
- Shares [0.2, 0.3, 0.5] for [dependent-with-scored-origin, scored 80, missing]: redistribute the first share over both remaining entries to obtain bound shares [0.375, 0.625]; point 80, bounds [30, 92.5]. Missing mass has not vanished.

Keep raw and capped bounds separately. Apply each established unconditional cap with min(value, ceiling) to point and both endpoints; do not increase confidence when a cap narrows the interval. Always verify lower ≤ point ≤ upper when a point exists. These are worst/best missing-score bounds under the current rubric, not statistical confidence intervals and not bounds on undiscovered defects.

For `not_gradable`, suppress the composite point and letter (raw and final are null). Diagnostic bounds may still be shown when applicable weight is positive. For other non-final results, make status and bounds the headline; a conditional point may appear alongside them, never as a standalone A+.

### 8.4 Confidence

1. **Contribution confidence:** §5.2, §7.5.
2. **Dimension base confidence:** share-weighted mean over scored contributions, using renormalized shares.
3. **Disagreement:** spread = max − min over scored and dependent contributions. If spread > 20 *(config v1)*, mark the dimension `contested` and multiply by `max(0.5, 1 − (spread − 20) ÷ 80)`.
4. **Completeness:** multiply by Σ_S(bound_share_i × internal_completeness_i). Internal completeness is the recursively retained scored mass of an owner's applicable sub-scores; it is 1 for an eligible scalar and 0 for a missing scalar. Coverage already incorporated into owner confidence is not substituted for this mass a second time. Dependent evidence with a scored origin does not count as missing; an orphaned origin does. Missing owners therefore reduce confidence and widen bounds.
5. **Composite confidence:** Σ_S(w × dimension confidence) ÷ Σ_A w. Unscored applicable dimensions contribute 0.
6. **Band:** `high` ≥ 0.75, `moderate` ≥ 0.50, `low` < 0.50.

## 9. Run state, verification outcomes and caps

### 9.1 Run state

- `run_state` is `complete` or `degraded`.
- It is `degraded` when an assessment task fails or an allowed legacy/missing artifact leaves failed contributions. Tampering and binding violations block (§5.3); invalid evidence is never used to grade.
- A degraded run is never `final`.
- `allow_degraded` lets the run finish and render. It never changes the verdict, and it adds a `status_reasons` entry.

### 9.2 Verification outcomes and confirmed-failure caps

| Outcome | Test command | Non-test command (build, lint, typecheck, other) |
|---|---|---|
| `fail`: ran to completion, non-zero exit | Cap C: `verification-tests-failing` | Cap C: `verification-checks-failing` |
| `error`: could not start, or the harness failed | Baseline-dependent verification contributions become `insufficient_evidence`; verification cannot be final | Affected baseline-dependent contributions become `insufficient_evidence`; a required unexecuted check prevents final status |
| `timed-out` | As `error`; the RIA blocking rule still applies unless `allow_degraded` | As `error` |
| `skipped` (documented) | As `error` | Neutral (matches Health) |
| No commands | Verification contributions `insufficient_evidence`; unverified banner | — |

**Cap rubric.** All v2 ceilings are numerical values on RIA's thirteen-band scale: C = 76.9, D = 66.9, D+ = 69.9 *(config v1)*. Ceilings use one-decimal precision, so D+ cannot round up to 70/C−. Persist full-precision point and bounds and derive the letter from the exact capped point. Render a non-negative point by flooring to one decimal; render interval endpoints outward. This keeps the displayed point in its letter band without understating the missing-score interval.

Evaluate admissible cap triggers before score eligibility: a confirmed defect is not erased because its owner lacks enough coverage to issue a score. A recorded test contains a failure only if a verified runtime guard or passing prevention check proves the harmful behavior is blocked on the assessed path; a failing reproduction or the mere existence of a test is not containment.

**`confirmed-critical-failure` (cap D).** Fires when a canonical defect group:
- has a confirmed evidentiary state (§7.2)
- has severity ≥ 4 on the spine 1–5 scale
- is on an applicable critical dimension
- is not contained by a recorded test or guard

**Severity contract:** use validated spine `scores.severity` on its 1–5 rubric, with the following explicit Health exception. Severity never comes from SEI's differently scaled deficiency value.
- Health's validated `uncontained_critical_failure` is the explicit severity-5 exception: preserve its failing non-judgment claim and baseline binding, even when no candidate row exists.
- Architecture candidates are cap-eligible only through their `ledger_candidate_ref`.
- SEI deficiencies are never cap-eligible; they affect dimension scores only.

### 9.3 Critical-dimension floor (D7)

If an applicable critical dimension:
- has a **point** score below 50 *(config v1)*,
- has verdict `scored` (not provisional), and
- has at least two independent contributors with established maturity and strong original evidence, each satisfying its applicable completeness rules; shared receipts do not satisfy this twice,

then the composite ceiling is **69.9 (D+)**. This is the top of the next broad letter band above F under the chosen policy, expressed numerically rather than an ambiguous plus/minus-band step. It is recorded as `critical-dimension-floor` with the dimension ID.

For example, Architecture 0 with every other dimension at 100 produces D+ (69.9), not B+ (85).

Caps record `cap_id`, the trigger (finding group ID, command ID or dimension ID) and the ceiling. Caps that fire but don't bind are still listed.

## 10. Output contract (`ria.composite@2`)

```json
{
  "schema_version": "ria.composite@2",
  "reported": false,
  "calibration_state": "uncalibrated | calibrated",
  "config": { "config_version": "", "config_sha256": "", "implementation_sha256": "" },
  "presentation": { "policy_sha256": "", "calibration_ref": null },
  "source_bindings": [],
  "status": "final | provisional | not_gradable",
  "status_reasons": [],
  "run_state": "complete | degraded",
  "point": { "raw_score": null, "final_score": null, "final_grade": null },
  "bounds": { "raw": { "lower": null, "upper": null }, "final": { "lower": null, "upper": null } },
  "caps": [{ "cap_id": "", "trigger": "", "ceiling": 0, "binding": false }],
  "confidence": { "value": null, "band": "" },
  "applicable_weight": 0, "scored_weight": 0,
  "weakest_critical_dimension": { "id": "", "point": null, "verdict": "" },
  "dimensions": [{
    "id": "", "weight": 0, "critical": true, "verdict": "",
    "point": null, "lower": null, "upper": null,
    "confidence": null, "contested": false, "spread": null,
    "contributions": [{
      "owner": "", "state": "", "score": null,
      "original_share": 0, "bound_share": 0, "effective_share": 0,
      "lower": null, "upper": null, "completeness": null, "maturity": "unavailable",
      "origin_refs": [], "limitations": [],
      "confidence": null, "coverage": null, "provisional": false,
      "adopted_strength_ratio": null,
      "evidence_keys": [{ "key": "", "origin": "", "quality": "" }]
    }]
  }],
  "canonical_defects": [{ "group_id": "", "members": [], "dimension": "", "severity": null, "evidentiary_state": "", "owners": [] }],
  "influence": { "nominal": {}, "effective": {} }
}
```

`reported` is false until a matching calibration receipt and presentation policy are validated by the report binder. `effective` influence is each owner's point-effective share of the scored dimension weight; missing-owner bound mass is reported separately, not called influence. With no scored weight, all influence values are zero (their sum is zero, not 100). Canonicalize set-valued inputs, group IDs and cap ordering; output contains no generated timestamp. Source bindings pin every artifact, while implementation binding covers reducers, normalized-input schema and imported factors. The same normalized evidence, scoring config, implementation and presentation policy produce byte-identical output.

## 11. Calibration gate and promotion (D6)

**Shadow mode.** The separate presentation-policy field `reported_composite` is `"v1"`. The report keeps v1 as the headline and shows v2 in a section labeled **"v2 composite — uncalibrated shadow"**.

**Calibration cases.** The user supplies 3–5 repositories with independently agreed health, as `calibration/cases/<id>.json`:

```json
{ "repository": "", "revision": "", "agreed_grade_letter": "A|B|C|D|F", "agreed_rank": 1, "rationale": "" }
```

**Gate inputs.** Before running v2, freeze case revisions, independently agreed letters/ranks, acceptable evidence requirements and rationales in a hashed case manifest. Calibration is inadmissible while required critical evidence is missing or contested. Require final evidence verdicts, then compare broad letters A/B/C/D/F (strip plus/minus) and use capped point scores for ranking, with explicit ties. A null point cannot pass ordering or accuracy. Reserve at least one case from parameter tuning; once its result informs tuning, obtain a fresh held-out case before claiming validation.

**Gate criteria.** All must pass:
1. **Ordering:** no pair is inverted when their agreed letters differ.
2. **Accuracy:** each case's v2 point letter is within one letter of the agreed letter.
3. **Determinism:** the same source artifacts, config, implementation and policy produce byte-identical composite output, including after input permutation.
4. **Stability:** force fresh Health/Integrity/Architecture owner returns on the same revision and fixed snapshot, SEI assessment and verification baseline; reuse must not satisfy this repeat. Point movement is ≤ 5, and status, critical-cap set and admissible finding identities do not change unexplained.
5. **Honesty:** no case is `final` while any applicable dimension is unscored.

**Changes.** Any scoring config change bumps `config_version`. A config, reducer, normalization/schema or imported-factor change invalidates the prior gate and requires the whole gate again. A presentation-only promotion does not change the scoring binding. Store a content-addressed gate receipt naming the case-manifest hash, scoring-config hash, implementation hash, input artifact hashes, before/after owner-return hashes and every criterion result. A user approval identifies that exact passing receipt; an unbound boolean `calibrated` is not authority. Publish the portable, verified receipt and case-manifest bundle with the presentation policy. Runtime verification must not depend on an abandoned candidate directory or mutable calibration report path.

**Promotion** (user approval required):
1. After approval of the exact passing receipt, set the presentation policy to `reported_composite: "v2"` and its `calibration_ref`. The report binder derives `calibrated`/`reported` only after verifying that receipt against the current scoring and implementation bindings. Subsequent scoring changes return v2 to shadow until recalibrated.
2. In a separate later change, remove v1.

## 12. Required tests

**Arithmetic and contracts**
1. `finiteOrNull` and `weightedComposite({})` (P1). Architecture with one `null` dimension: 80, not 72.
2. Config validation rejects shares not summing to 1, a share < 0.20, an Architecture cap breach, or nominal influence outside [20, 30].
3. Influence computed from config matches `print-influence.js` output.
4. Renormalization: dependent and missing contributions redistribute; bounds use original shares.
5. Bounds math, including the §8.3 worked example.
6. Confidence: the SEI categorical mapping; `NOT_ESTABLISHED` gives `insufficient_evidence`; the completeness multiplier; the contested multiplier.
7. `architecture.fitness@2` round-trips writer → artifact → report with reasons preserved. An `@1` artifact migrates on read.

**Adversarial**
8. Omitting a low dimension never yields a higher **final** grade (D8).
9. Omitting a low owner within a dimension never yields a higher final grade.
10. Changing only workflow status leaves the decision projection unchanged: point, bounds, verdicts, confidence, caps, influence and canonical defect identities (D9). Raw source-binding hashes may change because artifact bytes changed. Keep that provenance change visible; never falsify a byte hash to make a test pass.
11. Integrity sampling every mapped surface with no negative claim is `insufficient_evidence`, never 100.
12. Inspecting `runtime-code` for correctness gives security zero coverage.
13. The same defect reported by Health and Integrity forms one canonical group: counted once for caps and once in Integrity's score.
14. A mostly adopted Integrity contribution plus one minor original observation stays `dependent`.
15. Health lane evidence that is ≥ 50% SEI citations makes Health `dependent` in that dimension.
16. A citation to a criterion present in the rubric but absent from the bound assessment is rejected.
17. Architecture 0 and everything else 100 caps at D+ when the established, independently evidenced prerequisites hold. One source, shared receipts or provisional evidence alone cannot trigger the floor.
18. A failing lint command caps at C. An errored or timed-out test command does not cap, and makes verification provisional.
19. A degraded run is never `final`, with or without `allow_degraded`.

**Integration**
20. An evidence-grounded fixture repo with planted known properties produces owner artifacts whose evidence matches its files, and a v2 shadow composite whose findings include each planted defect exactly once.
21. The SEI root-commit regression repo completes SEI (P2).
22. The report renders v1 headline plus v2 shadow with no console errors at 1440 px and 390 px.
23. Every pre-existing suite at baseline or better, including `shared/report-presentation` tests and all package checks.
24. Hierarchical bounds: NA renormalization, missing sub-scores, orphaned/cyclic origins, all-dependent and zero-applicable cases, and [30, 92.5] in §8.3. Point-effective weights never replace bound shares.
25. A cap ceiling of 69.9 displays D+ and never 70; a failing reproduction is not containment. Insufficient coverage cannot hide an admissible critical failure.
26. Duplicate citations, overlapping-but-distinct defects, broad duplicate labels, contradictory/refuted evidence, stale receipts and mixed-root paths cannot alter truth or inflate independence.
27. Same-revision/wrong-snapshot assessment, metric with wrong criterion membership, path escape, hash tampering and malformed bytes block; genuinely missing legacy input follows explicit degraded policy.
28. A presentation-only promotion preserves the scoring binding and its gate. Any scoring or implementation change invalidates the gate. Hand-calculated golden cases catch a deliberately perturbed reducer.
29. Promotion preflight rejects live files changed since the candidate baseline; rollback restores only the published path set and preserves unrelated work.

## 13. Calibration items (config)

| ID | Item | Config v1 |
|---|---|---|
| C1 | Dimension weights | §4.1 |
| C2 | Owner shares | §4.2 |
| C3 | Owner eligibility thresholds | §5.2, §7.4 |
| C4 | Contested threshold and decay | 20; §8.4 |
| C5 | Integrity ceilings and steps | §7.3 |
| C6 | Integrity surface → dimension map | `correctness`: runtime-code, domain-libraries, data-lifecycle · `contracts`: contracts-and-wiring, generated-surfaces · `security`: runtime-code, contracts-and-wiring, specialized-paths · `reliability`: runtime-code, operational-behavior |
| C7 | Critical-floor threshold | 50 |
| C8 | Dependence threshold | 0.50 strength-weighted |
| C9 | SEI confidence mapping | 0.90 / 0.65 / 0.40 |
| C10 | Not-gradable scored-weight floor | 70% |
| C11 | Cap ceilings on RIA scale | C 76.9; D 66.9; D+ 69.9 |
| C12 | Critical-floor independent established sources | 2 minimum |

**Revision note — 2026-10-16:** v3.1 makes missing-mass arithmetic recursive and explicit, separates scoring identity from presentation promotion, binds truth/citations to actual artifacts, and closes display, calibration and publication gaps. These are document changes; no runtime gates have been run or claimed.
