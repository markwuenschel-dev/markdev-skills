# Swarm types

Loaded from SKILL.md after the router selects a type. Each section carries that type's goal, lanes, outputs, and hard rules.

**Global ownership rule:** this planner may run read-only lanes directly. Any type that would require repository mutation produces an execution topology only; `production-flywheel` owns the downstream worktree, mutation, commit, delivery loop, verification boundary, and publication policy. A mutating specialist named below is a lane method under Flywheel, never a competing delivery owner.

## Repo Audit swarm

Use when another skill (`codebase-integrity-audit-loop --parallel-report`) or the user needs broad repo-wide analysis without edits: the whole repo inspected through expert lenses, merged into one scored HTML report and one candidate ledger. It is not an Execution Swarm — no lane edits anything; the report and ledger artifacts are the only writes — and it stops at the candidate gate after the report/ledger. It never auto-selects a candidate: selection and any implementation happen only in a later, separately authorized loop, such as the user invoking auto mode against the ledger.

Goal: surface evidence-backed candidates and emit one deduplicated shared-spine ledger. Formal repository grades belong to `repository-health-assessment`.

Captain + adaptive evidence executor. The historical four lenses below are **coverage families, not a four-worker roster**. Split each family by independent subsystem/language/runtime/hotspot until the READY queue can keep the bounded read-only pool saturated; merge tiny packets when dispatch overhead would dominate.

- Audit Captain — Merge, Dedup, Report Integrator.
- Deepening-seams family — Matt-style module/interface/deepening analysis (vocabulary from codebase-design). Split by independent architecture surface.
- Graded-integrity family — maintainability, coupling, cohesion, reliability, security hygiene, test quality, data/model integrity, performance risk, and process drift. Split by independent subsystem or concern.
- Blast-radius family — connected-impact / Obra-style report-only impact analysis. Split by independent candidate/seam when evidence does not depend on another packet.
- Verification-readiness family — tests, missing test seams, red-capable checks, type/lint/build gates, fixtures/goldens, flaky/slow/unreachable tests, and required harnesses. Split by independent verification surface.

Dispatch all READY packets before awaiting one. Consume results as they complete and immediately refill freed worker slots. On broad repositories, logical packets should normally outnumber active workers so stragglers do not leave the pool idle. The captain alone reconciles cross-family duplicates and scoring.

Merge protocol (Agent 0):

- Deduplicate per REPORT-SCORING.md's Deduplication rules: candidates sharing a root cause, seam, behavior, file cluster, or implementation contract merge into one, with lane observations preserved under the merged candidate.
- Score and roll up every merged candidate per REPORT-SCORING.md; the report carries every section that file requires.
- Name human-decision blockers against connected-impact-sweep's `## Human-decision categories`.

Outputs:

- one scored, self-contained HTML report (sections per REPORT-SCORING.md)
- one candidate ledger (schema per REPORT-SCORING.md)
- explicit unknowns and rejected broad-cleanup items

Hard rules:

- Read-only: every finding is grounded in repository evidence gathered this run; the only writes are the HTML report, the candidate ledger, and any output file the user explicitly named.
- Stops at the candidate gate after report/ledger — no candidate selection, no implementation, no staged edits; candidate selection requires the user to separately invoke auto mode against the ledger.
- A lane that discovers something outside its lens reports it to the captain as a candidate, never acts on it.

## RIA Assessment Topology

This is a subordinate topology selected only by `repository-improvement-assessment` for the `ASSESS` stage. It is not a user-facing Repository Improvement Assessment, a lifecycle owner, a reconciliation path, or an execution swarm.

Goal: run the three canonical assessment owners from one supplied baseline and one RIA-owned opaque engineering intelligence reference, then return their immutable references to the caller.

- **Captain:** receives the caller-bound assessment identity and baseline reference; RIA computes/materializes SEI once, writes its own closed evidence reference, launches all three owners concurrently, and validates returns; never creates a graph or a lifecycle transition.
- **Owner envelope:** every owner receives the closed `{ baseline_ref, engineering_intelligence_ref, sei_assessment_ref?, verification_baseline_ref, presentation_policy: "inherit", candidate_namespace }` envelope defined by `shared/ria-owner-return/owner-return.schema.json` (`input_binding_echo`). All fields except `candidate_namespace` are identical across owners; `candidate_namespace` is `health`, `integrity`, or `architecture`, and each owner prefixes the candidate ids it mints with `<candidate_namespace>:`. `verification_baseline_ref` is required for Health and Integrity; `sei_assessment_ref` is optional.
- **Health owner:** `repository-health-assessment` receives that envelope with `candidate_namespace: "health"` and returns its canonical health reference.
- **Integrity owner:** `codebase-integrity-audit-loop` receives that envelope with `candidate_namespace: "integrity"` and returns its canonical integrity reference.
- **Architecture owner:** `architecture-improvement-intelligence --assessment` receives that envelope with `candidate_namespace: "architecture"` and returns its canonical architecture assessment reference. Architecture triage, standalone design, and implementation recommendation are not substitutes for this lane.
- **Presentation inheritance:** every report-capable child receives `presentation_policy: "inherit"` — the string, never an object; RIA (`repository-improvement-assessment`) is the report owner — unless the user explicitly requested separate child reports. Children return machine artifacts only; the RIA parent owns the single user-facing report election.
- **Global assessment executor:** when the runtime permits, flattens owner-tagged read-only evidence packets from all three owners into one bounded work-conserving pool. Owners keep their authority; the executor only schedules packets.
- **Shared command runner:** may provide read-only evidence authorized by the baseline under its own smaller command budget. It cannot change assessment ownership.

Do not give each owner a full-size nested swarm. If flattening is unavailable, RIA assigns explicit sub-budgets whose sum stays within the global ceiling and reclaims idle capacity as owners finish.

The captain returns exactly three hash-bound owner references plus the one RIA-owned opaque engineering intelligence reference and the baseline reference. The evidence reference is not a fourth owner or an `assessment_refs` member. It does not call `remediation-graph-optimizer`, compute an action graph or frontier, select candidates, schedule actions, invoke `production-flywheel`, invoke independent verification, run Stage 15, or publish.

Hard rules:

- Every lane is read-only and returns an owner reference, not copied findings or report payloads.
- The parent caller alone decides `RECONCILE` after all three valid returns. Missing, stale, duplicated, or cross-revision references return a blocker.
- This topology never appears as a second RIA command or semantic routing target. An explicit “Repository Improvement Assessment” or “RIA” routes to `repository-improvement-assessment`.

## Explorer swarm

Use when the problem shape is unknown.

Goal: map terrain, seams, candidates, risks, unknowns, and next actions.

Agents:

- Agent 0 — Exploration Captain / Map Integrator
- Agent 1 — Architecture / Module Topology Explorer
- Agent 2 — Data / Schema / Contract Explorer
- Agent 3 — Runtime / EntryPoint / CLI Explorer
- Agent 4 — Tests / Fixtures / Verification Explorer
- Agent 5 — Stale Paths / Legacy Surface Explorer
- Agent 6 — Docs / ADR / Intent Explorer
- Agent 7 — Risk / Unknowns / Candidate Ledger Explorer

Outputs:

- system/repo map
- seam map
- candidate ledger
- unknowns
- do-not-touch zones
- recommended next loop

Use with skills:

- codebase-integrity-audit-loop
- connected-impact-sweep
- architecture/review rubrics when available

## Review swarm

Use when a change, branch, PR, implementation, or generated artifact exists and needs pressure-testing.

Goal: find correctness, architecture, contract, test, static, runtime, and regression risks before merge.

Agents:

- Agent 0 — Review Captain / Finding Triage
- Agent 1 — Architecture / Boundary Reviewer
- Agent 2 — Correctness / Edge-Case Reviewer
- Agent 3 — Tests / Fixtures Reviewer
- Agent 4 — Schema / API / Contract Reviewer
- Agent 5 — Static / Security / Dependency Reviewer
- Agent 6 — Runtime / Verification Reviewer
- Agent 7 — Regression / Fake-Green Reviewer

Outputs:

- confirmed issues
- plausible risks
- false positives
- required fixes
- merge blockers
- verification gaps
- recommended next action

## Bug swarm

Use when there is a failing test, production bug, flaky behavior, mysterious regression, or unexplained red state **and** the defect presents several genuinely independent investigative surfaces. One defect with one obvious line of enquiry does not need a swarm — invoke `adaptive-causal-debugging` directly when installed, otherwise `diagnosing-bugs-mwdev`.

**This swarm does not own the diagnostic protocol.** `adaptive-causal-debugging` (or `diagnosing-bugs-mwdev` as compatibility fallback) owns the causal investigation method for one concrete defect. This swarm owns only the *parallel investigative topology around* that method. Read-only diagnostic lanes may run here; any repair is executed through `production-flywheel`, which may invoke `adaptive-causal-debugging` as the bounded debugging specialist. Do not restate or fork the diagnostic stages here.

Goal: decide whether parallel investigation is justified, run independent investigations without overlap, and reconcile their evidence into one confirmed diagnostic path.

Owned here:

- deciding whether parallel investigation is justified at all
- selecting independent investigative surfaces
- assigning non-overlapping lanes
- managing dependencies and evidence between lanes
- reconciling competing hypotheses
- selecting which confirmed diagnostic path advances
- captain synthesis

Topology: **adaptive — derive lanes from the defect's actual independent surfaces.** There is no fixed roster and no target lane count. A surface earns a lane only when it can be investigated without waiting on another lane's findings. Common surfaces, as *examples to choose from, not a roster to fill*: recent-change/diff, call-graph/data-flow, test/fixture/mock, config/environment/CI, dependency/version, data/state shape. If only one surface is real, run one lane — or no swarm at all.

Each read-only lane runs `adaptive-causal-debugging` (or the compatibility fallback) for its own bounded question and returns evidence plus falsifiable hypotheses/experiments. A lane never declares root cause on its own and never begins repository repair from this planner.

Outputs:

- which surfaces were investigated, and which were ruled out as non-independent
- per-lane evidence and ranked falsifiable hypotheses
- reconciliation of competing hypotheses, with the evidence that separated them
- the single confirmed diagnostic path selected to advance
- remaining risk and unexplored surfaces

Hard rules:

- No planner lane mutates a fix. After the captain reconciles the diagnostic path, any authorized repair is handed to `production-flywheel`, which invokes `adaptive-causal-debugging` (or the compatibility fallback) for the bounded repair/regression method as needed.
- No path advances until reproduction succeeded, or the inability to reproduce is explicitly reported.
- Contradictory hypotheses stay distinct until evidence resolves them; the captain does not average them into a consensus.

## Planning swarm

Use when the target is known but the execution plan needs to be production-grade.

Goal: convert a goal into scoped implementation contracts, tasks, gates, and acceptance commands.

Agents:

- Agent 0 — Planning Captain / Scope Control
- Agent 1 — Contract / Interface Planner
- Agent 2 — Implementation Planner
- Agent 3 — Test / Verification Planner
- Agent 4 — Migration / Compatibility Planner
- Agent 5 — Risk / Failure-Code Planner
- Agent 6 — Operator / CLI / Report Planner
- Agent 7 — Merge / Rollout / Capture Planner

Outputs:

- implementation contract
- non-goals
- agent briefs
- acceptance commands
- failure codes
- risks
- definition of done

Use with skills:

- implementation-plan-contract — the contract format and gates the lanes fill in

## Research swarm

Use when the work depends on external facts, libraries, tools, papers, APIs, standards, regulations, ecosystem choices, or current information.

Goal: gather evidence, compare options, identify constraints, and produce a decision-ready recommendation.

Agents:

- Agent 0 — Research Captain / Evidence Integrator
- Agent 1 — Primary Source Researcher
- Agent 2 — Alternatives / Competitor Researcher
- Agent 3 — Implementation Feasibility Researcher
- Agent 4 — Risk / Failure Mode Researcher
- Agent 5 — Tooling / Ecosystem Researcher
- Agent 6 — Cost / Maintenance / Adoption Researcher
- Agent 7 — Decision Memo / Recommendation Writer

Outputs:

- evidence table
- recommendation
- tradeoffs
- unknowns
- sources
- decision memo

Hard rule: use current sources and citations when external facts could have changed.

## Fitness-check swarm

Use when the user wants to make a recurring failure mode impossible or immediately visible.

Goal: turn one failure mode into an enforceable check. Read-only design may run here; if implementation is requested, emit the work-unit topology and hand it to `production-flywheel`.

Agents:

- Agent 0 — Fitness Captain / Gate Integration
- Agent 1 — Rule Definition / Contract Owner
- Agent 2 — Positive Fixture Builder
- Agent 3 — Negative Fixture Builder
- Agent 4 — Validator / Static Rule Implementer
- Agent 5 — CI / Command Integration
- Agent 6 — Report / Failure-Code Integration
- Agent 7 — Torture / Fake-Green / Regression Tester

Outputs:

- rule statement
- positive fixture
- negative fixtures
- validator/check
- CI command
- failure code
- proof invalid input fails
- proof valid input passes

Hard rule: feature claims without negative fixtures are incomplete.

## Migration / Connected-Impact swarm

Use when a schema, path, public API, enum, artifact format, model, taxonomy, or contract changes.

Goal: map and decompose one contract change across active producers and consumers without stale paths. Read-only blast-radius work may run here; authorized edits are handed to `production-flywheel`.

Agents:

- Agent 0 — Migration Captain / Coherence Control
- Agent 1 — Source-of-Truth / Contract Lane
- Agent 2 — Producer Lane
- Agent 3 — Consumer / Caller Lane
- Agent 4 — Tests / Fixtures / Golden Lane
- Agent 5 — Docs / Examples / Operator Lane
- Agent 6 — Stale Paths / Legacy Surface Lane
- Agent 7 — Verification / Migration Decision Lane

Outputs:

- blast-radius map
- updated surfaces or proposed staged edits
- paused ambiguities
- verification
- migration notes
- follow-ups

Use `connected-impact-sweep` when available.

## Production execution topology

Use when one already-authorized Flywheel item/action contains several genuinely independent implementation, integration, or verification work units and a deliberate swarm topology would improve throughput or reduce risk.

This is **not** an alternative to `production-flywheel`. The planner derives the topology; Flywheel executes it. Simple sequential work skips this type entirely.

### When topology adds value

Use this topology when most are true: one bounded authorized item/action, one coherent engineering thesis, one integration/acceptance boundary, several independent ownership surfaces, and meaningful parallel leverage. The reviewer question is useful: *would a reviewer still want this as one coherent delivery unit even though several lanes can work independently?*

If the work actually has separate review units, release timing, rollback boundaries, decision owners, or independent failure semantics, keep them as separate Flywheel items/actions rather than bundling them into one swarm. Item count alone does not decide the route.

### Build the topology

Read and fill [assets/execution-topology.yaml](assets/execution-topology.yaml). There is no fixed semantic roster: derive work units from independent questions, ownership surfaces, shared resources, dependencies, specialist methods, deliverables, and verification boundaries.

When work originates in an audit, RIA output, candidate ledger, architecture report, or other artifact, each selected finding begins as a reported premise. Recheck it on the execution revision and classify it `confirmed`, `contradicted`, `stale`, or `unverifiable`; only confirmed premises may become mutating work units.

Every downstream mutating unit declares allowed/forbidden writes and shared/exclusive resources. The planner derives conflicts and barriers; Flywheel enforces them. Write/write overlap, exclusive-resource overlap, unsafe write/read coupling, shared generated-state collision, and validation-environment collision require serialization or isolation.

Describe only the phases the mission needs:

1. **Premise** — read-only truth establishment.
2. **Mutation** — downstream Flywheel-owned work units and conflict-aware waves.
3. **Integration** — downstream serialized reconciliation.
4. **Verification** — downstream evidence/authority topology.

Logical lanes may exceed runtime capacity. The planner reports logical lanes, peak active lanes, waves/barriers, critical resources, integration owner, and verification owner. It does not create worktrees or execute the mutation.

### Action-graph boundary

For canonical `--action-graph` delivery, `shared/action-graph-execution` and Flywheel remain authoritative for action readiness, claims, D7 `computeConcurrencyBatch`, and cross-action resource safety. Planner topology may decompose work inside an already authorized action or claimed wave but may not rewrite the graph, change the frontier, invent action effects/resources, or override a fail-closed batch decision.

### Ownership, failures, and closure

Encode downstream behavior, do not perform it here:

- foreign-owned failures are returned as `FOREIGN_FAILURE`, not repaired by the observing lane;
- authorized/closure/adjacent/new-scope work remain distinct;
- closure work is proposed only when necessary, bounded, intent-preserving, and decision-free; Flywheel decides whether it is admissible under the existing authorization;
- integration edits require an explicitly owned downstream integration/reconciliation unit.

### Completion boundary

This planner is complete when it emits a valid topology bound to the existing authorization and hands it to `production-flywheel`, or reports the exact blocker. Implementation, integration, commit, verification, push/PR, and lifecycle completion remain downstream claims.
