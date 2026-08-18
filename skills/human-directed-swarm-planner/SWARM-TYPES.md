# Swarm types

Loaded from SKILL.md after the router selects a type. Each section carries that type's goal, lanes, outputs, and hard rules.

## Repo Audit swarm

The one read-only swarm class. Use when another skill (`codebase-integrity-audit-loop --parallel-report`) or the user needs broad repo-wide analysis without edits: the whole repo inspected through expert lenses, merged into one scored HTML report and one candidate ledger. It is not an Execution Swarm — no lane edits anything; the report and ledger artifacts are the only writes — and it stops at the candidate gate after the report/ledger. It never auto-selects a candidate: selection and any implementation happen only in a later, separately authorized loop, such as the user invoking auto mode against the ledger.

Goal: surface evidence-backed candidates and emit one deduplicated shared-spine ledger. Formal repository grades belong to `repository-health-assessment`.

Captain + four default lanes — used unless the user overrides the lane set:

- Agent 0 — Audit Captain / Merge, Dedup, Report Integrator
- Agent 1 — Deepening seams lane: Matt-style module/interface/deepening analysis (vocabulary from codebase-design). Finds shallow modules, leaky seams, duplicated domain language, weak abstractions, caller knowledge leakage, missing design questions, and ADR/CONTEXT capture needs. Output: deepening candidates and design questions.
- Agent 2 — Graded integrity lane: Jeff-style scored quality review. Finds maintainability, coupling, cohesion, reliability, security hygiene, test quality, data/model integrity, performance risk, and process drift. Output: scored quality candidates with evidence.
- Agent 3 — Blast-radius lane: connected-impact / Obra-style delivery impact analysis, run through connected-impact-sweep's `## Report-only blast-radius estimate` mode. Estimates callers, schemas, fixtures, goldens, generated outputs, docs, migration needs, review burden, verification burden, stale reachable paths, and cross-language seams. Output: report-only blast-radius estimates — classifications into the report, never implementation or auto-propagation.
- Agent 4 — Verification readiness lane: whether each candidate can be proven fixed. Checks existing tests, missing test seams, red-capable checks, type/lint/build gates, negative fixtures, golden-file risk, flaky/slow/unreachable tests, and required harnesses. Output: verification plan and testability score per candidate.

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

Use when there is a failing test, production bug, flaky behavior, mysterious regression, or unexplained red state **and** the defect presents several genuinely independent investigative surfaces. One defect with one obvious line of enquiry does not need a swarm — invoke `/adaptive-causal-debugging` directly (`diagnosing-bugs-mwdev` is a deprecated alias, not the live owner).

**This swarm does not own the diagnostic protocol.** `adaptive-causal-debugging` owns the complete workflow for one concrete reproducible defect — reproduction, hypothesis testing, root-cause confirmation, narrow repair, regression verification — and is the single definition of those stages. This swarm owns the *topology around* that protocol and nothing else. Do not restate, reorder, or substitute the stages here.

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

Each lane runs `/adaptive-causal-debugging` for its own bounded question and returns evidence plus falsifiable hypotheses. A lane never declares root cause on its own, and never begins repair.

Outputs:

- which surfaces were investigated, and which were ruled out as non-independent
- per-lane evidence and ranked falsifiable hypotheses
- reconciliation of competing hypotheses, with the evidence that separated them
- the single confirmed diagnostic path selected to advance
- remaining risk and unexplored surfaces

Hard rules:

- No lane proposes a fix. Repair and regression verification happen once, in `/adaptive-causal-debugging`, after the captain has selected the confirmed path.
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

Goal: turn one failure mode into an enforceable check.

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

Goal: propagate one contract change across active producers and consumers without stale paths.

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

## Production implementation swarm

Use when the user wants an aggressive production-grade delivery brief or parallel implementation plan.

Goal: deliver one selected production milestone as parallel lanes, with full-shield gates. Boundary: one milestone decomposed into parallel surfaces — a *queue* of separate items delivered sequentially, each its own per-item PR, is `production-flywheel`, not a swarm. **Opens a PR and stops; never merges** — merging stays an explicit, separate human act (the family's house rule).

Default agents (an example roster from a game-delivery project — adapt every lane to the actual project and task):

- Agent 0 — Integration Captain / Full-Shield / Merge Control
- Agent 1 — Contract / Schema / Taxonomy
- Agent 2 — Generation / Placement / Domain Core
- Agent 3 — State / Save-Load / Rewards
- Agent 4 — Asset / Mesh / Dependency Wiring
- Agent 5 — Playtest / Runtime Validation
- Agent 6 — Balance / Budgets / Metrics
- Agent 7 — Torture / Fuzz / Report Integrity / Regression

Agent 0 default subagents (same caveat — an example from a game-delivery project; adapt or generalize every one to the actual repo, e.g. `full_shield.py` → this repo's gate-runner):

- 0A — CI / build target integration
- 0B — gate-runner wiring
- 0C — report rollups
- 0D — regression preservation
- 0E — PR readiness (open the PR; never merge)
