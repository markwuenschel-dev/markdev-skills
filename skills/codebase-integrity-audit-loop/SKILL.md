---
name: codebase-integrity-audit-loop
description: "Use when the user asks to audit, improve, harden, or repair codebase integrity: bugs, wiring/integration drift, schema/contract problems, static-analysis findings, stale paths, architecture fitness concerns, or recurring breakage that should become an enforceable check. One disciplined loop per candidate: report + ledger, select one, execute, verify, capture. Supports --auto --max-turns, and --parallel-report for a read-only repo-wide swarm report that stops at candidate selection."
disable-model-invocation: false
---

# Codebase Integrity Audit Loop

A loopable command for turning codebase drift into one scoped, verified, future-resistant fix.

## Shared candidate contract and lifecycle

Resolve `shared/candidate-ledger-spine/{REPORT-SCORING.md,candidate.schema.json,ledger-verify.js}` repository-relatively, or use an explicit shared-spine override. Missing or incompatible version-3 code is a hard failure: this loop must not score, rank, or repair from a partial envelope.

Consume exactly one candidate source per active loop: a verified health ledger, an architecture candidate ledger, an audit-loop parallel-report ledger, a user-selected candidate, or an issue/defect record reconciled into the canonical envelope. Validate this input before selection:

```yaml
integrity_candidate_input:
  source_skill: repository-health-assessment | improve-codebase-architecture-mwdev | loop-router | user
  candidate_id: ""
  candidate_envelope: {}
  source_artifacts: { health_report: null, architecture_report: null, ledger: "" }
  repository: { assessed_revision: "", current_head: "", freshness: "", baseline_commands: [] }
  scope: { included: [], excluded: [], non_goals: [] }
  known_decisions: []
  unresolved_human_decisions: []
  recommended_action: ""
  execution_mode: ""
  verification_obligations: []
  mutation_authorized: false
  merge_authorized: false
```

Confirm human selection (unless an already-authorized caller supplied it), ensure no other candidate is active, recover prior state, establish a fresh baseline, and validate the treatment branch against current evidence. Treatment is one of `direct-fix`, `fitness-check`, `triage`, `design`, `prototype`, `diagnosing-bugs`, `connected-impact migration`, or `blocked-needs-human-decision`; execution topology is not a treatment branch.

Only independent verification can write `candidate_lifecycle.lifecycle_status: completed`, with `completion.completed_at` and non-empty `completion.verification_refs`. A failed or unavailable verification remains non-completed. After closure, decide whether reassessment is warranted; if so, emit a `repository_health_reassessment_request` preserving prior report, revision, completed IDs, verification references, expected lanes/surfaces/caps, and all continuity requirements. Request it and return; this loop never computes a health grade.

This command is not a broad cleanup mission. It is a disciplined integrity loop:

```text
recover/scan → HTML report + candidate ledger → candidate gate → lens selection → branch execution → verify → capture → next loop state
```

## Model invocation policy

This skill is model-invokable: invoke it when its role is needed inside the current approved workflow, without waiting for the user to name it.

Model invocation does not expand scope. The active mission, selected candidate, queue item, or implementation contract carries over unchanged — starting a new audit, roadmap, queue, or unrelated cleanup takes a user request. If invoking this skill would change the user's authorization boundary, pause and ask.

## Operating modes

Manual mode is the default.

Manual mode:

1. Produce or resume a report.
2. Ask the user to select one candidate.
3. Execute exactly one selected candidate.
4. Capture the result.
5. Record next loop state.
6. Stop.

Auto mode may be enabled explicitly:

```text
--auto
--max-turns <N|max>
```

`--auto` without `--max-turns` defaults to `--max-turns 1` (a single turn). A turn means one complete candidate loop:

```text
candidate selected → scoped → planned → executed → reviewed → verified → captured → ledger updated
```

Examples:

```text
/codebase-integrity-audit-loop --auto --max-turns 3
```

Execute the top 3 executable candidates from the report in recommended order.

```text
/codebase-integrity-audit-loop --auto --max-turns max
```

Execute all executable candidates from the report in recommended order until the ledger is exhausted or a hard stop occurs.

Auto mode consumes the candidate ledger. It does not create new scope. When `--auto` is set, read [AUTO-MODE.md](AUTO-MODE.md) before selecting the first candidate — candidate ranking, hard stops, per-turn capture, and the final report format live there.

Parallel report mode may be enabled explicitly:

```text
--parallel-report
```

`--parallel-report` produces the Stage 2 report and ledger through a read-only **Repo Audit Swarm** (four expert lanes, merged and scored) instead of a single-agent scan, then stops at the Stage 3 candidate gate — nothing is executed in the same invocation. When set, read [PARALLEL-REPORT.md](PARALLEL-REPORT.md) and follow it; Stages 4–13 belong to a later loop. Selection afterward is the normal candidate gate; auto mode applies to the emitted ledger only when the user explicitly passes `--auto` against that ledger in a later invocation. If `--auto` and `--parallel-report` are passed together, `--parallel-report` takes precedence — the ledger is produced and the invocation stops at the candidate gate; the co-passed `--auto` is deferred to the next invocation and executes nothing now.

## Hard rules

- Recovery and scanning must precede judgment.
- A self-contained report with candidate ledger is required before candidate selection unless resuming from a valid existing report.
- No production code changes before a candidate is explicitly selected for the current loop.
- Exactly one candidate per loop.
- Exactly one seam, boundary, finding category, or fitness concern per pass.
- Broad cleanup is forbidden — adjacent findings go to the ledger as new candidates.
- Enforceable checks are preferred over prose-only recommendations.
- Compatibility shims, thin wrappers, or fake backward compatibility appear only when explicitly selected as the candidate.
- Validators stay at full strength; a red report is information, not an obstacle.
- Integrity claims wait for verification-before-completion to pass.
- Durable knowledge must be captured in one authoritative place.
- Auto mode must stop on unresolved human-decision categories.

## Stage 1 — Recover / Scan

Recover and scan the current code health state before recommending edits.

Inspect or run, when available:

- test suites and focused reproductions
- linters and type checkers
- import/dependency/call graphs
- static-analysis output
- schema, DTO, API, and contract consistency checks
- build/CI visibility and generated artifact checks
- entrypoints, CLIs, scripts, endpoints, config keys, jobs, and runtime paths
- docs, ADRs, runbooks, RAG/policy corpus files, prompts, and few-shot examples that influence runtime behavior
- stale paths, duplicate implementations, legacy runners, obsolete shims, reachable dead code, and retired references
- numerical/GPU/kernel invariants when relevant

Separate deterministic/computational findings from inferential findings.

Gate:

- Current code health state is summarized from evidence.
- Claims distinguish confirmed facts, plausible inferences, and unknowns.
- Important seams, boundaries, and recurring patterns are named.
- No production code has been changed.

## Stage 2 — HTML Report + Candidate Ledger

Produce or update a self-contained HTML codebase integrity report.

The report follows the canonical candidate schema in `shared/candidate-ledger-spine/REPORT-SCORING.md`. It is a candidate-discovery report, not a repository health grade; formal overall grades, scorecards, weighted coverage, caps, and confidence route to `repository-health-assessment`. On top of the shared candidate spine, an integrity report surfaces these integrity-specific views:

- high-level code health map
- findings grouped by category (categories below)
- active seams and integration points with health status
- deterministic findings separated from inferential findings
- explicit unknowns
- stale, duplicate, unclear ownership, or dead-path findings
- broad-cleanup opportunities intentionally rejected as out of scope

Candidate categories:

- Bug
- Wiring / Integration
- Static
- Data / Schema / Contract
- Architecture Fitness
- Algorithm / Numerical
- CUDA / GPU
- Testing / Fixture / Golden
- Build / CI
- Maintainability
- Other

Each candidate card must include:

- Candidate ID
- Location with file:line evidence where possible
- Category
- Current friction, symptom, or failure mode
- Root seam or boundary involved
- Integrity rule or principle violated
- Confirmed facts vs plausible inferences vs unknowns
- Scores and priority rollup per [`shared/candidate-ledger-spine/REPORT-SCORING.md`](../shared/candidate-ledger-spine/REPORT-SCORING.md) — the canonical scoring spine for every scored report in this skill family
- Expected benefits and before/after framing when helpful
- Recommended branch: design / prototype / triage / fitness-check / direct fix
- Recommended lenses
- Enforceable check opportunity
- Status: open / selected / shipped / fixed / check-added / rejected / superseded / blocked / needs-human-decision / needs-rereport (where `needs-human-decision` ⇔ REPORT-SCORING `execution_mode: blocked-needs-human-decision`, and `rejected` is where `recommended_action: reject` lands — see REPORT-SCORING.md)

Gate:

- The report exists and is self-contained.
- The candidate ledger is present.
- Every candidate is independently selectable.
- No production code has been changed.
- Manual mode: ask the user to select exactly one candidate.
- Auto mode: rank per [AUTO-MODE.md](AUTO-MODE.md) and select the next safe candidate.

## Stage 3 — Candidate Gate

After one candidate is selected, summarize:

```markdown
## Selected integrity candidate

**Candidate ID:**
**Location / seam / boundary:**
**Category:**
**Current friction:**
**Integrity rule / principle:**
**Evidence:**
**Scores / priority rollup (per [`shared/candidate-ledger-spine/REPORT-SCORING.md`](../shared/candidate-ledger-spine/REPORT-SCORING.md)):**
**Recommended branch:** design / prototype / triage / fitness-check / direct fix
**Review lenses:** any relevant lens from Stage 4's catalogue (core: Wiring & Integration, Bug & Correctness, Consistency, Test/CI; supporting: Polyglot boundary, Bazel/build, API/schema/contract, Numerical correctness, CUDA/GPU, Static analysis, Security, Data integrity, Architecture fitness, Maintainability)
**Verification strategy:**
**Adjacent concerns out of scope:**
```

Gate:

- Exactly one candidate is selected.
- Adjacent concerns are explicitly out of scope.
- The selected candidate has a defined verification strategy.
- The branch is justified.

## Stage 4 — Lens Selection

Apply only the lenses relevant to the selected candidate.

Core lenses:

- Wiring & Integration
- Bug & Correctness
- Consistency
- Test / CI

Supporting lenses:

- Polyglot boundary
- Bazel / build
- API / schema / contract
- Numerical correctness
- CUDA / GPU
- Static analysis / RepoAudit-style data-flow
- Security
- Data integrity
- Architecture fitness
- Maintainability

When the Wiring & Integration lens is selected, read [LENSES.md](LENSES.md) for its checklist, required output format, enforceable checks, and anti-patterns.

Gate:

- Only relevant lenses were applied.
- Lens findings remain scoped to the selected candidate.
- At least one concrete enforceable check opportunity is identified when feasible.
- Lens findings do not expand the current loop into broad cleanup.

## Calibration rules

connected-impact-sweep is the single source of truth for edit-coherence calibration. Read that companion skill (routed command, or its SKILL.md in the sibling skill folder) whenever a loop executes changes, and apply its rules:

- passthrough consumers vs value-branching logic
- human-decision categories (the canonical list under that skill's `## Human-decision categories` heading)
- golden files and fixtures
- reachability beyond static imports
- hand-maintained mirrors
- runtime prose / RAG corpus as contract surface
- staged edits vs completed edits

## Stage 5 — Branch

Choose exactly one branch.

### Design branch

Use when the issue, root cause, seam, ownership, policy, migration behavior, or desired check shape is unclear.

Gate:

- Target issue is explicit.
- Rejected alternatives are named.
- Durable terms are captured.
- ADR-worthy decisions are identified.
- No implementation work has started unless explicitly staged.

### Prototype branch

Use when prose is insufficient to evaluate the candidate.

Prototype files may include:

- `LOGIC.md`
- `BOUNDARY.md`
- `KERNEL.md`
- `UI.md`

Gate:

- Prototype answers one explicit question.
- Prototype is deleted or marked for clean absorption.
- Prototype does not become an unowned alternate path.

### Triage branch

Use for failing checks, external reports, stale paths, suspected bugs, or unclear ownership.

Gate:

- Concern has one category and one state.
- Ownership is assigned or marked unknown.
- Agent-eligible work has a durable brief.
- Rejections/out-of-scope decisions are captured.

### Fitness-check branch

Preferred when the goal is lasting integrity.

Pattern:

1. State the integrity rule clearly.
2. Write or improve an enforceable check that fails or is missing before the fix.
3. Make the minimal change to pass.
4. Refactor only while green.
5. Document the check for future agents.
6. Prove the check catches the original class of problem.

Possible checks:

- regression test
- seam/integration test
- import/dependency-direction rule
- schema/contract compatibility test
- generated-contract drift check
- config-wiring check
- state-update path check
- static-analysis rule
- consistency lint/type rule
- numerical invariant test
- CPU/GPU equivalence test
- CI gate or smoke test

Gate:

- Rule is stated before implementation.
- Check is shown failing or missing before it is fixed.
- Check targets the seam/root cause, not incidental symptoms.
- Check is documented for future agents.

### Direct fix branch

Use only when the candidate is clear, low-risk, and contained.

Gate:

- Target seam is explicit.
- Desired state is explicit.
- Verification command is known.
- One vertical slice only.
- No adjacent cleanup.

## Execution mode selection

Select exactly one execution mode:

- sequential delivery
- subagent-driven development
- connected-impact sweep

Use connected-impact sweep when the selected candidate touches contracts, schemas, public APIs, CLI behavior, config keys, artifact paths, pipeline outputs, cross-language seams, shared models, state update paths, fixtures, goldens, numerical/kernel output contracts, hand-maintained mirrors, or runtime policy corpus surfaces.

When applying the companion skill `connected-impact-sweep` during execution, preserve this loop's candidate gate, scope limits, pause rules, and capture rules.

## Stage 6 — Worktree Gate

Create or switch to an isolated worktree or branch for the selected candidate when available.

Requirements:

- Working tree starts clean.
- Baseline verification commands are known and documented.
- Baseline verification runs before changes.
- If baseline verification cannot run, document why and what risk that introduces.
- Pre-existing unrelated failures are recorded separately.

Gate:

- Isolated worktree or branch exists, or reason for not using one is documented.
- Working tree is clean at start.
- Baseline verification commands are defined and executed, or inability is documented.
- Pre-existing unrelated failures are noted.

## Stage 7 — Plan Gate

Break work into ordered tasks with verification steps. When the candidate warrants a full plan document — multiple tasks, fan-out surfaces, or a swarm handoff — run the companion skill `implementation-plan-contract` and use its contract as this stage's output.

Gate:

- Each task maps to the selected candidate.
- Each task has a verification step.
- No task expands into adjacent cleanup.
- Execution mode is selected.

## Stage 8 — Execute

Follow the selected execution mode.

For behavior or check changes, use:

```text
state rule → write failing check/test → minimal change → green → refactor while green → verify
```

Failure interrupt:

If behavior is broken, unexpectedly red, flaky, slow, numerically unstable, GPU-dependent, nondeterministic, or unexplained, pause delivery and hand the defect to `/diagnosing-bugs-mwdev` — deprecated, forwards to `adaptive-causal-debugging` (not yet vendored in this repo).

This loop owns discovering and selecting **one** integrity candidate. When the selected candidate is a concrete reproducible defect, the diagnostic workflow for it — reproduction, hypothesis testing, root-cause confirmation, narrow repair, and regression verification — belongs to `adaptive-causal-debugging`, not this loop; `diagnosing-bugs-mwdev` is a deprecated alias with no protocol of its own. Do not restate or re-run those stages here; resume this loop's gate once the fix and its regression test are in.

Gate:

- Each task is completed in order or explicitly skipped with reason.
- Parallel/subagent work is reconciled into one coherent branch.
- No duplicate implementation paths remain.
- No abandoned prototypes, scripts, or throwaway artifacts remain.
- New checks enforce the selected rule where possible.

## Stage 9 — Review Loop

Run structured review.

Review must check:

- only the selected candidate was addressed
- no broad cleanup occurred
- no unauthorized shims/wrappers were added
- dependency direction is correct
- public interfaces did not widen unnecessarily
- tests/checks enforce the intended rule where possible
- docs, ADRs, corpus surfaces, prompts, fixtures, and generated artifacts match the implementation where relevant
- stale prototypes and throwaway harnesses are gone

Gate:

- Critical/high-confidence review issues are fixed.
- False positives are documented briefly.
- Deferred issues are captured as follow-ups.
- Tests/checks are rerun after review fixes.

## Stage 10 — Verification Before Completion

Run the strongest relevant verification available.

Examples:

- Python: pytest, Ruff, Pyright, mypy, import-linter, schema/contract tests
- TypeScript/React: tests, tsc, ESLint, API contract tests
- Java/Kotlin: unit/integration tests, Gradle/Maven/Bazel target tests, ArchUnit/dependency checks
- C++/CUDA: build, unit tests, sanitizer checks where available, kernel smoke tests, CPU/GPU equivalence tests
- Julia/numerical: unit tests, property/invariant tests, tolerance checks, benchmark-baseline checks
- Bazel: affected target tests, build graph checks, visibility/dependency checks
- Quant/ML: walk-forward checks, threshold validation, artifact-contract checks, leakage checks
- RAG: retrieval/eval harnesses, policy corpus consistency checks, bridge contract tests

Gate:

- Relevant tests pass.
- Type/lint/build passes when available.
- New or updated integrity checks pass.
- Numerical/GPU checks pass when applicable.
- Manual/HITL verification is complete when required.
- Acceptance criteria are checked one by one.
- No debug logs, temporary harnesses, stale prototypes, or accidental artifacts remain.
- The agent can state exact command output proving completion.

## Stage 11 — Finish + Ship or Capture

If code, tests, static rules, CI config, generated contracts, corpus files, or enforceable checks changed, follow branch/PR process.

PR body must include:

- selected candidate
- what changed
- why
- architecture/integrity impact
- verification evidence
- new or updated fitness checks
- agent-readability impact
- risks/follow-ups

If the loop produced only a report, triage decision, rejected candidate, design note, prototype result, or follow-up issue, capture without forcing a PR.

## Stage 12 — Capture

Capture durable knowledge in one authoritative place.

- HTML report and candidate ledger → report artifact
- new/updated enforceable checks → the check itself + documentation
- architecture/integrity decisions → ADR, CONTEXT.md, or project docs
- policy/taxonomy/RAG decisions → authoritative corpus/policy docs
- risk register/themes/remediation items → report or issue tracker
- rejected options/out-of-scope items → appropriate archive
- future candidates → follow-up issue or next report

Gate:

- Every durable decision has a single source of truth.
- Candidate ledger is updated.
- Selected candidate is marked with final status.
- Follow-up work is captured outside the current loop.
- Current loop state is closed.

## Stage 13 — Next Loop State

Record exactly one next valid starting point:

- stop
- fresh report
- existing report candidate gate
- follow-up issue
- retry failed loop
- rerun after dependency/context change

Gate:

- Next state is unambiguous.
- No next candidate is auto-selected unless auto mode remains active and within `--max-turns`.
- No unowned observations remain only in chat context.
- Repo is clean or intentionally preserved for the next iteration.
