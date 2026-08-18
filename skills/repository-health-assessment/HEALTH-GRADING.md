# Health Grading

The A–F rubric, the caps, and the confidence index. [COVERAGE-MODEL.md](COVERAGE-MODEL.md) supplies the denominator; this file turns lane evidence into a grade. `assets/health-verify.js` owns the arithmetic in code — every formula here exists in exactly one place there, and the report renders from that, never from a hand-typed number.

## Lanes are not candidate categories

A candidate category describes **what kind of problem was found**. A lane describes **which system capability is being assessed**. The two are orthogonal on purpose: one contract-drift finding can inform both the contracts lane and the architecture lane, which is why candidates carry `lane_sources` as an array.

### Required lanes

Always assessed. Absence of evidence in a required lane is a level-0 finding, not an excuse to skip it.

| Lane id | Assesses | Weight | Critical |
| --- | --- | ---: | :---: |
| `correctness-and-integrity` | Reachable defects, stale paths, invariant protection | 5 | ● |
| `architecture-fitness` | Dependency direction, boundaries, coupling, structural drift | 4 | ● |
| `contracts-and-integration` | Ownership, schema consistency, data flow, cross-layer wiring | 4 | ● |
| `verification-readiness` | Testability, harness quality, baseline trustworthiness | 4 | ● |
| `build-and-delivery` | Build reproducibility, CI enforcement, release confidence | 3 | |
| `maintainability-and-ownership` | Clarity, duplication, dead code, change containment | 2 | |

### Optional lanes

Activate only when the repository actually has the surface. An irrelevant scorecard is noise, and a lane scored 0 because it does not apply corrupts the weighted mean.

| Lane id | Activate when | Weight | Critical |
| --- | --- | ---: | :---: |
| `data-and-migrations` | Persistent state with schema evolution | 4 | ● |
| `security-and-production-safety` | Authn/authz, secrets, PII, or public exposure | 5 | ● |
| `numerical-correctness` | Financial, scientific, or statistical computation | 4 | ● |
| `gpu-equivalence` | CUDA/Metal/ROCm kernels with a CPU reference path | 3 | |
| `performance-and-resources` | Stated latency, throughput, or memory budgets | 3 | |
| `platform-compatibility` | More than one supported OS, runtime, or architecture | 2 | |

**Optional lanes must be declared, not merely omitted.** Every optional lane appears either in `lanes` (scored) or in `lane_applicability` with `state: not-applicable`, a `rationale`, and `surface_refs` naming the inventory surfaces that justify it. Silence is not a declaration, and without this the three most expensive optional lanes — data, security, numerical — could simply vanish from a repository that plainly has those surfaces.

```yaml
lane_applicability:
  data-and-migrations:
    state: applicable
    surface_refs: [data-lifecycle]
    rationale: Repository contains versioned database migrations.
  gpu-equivalence:
    state: not-applicable
    surface_refs: [specialized-paths]
    rationale: No GPU implementation exists.
```

**Lane weights are locked.** They live in `HEALTH_LANE_DEFINITIONS` in the verifier, not in the island. An island may restate a weight for readability, but a value that disagrees is rejected (`lane-weight-locked`). A free weight is the cheapest possible way to launder a bad grade: demote the failing critical lane to weight 1 and it both escapes the weakest-critical-lane cap and stops pulling on the mean. **Critical lane** means weight ≥ 4.

## The maturity scale

Every dimension of every lane is scored against this one scale. Reusing a single scale is what makes lane scores comparable.

| Level | Meaning |
| ---: | --- |
| 0 | Absent, broken, or no trustworthy evidence |
| 1 | Ad hoc; primarily dependent on manual knowledge |
| 2 | Partial; some controls exist but coverage or enforcement is inconsistent |
| 3 | Mostly systematic; important paths are covered and enforced |
| 4 | Systematic and regression-resistant; controls are automated, owned, and observable |

The jump from 2 to 3 is *enforcement*, and from 3 to 4 is *automation plus observability*. A practice that a careful human performs reliably is a 2; the same practice failing the build when violated is a 3.

### Lane anchors for level 3

The generic scale needs a concrete referent per lane, or "mostly systematic" drifts to mean whatever the assessor hoped. Level 3 in each lane looks like:

| Lane | Level 3 anchor |
| --- | --- |
| `correctness-and-integrity` | Invariants are asserted in code or tests on the paths that carry them; a violation fails a run rather than being noticed in review |
| `architecture-fitness` | Dependency direction is enforced by a lint rule, build graph, or module system — not by convention |
| `contracts-and-integration` | Each public contract has one authoritative definition, and consumers are generated or checked against it |
| `verification-readiness` | Core paths are covered by tests that run in CI and fail loudly; the suite is trusted enough that a red run blocks a merge |
| `build-and-delivery` | CI runs the same commands developers run, from a clean checkout, and a failure blocks release |
| `maintainability-and-ownership` | Ownership is recorded and current; dead paths are removed rather than accumulating |
| `data-and-migrations` | Migrations are versioned, reversible or explicitly one-way, and exercised before release |
| `security-and-production-safety` | Authn/authz and secret handling are centralised and covered by automated checks |
| `numerical-correctness` | A reference implementation and tolerance are defined, and results are compared automatically |
| `gpu-equivalence` | A CPU reference path exists and equivalence is asserted within a stated tolerance in CI |
| `performance-and-resources` | Budgets are stated and regressions are detected automatically |
| `platform-compatibility` | Every supported platform is built and tested in CI |

Level 4 adds observability and ownership on top of the anchor; level 2 has the control but not the enforcement; level 1 has the knowledge but not the control.

### Code-sprawl pressure as lane evidence

The island's `sprawl_pressure` block (schema v5) surfaces stale reachable paths, competing authoritative implementations, duplicated contract representations, unowned compatibility layers, and abandoned reachable experiments. It is **not** a thirteenth lane and does not add a seventh dimension — read [COVERAGE-MODEL.md](COVERAGE-MODEL.md)'s criticality rule before treating any of this as a size or count argument. What it does is give `architecture-fitness` and `maintainability-and-ownership` concrete, countable evidence for dimension levels that would otherwise rest on impression. Every entry's `claim_id` must belong to one of those two lanes (`sprawl-claim-foreign` otherwise), so a `sprawl_pressure` finding is always eligible to become a `claim_refs` entry on one of their dimensions — it does not automatically become one; the assessor still writes the `support` line.

How the arrays read against the level-3 anchors above (`architecture-fitness`: "dependency direction is enforced by a lint rule, build graph, or module system — not by convention"; `maintainability-and-ownership`: "ownership is recorded and current; dead paths are removed rather than accumulating"):

- **`competing_authoritative_implementations` non-empty** is direct evidence against `architecture-fitness`'s `boundary_clarity` — if two reachable implementations both claim authority, the authoritative definition is not identifiable, which is the level-3 anchor's own condition stated in the negative. A non-empty group with `automated_sprawl_checks: none` caps that dimension's plausible level at 2: the control (recognising the duplication) exists in the assessor's head, not in anything that would catch a third competing implementation appearing.
- **`duplicated_contract_representations` non-empty** is the same argument aimed at whichever lane's claim it cites — most often `architecture-fitness` when the duplication is structural, `contracts-and-integration` claims remain the primary home for a contract-shape finding (`claim_refs` there still point at `contracts-and-integration`; `sprawl_pressure` only ever cites `architecture-fitness` or `maintainability-and-ownership`, so use it here for the architectural-boundary angle of the same fact, not the contract-ownership angle).
- **`stale_reachable_paths` and `abandoned_reachable_experiments` non-empty** are direct evidence against `maintainability-and-ownership`'s `change_containment` and `observed_soundness` — a path that still executes but serves no current purpose is exactly what the level-3 anchor means by "dead paths are removed rather than accumulating," read as failing. `automated_sprawl_checks: enforced` (a dead-code or unused-export lint actually running) is what would let `automated_enforcement` reach level 3 on this evidence instead of capping at 2.
- **`unowned_compatibility_layers` non-empty** is direct evidence against `maintainability-and-ownership`'s `boundary_clarity` and `change_containment` — a shim nobody owns is a boundary nobody can name, and a change near it has no one to contain the blast radius.
- **`assessment: high`** does not by itself force a dimension level down; it is a summary judgment, not a fourth arithmetic path (the same reason `HEALTH-GRADING.md`'s "Stamped deviation" rejected `score_effect`). It is the prompt to go read the arrays and write `claim_refs` and `rationale` that actually justify whatever level results.

None of this changes `lane_score`, `overall_raw`, or any cap. Sprawl evidence earns a lower dimension level the same way any other claim does — by being cited with a `support` line under `dimension-incoherent`'s existing coherence rules — never by a separate sprawl arithmetic path.

## The six dimensions

| Dimension | Weight | Asks |
| --- | ---: | --- |
| `observed_soundness` | 30% | Is what we read actually correct and internally consistent? |
| `automated_enforcement` | 25% | Would a violation be caught by machinery rather than by a reviewer? |
| `verification_readiness` | 20% | Can a change in this lane be proved safe? |
| `boundary_clarity` | 10% | Is the authoritative definition of each contract and seam identifiable? |
| `change_containment` | 10% | Does a change here stay local, or ripple? |
| `operational_reproducibility` | 5% | Can the behavior be reproduced deterministically off one machine? |

Weights sum to 100 and are fixed. A lane that argues for its own weights is a lane that cannot be compared to another.

## Lane score

```text
lane_score = Σ over dimensions ( level ÷ 4 × weight_pct )
```

Range 0–100. Worked example:

```yaml
lane: contracts-and-integration
scores:
  observed_soundness:          { level: 3, ... }   # 3/4 × 30 = 22.50
  automated_enforcement:       { level: 1, ... }   # 1/4 × 25 =  6.25
  verification_readiness:      { level: 2, ... }   # 2/4 × 20 = 10.00
  boundary_clarity:            { level: 2, ... }   # 2/4 × 10 =  5.00
  change_containment:          { level: 1, ... }   # 1/4 × 10 =  2.50
  operational_reproducibility: { level: 2, ... }   # 2/4 ×  5 =  2.50
lane_score: 48.75
```

> **Stamped correction.** The originating design note printed `52.5` for exactly these levels. Under the formula above the value is `48.75`; `52.5` satisfies no weighting of these six dimensions and was illustrative rather than computed. `48.75` is authoritative and asserted in `assets/health-verify.test.html`.

Every lane also carries, in prose: grade drivers, what would raise the score, and what could lower it if investigated further.

## Every dimension carries its own support

A lane score without an audit trail is an opinion with a number attached — and an audit trail at lane granularity is barely better, because one broad claim can then justify all six dimensions at once.

Support is therefore declared **per dimension**, and each reference says what it supports **there**:

```yaml
scores:
  observed_soundness:
    level: 3
    claim_refs:
      - claim_id: CONTRACT-01
        support: Confirms the primary intake path validates before persisting.
      - claim_id: CONTRACT-04
        support: Two duplicated schemas remain, which is why this is 3 and not 4.
    rationale: Core paths are consistent, but two duplicated schemas remain.

  automated_enforcement:
    level: 1
    claim_refs:
      - claim_id: CONTRACT-01
        support: The same duplication has no CI comparison behind it.
    rationale: No generation or comparison check exists in any workflow.
```

One claim may legitimately inform several dimensions — a duplicated schema is evidence about boundary clarity *and* about enforcement — so a blanket uniqueness rule would be too rigid. What is rejected is reuse **without a distinct account of what it evidences each time**: that is the rubber stamp.

The verifier enforces six things:

1. `claim_refs` is non-empty and every id names a real claim (`dimension-unjustified`, `dimension-claim-unknown`).
2. Each referenced claim belongs to **this** lane (`dimension-claim-foreign`).
3. Each reference carries a `support` line (`claim-ref-support-missing`); a bare string id is rejected outright (`claim-ref-shape`).
4. The same claim reused across dimensions with an **identical** support line is rejected (`claim-ref-duplicate-support`).
5. `rationale` is present — the level is a human judgment and must be readable as one (`dimension-rationale-missing`).
6. Level and claim results cohere in both directions (`dimension-incoherent`):
   - level ≥ 2 needs at least one supporting claim resulting `pass` or `partial` — a control that is absent, failing, or unverified cannot evidence partial maturity;
   - level 4 needs at least one claim resulting `pass` outright, since it means systematic *and* regression-resistant;
   - a dimension whose supporting claims are all `unknown` cannot exceed level 1;
   - level ≤ 1 must not rest exclusively on passing claims.

Rules 3–6 exist because earlier schema versions accepted a claim reading `fail` sitting under six levels of 4 (and the grade *improved*), and accepted one claim justifying an entire lane. Coherence checking does not automate the judgment; it makes an incoherent judgment impossible to ship quietly.

> **Stamped deviation.** The originating design note gave each claim a numeric `score_effect` (e.g. `-8`). That is deliberately **not adopted**: it creates a second arithmetic path to the same lane score, and two paths to one number always eventually disagree. Schema v1's `affects_dimensions` is also gone, for the rubber-stamping reason above. Both are actively rejected by the verifier so an old island fails loudly rather than half-working.

## Overall raw score

```text
overall_raw = Σ(lane_score × lane_weight) ÷ Σ(lane_weight)
```

Only activated lanes participate. Never fold coverage or candidate counts into this mean — they enter through the caps and the confidence index, where they can be seen and argued with.

## Grade thresholds

Thresholds are **anchored to the maturity scale**. A repository uniformly at level N scores 25N and lands exactly on the floor of its band, so each letter means the maturity level it corresponds to:

| Grade | Score | Anchor | Interpretation |
| --- | ---: | :---: | --- |
| A | 90–100 | level 4 → 100 | Systematic and regression-resistant across the board |
| B | 75–89 | level 3 → 75 | Mostly systematic; important paths covered and enforced |
| C | 50–74 | level 2 → 50 | Partial; controls exist but coverage or enforcement is inconsistent |
| D | 25–49 | level 1 → 25 | Ad hoc; primarily dependent on manual knowledge |
| F | below 25 | level 0 → 0 | Absent, broken, or substantially unverified |

> **Stamped recalibration.** v1 used 90/80/70/60. Under those cuts a repository uniformly "partial" (all level 2, score 50) graded **F — systemically unsafe**, and one uniformly "mostly systematic" (all level 3, score 75) graded **C**. The rubric's own words and the letters disagreed, and the letters were the ones people would quote. The anchor makes them agree by construction. Each grade's label is now its maturity level's language, verbatim.
>
> The anchor fixes *internal* consistency. It does not by itself make the letters externally calibrated — see the open item at the end of this file.

## Caps

The raw mean is a starting point, not the answer. A strong average can hide one fatal lane or rest on a thin denominator. Compute `raw_grade` from `overall_raw`, then take the **most restrictive** of the caps below.

| Cap | Trigger | Ceiling |
| --- | --- | --- |
| `weakest-critical-lane` | Any lane with weight ≥ 4 | one letter above that lane's own grade |
| `baseline-no-test-command` | Commands ran, but none of kind `test` | B |
| `baseline-non-test-not-passing` | A non-test command failed | C |
| `baseline-test-not-passing` | A test command did not pass | C |
| `baseline-no-commands` | Nothing was run | C |
| `coverage-below-80` | `weighted_coverage < 80` | B |
| `coverage-below-60` | `weighted_coverage < 60` | C |
| `uncontained-critical-failure` | A known, reachable, uncontained critical failure | D |

A `partial` baseline used to cap nothing at all, which let a repository whose only executed command was a passing build earn an **A** — nothing had demonstrated the code runs. Partial now caps, and the two reasons for it cap differently.

`weakest-critical-lane` means: grade the weakest critical lane's own `lane_score` on the table above, then allow the overall grade at most one letter higher. A critical lane at 30 (D) caps the repository at C.

Every applied cap is recorded in `caps_applied` with the trigger value that fired it, and displayed — including caps that fired but did not bind, which are useful information. A cap declared but not fired (`cap-fabricated`) and a cap fired but not declared (`cap-undeclared`) are both rejected.

### Not gradable

Not a cap — a different verdict entirely.

```text
weighted_coverage < 40   OR   any core surface has coverage: unavailable
  → final_grade = "Not gradable"
```

Emit the reason and the coverage map, and stop grading. Never fabricate an F: F means *assessed and substantially unverified*, a far stronger claim than *not assessed*. The distinction only survives contact with an impatient reader if the tool refuses to blur it.

## The verification baseline is derived, not declared

`verification.commands` records every command run, with its kind, exit code, elapsed time, and result. The baseline state follows from those results:

```text
no commands                                    → not-run / no-commands
no command of kind `test`                      → partial / no-test-command
any test command not `pass`                    → untrustworthy / test-not-passing
any other command neither `pass` nor a
  documented `skipped`                         → partial / non-test-not-passing
otherwise                                      → trustworthy / all-passing
```

A declared `baseline` that disagrees with the derived one is rejected (`baseline-mismatch`). Declaring trustworthiness is not the same as demonstrating it.

**Commands must carry their metrics.** Every executed command records `exit_code` and `elapsed_seconds`, and the result must agree with the exit code (`pass` ⇒ 0, `fail` ⇒ non-zero). Without them, `result: pass` is a claim about a command rather than a record of one. A `skipped` command carries a `reason` and no metrics, and a documented skip of a **non-test** command is neutral — penalising it would reward omitting the record entirely, which is the opposite of the point. A skipped *test* still lands as `untrustworthy`: nothing was proved.

**Isolation is required.** `verification.isolation` must be `worktree`, `copy`, or `container` when commands ran. `in-place` and `none` are rejected (`baseline-not-isolated`) because a build or test run leaves caches, coverage output, snapshots, generated files, or a touched lockfile behind — which breaks the skill's byte-identical promise. User approval to run a command does not make that command read-only; running it somewhere else does.

## Confidence

Confidence is reported **beside** the grade, never folded into it. `B — low confidence` and `C — high confidence` describe materially different situations, and collapsing them destroys the only signal that says "go look harder."

```text
confidence_index =
    0.40 × weighted_coverage
  + 0.20 × evidence_strength
  + 0.15 × baseline_factor
  + 0.10 × core_availability
  + 0.10 × determinism_ratio
  + 0.05 × freshness_factor
```

| Input | Definition |
| --- | --- |
| `weighted_coverage` | From [COVERAGE-MODEL.md](COVERAGE-MODEL.md) |
| `evidence_strength` | Criticality-weighted mean of evidence factors |
| `baseline_factor` | `trustworthy` 100 · `partial` 50 · `untrustworthy` 0 · `not-run` 0 |
| `core_availability` | Weighted credit over core surfaces only, ×100 |
| `determinism_ratio` | Claims carrying a non-empty `observation.confirmed`, ÷ all claims, ×100 |
| `freshness_factor` | `fresh` 100 (assessed revision is current HEAD, clean tree) · `stale` 50 · `unknown` 0 |

| Band | Index |
| --- | ---: |
| `high` | ≥ 75 |
| `moderate` | 50–74 |
| `low` | < 50 |

Display as three separate facts, never merged:

```text
Repository grade:   C
Grade confidence:   moderate  (index 61)
Weighted coverage:  74%
```

## Claims

```yaml
claims:
  - claim_id: CONTRACT-01
    lane: contracts-and-integration
    statement: Public request schemas have one authoritative definition.
    result: partial          # pass | partial | fail | unknown
    evidence:
      - path: src/api/schema.ts
        lines: 18-94
      - path: clients/python/models.py
        lines: 12-83
    observation:
      confirmed: Two manually maintained representations exist.
      inferred: They may drift during independent releases.
      unknown: Whether release CI compares them.
```

Separating `confirmed` / `inferred` / `unknown` is load-bearing. It feeds `determinism_ratio`, it tells the next run what to re-check rather than re-derive, and it stops an inference from hardening into a fact between report and roadmap.

Claims are also the reassessment unit. A later run re-verifies `CONTRACT-01` without rescanning unrelated lanes, and the delta reports claim results changing rather than grades moving for unstated reasons.

## Candidate scoring is not here

Candidate identity, evidence shape, the eight 1–5 scores, `priority_score`, dedup, blocking, dependencies, ranking, and status transitions belong to the shared spine. This skill emits candidates in that schema and adds exactly two fields, `lane_sources` and `claim_refs`. Do not restate the priority formula here, do not re-tune its bands, and never let a health lane score influence a candidate's priority or the reverse.

## Open calibration item

The thresholds are now internally consistent with the maturity language. They are **not yet externally calibrated**: no one has run this rubric against a set of repositories whose health is independently agreed and checked whether the letters read as truthful. Until that happens, present the grade with its lane scorecards and coverage map rather than as a standalone verdict, and treat a letter quoted without its confidence and coverage as a misuse of this report.


## Surface evidence traceability

Coverage and evidence strength feed grade caps and confidence, so every surface assertion must cite `evidence_refs`. The verifier resolves claim and command references and rejects untraceable strong-evidence declarations. This does not change the grade formula; it makes its denominator auditable.
