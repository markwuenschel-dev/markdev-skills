# Coverage Model

The health denominator. Before any grade is defensible, the assessment has to state **what health surfaces exist** and **which ones were actually looked at**. `shared/evidence-recon` owns the generic coverage-state and evidence-quality vocabulary; this file owns the repository-health surface inventory, criticality weights, credits, denominator, and weighted-coverage mathematics. [HEALTH-GRADING.md](HEALTH-GRADING.md) consumes its output.

Weighted coverage is the strongest guard against the failure this skill exists to prevent: a clean-looking report produced by a shallow scan. Three findings from 30% coverage and three findings from 95% coverage are not the same result, and the grade must not let them look alike.

## The default inventory is mandatory

Every id below **must appear in every assessment**. A surface the repository genuinely lacks is declared `not-applicable` with a reason. It is never omitted.

This is a hard rule, not a convention, because omission is the single most effective way to inflate the number. Removing `contracts-and-wiring` from the reference fixture raised its weighted coverage from **78.8% to 84.4%** — the assessment got thinner and the score went up. The verifier now rejects an incomplete inventory (`surface-inventory-incomplete`).

| Surface id | Covers | Default weight | Core |
| --- | --- | ---: | :---: |
| `runtime-code` | Applications, services, workers, entrypoints | 5 | ● |
| `domain-libraries` | Shared libraries and internal packages | 4 | ● |
| `architecture-boundaries` | Package/layer structure, dependency direction | 4 | ● |
| `contracts-and-wiring` | Public APIs, DTOs, schemas, events, config keys | 5 | ● |
| `data-lifecycle` | Storage, migrations, backfills, serialization | 4 | |
| `verification` | Unit, integration, e2e, golden, fixture tests | 4 | ● |
| `build-and-delivery` | Build system, CI, packaging, deployment | 3 | |
| `operational-behavior` | Startup, shutdown, logging, health checks | 3 | |
| `generated-surfaces` | Codegen output, duplicated contracts, vendored code | 2 | |
| `specialized-paths` | Numerical, GPU, security, platform-specific code | 3 | |
| `ownership-and-maintainability` | Module ownership, dead paths, stale implementations | 2 | |

Extra surfaces may be added when a repository has something the list does not anticipate. Nothing may be removed.

### Core surfaces

The five marked ● trigger the *Not gradable* rule: if any resolves to `unavailable`, the repository is not gradable regardless of the arithmetic. A grade that omits the runtime, the domain libraries, the boundaries, the contracts, or the tests is not a grade.

`core_surfaces` in the island is **additive only**. It can designate further surfaces as core; it can never drop a default. Otherwise the cheapest way past the Not-gradable rule would be to redefine what counts as core, which is exactly the move the rule exists to prevent.

### Weighting

`criticality_weight` is an integer 1–5 keyed to **blast radius if this surface is wrong**, never to size:

| Weight | Meaning |
| ---: | --- |
| 5 | Failure here is user-visible, data-affecting, or security-affecting |
| 4 | Failure here breaks a major capability or corrupts a downstream contract |
| 3 | Failure here degrades delivery, operability, or developer throughput |
| 2 | Failure here costs maintenance effort but contains itself |
| 1 | Failure here is cosmetic or trivially reversible |

A 40-line auth middleware outweighs a 4,000-line generated client. If a weight is being argued from line count, it is wrong.

Repository-specific adjustment is legitimate — a repository with no public consumers may reasonably weight `contracts-and-wiring` lower. But a weight that differs from the default requires a `weight_rationale` recorded in the island (`surface-weight-undocumented`), so the adjustment is an argument on the page rather than a silent thumb on the scale.

### Code-sprawl pressure is not a twelfth surface

The island's `sprawl_pressure` block (schema v5) is evidence, not a surface: it does not get a `criticality_weight`, does not enter `weighted_coverage`, and is never declared `not-applicable` or `unavailable`. Its nearest vocabulary among the eleven default surfaces is `ownership-and-maintainability` (module ownership, dead paths, stale implementations) and `generated-surfaces` (codegen output, duplicated contracts, vendored code) — inspecting those two surfaces is typically where stale reachable paths, competing implementations, and unowned compatibility layers are actually found. A thorough pass over those two surfaces is what populates `sprawl_pressure`'s arrays; the block does not replace inspecting them, and a `sprawl_pressure` full of findings does not excuse marking `ownership-and-maintainability` `uninspected`.

The same criticality rule that governs surface weights governs sprawl evidence: the negative condition being measured is *unnecessary, unowned, reachable behavioral redundancy* — never file count or line count. A single 40-line unowned compatibility shim sitting on a hot path is worse than a 4,000-line abandoned prototype nothing imports; if a `sprawl_pressure` finding is being argued from size rather than reachability and blast radius, it does not belong in the block. See [HEALTH-GRADING.md](HEALTH-GRADING.md#code-sprawl-pressure-as-lane-evidence) for how these findings turn into `architecture-fitness` and `maintainability-and-ownership` dimension levels — coverage states what was looked at; grading is what the looking found.

## Coverage states

These six state names are imported unchanged from `shared/evidence-recon`. Exactly one state per health surface. The distinction that matters most is `unavailable` versus `not-applicable` — see the denominator rule below.

| State | Meaning | Credit |
| --- | --- | ---: |
| `inspected` | Read directly and substantially; findings are grounded in the actual code | 1.00 |
| `sampled` | A representative subset read; conclusions extrapolate beyond what was seen | 0.60 |
| `inventory-only` | Enumerated and classified, but contents not read | 0.25 |
| `uninspected` | Present, in scope, not looked at — ran out of budget or attention | 0.00 |
| `unavailable` | Present and in scope, but could not be inspected (no access, no toolchain, binary-only, requires hardware) | 0.00 |
| `not-applicable` | The repository genuinely does not have this surface | — |

`unavailable` and `not-applicable` both require a `reason`. For `not-applicable` it is a factual claim that the surface does not exist; for `unavailable` it is what turns the gap into a human-decision blocker.

**A default core surface may never be `not-applicable`.** `not-applicable` removes a surface from the denominator, so declaring the whole core absent produced **100% weighted coverage and a grade of A** on an island where nothing had been inspected at all. A repository with no runtime code, no domain libraries, no boundaries, no contracts, or no tests is not a repository this skill can grade — if a core surface genuinely cannot be looked at, it is `unavailable`, which keeps it in the denominator and makes the repository Not gradable. The verifier rejects the alternative (`core-surface-not-applicable`).

## Evidence quality

These four quality names are imported unchanged from `shared/evidence-recon`. Coverage says how much was seen; evidence quality says how much the seeing is worth. The numerical factors below are health-specific grading semantics and remain owned here.

| Quality | Meaning | Factor |
| --- | --- | ---: |
| `strong` | Direct file/line reads, executed commands, reproduced behavior | 1.00 |
| `moderate` | Direct reads with gaps, or consistent secondary signals | 0.90 |
| `weak` | Naming conventions, structure, documentation, or inference alone | 0.70 |
| `none` | Nothing observed | 0.00 |

**Consistency rule:** `coverage: inspected` requires `evidence_quality` of `strong` or `moderate`. "Inspected but weak evidence" is a contradiction and the verifier flags it (`coverage-evidence-mismatch`). Downgrade the coverage state or upgrade the evidence.

## Weighted coverage

Over all surfaces **except** `not-applicable`:

```text
credit(s)         = state_credit(s) × evidence_factor(s)
weighted_coverage = Σ(weight(s) × credit(s)) ÷ Σ(weight(s)) × 100
```

**Denominator rule — the anti-gaming property.** `not-applicable` leaves the denominator; `unavailable` stays in it at zero credit. A surface you could not inspect is a hole in the assessment, not an absence in the repository.

`evidence_strength` — used by the confidence index, not by coverage — is the same weighted mean over evidence factors alone:

```text
evidence_strength = Σ(weight(s) × evidence_factor(s)) ÷ Σ(weight(s)) × 100
```

## Worked example

Four of the eleven surfaces, to show the arithmetic:

```yaml
- id: runtime-code
  criticality_weight: 5
  coverage: inspected
  evidence_quality: strong

- id: data-lifecycle
  criticality_weight: 4
  coverage: sampled
  evidence_quality: moderate

- id: specialized-paths
  criticality_weight: 3
  coverage: unavailable
  evidence_quality: none
  reason: no CUDA toolchain in the assessment environment

- id: generated-surfaces
  criticality_weight: 3
  coverage: not-applicable
  reason: repository contains no generated or vendored code
```

```text
runtime-code       5 × (1.00 × 1.00) = 5.000
data-lifecycle     4 × (0.60 × 0.90) = 2.160
specialized-paths  3 × (0.00 × 0.00) = 0.000
generated-surfaces excluded (not-applicable)

weighted_coverage = 7.160 ÷ 12 × 100 = 59.7%
```

59.7% caps the overall grade at **C**, and because a specialized path is dark, the report says so in words next to the grade. Had `specialized-paths` been marked `not-applicable` instead, the same evidence would have read as **79.6%** — the exact overstatement this model exists to prevent, and the reason `not-applicable` requires a stated reason that another person can check.

## Coverage states are also a work plan

The coverage map is the honest answer to "what would make this assessment better?" Rank `uninspected` and `inventory-only` surfaces by weight; that ordering is the fastest route to a higher-confidence grade, and it belongs in the report's improvement roadmap. `unavailable` surfaces get a different remedy — access, a toolchain, or hardware — and belong in the human-decision blockers section instead.


## Surface evidence references

Every surface carries one or more `evidence_refs` records:

```yaml
- kind: claim | command | path | inventory | rationale | blocker
  ref: stable identifier or repository-relative path
```

`claim` references must resolve to a claim in the same island. `command` references must resolve to a recorded `verification.commands[].command_id`. `inspected` requires evidence; `strong` evidence requires at least one claim, command, path, or inventory reference. `unavailable` and `not-applicable` remain evidence-backed factual claims rather than denominator labels with no audit trail.

Repository freshness is likewise evidence-backed: record the assessed revision, current HEAD, clean-tree result, and observation time under `repository.freshness_evidence`. `fresh` means the assessed revision equals HEAD and the tree was clean.


## Generic evidence sidecar boundary

A full health run also emits a validated Evidence Recon v1 sidecar through `assets/evidence-recon-projection.js`. The sidecar preserves generic claims, coverage limits, contradictions, lane provenance, and negative-claim receipts for downstream consumers. It is **not** a second health island and does not participate in `weighted_coverage`, lane levels, grade caps, or confidence arithmetic.

A health observation can remain visible in the health report while still being unresolved in the generic sidecar. In particular, statements such as “no owner exists,” “nothing tests this,” or “no alternate path was found” cannot enter `handoff.safe_to_assume` until the current run records a bounded search scope, methods, completeness, exclusions, and sources sufficient to support absence. See [EVIDENCE-RECON-ADAPTER.md](EVIDENCE-RECON-ADAPTER.md).
