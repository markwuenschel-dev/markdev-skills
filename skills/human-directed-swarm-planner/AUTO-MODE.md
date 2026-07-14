# Auto mode

Loaded from SKILL.md when `--auto` is set. Read this before the first auto mission; it governs mission sources, ranking, hard stops, and the stop report.

For this skill, one turn = one complete swarm mission: mission selected → lanes assigned → subagents briefed → findings integrated → verification/capture defined → next mission selected or stopped. This is coarser than the audit loop's turn (one candidate loop) — the two are not interchangeable.

Repo Audit swarm is not an auto-mode mission. It runs standalone, produces the report/ledger, and stops. Auto mode consumes missions selected from a report/ledger afterward.

## Mission sources

Auto mode may consume:

- candidate ledger from codebase-integrity-audit-loop
- report from an explorer swarm
- review finding ledger
- bug queue
- fitness-check backlog
- user-provided ordered list

## Ranking

Rank executable missions by:

1. human priority if provided
2. safety
3. leverage
4. dependency order
5. locality
6. verification availability
7. risk
8. likelihood of blocking future work

Missions that require human judgment stay in the ledger; auto mode never selects them.

## Hard stops

Stop auto mode immediately when any of these occurs:

- mission boundary is unclear
- mission requires a product, policy, SME, or architecture decision, or hits a human-decision category (connected-impact-sweep `## Human-decision categories`)
- required repo/tool access is missing
- prior mission leaves dirty/unintegrated state
- verification baseline is untrustworthy
- two missions are coupled and cannot be safely separated
- report/ledger integrity is suspect
- a subagent/lane returns contradictory evidence that cannot be resolved
- executing the next mission would expand scope beyond the human-selected report/ledger

## Stop report

On stop, report:

- completed turns
- current blocked mission
- reason for stop
- evidence gathered
- changed files, if any
- verification evidence
- recommended human decision
