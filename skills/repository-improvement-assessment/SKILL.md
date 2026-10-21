---
name: repository-improvement-assessment
description: Primary ASSESS entry for a Repository Improvement Assessment (RIA). Use when the user asks to run a Repository Improvement Assessment or RIA that needs health, integrity, and architecture owner references from one baseline. Do not use for a health baseline alone or for graph reconciliation, execution, or publication. Returns the immutable ASSESS projection and, when the user elects it, a synthesized human-facing report.
---

# Repository Improvement Assessment

## Authority and return boundary

RIA is a directly invoked, read-only assessment owner. It coordinates three assessment owners from one baseline and returns its immutable assessment projection to the invoking caller. It never auto-dispatches reconciliation or delivery and never transitions `RECONCILE`, `EXECUTE`, `VERIFY`, `INTEGRATE`, or `COMPLETE`.

RIA requests one canonical, hash-bound reference from each owner:

- `repository-health-assessment` owns the health grade and health evidence.
- `codebase-integrity-audit-loop` owns integrity candidates.
- `architecture-improvement-intelligence --assessment` owns architecture assessment findings.

The canonical architecture invocation is `architecture-improvement-intelligence --assessment`. It is reference-only and does not substitute architecture triage, full design, or an implementation recommendation.

After establishing the baseline, RIA reads the immutable baseline-to-intelligence binding before it computes Software Engineering Intelligence. It reuses its first valid bound artifact or, only when no binding exists, computes and materializes it once while atomically pinning that first result. RIA alone writes its immutable, content-addressed `engineering_intelligence_ref`; SEI may additionally provide a content-addressed engineering-assessment sidecar, but each SEI reference is not a fourth member of `assessment_refs` and does not replace an owner.

RIA returns this immutable ASSESS projection and nothing from a later lifecycle stage:

```json
{
  "stage": "ASSESS",
  "owner": "repository-improvement-assessment",
  "baseline_ref": { "artifact_id": "", "sha256": "", "repository_revision": "" },
  "engineering_intelligence_ref": {
    "artifact_id": "engineering-intelligence:<sha256>",
    "owner": "repository-improvement-assessment",
    "kind": "engineering-intelligence",
    "schema_version": "1.0.0",
    "sha256": "",
    "repository_revision": "",
    "mission_id": "",
    "scope_hash": "",
    "baseline_binding": { "artifact_id": "", "sha256": "", "repository_revision": "" }
  },
  "assessment_refs": [
    { "owner": "repository-health-assessment", "artifact_id": "", "sha256": "", "repository_revision": "" },
    { "owner": "codebase-integrity-audit-loop", "artifact_id": "", "sha256": "", "repository_revision": "" },
    { "owner": "architecture-improvement-intelligence", "artifact_id": "", "sha256": "", "repository_revision": "" }
  ]
}
```

The projection contains exactly three canonical owner references plus the opaque engineering-intelligence evidence reference. The projection contains no graph, frontier, action set, execution packet, completion reference, verification verdict, integration receipt, Stage 15 outcome, publish decision, or future-stage artifact. Those values do not exist yet at ASSESS.

## Operating reality

RIA is an orchestration and evidence-binding harness, not a repository scanner. Production runs go through `executeRia(request, adapter)` in `scripts/ria.js` with `scripts/ria-agent-adapter.js`. The CLI defaults to that adapter:

```bash
node scripts/ria.js --request <request.json> [--adapter scripts/ria-agent-adapter.js] [--output <result.json>]
```

`scripts/test-support/ria-stock-adapter.js` is a fixture that reads canned child artifacts; never use it as evidence for a real repository. Adapters may implement only SEI, verification, owner, and report source tasks. Baseline verification, owner-return validation, ASSESS binding, event production, lineage persistence, and telemetry finalization remain non-overridable RIA authority seams.

Before starting, mint a canonical baseline (`scripts/build-baseline.js` or the `baseline-build` node) and verify it with `scripts/verify-baseline.js`. A hash-valid JSON file is not a valid `ria.baseline@1` artifact unless the canonical verifier accepts it.

The default durable mode is `git` and requires the declared root to be the Git root. For a non-Git tree, explicitly choose `durable_mode: "content-addressed-degraded"`. Set `scope: "head"` for a clean checkout of `HEAD` or `scope: "worktree"` to include authorized uncommitted changes. Non-Git degraded mode permits only `worktree`. The baseline, tests, inventories, and every owner must use the same surface.

## Engineering intelligence evidence

Use [references/engineering-intelligence.md](references/engineering-intelligence.md) and `engineering-intelligence.schema.json` for the closed contract. The reference contains only `artifact_id`, RIA ownership/kind/version, lowercase SHA-256, repository revision, mission id, scope hash, and its exact baseline binding. It has no storage path, payload, alias, grade, candidate, score, recommendation, graph, lifecycle, verification, or publish field.

RIA resolves the canonical repository storage root itself at `.project-intelligence/evidence/engineering-intelligence/`; a consumer never supplies or follows a path. It first reads the closed immutable `baseline-pin/<binding-hash>.json` first-minted binding and the reusable `baseline-index/<binding-hash>.json` mapping; the index must exactly echo the independent pin before reuse. RIA then rehashes the bound `<sha256>.json` bytes before parsing, validates the closed artifact and M2 snapshot, and checks the exact mission, scope, revision, and baseline binding. A missing, corrupt, substituted, mismatched, or differing pre-existing pin/index/artifact byte sequence is a fail-closed blocker, never a reason to recompute or overwrite.

Each child receives the identical closed `{ baseline_ref, engineering_intelligence_ref, sei_assessment_ref?, verification_baseline_ref, presentation_policy }` envelope. `verification_baseline_ref` is required for Health and Integrity. `sei_assessment_ref` is optional for v1 compatibility. A child may consume either evidence reference read-only and must echo the identical supplied bindings with its own reference. Architecture may omit `verification_baseline_ref` when it is not relevant.

## Lifecycle, depth, and reuse controls

The explicit caller selects one mode. RIA does not reinterpret it:

- `plan`: build and validate the canonical DAG without executing assessment nodes.
- `run`: execute a fresh scheduler run and return the ASSESS result or an owner-rendezvous pause.
- `continue`: resume the persisted DAG state after owner returns are written.
- `report-only`: require reusable assessment artifacts and build only the elected presentation projection.
- `verify-only`: run the verification lifecycle without granting later mutation authority.

Select `quick`, `standard`, `deep`, or an explicit closed `custom` budget. Per-component reuse controls accept only `auto`, `rerun`, or `require-reuse` for SEI, verification, Health, Integrity, and Architecture.

Unknown modes, an unresolved caller identity, a baseline mismatch, or a stale/malformed owner reference stop the assessment and return a typed blocker to the caller.

## Procedure

0. Enter by direct invocation. Capture repository scope, lifecycle, depth, command authorization, reuse controls, and presentation policy. Write a request JSON. Do not hand-schedule owner skills or report binders outside `executeRia`.
1. Run `node scripts/ria.js --request <request.json>`. The agent adapter loads `assets/sei-ria-config.json` (required `generated_path_patterns`, `history_window.kind` = `revision-range` bound to the baseline revision). If lineage has a comparable prior SEI snapshot, the adapter passes `--baseline`. Verification runs in a `worktree` or `copy` isolation workspace; coverage files stay there; isolation mode is never `read-only-source` when a command may write. Health and Integrity receive `verification_baseline_ref` in the envelope.
2. If the result status is `awaiting-owner-returns`, dispatch the three owner skills concurrently. Each envelope is at `owner_rendezvous.envelopes[<owner>]`. Each owner writes `ria.owner-return@1` to `owner_rendezvous.return_paths[<owner>]`. Then rerun with `lifecycle: "continue"` and the returned `state_path`.
3. `executeRia` persists lineage, a binding-keyed current pointer (`lineage/ria-current.json`), and the ASSESS projection before it returns `complete`. A rendered report without those records is a failed run.
4. Apply `shared/report-election`. Child reports inherit from RIA. For `generate`, the adapter calls `scripts/build-report-data.js` then `scripts/build-report.js`. For `skip`, return the ASSESS projection plus a concise synthesis and no report file.

Completion criterion: the invoking caller receives a baseline-bound immutable projection with one RIA-owned engineering-intelligence reference and exactly the three canonical owner references, stored lineage and current refs, or an explicit blocker / owner-rendezvous pause. Interactive users also receive either the elected responsive analytical report or an explicit elected skip.

## Owner rendezvous

Owner skills remain agents. The adapter does not scan the repository for Health, Integrity, or Architecture. It writes the closed envelope and consumes the owner-return file. Missing returns are `OWNER_RETURN_PENDING` (`status: "awaiting-owner-returns"`, exit code 3), not a reason to hand-run the rest of the DAG.

## Report election and synthesized report

RIA's immutable ASSESS projection is always produced first. Human-facing report rendering follows `shared/report-election` and is user-elected.

For a direct interactive RIA with no explicit report preference, ask:

> The Repository Improvement Assessment is complete and a combined report can be generated.
>
> **A. Generate the full RIA report.**
> **B. Skip the report and return the canonical ASSESS projection + concise synthesis.**
>
> **My recommendation: A/B —** [result-specific reasoning].
>
> Choose A or B.

The machine lean must use the actual assessment result. Cross-owner patterns, multiple high-priority findings, meaningful comparisons, score/coverage context, uncertainty, and durable review value generally lean `generate`; a tiny nearly-empty assessment may lean `skip`.

When generated, the report is a **read-only presentation projection**. It may dereference the validated owner artifacts to synthesize an executive assessment, owner summaries, cross-cutting patterns, top priorities, uncertainty/coverage, and downstream dispositions. Candidate rows include Health, Integrity, and Architecture; the table caption states shown of total. Integrity/health priority bands use the candidate-ledger spine (`Strong` / `Worth exploring` / `Speculative` on −10…+22), never the 0–100 `priorityLabel` scale. Downstream routing is derived from architecture dispositions when the request does not author `downstream_routing`. Trend is a presentation sidecar from SEI comparison; it is not an ASSESS field. The report must visibly attribute every derived item to its owner and preserve canonical IDs. Graph, execution, verification, integration, and publish state remain `not-yet-created`.

When RIA owns the report election, Health, Integrity, Architecture, and optional SEI child presentation policies are `inherit`.

## Deterministic contract check

```bash
node skills/repository-improvement-assessment/scripts/task3-contract-check.js
```

The scan proves the ASSESS-only direct return, closed engineering-intelligence evidence contract, explicit RGO invocation boundary, canonical `--assessment` architecture ownership, subordinate swarm topology, canonical action-graph separation, and policy-gated publication wording. It does not run a lifecycle.

## Repository-local intelligence workspace

Durable RIA state is resolved through `shared/project-intelligence-workspace` under `<repo>/.project-intelligence/`. `executeRia` records SEI, verification, and owner artifacts in `.project-intelligence/lineage/ria-artifacts.json`, publishes `.project-intelligence/lineage/ria-current.json`, and stores the ASSESS projection under `.project-intelligence/assessments/ria/`. Consumers resolve through that current pointer, never by counting files in a content-addressed directory. RIA may read verified legacy `.autonomous-loop/` state for compatibility, but all new durable writes use the canonical workspace.

**Workspace evidence boundary:** `.project-intelligence/` is runtime state, not repository evidence. Exclude it from filesystem inventories, counts, searches, and candidate discovery; only read it through declared artifact/cache interfaces.

## Composite scoring and specialist evidence

The human-facing report computes one deterministic RIA composite from six non-overlapping dimensions:

- correctness and integrity — 25%
- architecture fitness — 20%
- contracts and integration — 15%
- test-suite / verification fitness — 20%
- build and delivery — 10%
- maintainability and ownership — 10%

The baseline source for all six is the canonical Repository Health lanes. A dedicated `architecture.fitness@1` value from Architecture Improvement Intelligence replaces only the architecture dimension when present. A hash-bound `ria.testing-fitness@1` sidecar produced from `review-testing` replaces only the verification dimension when present. Specialist evidence never becomes a fourth `assessment_ref` and is never added as extra weight.

Letter grades use the shared `shared/ria-scoring/scoring.js` A+ through F mapping. Health caps remain visible and may cap the final composite; the report always shows raw score, raw grade, binding cap, final score, and final grade separately.

### Testing sidecar

Within the existing `owner-health` DAG node, the Health owner should run `review-testing` when budget and evidence allow, then normalize its authoritative `review-fitness-report/v1` through:

```bash
node review-testing/ria-testing-fitness.js \
  --review-report <review-testing-report.json> \
  --coverage <coverage-counts.json> \
  --output <ria-testing-fitness.json>
```

Pass that file to `write-health-artifact.js --testing-fitness <ria-testing-fitness.json>`. When invoking `build-report-data.js`, use the exact kebab-case flag `--testing-fitness`. Coverage must be recorded as covered/total counts for `line`, `branch`, and optionally `changed_line`; do not infer coverage from test counts and do not average package percentages. If coverage tooling is absent, record coverage as unavailable and surface the missing measurement as an integrity opportunity.

### Architecture fitness

Architecture Improvement Intelligence may include `architecture_fitness` in its candidate-set input. `write-candidate-set.js` deterministically normalizes it to `architecture.fitness@1` using the fixed eight-dimension weighting in `assets/architecture-fitness.js`. Candidate priority remains separate from repository Architecture Fitness. Architecture coupling and churn consume SEI evidence through `engineering_intelligence_ref`; do not invent a parallel Architecture `history_window`.
