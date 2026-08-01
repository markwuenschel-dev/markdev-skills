# Auto mode

Loaded from SKILL.md when `--auto` is set. Read this before the first auto mission; it governs mission sources, eligibility, ranking, hard stops, and the stop report.

For this skill, the unit of auto-mode work is a **mission**: one complete swarm job — mission selected → lanes assigned → subagents briefed → findings integrated → verification/capture defined → next mission selected or stopped. `--max-turns N` counts missions: auto mode executes up to N sequential missions. (The audit loop's "turn" is one candidate loop — finer-grained; the two are not interchangeable.)

Repo Audit swarm is not an auto-mode mission. It runs standalone, produces the report/ledger, and stops at the candidate gate — it never auto-selects a candidate. Auto mode consumes missions from that report/ledger only when the user separately invokes it against the ledger.

## Mission sources

Auto mode may consume:

- candidate ledger from codebase-integrity-audit-loop
- report from an explorer swarm
- review finding ledger
- bug queue
- fitness-check backlog
- user-provided ordered list

A source that is not a canonical candidate ledger (schema per `REPORT-SCORING.md` in the codebase-integrity-audit-loop skill folder) must either carry explicit human ordering or be expressed in that schema before auto mode ranks it. Auto mode never invents its own scoring for a source.

## Mission eligibility and ranking

Auto mode consumes the canonical candidate ledger from `REPORT-SCORING.md` (codebase-integrity-audit-loop skill folder), whose `## Eligibility and stable ranking` section owns the gates and comparator restated verbatim below. Auto mode does not independently rescore candidates — leverage, locality, testability, blast radius, regression risk, and human-decision risk are already inside `priority_score` and are never re-weighed here.

A mission is eligible only when:

- its `status` is `ready` (the executable status)
- `recommended_action` is not `reject`
- `human_decision_risk < 4`
- `blocked_by` is empty
- all `depends_on` candidates are `completed`
- required access and verification are available
- no hard stop below applies

Ineligible candidates stay in the ledger; auto mode skips them, never removes them.

Apply explicit human ordering first when provided. Human ordering decides between eligible candidates only — it cannot make a blocked, human-decision, or rejected candidate executable, and it never modifies `priority_score`.

Among eligible candidates, rank by:

1. `priority_score` descending
2. `effort` ascending (`S` before `M` before `L`)
3. `severity` descending
4. `confidence` descending
5. `candidate_id` ascending

Dependencies affect readiness, not `priority_score`. Safety and human-decision conditions are eligibility gates, not additional ranking dimensions. Visual recommendation bands (`Strong`, `High`, `Worth exploring`, badge colors) are presentation only, never execution logic. `unlocks` is informational — do not prioritize by unlock count.

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

- completed missions
- current blocked mission
- reason for stop
- evidence gathered
- changed files, if any
- verification evidence
- recommended human decision
