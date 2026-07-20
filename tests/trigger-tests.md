# Trigger tests

Pass/fail cases for **when** each top-level skill should auto-invoke or be recommended by `loop-router`.

## loop-router

| # | User utterance (gist) | Expect |
| --- | --- | --- |
| T1 | "Which skill should I use?" | `loop-router` |
| T2 | "I'm not sure if this is an audit or a flywheel" | `loop-router` → then one destination |
| T3 | User already said `/production-flywheel` | do **not** re-route; stay on flywheel |

## expanded-grill-with-docs

| # | User utterance (gist) | Expect |
| --- | --- | --- |
| T4 | "Grill me on this design" | expanded-grill-with-docs |
| T5 | "Let's pin the domain language before coding" | expanded-grill-with-docs |
| T6 | "Stress-test this plan and write ADRs as we go" | expanded-grill-with-docs |

## codebase-integrity-audit-loop

| # | User utterance (gist) | Expect |
| --- | --- | --- |
| T7 | "Audit this repo for integrity issues" | codebase-integrity-audit-loop |
| T8 | "Fix wiring drift with one disciplined loop" | codebase-integrity-audit-loop |
| T9 | "Parallel report only, no edits" | audit with `--parallel-report` |

## human-directed-swarm-planner

| # | User utterance (gist) | Expect |
| --- | --- | --- |
| T10 | "Plan a swarm for this mission" | human-directed-swarm-planner |
| T11 | "Run parallel agent lanes on X" | human-directed-swarm-planner |
| T12 | "Multi-agent review of this PR" | human-directed-swarm-planner (Review type) |

## production-flywheel

| # | User utterance (gist) | Expect |
| --- | --- | --- |
| T13 | "Run production-flywheel on this repo" | production-flywheel |
| T14 | "Ship candidates 2, 5, then 1 from the report" | production-flywheel |
| T15 | "Deliver this approved batch end-to-end" | production-flywheel |

## improve-codebase-architecture

| # | User utterance (gist) | Expect |
| --- | --- | --- |
| T16 | "Find deepening opportunities in this codebase" | improve-codebase-architecture |
| T17 | "HTML architecture deepening report" | improve-codebase-architecture |
| T18 | "Scan for shallow modules and grill one" | improve-codebase-architecture |

## prompt-forge

| # | User utterance (gist) | Expect |
| --- | --- | --- |
| T19 | "Write a system prompt for our support agent" | prompt-forge |
| T20 | "Fix this pasted prompt for Claude Code" | prompt-forge |
| T21 | "Port this brief to an overnight autonomous agent" | prompt-forge |

## Negative triggers

| # | Utterance | Must **not** alone select |
| --- | --- | --- |
| N1 | "Fix this one failing test" | production-flywheel (prefer diagnose / single fix path) |
| N2 | "What does CAPABILITY-MAP say?" | any execute skill |
| N3 | "Install all the skills on the internet" | nothing — refuse dumping unrelated skill universes |
| N4 | "Author a new Claude Code SKILL.md package" | prompt-forge (belongs to skillwright-forge / outside inventory) |

## How to run

Manual review or agent self-check: for each row, given only the utterance, does the description frontmatter / router table pick the Expect skill? Mark PASS/FAIL in a session note; no automated harness required yet.
