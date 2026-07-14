# Auto mode

Loaded from SKILL.md when `--auto` is set. Read this before selecting the first auto candidate; it governs ranking, hard stops, per-turn capture, and the final report.

For this skill, one turn = one complete candidate loop: candidate selected → scoped → planned → executed → reviewed → verified → captured → ledger updated. This is narrower than the swarm planner's turn (one swarm mission) — the two are not interchangeable.

## Candidate ranking

When auto mode starts, rank open candidates by:

1. safety
2. `rollup.priority_score` per [REPORT-SCORING.md](../../shared/REPORT-SCORING.md) — it folds in all eight scores (severity, confidence, leverage, locality, testability, blast radius, regression risk, human-decision risk)
3. dependency order
4. verification availability

Prefer candidates that:

- are independently executable
- have clear ownership
- have strong verification commands
- create or improve enforceable checks
- unblock later candidates
- require no unresolved human-decision category (connected-impact-sweep `## Human-decision categories`, plus policy/SME and architecture-direction decisions)

Candidates that require human judgment stay in the ledger as `needs-human-decision`; auto mode never selects them. The mechanical test for ranking key #1 (safety): skip any candidate whose `execution_mode` is `blocked-needs-human-decision` per [REPORT-SCORING.md](../../shared/REPORT-SCORING.md) — i.e. `human_decision_risk ≥ 4` or a non-empty `blocked_by`. (`execution_mode: blocked-needs-human-decision` ⇔ ledger `status: needs-human-decision` — the same state.)

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
