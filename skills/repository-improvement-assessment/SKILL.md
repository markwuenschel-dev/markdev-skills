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

### The request

`request.schema.json` is the closed contract and `request.example.json` is a working request; start from the example. An unknown top-level field is rejected (`FAIL-RIA-REQUEST`) rather than ignored, so a typo fails at the door. A custom adapter puts its own inputs under `adapter_options`.

Required: `repository` (`root` or `roots`), `command_authorization`, `sei_compatibility_binding`.
Common optional: `lifecycle` (`plan` · `run` · `continue` · `report-only` · `verify-only`, default `run`), `depth` (`quick` · `standard` · `deep` · `custom`), `scope`, `require_clean`, `reuse_controls`, `verification_contract`, `presentation_policy`, `allow_degraded`.

`reuse_controls` keys are **case-sensitive and deliberately inconsistent**: `SEI`, `verification`, `Health`, `Integrity`, `Architecture`. Values are `auto` · `rerun` · `require-reuse`.

**`verification_contract.commands` entries are literal shell strings.** Each is handed to the platform shell (`cmd.exe` or `/bin/sh`) inside the isolation worktree — they are not exec'd as argv, and there is no `command_definitions` form. Write what you would type at a prompt: `"node --test"`, not `"test"`. The sole reserved sentinel is `"node-version"`. An entry may instead be `{ "command": "...", "kind": "test|build|lint|typecheck|other" }` to pin the command class; otherwise `kind` is derived from the command string and marked `kind_inferred: true`, and an unrecognised command derives `other`, never `test`.

### Scope and the working tree

`scope: "head"` assesses the committed HEAD revision. Uncommitted work is out of scope by construction and **does not enter baseline identity**, so a scratch file cannot defeat exact reuse; the run reports what it skipped in `working_tree` and on stderr. Set `require_clean: true` to refuse to start while the tree is dirty.

`scope: "worktree"` is accepted **only** with `durable_mode: "content-addressed-degraded"` (non-Git roots). On a Git repository it is refused up front with `FAIL-RIA-SCOPE-UNSUPPORTED`: the scope sets `repository.revision` to a synthetic content hash, and SEI anchors its history window and Repository Index binding to that value while deriving its own revision from Git, so `shared/software-engineering-intelligence/incremental-run-state.js` rejects the pair. The isolation layer itself handles the scope correctly — `isolateSource` pins the checkout to `head_revision` and layers the uncommitted delta over it, recording the result in the artifact's `isolation.overlay` — so what remains is separating "identity revision" from "Git history anchor" across the RIA/SEI boundary. Until that lands, `head` is the scope for Git repositories, and it no longer demands a clean checkout.

**No `verification_contract` means an unverified run.** It proceeds, Health caps its grade at C (`not-run`), and `result.verification.trust_state`, stderr and a banner above the report grade all say so. Commands run in a fresh detached worktree that holds **tracked files only** — no `node_modules`, virtualenv or build output — so a command that needs dependencies must install them itself (e.g. `"npm ci && npm test"`). Each command is killed at `timeout_ms` (default 10 minutes) and recorded as `timed-out`, which blocks the run like any other failure.

`presentation_policy` is one of `generate` · `skip` · `ask` · `inherit`; anything else is rejected. The CLI cannot hold an interactive election, so `ask` and `inherit` behave like `skip` and print a note saying so.

### Exit codes

| code | status | meaning |
|---|---|---|
| 0 | `complete` · `degraded` · `planned` | Ran to completion. `degraded` means the projection is incomplete. |
| 1 | — | An error was thrown; the stack is on stderr. |
| 2 | `blocked` | A strict task failed — including a failed verification gate. |
| 3 | `awaiting-owner-returns` | Owner rendezvous; resume with `lifecycle: "continue"` and `state_path`. |

Every non-zero exit writes a one-line summary to stderr. With `--output` the full result goes to the file and stderr names it.

### Verification is a gate, not a receipt

If any verification command does not pass, the artifact records `trust.state: "untrustworthy"` and the run **blocks** (exit 2). Pass `allow_degraded: true` to proceed anyway; the artifact still carries the verdict so no downstream owner can read it as a clean baseline. The artifact is always written before the gate is applied, so a refusal is backed by evidence on disk.

Before starting, mint a canonical baseline (`scripts/build-baseline.js` or the `baseline-build` node) and verify it with `scripts/verify-baseline.js`. A hash-valid JSON file is not a valid `ria.baseline@1` artifact unless the canonical verifier accepts it.

The default durable mode is `git` and requires the declared root to be the Git root. For a non-Git tree, explicitly choose `durable_mode: "content-addressed-degraded"`. Set `scope: "head"` to assess the committed `HEAD`; it does not require a clean checkout (see [Scope and the working tree](#scope-and-the-working-tree)). `scope: "worktree"` is refused on a Git repository (`FAIL-RIA-SCOPE-UNSUPPORTED`) and is the only scope non-Git degraded mode permits. The baseline, tests, inventories, and every owner must use the same surface.

## Engineering intelligence evidence

Use [references/engineering-intelligence.md](references/engineering-intelligence.md) and `engineering-intelligence.schema.json` for the closed contract. The reference contains only `artifact_id`, RIA ownership/kind/version, lowercase SHA-256, repository revision, mission id, scope hash, and its exact baseline binding. It has no storage path, payload, alias, grade, candidate, score, recommendation, graph, lifecycle, verification, or publish field.

RIA resolves the canonical repository storage root itself at `.project-intelligence/evidence/engineering-intelligence/`; a consumer never supplies or follows a path. It first reads the closed immutable `baseline-pin/<binding-hash>.json` first-minted binding and the reusable `baseline-index/<binding-hash>.json` mapping; the index must exactly echo the independent pin before reuse. RIA then rehashes the bound `<sha256>.json` bytes before parsing, validates the closed artifact and M2 snapshot, and checks the exact mission, scope, revision, and baseline binding. A missing, corrupt, substituted, mismatched, or differing pre-existing pin/index/artifact byte sequence is a fail-closed blocker, never a reason to recompute or overwrite.

Each child receives the closed `{ baseline_ref, engineering_intelligence_ref, sei_assessment_ref?, verification_baseline_ref, presentation_policy: "inherit", candidate_namespace }` envelope (`shared/ria-owner-return/owner-return.schema.json` `input_binding_echo`). Every field except `candidate_namespace` is identical across the three owners; `presentation_policy` is the string `"inherit"`, never an object. `candidate_namespace` is per owner — `health`, `integrity`, or `architecture` (`CANDIDATE_NAMESPACES` in `shared/ria-owner-return/owner-return.js`) — and the return validator rejects an echo whose namespace is not the returning owner's. `verification_baseline_ref` is required for Health and Integrity. `sei_assessment_ref` is optional for v1 compatibility. A child may consume either evidence reference read-only and must echo the supplied bindings exactly with its own reference. Architecture may omit `verification_baseline_ref` when it is not relevant.

**Candidate id namespace.** Each owner prefixes every `candidate_id` it mints with `<candidate_namespace>:` (for example `health:CONTRACT-007`). An owner that adopts an upstream candidate — Integrity taking a Health ledger row, Architecture taking a Health candidate under `health_context` — keeps the upstream id unchanged. The report model rejects a `candidate_id` that appears under two owners unless it is such an adoption: the id carries the namespace of one of the owners that hold it, or (legacy unprefixed ids) every copy carries the same title (`CANDIDATE_ID_CROSS_OWNER_DUPLICATE`, `scripts/report-model.js` `assertNoCrossOwnerDuplicates`).

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

The pause payload is self-describing: `owner_rendezvous.contract` names the return schema, the validator and its export, the required fields, and each owner's writer script. Each owner runs its writer with the environment in `owner_rendezvous.contract.env` (`RIA_RUNTIME_ROOT=<run directory>`, because writers confine `--output`/`--return-out` to `<repo>/.project-intelligence/` or `$RIA_RUNTIME_ROOT`; never `--allow-path-outside`) and `--ria-envelope <envelopes[owner]> --return-out <return_paths[owner]>`. **`--return-out` matters** — without it the writer prints the return to stdout and the file RIA requires is never created, which is indistinguishable from an owner that never ran. `owner_rendezvous.contract.sei` names the one SEI reader (`reader.module`, `reader.export` = `readSeiEvidence`) and the exact bound `engineering_intelligence_ref` and `sei_assessment_ref`. Health and Architecture cite SEI metrics as `{kind: "sei-criterion", criterion_id, metric_id}`; their writers check each citation against the bound assessment bytes, and the owner-artifact verification node re-checks it authoritatively (`FAIL-RIA-SEI-CITATION` blocks, even with `allow_degraded`).

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

When generated, the report is a **read-only presentation projection**. It may dereference the validated owner artifacts to synthesize an executive assessment, owner summaries, cross-cutting patterns, top priorities, uncertainty/coverage, and downstream dispositions. Candidate rows include Health, Integrity, and Architecture; the table caption states shown of total. Integrity/health priority bands use the candidate-ledger spine (`Strong` / `Worth exploring` / `Speculative` on −10…+22), never the 0–100 `priorityLabel` scale. When the request does not author `downstream_routing`, routing is derived from the bound artifacts (`deriveRouting`, `scripts/report-model.js`): Architecture candidates by disposition; Integrity candidates by status, with `execution_mode: blocked-needs-human-decision` going to `decision_queue`; Health candidates by spine-v3 `rollup.recommended_action` — `design`/`prototype` → `to_architecture`, `direct-fix`/`fitness-check`/`triage` → `to_integrity`, `reject` unrouted — except that `execution_mode: blocked-needs-human-decision` (⇔ status `needs-human-decision`) always goes to `decision_queue`. `execution_mode` values `sequential`/`swarm`/`connected-impact-sweep` describe how to run, not where to route. Trend is a presentation sidecar from SEI comparison; it is not an ASSESS field. The report must visibly attribute every derived item to its owner and preserve canonical IDs. Graph, execution, verification, integration, and publish state remain `not-yet-created`.

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

The source for all six is the canonical Repository Health lanes. A dedicated `architecture.fitness@2` value (or read-migrated legacy `@1` value) from Architecture Improvement Intelligence replaces only the architecture dimension when present. **The verification dimension is always Health's `verification-readiness` lane.** Specialist evidence never becomes a fourth `assessment_ref` and is never added as extra weight.

Letter grades use the shared `shared/ria-scoring/scoring.js` A+ through F mapping. Health caps remain visible and may cap the final composite; the report always shows raw score, raw grade, binding cap, final score, and final grade separately.

**Not gradable propagates.** When Health's grade is `Not gradable` (a core surface `unavailable` or `uninspected`, or weighted coverage below the 40% floor), the RIA composite is `Not gradable` too, with Health's reason: no raw or final score and no letter are computed (`compositeAnalytics`, `scripts/report-model.js`). The report renders the reason in place of the dial value.

**Critical optional Health lanes.** `security-and-production-safety` (weight 5) and `data-and-migrations` (weight 4) are optional Health lanes heavy enough to be critical. They have no RIA weight — the six-dimension table is fixed in `shared/ria-scoring` and is out of scope here. When present they are rendered explicitly (`composite.optional_critical_lanes`, the scoreboard caption) and bind the composite through Health's `weakest-critical-lane` cap, which RIA translates and applies.

**Rescaling between rubrics.** Health lane scores are 0–100 (`Σ level ÷ 4 × weight`) and Health letters use a five-band rubric (A ≥ 90, B ≥ 75, C ≥ 50, D ≥ 25). RIA reuses the same 0–100 lane numbers unchanged but letters them on the thirteen-band RIA scale (C = 73–<77). Health cap ceilings are letters on Health's rubric, so `translateHealthCaps` converts each to a score (`ceiling_score`, e.g. Health "B" → 89.999) before `applyGradeCaps`; the RIA letter table never reinterprets a Health letter. The same number can carry different letters on the two rubrics; neither is a miscalculation of the other.

### Composite v2 shadow (composite-scoring-v3, D6)

The full specification is [references/composite-scoring-v3.md](references/composite-scoring-v3.md) (v3.1). This subsection records how this skill implements it.

Every report also computes `analytics.composite_v2`, a `ria.composite@2` document from `shared/ria-scoring/composite-v2.js`: nine dimensions, each scored by every eligible owner (Health, Architecture, Integrity, SEI). **v1 above stays the reported grade.** v2 is rendered in the section "v2 composite — uncalibrated shadow" with its status, point and bounds, confidence, run state, caps, per-contribution states and shares, dependence, contested dimensions, canonical defects and nominal versus effective influence. The headline switches to v2 only when `shared/ria-scoring/composite-v2.policy.json` selects it **and** its calibration receipt verified (`composite_v2.reported === true`). That needs Promotion B; no reducer changes.

- **Binder:** `scripts/composite-v2-model.js` `compositeV2Analytics`. It reads the hash-bound owner artifacts read-only. It also uses the Architecture evidence receipt from owner-artifact verification, the SEI assessment through `readSeiEvidence`, and the verification baseline. `ria-agent-adapter.js` and the stock adapter pass these through `v2ContextFromRun`. `build-report-data.js --ria-envelope <owner-envelope.json> --repo <root>` re-derives them from the same bound bytes (`v2ContextFromEnvelope`).
- **Missing versus corrupt (§5.3, §9.1):** with no bound SEI assessment, or bound SEI bytes that are absent, SEI contributions are `failed` and the shadow is `degraded`. Hash, shape, path or binding problems fail with `FAIL-RIA-COMPOSITE-V2-SEI`, `FAIL-RIA-COMPOSITE-V2-VERIFICATION` or `FAIL-RIA-ARCHITECTURE-EVIDENCE`. These failures are `non_degradable`, so they block. v1 never depends on the v2 context.
- **Shadow availability (§5.3):** if a partial installation is missing a v2 implementation file (a module or data file under the skills tree) and `composite-v2.policy.json` reports v1, the report omits `analytics.composite_v2`. It records `provenance.composite_v2_shadow: false` and `provenance.composite_v2_unavailable` naming the file, and v1 is unchanged. Everything else still blocks: receipt hash mismatches, binding failures, invalid evidence, any `FAIL-*` or non-degradable error, and any error while policy selects v2 as the headline.
- **Receipts and sources (§7.1, §7.2, §9.2):** proof receipts are content-addressed `ria.proof-receipt@1` files (`<sha256>.json`). They live under the assessed repository's `.project-intelligence/assessments/integrity/receipts/` or the runtime root's `receipts/` [assumed location]. A proof or containment record whose receipt bytes are absent is inadmissible. Bytes that don't hash to their name block (`FAIL-RIA-PROOF-RECEIPT`, non-degradable). Integrity coverage path refs are resolved at the assessed source snapshot (the Git commit for a clean single root, otherwise the working tree). An unverifiable receipt leaves Integrity `insufficient_evidence`. A strong observation counts only when its cited file and line range exist in that snapshot. Every Integrity coverage ref must resolve. Absence needs every applicable surface `inspected`, each with a file inventory (path refs, or resolving file paths in a closed `scope` grammar), and a search that covers all of them. A scored Architecture sub-dimension counts only when its receipt entry has `evidence_complete: true`; otherwise its weight is missing mass that widens the bounds (§4.1).
- **Verification outcomes (§9.2):** baseline `passed`→`pass`, `failed`→`fail`, `timed-out`→`timed-out`, `skipped`→`skipped`, `unavailable`→`error` (could not start).
- **Normalization choices the spec leaves open** [assumed, calibration items]:
  - *Health* facts are the claims its lane dimension scores cite. Line-bound evidence is `strong` when the claim is mechanical or has a confirmed observation; otherwise it is `moderate`. The executed shared verification commands are Health's strong original facts for verification (test kinds) and delivery (other kinds).
  - *SEI* facts are the observations of the mapped dimension's applicable criteria, at criterion confidence (HIGH strong, MODERATE moderate, LOW weak).
  - *Integrity* facts are the code evidence of findings it holds, plus inspected or sampled surface path refs and negative-claim path sources, at their declared quality.
  - *Architecture* facts come from `architecture.evidence-binding@1`.
  - Architecture candidates enter canonical defects only through Integrity rows (`ledger_candidate_ref`). SEI deficiencies never do.
  - `change_and_docs` combines `change_discipline`, `documentation` and `developer_experience` by SEI rubric weight.

### Testing evidence and review lanes

Repository Health dispatches the `review-*` lanes itself and folds each review report into its lanes as **claims** (see `repository-health-assessment/REVIEW-LANES.md`). `review-testing` therefore reaches RIA as claims inside Health's `verification-readiness` lane. RIA no longer schedules `review-testing` in the `owner-health` node (`scripts/build-execution-plan.js`) and no longer substitutes a testing score for that lane — doing so counted the same evidence twice, while Health's cap on the replaced lane still bound the composite.

A legacy `ria.testing-fitness@1` sidecar (`specialist_refs` kind `testing-fitness`, or `build-report-data.js --testing-fitness`) is still accepted, hash-verified, and shown beside the Health lane as **informational** (`composite.testing_informational`). It is never substituted and never combined with Health caps. Coverage must be recorded as covered/total counts for `line`, `branch`, and optionally `changed_line`; do not infer coverage from test counts and do not average package percentages. If coverage tooling is absent, record coverage as unavailable and surface the missing measurement as an integrity opportunity.

### Architecture evidence binding

Owner-artifact verification re-resolves Architecture's packet-qualified claim refs against the bound packet bytes on every run, including `continue` and `report-only`, because this node is never served from cache (`architecture-improvement-intelligence/assets/architecture-evidence-binding.js`, `architecture.evidence-binding@1`). The receipt, `owner-artifact-verification.architecture_evidence`, lists §6.1 evidence keys per fitness sub-dimension with quality and origin. Composite v2 reads it in shadow mode. Tampered or unparseable packet bytes, path escape, binding mismatch and dangling refs fail with `FAIL-RIA-ARCHITECTURE-EVIDENCE`. Like `FAIL-RIA-SEI-CITATION`, that failure is `non_degradable` and blocks even under `allow_degraded`. Policy violations in an artifact that bypassed the writer are withheld (`withheld[]`), never credited. A packet file that is legitimately missing leaves that evidence missing.

### Evidence Recon sidecar

Health's validated Evidence Recon sidecar reaches RIA as a `specialist_refs` entry of kind `evidence-recon`: `{kind, schema_version: "evidence-recon.packet@1", artifact_id: "evidence-recon:<sha256>", sha256, repository_revision, path, artifact_path, packet_id: "RHA-ER:sha256:<64 hex>"}`. The owner-return validator re-hashes the file and checks the shape; the report model re-binds the bytes, packet id, and producer and lists it under `specialist_bindings`. It contributes no score.

From evidence-recon 1.1.0 the packet may carry `producer.artifact_refs: [{kind: "health-artifact", artifact_id, sha256}]`. When that ref is present, the report model requires its `sha256` to equal the hash-bound Health artifact's sha256. A mismatch fails with `EVIDENCE_RECON_HEALTH_ARTIFACT_MISMATCH`. A legacy sidecar without the ref is still accepted. `provenance.evidence_recon_artifact_bound` records which case applied, so a report never claims a binding it did not check.

When Health claims came from review-fitness reports (`review_source.proof_basis`), the report shows how many are mechanical and how many are judged (`analytics.health.review_proof_basis`). This is display only and changes no score.

### Architecture fitness

Correction (RIA v2 Phase 4): Architecture Improvement Intelligence must supply complete `architecture_fitness` @2 or `architecture_fitness_unavailable: { reason_code, detail }` under `--ria-envelope`. `write-candidate-set.js` preserves all eight dimension states through `architecture.fitness@2` using the fixed eight-dimension weighting in `assets/architecture-fitness.js`. The reader migrates legacy @1 artifacts in memory; v1 headline arithmetic remains active. RIA validates the Architecture payload after checking the shared owner-return envelope. Candidate priority remains separate from repository Architecture Fitness. Architecture coupling and churn consume SEI evidence through `engineering_intelligence_ref`; do not invent a parallel Architecture `history_window`.
