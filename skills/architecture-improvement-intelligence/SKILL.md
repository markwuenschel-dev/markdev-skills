---
name: architecture-improvement-intelligence
description: Use when a user asks for a read-only structural architecture analysis, architecture opportunity discovery, or one-candidate architecture design handoff without implementation. Under `--assessment`, act as RIA's canonical read-only architecture owner and return a hash-bound assessment reference only. Not for health grading, generic code review, execution, publication, or user-facing implementation planning.
disable-model-invocation: false
---

# Improve Codebase Architecture — V2

ICA V2 discovers, challenges, ranks, and routes architecture improvements. Its job is not to maximize refactor count or force every problem into a "deep module" answer. Its job is to reduce conceptual burden, clarify authority, improve locality and leverage, and produce decision-ready architecture candidates with explicit evidence and proof obligations.

## Governing principle

**Architecture rigor is mandatory. Architecture ceremony is conditional.**

Every substantive run must establish sufficient evidence, execute the architecture coverage sweep, challenge candidate transformations, and preserve uncertainty. It must not always pay for the same machinery:

- evidence discipline is mandatory; `shared/evidence-recon` selects `inline` or `expedition` based on the evidence topology;
- architecture coverage is mandatory; an aggressive swarm is used when independent surfaces exist, not because a fixed worker count was requested;
- candidate quality gates are mandatory; the HTML report is optional;
- decision topology belongs to Decision Terrain Mapper, not ICA;
- implementation remains outside ICA.

## Shared contracts

Resolve and obey:

- `shared/evidence-recon` — canonical evidence packet, coverage/confidence separation, contradiction reconciliation, negative-claim receipts, inline/expedition selection;
- `shared/assessment-acceleration` — adaptive concurrency profile, work-conserving ThreadPool-style execution, caching, performance receipts;
- `agent-executor-pool` — bounded READY queue, leases/resources, `as_completed` refill behavior, cancellation;
- `shared/candidate-ledger-spine` — candidate identity, eligibility, scoring arithmetic, stable ranking, ledger verification;
- `/codebase-design` — architecture vocabulary: **module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**, deletion test, and design-it-twice.

ICA does not privately reimplement those mechanisms.

## Family handoff contract

ICA has three bounded modes:

1. **Standalone architecture discovery** — analyze the user's stated repository/architecture scope and return a canonical architecture candidate set; render an HTML review only when comparison benefits from it or the user/caller requests it.
2. **One-candidate design handoff** — analyze exactly one validated spine-v3 candidate and return a disposition/recommendation without widening into an unrelated repository-wide review. The input is the bare spine-v3 candidate plus an optional `health_context` when Repository Health routed it here (`recommended_action` `design` or `prototype`):

   ```yaml
   candidate: {}            # one spine-v3 candidate, unchanged (candidate_id keeps its upstream namespace, e.g. "health:ARCH-003")
   health_context:          # optional; present only when repository-health-assessment is the source
     source_skill: repository-health-assessment
     health_artifact_ref: { artifact_id: "", sha256: "" }   # the hash-bound Health artifact the candidate came from
     lane_sources: []       # Health lane ids whose claims produced the candidate
     claim_refs: []         # Health claim ids that evidence it
   ```

   `health_context` is evidence, not authority: re-verify `health_artifact_ref.sha256` against the artifact bytes before citing a claim, and keep the candidate's `candidate_id` unchanged in the return (an adopted id is never re-minted).
3. **`--assessment`** — canonical RIA architecture-owner mode; read-only, hash-bound, reference-only return.

In every mode inherit mission, scope, non-goals, mutation posture, decision owner, and return owner. Do not implement. Do not mutate `CONTEXT.md`, ADRs, source files, tests, or generated tracked project artifacts. Runtime evidence/candidates/reports may be written only beneath the Git-locally-excluded `.project-intelligence/` workspace. If domain vocabulary or an ADR should change, emit a proposed documentation update for the authorized caller.

### One-candidate return

```yaml
architecture_candidate_return:
  candidate_id: ""
  disposition: ready_for_integrity_loop | needs_expanded_grill | needs_decision_terrain_mapper | needs_prototype | blocked_needs_human_decision | rejected | superseded
  recommended_direction: ""
  alternatives_considered: []
  rejected_alternatives: []
  confirmed_architecture_findings: []
  inferred_findings: []
  unknowns: []
  affected_surfaces: []
  connected_impact_required: false
  implementation_constraints: []
  verification_obligations: []
  proposed_domain_updates: []
  proposed_adr_updates: []
  artifact_links: []
  updated_candidate: {}
```

## `--assessment` — canonical RIA owner mode

`--assessment` is accepted only from RIA's subordinate assessment topology with the exact closed `{ baseline_ref, engineering_intelligence_ref, sei_assessment_ref?, verification_baseline_ref?, presentation_policy: "inherit", candidate_namespace: "architecture" }` envelope (`shared/ria-owner-return/owner-return.schema.json` `input_binding_echo`) and router-owned runtime identity. `sei_assessment_ref` is additive and optional for v1 compatibility; `verification_baseline_ref` may be absent when not relevant; `presentation_policy` is the string `"inherit"`.

**Candidate namespace.** Prefix every `candidate_id` this run mints with `architecture:` (the supplied `candidate_namespace`). A candidate adopted from Health or Integrity keeps its upstream id unchanged. RIA rejects a `candidate_id` that two owners minted independently (`CANDIDATE_ID_CROSS_OWNER_DUPLICATE`).

The supplied evidence references are resolved only as closed, hash-verified, baseline-bound evidence. They may support architecture findings but never replace ICA's architecture-judgment authority. The child echoes every supplied binding in its artifact.

**Reading and citing SEI evidence.** Read SEI evidence through the one reader RIA names in its rendezvous (`contract.sei.reader`): `require("<skills>/repository-improvement-assessment/engineering-intelligence-reader.js").readSeiEvidence({ repository_root, envelope })` returns `{ snapshot, assessment, assessment_status }`, with the snapshot and the scored criterion assessment both hash-verified and cross-bound to the envelope. `assessment_status: "missing"` means no `sei_assessment_ref` was bound; any thrown `FAIL-SEI-*` / `FAIL-ENGINEERING-INTELLIGENCE-*` error is a typed blocker, never missing evidence. To cite one SEI metric, add `{ "kind": "sei-criterion", "criterion_id": "<criteria[].criterion_id>", "metric_id": "<an observation_id or source_metric_ids entry of that criterion>" }`. Cite only what is in `assessment.criteria` of the bound bytes, not the rubric; the writer rejects anything else (`FAIL-SEI-CITATION-INVALID`) and RIA re-checks it (`FAIL-RIA-SEI-CITATION`). SEI citations are adopted evidence: a contribution whose consumed evidence is at least half SEI citations counts as dependent on SEI in RIA's composite v2, not as an independent measurement. In a candidate the citation is one entry of `evidence_refs[]`, beside the usual reference strings.

**Binding fitness evidence to packets (RIA mode, `architecture.evidence-binding@1`).** Under `--ria-envelope`, store each Evidence Recon packet with `writeEvidencePacketForRepository` and list it in `evidence_packet_refs[]` as the structured ref `assets/architecture-evidence-binding.js` `packetRefFor(path, bindingFromEnvelope(envelope))` returns. Every scored fitness dimension then names the claims it used in its own `evidence_refs[]` as `evidence-recon:<packet sha256>#<claim id>`, and each cited claim declares `supports: ["architecture-fitness:<dimension_id>"]`. Attaching a packet to the whole set does not support any one score. Cited code must exist at the assessed revision inside `scope.included`. Evidence repackaged from Health or SEI stays adopted. The writer rejects violations (`FAIL-ARCHITECTURE-EVIDENCE-*`) and RIA re-checks on every run. `assets/architecture-candidate-set.ria.example.json` with `assets/canonical-ria-evidence-packet.json` is the worked example; [MIGRATIONS.md](MIGRATIONS.md) has the full rules.

Return exactly one immutable reference:

```json
{ "owner": "architecture-improvement-intelligence", "artifact_id": "", "sha256": "", "repository_revision": "" }
```

The assessment artifact may contain architecture findings/evidence owned by ICA, but the public return must not contain remediation graphs, action sets, execution plans, candidate selection, flywheel handoffs, verification results, Stage 15 results, or publish decisions. RIA owns the global executor; ICA submits owner-tagged `architecture:*` jobs into that pool rather than starting a nested full-size swarm.

Typed blockers include baseline mismatch, write request, missing runtime identity, inaccessible revision, stale/mismatched evidence references, and unavailable evidence that prevents a required claim.

# Process

## 0. Frame scope, authority, and performance profile

Read only enough repository identity, instructions, domain glossary/ADR index, and topology to form safe evidence packets. Do **not** finish the analysis in the parent before fan-out.

Read [PERFORMANCE.md](PERFORMANCE.md). Resolve the shared aggressive concurrency profile. The active worker count is adaptive; use as many non-overlapping lanes as the evidence and architecture topology justify, subject to the runtime ceiling and resource policy.

Determine:

- architecture question/scope;
- required completeness and false-negative cost;
- authoritative source surfaces;
- mutation posture: read-only;
- evidence mode: `inline` or `expedition`;
- likely independent architecture surfaces for parallel analysis.

## 1. Establish evidence with `shared/evidence-recon`

Every substantive architecture claim must be backed by a validated Evidence Packet or packet fragment.

### Inline evidence

Use when the claim can be established coherently by the parent through bounded reads/deterministic searches. Inline does not mean weak. It means coordination would not reduce latency or improve coverage.

### Expedition evidence

Use when the evidence topology is wide/heterogeneous, required completeness is high, contradiction risk is material, or repository-wide negative claims require independent coverage. Build non-overlapping lane packets from real surfaces and dispatch them through the shared bounded executor.

Evidence lanes return fragments only: claims, sources, coverage, uncertainty, contradictions, negative-claim receipts, affected surfaces. They do not score or choose architecture candidates.

**Negative claims require coverage receipts.** "No other caller", "no alternate construction path", "unused", "no tests", and equivalent claims are invalid without a search/coverage receipt adequate to support absence.

## 2. Run the mandatory architecture coverage sweep

Evidence completeness does not imply architecture completeness. After evidence gathering has established enough substrate, deliberately sweep relevant architecture lenses using [ARCHITECTURE-COVERAGE.md](ARCHITECTURE-COVERAGE.md).

At minimum consider, when applicable:

- canonical authority and ownership;
- module depth and interface burden;
- locality and change propagation;
- dependency direction/cycles;
- duplicate/parallel execution paths;
- state ownership and lifecycle transitions;
- seam placement and adapter maturity;
- pass-through/shallow-module pressure;
- concentration/god-module risk;
- transaction/concurrency/failure ownership;
- tests and proof surfaces;
- generated/cross-language/runtime seams;
- migration and compatibility;
- operational/recovery boundaries;
- change coupling/churn/hotspots;
- locked ADR/domain constraints.

The sweep can run as parallel architecture-analysis lanes over independent surfaces. It is mandatory even when evidence collection stayed inline.

## 3. Overgenerate candidate transformations

For each consequential friction surface, generate multiple materially different transformations before choosing one. Use the transformation vocabulary in [CANDIDATE-MODEL.md](CANDIDATE-MODEL.md):

- deepen/merge behind one narrower interface;
- split by genuine authority/lifecycle;
- relocate a seam;
- eliminate a false seam;
- inline a meaningless wrapper;
- consolidate state ownership;
- invert a dependency;
- isolate an adapter;
- remove a duplicate execution path;
- deliberately keep the current structure when the alternatives fail the architecture tests.

When spare agent capacity exists and the candidate is high-impact or ambiguous, run independent alternative-generation/critique workers in parallel. Do not duplicate routine scans simply to increase worker count.

## 4. Run the Architecture Candidate Critic

Before scoring, every proposed architecture transformation passes [CANDIDATE-CRITIC.md](CANDIDATE-CRITIC.md).

Hard failures include:

- cosmetic code cleanup masquerading as architecture;
- complexity merely moved rather than reduced/owned;
- a new seam with no real substitution/ownership value;
- interfaces that do not shrink or become easier to reason about;
- an authority change that creates ambiguity rather than resolving it;
- a god module created by indiscriminate merging;
- a recommendation that ignores a materially cheaper local alternative;
- missing migration/compatibility consequences where relevant;
- unsupported negative claims;
- unverifiable claimed benefits.

Candidates that fail are rewritten, downgraded to non-architecture work, or rejected. Scoring is not a substitute for eligibility.

## 5. Canonicalize, score, and rank

Emit a schema-valid `architecture_candidate_set` using `assets/architecture-candidate-set.schema.json`.

Only architecture-eligible candidates enter `shared/candidate-ledger-spine`. Preserve spine-v3 identity, provenance, arithmetic, eligibility, and stable ranking. Never hand-write priority scores or maintain a private scoring verifier.

The canonical candidate set is the source of truth. Use `assets/architecture-candidate-set.example.json`, `assets/architecture-candidate-set.schema.json`, and `assets/write-candidate-set.js` directly. Persist it with `assets/write-candidate-set.js --repo <repository-root>` so its immutable reference lives under `.project-intelligence/assessments/architecture/`. Under RIA, also pass `--ria-envelope <exact-input-envelope.json>`; the writer returns `ria.owner-return@1` without adding orchestration fields to the candidate-set artifact. HTML is a renderer, not the authority.

## 6. Report election

The canonical `architecture_candidate_set` is already complete and remains the source of truth. HTML is optional presentation.

Read `shared/report-election/REPORT-ELECTION.md`.

- Direct user invocation with no explicit report preference → compute a result-specific machine lean and ask A/B.
- Explicit report request → generate without asking.
- Explicit no-report request → skip without asking.
- Nested invocation with `presentation_policy: "inherit"` (a string) → do not ask and do not render; return the canonical candidate set to the declared parent report owner.
- `--assessment` under RIA always inherits RIA's presentation policy unless the user explicitly asked for separate child reports.

Election shape:

> Architecture analysis is complete and a human-facing review can be generated.
>
> **A. Generate the full architecture report.**
> **B. Skip the report and return the canonical candidate set + concise recommendation.**
>
> **My recommendation: A/B —** [result-specific reasoning].
>
> Choose A or B.

Lean `generate` when multiple viable candidates materially benefit from visual comparison, cross-cutting architecture patterns exist, a broad repository review benefits from a durable artifact, or the caller needs a numbered selection surface. Lean `skip` for one bounded candidate with little visual/comparative value.

If elected, use the deterministic zero-network builder in `assets/build-report.js`. See [HTML-REPORT.md](HTML-REPORT.md). Do not introduce runtime CDN dependencies.

A skipped report does not alter candidate eligibility, scoring, routing, or architecture authority.

## 7. Route unresolved architecture work

ICA owns architecture judgment, not all downstream decision management.

- `ready_for_integrity_loop` — architecture direction is sufficiently determined; no material design decision remains.
- `needs_expanded_grill` — one bounded architecture surface contains unresolved consequential design decisions.
- `needs_decision_terrain_mapper` — the candidate unfolds into multiple independent/coupled decision surfaces whose cross-ticket topology needs durable mapping.
- `needs_prototype` — a material recommendation depends on empirical behavior that reading cannot settle efficiently.
- `blocked_needs_human_decision` — owner intent remains necessary and no downstream skill can resolve it from evidence.

ICA may use code/dependency/state graphs as evidence. It does **not** own the persistent decision-dependency graph; Decision Terrain Mapper does.

## 8. Final adversarial architecture sweep

Before returning a recommendation, run one fresh adversarial pass over the selected/leading candidates:

- What complexity was merely displaced?
- What authority is still ambiguous?
- What interface or state transition remains wider than claimed?
- What concurrency/failure/migration burden appeared because of the transformation?
- What simpler alternative is still plausible?
- What proof would falsify the claimed benefit?
- What evidence surface was unavailable or only sampled?

New consequential findings reopen candidate synthesis or routing. Do not declare closure because the ledger is populated.

# Performance invariants

The performance implementation is defined in [PERFORMANCE.md](PERFORMANCE.md). The following are hard requirements:

1. **Maximum safe concurrency.** Use as many non-overlapping lanes as the topology and runtime safely support; do not use arbitrary small fixed worker counts.
2. **ThreadPool semantics.** Submit all READY independent jobs before awaiting one, consume results as they complete, immediately refill freed slots, and avoid wave barriers.
3. **Deep READY queue.** On broad scopes, materialize enough real work to keep the agent pool saturated; do not create fake work to satisfy a number.
4. **Separate pools.** Read-only agent work may be aggressively oversubscribed; tests/builds/local commands use a smaller resource-aware class budget.
5. **Critical-path splitting.** Split stragglers when independent sub-surfaces exist and the split preserves evidence meaning.
6. **Incremental synthesis.** Start candidate/owner synthesis as soon as the required evidence for that surface settles; unrelated lanes continue concurrently.
7. **Single-flight/cache reuse.** Deterministic duplicate work is coalesced; exact/content-stable shards may support current claims, warm-only shards may not.
8. **No nested swarm explosion.** Under RIA, flatten ICA jobs into RIA's global pool.
9. **Performance receipts.** Record budgets, planned jobs, peak concurrency by class, queue depth, cache reuse, stragglers/splits, stage timings, report time, and wall time.
10. **Parallelism changes latency, not authority.** Spare capacity never widens scope or upgrades evidence quality/recommendation strength.

# Architecture vocabulary and domain language

Use `CONTEXT.md` domain vocabulary when present, but remain read-only. If a recommendation introduces or sharpens a domain term, return it under `proposed_domain_updates` rather than editing the file.

Respect ADRs as recorded decisions. Reopen an ADR only when current architecture friction is material enough to justify reconsideration; record the conflict and rationale in the candidate rather than modifying the ADR.

Use `/codebase-design` vocabulary consistently. Do not drift into vague synonyms when the shared architecture term is available.

# Stopping condition

ICA is complete when:

- evidence required for the recommendation is validated with explicit coverage/uncertainty;
- the architecture coverage sweep and final adversarial sweep are complete;
- each surviving candidate passed the architecture critic;
- candidates are canonicalized and, where eligible, verified by the shared scoring spine;
- unresolved work is routed to the correct owner;
- no implementation or unauthorized repository mutation occurred;
- the performance receipt accurately describes the execution topology.

## RIA runtime contract and responsive analytics

`RUNTIME-CONTRACT.json` is the source-owned machine interface used by RIA. The parent loads this compact contract in parallel rather than rereading the full skill. AII still reads and follows its full contract when invoked.

AII does not wait for the shared verification baseline unless a particular architecture candidate needs empirical evidence. It begins from the engineering-intelligence reference and evidence packets as soon as those prerequisites exist, submits owner-tagged work into the RIA global executor, and returns its immutable candidate set for immediate parent-side normalization.

Generated reports use `shared/report-presentation`. Material candidate scores, priority bands, dispositions, transformation types, and performance data are visualized when present. Missing canonical scores remain `Not scored`. Layouts adapt from phone to 32-inch/ultrawide displays without turning long prose into full-width lines.


## Repository-local artifact storage

Use `shared/project-intelligence-workspace` for durable Architecture Improvement Intelligence state. Canonical candidate sets and assessment artifacts belong under `.project-intelligence/assessments/architecture/`; elected reports belong under `.project-intelligence/reports/architecture/`; evidence packets use `.project-intelligence/evidence/`. Source analysis remains read-only; workspace writes are runtime-state maintenance rather than tracked source mutation.

**Workspace evidence boundary:** `.project-intelligence/` is runtime state, not repository evidence. Exclude it from filesystem inventories, counts, searches, and candidate discovery; only read it through declared artifact/cache interfaces.

## Repository Architecture Fitness for RIA

Candidate priority answers which architecture change should happen first; it is not a repository architecture grade. In RIA assessment mode, supply exactly one of complete `architecture_fitness` (`architecture.fitness@2`) or `architecture_fitness_unavailable: { reason_code, detail }` in the candidate-set input. All eight dimensions must be present in fitness @2. Use these dimensions:

- boundary integrity — 20%
- dependency direction and cycle control — 15%
- cohesion and locality — 15%
- interface and contract clarity — 15%
- state and data ownership — 10%
- change containment and evolvability — 10%
- duplication / competing implementations — 10%
- architectural testability / observability — 5%

Correction (RIA v2 Phase 4): the writer normalizes this through `assets/architecture-fitness.js` into `architecture.fitness@2`, retaining score, A+–F grade, global coverage, confidence in [0, 1] (or null when unavailable), fixed weights and each dimension's state. Each dimension is `{ score, state, reason_code?, detail?, evidence_refs? }`: `scored` requires a finite number in [0, 100]; `unavailable` and `not_applicable` require null score plus nonempty reason/detail. `not_applicable` also requires source evidence references bound to the assessed revision. Missing evidence is never zero. Global coverage counts scored fitness weight; RIA contribution eligibility uses only that dimension's mapped sub-scores.

`write-candidate-set.js --ria-envelope` rejects a missing or legacy fitness unless the explicit whole-fitness unavailable form is supplied (`FAIL-ARCHITECTURE-FITNESS-REQUIRED`), and rejects an input revision different from `baseline_ref.repository_revision` (`RIA_ENVELOPE_REVISION_MISMATCH`) before writing artifacts or owner returns. Use `--return-out` for the parent-named owner-return path. The report reader migrates legacy @1 numbers/nulls in memory; it never rewrites stored artifacts. v1 remains the reported composite during shadow work. Do not derive Architecture Fitness from candidate count, candidate priority, or disposition ratio.

