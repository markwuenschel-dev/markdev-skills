---
name: repository-health-assessment
description: Produce an evidence-backed read-only assessment of repository health — a mandatory surface inventory with weighted coverage, six lane scorecards whose every dimension traces to a claim, an A–F grade with explicit caps and separately-stated confidence, a validated shared Evidence Recon sidecar, a candidate ledger routed to the architecture and integrity skills, and an optional user-elected human-facing report. Use when asked how healthy a repository is, to grade or audit a codebase, to establish a health baseline before deciding what to fix, or to re-grade after a round of fixes. An explicit Repository Improvement Assessment or RIA request selects repository-improvement-assessment; health alone does not substitute for that combined lifecycle. Not for implementing fixes (use codebase-integrity-audit-loop), not for proposing architecture direction (use architecture-improvement-intelligence), not for reviewing a single diff or PR.
disable-model-invocation: false
disallowed-tools: Edit, NotebookEdit
---

# Repository Health Assessment

Answer one question: **how healthy is this repository, and how much of it did we actually assess?**

Produce a coverage map, lane grades, an overall A–F grade, and a candidate ledger — and assign a grade **only when the evidence supports one**. Diagnose and route. Never change production code.

When the user explicitly asks for a **Repository Improvement Assessment** or **RIA**, route to `repository-improvement-assessment` before running a health assessment. This skill remains the health-owned child lane when that parent invokes it with a shared baseline. When RIA supplies `engineering_intelligence_ref`, resolve it only as closed, hash-verified baseline-bound evidence; it may inform evidence claims but never replaces this lane's health-owned grade authority. The additive RIA v2 envelope may also include an optional verified `sei_assessment_ref`; consume it read-only only after its schema, digest, snapshot, and baseline revision binding have been verified, then echo it with the health-owned return reference. It cannot set, cap, or replace the health-owned grade.

## Position in the family

| Skill | Primary question | Output |
| --- | --- | --- |
| **repository-health-assessment** (this one) | How healthy is the repository, and how much did we assess? | Coverage map, lane grades, overall grade, candidate ledger |
| `architecture-improvement-intelligence` | Which structural direction is preferable? | Architecture proposals and decision-ready analysis |
| `codebase-integrity-audit-loop` | Which concrete problem should we fix next, and can we prove the fix? | Selected candidate, implementation, verification, outcome |

This skill owns **the repository-health denominator, maturity rubric, grade calculation, grade caps, and grade confidence**. It does **not** own the generic evidence packet, coverage-state/evidence-quality vocabulary, negative-claim receipts, or contradiction state — those live in `shared/evidence-recon`. It also does **not** own candidate semantics, the eight 1–5 scores, `priority_score`, blocking, dependencies, or ranking — those live in the candidate ledger spine. Never re-derive either shared contract locally.

The health score is **never** calculated from the number, severity, or priority of candidates. Candidate severity and institutional maturity are related measures; they are not the same measure. Keeping them separate is what stops "we only found three problems" from reading as "the repository is healthy."

### Shared-spine dependency

**Protocol versions:** health island schema v5; shared candidate spine v3; shared Evidence Recon packet v1. Older health islands or candidate envelopes fail closed. See [MIGRATIONS.md](MIGRATIONS.md).

The spine has one physical home: `shared/candidate-ledger-spine/`. Its `REPORT-SCORING.md`, `candidate.schema.json`, and `ledger-verify.js` own the candidate contract, arithmetic, eligibility, ranking, lifecycle validation, and rendering. Resolve repository-relatively or through `LEDGER_VERIFY_PATH`; a missing or incompatible verifier is a hard stop, never a reason to score locally or render an empty panel.

**Invocation.** The model may invoke this skill, so an orchestrator (`production-flywheel`, or the architecture skill handing off) can call it directly. `allow_implicit_invocation: false` still keeps general conversational routing from firing a full repository scan; ordinary questions that merely mention repository health should not start one.

### Shared Evidence Recon dependency

`shared/evidence-recon/` owns the generic epistemic substrate. A full repository health run is an `expedition`-mode evidence producer because the repository-wide lanes are independent, heterogeneous, and already reconciled by this parent. Each lane returns bounded evidence; the parent emits one validated sidecar through [`assets/evidence-recon-projection.js`](assets/evidence-recon-projection.js). Read [EVIDENCE-RECON-ADAPTER.md](EVIDENCE-RECON-ADAPTER.md).

The sidecar is additive and cannot set, cap, or replace the health grade. RHA's eleven-surface inventory, criticality weights, weighted-coverage formula, lane scorecards, grade caps, and confidence remain health-owned. Conversely, RHA must not weaken the shared absence rule: a negative observation without an explicit search scope/method/completeness receipt remains unresolved in the sidecar even when the older health island can still display the observation.

## Hard stops

These hold for the entire session once this skill is invoked, not just at first mention.

1. **Read-only on the repository.** Never edit, create, delete, move, or reformat a file inside the repository under assessment, and never run a command that mutates it. The only file this skill writes is the report in the OS temp directory. If a finding seems trivially fixable, it becomes a candidate, not an edit.
2. **Project commands run in an isolated copy, and need approval first.** Ask before the first build, test, or lint command, state exactly what will run, then run it in a `git worktree`, copy, or container at the assessed revision — never in the repository itself. Approval makes a command *authorized*; running it elsewhere is what makes it *read-only*. A test run leaves caches, coverage output, snapshots, generated files, or a touched lockfile behind. Record refusal as no commands rather than assuming success. The one exception: under a `human-directed-swarm-planner` Repository Improvement Assessment run, a parent captain may already have run these commands, once, in its own isolated worktree at this same revision, and injected the resulting `command_id` records as this run's baseline (§4). That still satisfies both halves of this rule only when the injected approval scope plainly covers this run and the injected isolation mode is recorded — otherwise decline the injection and record no commands, exactly as this rule already requires for a declined approval.
3. **Not gradable is a real verdict.** When weighted coverage falls below 40%, or a core surface cannot be inspected, emit `Not gradable` with the reason. Never fabricate an F to fill the slot — an F means *assessed and substantially unverified*, a different and much stronger claim than *not assessed*.
4. **A red verification chip means the report does not ship.** Fix the island or the arithmetic and re-render. Never hand-correct a rendered number to turn a chip green.
5. **Every displayed number comes from the island.** Never hand-write a score, percentage, grade, or count into report prose or markup.

## Throughput contract

Every repository-wide health run loads [PERFORMANCE.md](PERFORMANCE.md), [PARALLEL-ASSESSMENT.md](PARALLEL-ASSESSMENT.md), and the shared Evidence Recon model. The six grading lanes are not worker slots. Build the denominator with parallel deterministic tasks, then saturate an adaptive read-only evidence pool with topology-derived packets and `as_completed` refill. Grade authority remains entirely in this parent; lane evidence is reconciled into one expedition-mode Evidence Recon sidecar.

## Process

### 1. Frame the assessment

Establish and state: the repository root, the commit assessed, the current HEAD, and whether the tree is clean. Record these under `repository.freshness_evidence`; `repository.freshness` is derived from them, not asserted. the languages and build systems present, whether a prior health report exists, and any scope the user has excluded.

Under a Repository Improvement Assessment run, a parent captain supplies this frame as part of the wave-0 shared baseline. Adopt it, but still verify HEAD has not moved since the baseline was built before treating it as fresh — `freshness_evidence` stays evidence-backed either way, not asserted from a hand-off alone.

Read the project's own instructions first — `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, and any ADRs in `docs/adr/`. `CONTEXT.md` names the domain concepts; use its vocabulary for surfaces and claims. ADRs record decisions this assessment reports against but does not re-litigate.

**Completion criterion:** repository name, assessed revision, current HEAD, clean-tree result, observation time, prior-run baseline, and excluded scope are stated in checkable terms.

### 2. Build the complete surface inventory

Establish the denominator before looking for problems. **All eleven default surfaces must appear** — a surface the repository lacks is declared `not-applicable` with a reason, never omitted. Assign each a `criticality_weight` 1–5, a `coverage` state, an `evidence_quality`, and one or more `evidence_refs` pointing to a claim, command record, inspected path, inventory, rationale, or blocker.

Under a Repository Improvement Assessment run, a parent captain may supply the surface enumeration and `criticality_weight`/`weight_rationale` for each — adopt those verbatim rather than re-deriving them, so every lane's weighted coverage shares one denominator. That supplied inventory never carries `coverage` or `evidence_quality`: this run still assigns those two fields itself, from what this run actually inspected. Adopting an inventory is never adopting coverage.

Weight by **criticality, never by file count or lines of code.** A 40-line auth middleware outweighs a 4,000-line generated client. A weight that differs from the default needs a `weight_rationale` on the record.

Read [COVERAGE-MODEL.md](COVERAGE-MODEL.md) for the health-specific inventory, weights, credits, and weighted-coverage formula. The six coverage states and four evidence-quality values are shared vocabulary owned by `shared/evidence-recon`; this file specializes them into the health denominator.

Build the Evidence Recon coverage plan at the same time. Record source classes, independent lane surfaces, contradiction risk, false-negative cost, exclusions, and why expedition mode is proportional. This planning artifact does not replace the mandatory health inventory.

**Gate:** every default surface is present with a weight, coverage state, evidence quality, and traceable evidence references; `unavailable` and `not-applicable` carry reasons; weighted coverage is computed, not estimated; a supplied inventory's weights are adopted unchanged, and its coverage states are always this run's own.

### 3. Assess each lane, with support declared per dimension

Six lanes are always assessed. **Every optional lane must also be declared** — either scored, or entered in `lane_applicability` with `state: not-applicable`, a rationale, and the inventory surfaces that justify it. Omission is not a declaration.

Each lane is scored on the same six dimensions against the same 0–4 maturity scale, and **each dimension carries its own `claim_refs` and `rationale`**. Every reference is `{claim_id, support}` — one claim may inform several dimensions, but it must say something different about each. A level must cohere with the claims supporting it: level ≥ 2 needs a `pass` or `partial`; level 4 needs a `pass`; a dimension supported only by `unknown` claims cannot exceed level 1; level ≤ 1 must not rest solely on passing claims.

Read [HEALTH-GRADING.md](HEALTH-GRADING.md) for the lane definitions, the maturity scale with its per-lane anchors, the dimension weights, the `lane_score` formula, and the claim schema.

Build the inventory first, then derive non-overlapping read-only evidence lanes from the actual repository topology — read [PARALLEL-ASSESSMENT.md](PARALLEL-ASSESSMENT.md). Evidence lanes can support several fixed grading lanes; only the parent assigns final dimension levels, grade, caps, confidence, and candidate rank.

**Gate:** all six required lanes have six dimensions each; every dimension cites at least one claim from its own lane and carries a rationale; every claim carries evidence or an explicit `architecture_level` rationale.

### 3a. Emit and validate the generic Evidence Recon sidecar

Project the health island with `assets/evidence-recon-projection.js` or the atomic `assets/write-evidence-recon-sidecar.js` CLI, augment every consequential negative observation with its explicit search receipt when the run actually supports absence, and validate the result with `shared/evidence-recon/evidence-recon.js`. Write the sidecar beside the HTML report in the OS temp directory or attach it to the parent orchestration envelope; never write it into the assessed repository.

The projection is intentionally conservative. Existing health claims that say “no guard,” “no owner,” or similar do not become safe absence facts unless the current run records search scope, methods, completeness, exclusions, and receipts. Unsupported negative claims stay in `handoff.unresolved_facts`.

**Gate:** the sidecar validates, lane provenance is preserved, every negative claim has a receipt, and `handoff.safe_to_assume` contains only confirmed facts or supported absence claims. A sidecar failure blocks generic downstream evidence handoff; it never authorizes hand-editing the health grade.

### 4. Establish the verification baseline

Ask for approval, create an isolated worktree or copy at the assessed revision, and run the project's own commands there unchanged. Record **every** command with a stable `command_id`, kind, exit code, elapsed time, and result.

Under a Repository Improvement Assessment run, adopt the parent captain's wave-0 command records in place of running the suite again — one isolated run per revision, not one per lane. Adopting a record still means recording its `command_id`, kind, exit code, elapsed time, and result exactly as if this run had produced it; a declined injection (per Hard stop 2) records no commands, the same as any other refusal.

Every executed command records `exit_code` and `elapsed_seconds`, and the result must agree with the exit code. A `skipped` command carries a reason and no metrics.

The baseline state is **derived** from those results, not declared: no commands → `not-run`; no test command → `partial/no-test-command`; any test not passing → `untrustworthy`; any other command neither passing nor a documented skip → `partial/non-test-not-passing`; otherwise `trustworthy`. Each of those caps the grade — `no-test-command` at **B**, the rest at **C**. A repository whose only executed command was a passing build has not demonstrated that its code runs.

**Completion criterion:** every command run is recorded with its kind, exit code, elapsed time and result; the isolation mode is recorded; or there is an explicit reason nothing was run.

### 5. Compute the grade, apply the caps, derive the confidence

Compute in this order and never out of it: lane scores → criticality-weighted `overall_raw` → `raw_grade` → caps → `final_grade`; then, separately, the confidence index.

The raw mean is never the final grade. Caps exist because a strong average can hide one fatal lane or a thin denominator. Confidence is reported **beside** the grade, never folded into it.

[HEALTH-GRADING.md](HEALTH-GRADING.md) owns the thresholds, every cap, and the confidence formula.

**Gate:** `final_grade` differs from `raw_grade` only through a cap named in `caps_applied` with its trigger value.

### 6. Emit the candidate ledger

Convert findings into **complete shared-spine v3 candidates** — `spine_version: 3`, `candidate_id`, `title`, `summary`, `root_cause`, file/line or architecture-level `evidence`, the eight 1–5 `scores`, `rollup`, `effort`, `depends_on`, `unlocks`, `status`, and `dedup`. Add this skill's two provenance fields: `lane_sources`, naming the lanes that produced the finding, and `claim_refs`, naming the claims it traces to. Every actionable candidate needs at least one claim reference, and each referenced claim must belong to one of the candidate's `lane_sources`.

Route by `recommended_action`: `direct-fix` / `fitness-check` / `triage` → the integrity skill; `design` → the architecture skill; anything `blocked-needs-human-decision` → the decision queue; rejected or informational candidates stay recorded rather than deleted, so the next run does not resurface them as new.

A candidate keeps the same `candidate_id` across health discovery → architecture decision → integrity execution → verification → reassessment. A renamed finding is an untraceable finding.

**Absence is not completion.** When re-grading, a candidate present in the previous run and missing from this one is reported `missing-from-current-run` and fails continuity verification — unless its previous `candidate_lifecycle` carries terminal evidence: `completed` needs `completion.completed_at` plus `completion.verification_refs`; `superseded` needs `resolution.superseded_by`; `rejected`, `deferred`, and `out-of-scope` need `resolution.reason`. Historical top-level lifecycle records are read only for migration. A candidate can vanish because it was renamed, merged, deferred, or simply lost during report generation; only a stated resolution distinguishes those from being fixed.

**Gate:** every candidate traces to at least one claim, carries `lane_sources`, and validates against the spine schema.

### 7. Validate the canonical health artifact and elect presentation

The validated health island, candidate ledger, and Evidence Recon sidecar are the machine outputs. They must be complete before report presentation is decided.

Read `shared/report-election/REPORT-ELECTION.md`.

- Direct user invocation with no explicit report preference → compute a result-specific machine lean and ask A/B.
- Explicit "full report" / equivalent → `generate`, no question.
- Explicit "no report/HTML" → `skip`, no question.
- Nested invocation with `presentation_policy.report: inherit` → do not ask and do not render; return the canonical health artifacts to the declared `report_owner`.

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

### 8. Render and verify the report only when elected

When the election resolves to `generate`, start from [`assets/report-scaffold.html`](assets/report-scaffold.html), which carries the section order, the embedded design system, and every required placeholder. Write to `<tmpdir>/repository-health-<timestamp>.html`, resolving the temp dir from `$TMPDIR` with `/tmp` (or `%TEMP%`) as fallback. Open it and tell the user the absolute path.

The report is genuinely self-contained — no CDN, no external font, no network at view time, because it is opened from a local file and often offline. Keep the validated Evidence Recon sidecar as a sibling artifact or parent-envelope reference; the report may link its path but must not duplicate or hand-edit its claims. Every number renders from the single JSON island through [`assets/health-verify.js`](assets/health-verify.js), which recomputes lane scores, coverage, the overall raw score, the grade, the caps, and the confidence, **and checks that the report actually displays them all**.

Read [HTML-REPORT.md](HTML-REPORT.md) for the section order and the island contract.

**Gate when generated:** the verification chip is green. A red chip means the report does not ship. A user-elected `skip` is not a red report and does not invalidate the health artifact.

### 9. Hand off

Route only one discovery mode: a formal grade, baseline, or regrade stays here; broad candidate discovery goes to `codebase-integrity-audit-loop --parallel-report`; a structural question goes to `architecture-improvement-intelligence`. The one named exception is `human-directed-swarm-planner`'s Repository Improvement Assessment swarm, which runs this skill and `codebase-integrity-audit-loop --parallel-report` together by design — reconciliation there is the captain's job, not either lane's. Under RIA, this skill receives `presentation_policy.report: inherit`; the RIA parent owns the single report election and, when elected, the combined report carrying this skill's grade.

For `recommended_action: design`, emit this health-to-architecture packet and stop; it is design-only, preserves identity, and cannot trigger a health scan recursively:

```yaml
return_to_improve_codebase_architecture_mwdev:
  source_skill: repository-health-assessment
  repository: { name: "", revision: "", freshness: "", report_path: null }
  health_context: { final_grade: "", confidence: 0, weighted_coverage: 0, caps_applied: [] }
  candidate: {}
  architecture_context: { architecture_health_claims: [], contract_health_claims: [], affected_surfaces: [], existing_adrs: [], known_constraints: [], human_decisions: [] }
  return_contract: { preserve_candidate_id: true, implementation_authorized: false, parent_owner: repository-health-assessment }
```

For `direct-fix`, `fitness-check`, or `triage`, emit the integrity input packet from the integrity skill with `mutation_authorized` and `merge_authorized` copied from the caller; do not infer either authority. On an integrity reassessment request, retain prior claims, surfaces, lanes, and candidate IDs, render their transitions, and reject unexplained absence.

Close by telling the user, in this order: the grade and its confidence, the weighted coverage and what was **not** assessed, the caps that bound the grade, the single highest-priority candidate, the count routed to each downstream skill, and whether the generic Evidence Recon sidecar is valid plus its path/reference. Then stop.

Selection is not implementation approval. Do not start fixing anything from this skill.

## Definition of done

- The full default surface inventory is present, weighted coverage is computed from it, and unassessed surfaces are visible rather than silently absent.
- One Evidence Recon v1 sidecar validates; lane provenance is preserved; confirmed/inferred/unknown remain separate; unsupported negative claims are not promoted to safe facts.
- All six required lanes carry six dimension levels, each with its own claim references and rationale, each coherent with the results of those claims.
- Every command run is recorded with its result and isolation mode; the baseline state is derived from them.
- `final_grade` is derived, every applied cap is named with its trigger, and confidence is reported separately.
- The candidate ledger validates against the shared spine, every candidate carries `lane_sources` and `claim_refs`, and every candidate has a visible row in the report.
- Every optional lane is either scored or declared not-applicable with evidence.
- No candidate from a previous run has silently disappeared.
- The report renders every number from the island, displays every lane in it, and the verification chip is green.
- Nothing in the repository under assessment was modified.
