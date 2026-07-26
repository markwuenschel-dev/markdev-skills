# Auto mode

Loaded from SKILL.md when `--auto` is set. Read this before selecting the first auto candidate; it governs eligibility, ranking, hard stops, per-turn capture, and the final report.

For this skill, one turn = one complete candidate loop: candidate selected → scoped → planned → executed → reviewed → verified → captured → ledger updated. This is narrower than the swarm planner's mission (one swarm job) — the two are not interchangeable.

## Candidate eligibility and ranking

Auto mode consumes the canonical candidate ledger and its stable ranking from [`shared/candidate-ledger-spine/REPORT-SCORING.md`](../shared/candidate-ledger-spine/REPORT-SCORING.md) `## Eligibility and stable ranking` — that section owns the gates and the comparator; this section restates them verbatim. Auto mode does not independently rescore candidates: safety, leverage, locality, testability, blast radius, regression risk, and human-decision risk are already inside `priority_score` or act as eligibility gates, never as extra ranking dimensions.

A candidate is eligible only when:

- its `status` is `ready` (the executable status)
- `recommended_action` is not `reject`
- `human_decision_risk < 4`
- `blocked_by` is empty
- all `depends_on` candidates are `completed`
- required access and a trustworthy verification baseline are available
- no hard stop below applies

Ineligible candidates stay in the ledger (`needs-human-decision`, `blocked`, `rejected`); auto mode skips them, never removes or selects them.

Apply explicit human ordering first when provided. Human ordering decides between eligible candidates only — it cannot make a blocked, human-decision, or rejected candidate executable, and it never modifies `priority_score`.

Among eligible candidates, rank by:

1. `priority_score` descending
2. `effort` ascending (`S` before `M` before `L`)
3. `severity` descending
4. `confidence` descending
5. `candidate_id` ascending

Dependencies affect readiness, not `priority_score`. Safety and human-decision conditions are eligibility gates, not additional ranking dimensions. Visual bands are presentation only, never execution logic. `unlocks` is informational — do not prioritize by unlock count.

## Hard stops

Stop auto mode immediately when any of these occurs:

- any human-decision category is hit: public/external contract, migration/default/backfill, deletion of reachable code, numerical correctness, GPU/CPU equivalence, security or production safety, escalation/safety-routing ambiguity
- policy/SME decision required
- architecture direction decision required
- golden/fixture behavior changed without explicit behavior-change intent
- verification failure with unclear root cause
- dirty worktree that cannot be reconciled safely
- candidate scope expands beyond the selected boundary
- two candidates are coupled and cannot be safely executed independently
- required commands are unavailable or baseline is not trustworthy
- report or ledger integrity is suspect

When stopped, report:

- completed turns
- current blocked candidate
- reason for stop
- files changed
- staged/proposed edits, if any
- verification evidence
- ledger status
- recommended next human decision

## Capture after each turn

After each candidate loop, update the ledger before continuing. Each turn records:

- selected candidate
- branch/execution mode used
- files changed
- staged/proposed edits
- checks added or strengthened
- verification commands and results
- deferred items
- unrelated findings
- next candidate recommendation

## Final report

When auto mode ends (turns exhausted, ledger exhausted, or hard stop), report:

- number of turns requested
- number of turns completed
- candidates completed
- candidates skipped
- candidates blocked
- verification summary
- remaining open ledger
- recommended next command
