# Parallel report mode

Loaded from SKILL.md when `--parallel-report` is set. This mode replaces Stages 1–2 with a read-only **Repo Audit Swarm** and ends the invocation at the Stage 3 candidate gate. Analysis only: the repo is inspected, never edited — the only files written are the HTML report, the candidate ledger, and any output files the user explicitly named.

## Flow

1. Invoke the companion skill `human-directed-swarm-planner`, routing to its **Repo Audit swarm** type (that heading in its SWARM-TYPES.md defines the lanes and merge protocol).
2. The captain derives non-overlapping read-only evidence lanes from the repository surface inventory; the number is adaptive, not a fixed four-lane roster.
3. The captain merges evidence into one candidate-discovery HTML report and one shared-spine v3 ledger. Lanes return evidence, claims, proposed candidates, and uncertainty; the captain alone deduplicates and scores.
4. Print the report's absolute path and the ledger, then stop at the candidate gate: ask the user to select exactly one candidate, exactly as Stage 2's manual-mode gate asks.

## Hard rules

- Read-only: production code, tests, configs, generated artifacts, docs, and fixtures are inspected, never modified. Report/ledger artifacts are the only writes.
- The invocation ends at the candidate gate — even a trivially fixable candidate waits for selection in a later loop.
- Every candidate satisfies REPORT-SCORING.md's Evidence rule.
- Human-decision blockers are named against connected-impact-sweep's `## Human-decision categories`.
- Broad-cleanup opportunities are recorded as rejected-out-of-scope findings, exactly as in a normal Stage 2 report.

## After the report

The emitted ledger is a normal Stage 2 output. A later invocation resumes at Stage 3 (candidate gate) in manual mode, or in auto mode only when the user explicitly passes `--auto` against this ledger — `--parallel-report` itself never selects a candidate.
