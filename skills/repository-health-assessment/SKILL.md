---
name: repository-health-assessment
description: Produce an evidence-backed read-only assessment of repository health — a mandatory surface inventory with weighted coverage, six required lanes plus declared optional lanes whose every dimension traces to a claim, an A–F grade with explicit caps and separately-stated confidence, a validated Evidence Recon sidecar, a candidate ledger routed to the architecture and integrity skills, and an optional user-elected report. Use when asked how healthy a repository is, to grade a codebase, to establish a health baseline before deciding what to fix, or to re-grade after a round of fixes. An explicit Repository Improvement Assessment or RIA request selects repository-improvement-assessment; health alone does not substitute for that combined lifecycle. Not for Software Engineering Intelligence (software-engineering-intelligence), not for a single-domain review (the review-* skills), not for implementing fixes (codebase-integrity-audit-loop reconciles candidates and hands off; production-flywheel implements), not for proposing architecture direction (architecture-improvement-intelligence), not for reviewing a single diff or PR.
disable-model-invocation: false
disallowed-tools: Edit, NotebookEdit
---

# Repository Health Assessment

Answer one question: **how healthy is this repository, and how much of it did we actually assess?**

Produce a coverage map, lane grades, an overall A–F grade, and a candidate ledger — and assign a grade **only when the evidence supports one**. Diagnose and route. Never change production code.

**Paths.** `<skill>` is the directory containing this file; `<skills-root>` is its parent. Every `assets/…` path below is `<skill>/assets/…`; every `shared/…` path is `<skills-root>/shared/…`. Run scripts by those absolute paths, never relative to the assessed repository's working directory.

**Modes.** When the user explicitly asks for a **Repository Improvement Assessment** or **RIA**, route to `repository-improvement-assessment`; do not run a health-only assessment in its place. When this skill is invoked **with an RIA envelope** (RIA's owner rendezvous hands one over), it runs in **RIA mode**: read [RIA-MODE.md](RIA-MODE.md) before step 1. In RIA mode, `engineering_intelligence_ref` may inform evidence claims but never replaces this skill's health-owned grade authority, and an optional verified `sei_assessment_ref` is consumed read-only and echoed. Read SEI evidence and cite SEI metrics exactly as [RIA-MODE.md](RIA-MODE.md#reading-and-citing-sei-evidence-composite-scoring-v3-53) describes. Every other invocation is **standalone mode**, which is what the steps below describe.

## Position in the family

| Skill | Primary question | Output |
| --- | --- | --- |
| **repository-health-assessment** (this one) | How healthy is the repository, and how much did we assess? | Coverage map, lane grades, overall grade, candidate ledger |
| `architecture-improvement-intelligence` | Which structural direction is preferable? | Architecture proposals and decision-ready analysis |
| `codebase-integrity-audit-loop` | Which reconciled candidate should be fixed next, and what exactly is authorized? | Reconciled candidate ledger, one selected candidate, signed handoff |
| `production-flywheel` | How is authorized work implemented and verified? | Mutation, verification, integration |
| `review-*` (ten domain skills) | How fit is one domain against its rule set? | `review-fitness-report/v1.1` (v1 still accepted), consumed here as lane claims via [REVIEW-LANES.md](REVIEW-LANES.md) |

This skill owns **the repository-health denominator, maturity rubric, grade calculation, grade caps, and grade confidence**. It does **not** own the generic evidence packet, coverage-state/evidence-quality vocabulary, negative-claim receipts, or contradiction state — those live in `shared/evidence-recon`. It also does **not** own candidate semantics, the eight 1–5 scores, `priority_score`, blocking, dependencies, or ranking — those live in the candidate ledger spine. Never re-derive either shared contract locally.

The health score is **never** calculated from the number, severity, or priority of candidates. Candidate severity and institutional maturity are related measures; they are not the same measure. Keeping them separate is what stops "we only found three problems" from reading as "the repository is healthy."

### Shared-spine dependency

**Protocol versions:** health island schema v5; shared candidate spine v3; shared Evidence Recon packet v1. Older health islands or candidate envelopes fail closed. See [MIGRATIONS.md](MIGRATIONS.md).

The spine has one physical home: `shared/candidate-ledger-spine/`. Its `REPORT-SCORING.md`, `candidate.schema.json`, and `ledger-verify.js` own the candidate contract, arithmetic, eligibility, ranking, lifecycle validation, and rendering. Resolve it under `<skills-root>` or through `LEDGER_VERIFY_PATH`; a missing or incompatible verifier is a hard stop, never a reason to score locally or render an empty panel.

**Invocation.** The model may invoke this skill, so an orchestrator (`repository-improvement-assessment`) can call it directly. `allow_implicit_invocation: false` still keeps general conversational routing from firing a full repository scan; ordinary questions that merely mention repository health should not start one.

### Shared Evidence Recon dependency

`shared/evidence-recon/` owns the generic epistemic substrate. A full repository health run is an `expedition`-mode evidence producer because the repository-wide lanes are independent, heterogeneous, and already reconciled by this parent. Each lane returns bounded evidence; the parent emits one validated sidecar through `assets/evidence-recon-projection.js`. Read [EVIDENCE-RECON-ADAPTER.md](EVIDENCE-RECON-ADAPTER.md).

The sidecar is additive and cannot set, cap, or replace the health grade. RHA's eleven-surface inventory, criticality weights, weighted-coverage formula, lane scorecards, grade caps, and confidence remain health-owned. Conversely, RHA must not weaken the shared absence rule: a negative observation without an explicit search scope/method/completeness receipt remains unresolved in the sidecar even when the health island still displays the observation.

## Hard stops

These hold for the entire session once this skill is invoked, not just at first mention.

1. **Read-only on tracked/source state.** Never edit, create, delete, move, or reformat tracked project files while assessing, and never run project commands in the primary worktree when they can mutate it. Runtime artifacts are the explicit exception: write them only through `shared/project-intelligence-workspace` under the Git-locally-excluded `.project-intelligence/` root. If a finding seems trivially fixable, it becomes a candidate, not an edit.
2. **Project commands run in an isolated copy, and need approval first.** Ask before the first build, test, or lint command, state exactly what will run, then run it in a `git worktree`, copy, or container at the assessed revision — never in the repository itself. Approval makes a command *authorized*; running it elsewhere is what makes it *read-only*. A test run leaves caches, coverage output, snapshots, generated files, or a touched lockfile behind. Record refusal as no commands rather than assuming success. In RIA mode, RIA has already run the declared commands once in its own isolated worktree and hands them over as `verification_baseline_ref`; adopting them per [RIA-MODE.md](RIA-MODE.md) satisfies this rule.
3. **Not gradable is a real verdict.** When weighted coverage falls below 40%, or a core surface is `unavailable` or `uninspected`, emit `Not gradable` with the reason. Never fabricate an F to fill the slot — an F means *assessed and substantially unverified*, a different and much stronger claim than *not assessed*. [HEALTH-GRADING.md](HEALTH-GRADING.md#not-gradable) lists which steps still run.
4. **A red verification chip means the report does not ship.** Fix the island or the arithmetic and re-render. Never hand-correct a rendered number to turn a chip green.
5. **Every displayed number comes from the island.** Never hand-write a score, percentage, grade, or count into report prose or markup.

## Throughput contract

Every repository-wide health run loads [PERFORMANCE.md](PERFORMANCE.md), [PARALLEL-ASSESSMENT.md](PARALLEL-ASSESSMENT.md), [REVIEW-LANES.md](REVIEW-LANES.md), and the shared Evidence Recon model — `shared/evidence-recon/EVIDENCE-MODEL.md` and `shared/evidence-recon/NEGATIVE-CLAIMS.md`. The six grading lanes are not worker slots. Build the denominator with parallel deterministic tasks, then saturate an adaptive read-only evidence pool with topology-derived packets and `as_completed` refill, alongside the lane-mapped `review-*` workers. Grade authority remains entirely in this parent; lane evidence is reconciled into one expedition-mode Evidence Recon sidecar.

## Process

### 1. Frame the assessment

Establish and state: the repository root, the commit assessed, the current HEAD, whether the tree is clean, the languages and build systems present, whether a prior health report exists, and any scope the user has excluded. Record the revision, HEAD, clean-tree result, and observation time under `repository.freshness_evidence`; `repository.freshness` is derived from them, not asserted.

Read the project's own instructions first — `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, and any ADRs in `docs/adr/`. `CONTEXT.md` names the domain concepts; use its vocabulary for surfaces and claims. ADRs record decisions this assessment reports against but does not re-litigate.

**Completion criterion:** repository name, assessed revision, current HEAD, clean-tree result, observation time, prior-run baseline, and excluded scope are stated in checkable terms.

### 2. Build the complete surface inventory

Establish the denominator before looking for problems. **All eleven default surfaces must appear** — a surface the repository lacks is declared `not-applicable` with a reason, never omitted. Assign each a `criticality_weight` 1–5, a `coverage` state, an `evidence_quality`, and one or more `evidence_refs`. At this step the only refs that exist are `path`, `inventory`, and `rationale` refs (plus `blocker` for an `unavailable` surface); `claim` and `command` refs are appended after steps 3 and 4 create those ids.

Weight by **criticality, never by file count or lines of code.** A 40-line auth middleware outweighs a 4,000-line generated client. A weight that differs from the default needs a `weight_rationale` on the record.

Read [COVERAGE-MODEL.md](COVERAGE-MODEL.md) for the health-specific inventory, weights, credits, and weighted-coverage formula. The six coverage states and four evidence-quality values are shared vocabulary owned by `shared/evidence-recon`; this file specializes them into the health denominator.

Build the Evidence Recon coverage plan at the same time. Record source classes, independent lane surfaces, contradiction risk, false-negative cost, exclusions, and why expedition mode is proportional. This planning artifact does not replace the mandatory health inventory.

**Gate:** every default surface is present with a weight, coverage state, evidence quality, and traceable evidence references; `unavailable` and `not-applicable` carry reasons; weighted coverage is computed, not estimated.

### 3. Assess each lane, with support declared per dimension

Six lanes are always assessed. **Every optional lane must also be declared** — either scored, or entered in `lane_applicability` with `state: not-applicable`, a rationale, and the inventory surfaces that justify it. Omission is not a declaration.

Each lane is scored on the same six dimensions against the same 0–4 maturity scale, and **each dimension carries its own `claim_refs` and `rationale`**. Every reference is `{claim_id, support}` — one claim may inform several dimensions, but it must say something different about each. A level must cohere with the claims supporting it: level ≥ 2 needs a `pass` or `partial`; level 4 needs a `pass`; a dimension supported only by `unknown` claims cannot exceed level 1; level ≤ 1 must not rest solely on passing claims. A review claim whose `review_source.proof_basis` is `judgment` is weaker evidence: level ≥ 3 cannot rest only on judgment claims, and level 4 needs a `pass` that is not a judgment ([HEALTH-GRADING.md](HEALTH-GRADING.md#judgment-evidence)).

Read [HEALTH-GRADING.md](HEALTH-GRADING.md) for the lane definitions, the maturity scale with its per-lane anchors, the dimension weights, the `lane_score` formula, and the claim schema.

Derive non-overlapping read-only evidence lanes from the repository topology ([PARALLEL-ASSESSMENT.md](PARALLEL-ASSESSMENT.md)) and, in the same dispatch, the `review-*` workers that [REVIEW-LANES.md](REVIEW-LANES.md) maps to each active lane. Review reports enter only as claims carrying `review_source`, through `assets/review-to-claims.js`. Review rules are hybrid: mechanical sub-rules are re-derived by the runtime's analyzers and enter as `proof_basis: mechanical` claims in `observation.confirmed`; each dimension's baseline is a model judgment and enters as `proof_basis: judgment` in `observation.inferred`. Evidence lanes can support several fixed grading lanes; only the parent assigns final dimension levels, grade, caps, confidence, and candidate rank.

Record one `evidence_workers[]` entry for **every** dispatched worker — `{worker_id, lane, status, limitations[]}`, where `status` is `complete`, `partial`, `failed`, `blocked`, or `timeout`. A worker that did not complete still gets its entry; its limitations are what the sidecar's lane receipts report.

**Gate:** all six required lanes have six dimensions each; every dimension cites at least one claim from its own lane and carries a rationale; every claim carries evidence or an explicit `architecture_level` rationale; every dispatched worker has an `evidence_workers` entry.

### 4. Establish the verification baseline

Ask for approval, create an isolated worktree or copy at the assessed revision, and run the project's own commands there unchanged. Record **every** command with a stable `command_id`, kind, exit code, elapsed time, and result. In RIA mode, adopt the commands instead ([RIA-MODE.md](RIA-MODE.md)).

Every executed command records `exit_code` and `elapsed_seconds`, and the result must agree with the exit code. A `skipped` command carries a reason and no metrics.

The baseline state is **derived** from those results, not declared: no commands → `not-run`; no test command → `partial/no-test-command`; any test not passing → `untrustworthy`; any other command neither passing nor a documented skip → `partial/non-test-not-passing`; otherwise `trustworthy`. Each of those caps the grade — `no-test-command` at **B**, the rest at **C**. A repository whose only executed command was a passing build has not demonstrated that its code runs.

**Completion criterion:** every command run is recorded with its kind, exit code, elapsed time and result; the isolation mode is recorded; or there is an explicit reason nothing was run.

### 5. Compute the grade, apply the caps, derive the confidence

Compute in this order and never out of it: lane scores → criticality-weighted `overall_raw` → `raw_grade` → caps → `final_grade`; then, separately, the confidence index.

Set `uncontained_critical_failure` before computing. It is `null` unless a known, reachable, uncontained critical failure exists; then it is `{claim_id, statement}`, where `claim_id` names a claim in this island with `result: fail` that is not a judgment claim. Never a string or boolean — those are rejected, not read as a trigger.

The raw mean is never the final grade. Caps exist because a strong average can hide one fatal lane or a thin denominator. Confidence is reported **beside** the grade, never folded into it.

[HEALTH-GRADING.md](HEALTH-GRADING.md) owns the thresholds, every cap, and the confidence formula.

**Gate:** `final_grade` differs from `raw_grade` only through a cap named in `caps_applied` with its trigger value.

### 6. Emit the candidate ledger

Convert findings into **complete shared-spine v3 candidates** — `spine_version: 3`, `candidate_id`, `title`, `summary`, `root_cause`, file/line or architecture-level `evidence`, the eight 1–5 `scores`, `rollup`, `effort`, `depends_on`, `unlocks`, `status`, `dedup`, and `candidate_lifecycle`. Add this skill's two provenance fields: `lane_sources`, naming the lanes that produced the finding, and `claim_refs`, naming the claims it traces to. Under an RIA envelope that carries `candidate_namespace`, prefix every newly minted `candidate_id` with it (`health:<local>`); standalone runs stay unprefixed ([RIA-MODE.md](RIA-MODE.md#the-envelope)). Every actionable candidate needs at least one claim reference, and each referenced claim must belong to one of the candidate's `lane_sources`.

Route each candidate by `rollup.execution_mode` first, then `rollup.recommended_action`:

| Condition | Destination |
| --- | --- |
| `execution_mode: blocked-needs-human-decision` | Decision queue (whatever the action) |
| `recommended_action: design` or `prototype` | `architecture-improvement-intelligence` |
| `recommended_action: direct-fix`, `fitness-check`, or `triage` | `codebase-integrity-audit-loop` |
| `recommended_action: reject`, or informational | Stays recorded in the ledger, so the next run does not resurface it as new |

A candidate keeps the same `candidate_id` across health discovery → architecture decision → integrity reconciliation → implementation → verification → reassessment. A renamed finding is an untraceable finding.

**Absence is not completion.** When re-grading, a candidate present in the previous run and missing from this one is reported `missing-from-current-run` and fails continuity verification — unless its previous `candidate_lifecycle` carries terminal evidence: `completed` needs `completion.completed_at` plus `completion.verification_refs`; `superseded` needs `resolution.superseded_by`; `rejected`, `deferred`, and `out-of-scope` need `resolution.reason`. Historical top-level lifecycle records are read only for migration. A candidate can vanish because it was renamed, merged, deferred, or simply lost during report generation; only a stated resolution distinguishes those from being fixed.

**Gate:** every candidate traces to at least one claim, carries `lane_sources`, and validates against the spine schema.

### 7. Validate and persist the health artifact

The validated health island and candidate ledger are the machine outputs. `assets/canonical-island.json`, `assets/health.schema.json`, and `assets/health-verify.js` are the canonical example, schema, and verifier. Persist the island with:

```bash
node <skill>/assets/write-health-artifact.js --input <island.json> --repo <repository-root> [--output <artifact.json>]
```

- `--input` is required; without it the writer exits 2.
- Output paths must sit under `<repository-root>/.project-intelligence/` (or `RIA_RUNTIME_ROOT`) unless `--allow-path-outside` is passed. The default is `.project-intelligence/assessments/health/`.
- The writer injects the computed `grade` block (`final_grade`, `caps_applied`, …) and re-verifies the persisted file. A disagreement is a writer failure, never something to hand-correct.
- `--testing-fitness <json>` is deprecated; review-testing now enters as claims ([REVIEW-LANES.md](REVIEW-LANES.md)).

**Completion criterion:** the writer exits 0 and prints the persisted artifact path and sha256.

### 7a. Emit and validate the Evidence Recon sidecar

Only after step 7 succeeds, project the persisted island:

```bash
node <skill>/assets/write-evidence-recon-sidecar.js --island <persisted-island.json> --repo <repository-root> [--receipts <negative-receipts.json>]
```

The writer verifies the island first, projects it with `assets/evidence-recon-projection.js`, validates the packet with `shared/evidence-recon/evidence-recon.js`, and writes it under `.project-intelligence/evidence/health/` without overwriting. Augment every consequential negative observation with its explicit search receipt (`--receipts`) when the run actually supports absence. It is runtime evidence, not tracked repository content.

The projection is intentionally conservative. Health claims that say "no guard," "nothing tests this," "no owner," or similar do not become safe absence facts unless the current run records search scope, methods, completeness, exclusions, and receipts. Unsupported negative claims stay in `handoff.unresolved_facts`. Lane receipts take their status from `evidence_workers`, so a failed or timed-out worker shows as a limitation, not as `complete`.

**Gate:** the sidecar validates, lane provenance is preserved, every negative claim has a receipt, and `handoff.safe_to_assume` contains only confirmed facts or supported absence claims. A sidecar failure blocks generic downstream evidence handoff; it never authorizes hand-editing the health grade.

### 8. Elect presentation, and render only when elected

In RIA mode, skip this step: RIA owns the single report election ([RIA-MODE.md](RIA-MODE.md)).

Read `shared/report-election/REPORT-ELECTION.md`.

- Direct user invocation with no explicit report preference → compute a result-specific machine lean and ask A/B.
- Explicit "full report" / equivalent → `generate`, no question.
- Explicit "no report/HTML" → `skip`, no question.

For a direct election use:

> The repository health assessment is complete and a human-facing report can be generated.
>
> **A. Generate the full health report.**
> **B. Skip the report and return the canonical health artifact + concise summary.**
>
> **My recommendation: A/B —** [result-specific reasoning].
>
> Choose A or B.

The machine generally leans `generate` when multiple lanes/candidates, caps, coverage gaps, confidence caveats, or comparisons materially benefit from a durable review surface. It may lean `skip` for a narrow re-grade where the report would mostly repeat the concise result.

When the election resolves to `generate`, write a report input matching `assets/report-input.schema.json` (the health island plus authored prose) and compile it:

```bash
node <skill>/assets/build-report.js --input <report-input.json> --repo <repository-root> [--output <report.html>]
```

The default output is `.project-intelligence/reports/health/repository-health-<timestamp>.html`. Open it and tell the user the absolute path. The report starts from `assets/report-scaffold.html`, is genuinely self-contained (no CDN, no external font, no network at view time), and renders every number from the island through `assets/health-verify.js`, which recomputes lane scores, coverage, the overall raw score, the grade, the caps, and the confidence, **and checks that the report actually displays them all**. Keep the sidecar as a sibling artifact; the report may link its path but must not duplicate or hand-edit its claims. Read [HTML-REPORT.md](HTML-REPORT.md) for the section order and the island contract.

**Gate when generated:** the verification chip is green. A red chip means the report does not ship. A user-elected `skip` is not a red report and does not invalidate the health artifact.

### 9. Hand off

Route only one discovery mode: a formal grade, baseline, or regrade stays here; broad candidate discovery goes to `codebase-integrity-audit-loop --parallel-report`; a structural question goes to `architecture-improvement-intelligence`. In RIA mode, skip the packets below: RIA's owner rendezvous returns this run's artifact and reconciles owners ([RIA-MODE.md](RIA-MODE.md)).

**Architecture (`design`, `prototype`).** Hand over the bare spine-v3 candidate exactly as it validates against `shared/candidate-ledger-spine/candidate.schema.json`, plus an optional sibling `health_context`:

```yaml
candidate: {}            # the unmodified spine-v3 candidate; candidate_id preserved
health_context:          # optional; read-only context, never an authority
  health_artifact_ref: { artifact_id: "", sha256: "", repository_revision: "" }
  final_grade: ""
  confidence: ""
  weighted_coverage: 0
  caps_applied: []
  claim_refs: []         # the claims this candidate traces to
```

The handoff is design-only, preserves identity, and cannot trigger a health scan recursively.

**Integrity (`direct-fix`, `fitness-check`, `triage`).** Candidates reach `codebase-integrity-audit-loop` as rows of the persisted candidate ledger — no separate packet. Integrity reconciles them and decides; mutation authority exists only in integrity's signed handoff to `production-flywheel`. This skill neither grants nor forwards any authority. On an integrity reassessment request, retain prior claims, surfaces, lanes, and candidate IDs, render their transitions, and reject unexplained absence.

Close by telling the user, in this order: the grade and its confidence (or the Not gradable reason), the weighted coverage and what was **not** assessed, the caps that bound the grade, the single highest-priority candidate, the count routed to each destination, the `evidence_workers` that did not complete, and whether the Evidence Recon sidecar is valid plus its path. Then stop.

Selection is not implementation approval. Do not start fixing anything from this skill.

## Definition of done

- The full default surface inventory is present, weighted coverage is computed from it, and unassessed surfaces are visible rather than silently absent.
- All six required lanes carry six dimension levels, each with its own claim references and rationale, each coherent with the results of those claims. Every optional lane is either scored or declared not-applicable with evidence.
- Every dispatched worker, including every `review-*` worker, has an `evidence_workers` entry; review results entered only as `review_source` claims or as limitations.
- Every command run is recorded with its result and isolation mode; the baseline state is derived from them.
- `final_grade` is derived, every applied cap is named with its trigger, and confidence is reported separately.
- The candidate ledger validates against the shared spine, and every candidate carries `lane_sources` and `claim_refs`. No candidate from a previous run has silently disappeared.
- The health artifact was written by `write-health-artifact.js` and re-verified as persisted.
- One Evidence Recon v1 sidecar validates; lane provenance is preserved; confirmed/inferred/unknown remain separate; unsupported negative claims are not promoted to safe facts.
- **If a report was elected:** it renders every number from the island, displays every lane and every candidate row, and the verification chip is green.
- No tracked or source file in the assessed repository was modified. Writes under `.project-intelligence/`, and the `.git/worktrees` and `.git/info/exclude` entries that isolated command runs and the workspace create, are declared runtime exceptions.

## Repository-local artifact storage

Use `shared/project-intelligence-workspace` for durable assessment state:

| Artifact | Location under `.project-intelligence/` |
| --- | --- |
| Health artifact | `assessments/health/` |
| Evidence Recon sidecar | `evidence/health/` |
| Elected report | `reports/health/` |
| Verification baselines (read) | `verification/` |

Explicit caller-selected paths remain valid within the writers' path restriction, but normal runs must not scatter durable state into OS temp or user Documents folders.

**Workspace evidence boundary:** `.project-intelligence/` is runtime state, not repository evidence. Exclude it from filesystem inventories, counts, searches, and candidate discovery; only read it through declared artifact/cache interfaces.
