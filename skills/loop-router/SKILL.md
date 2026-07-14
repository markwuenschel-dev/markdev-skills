---
name: loop-router
description: "Route a vague request to exactly one top-level skill in the markdev-skills inventory. Use when the user is unsure which loop applies, asks 'which skill', 'what should I run', or describes a need without naming expanded-grill-with-docs, codebase-integrity-audit-loop, human-directed-swarm-planner, or production-flywheel."
disable-model-invocation: false
---

# Loop router

Route. Do not execute the destination skill's full loop unless the user also asked you to start it.

Read [CAPABILITY-MAP.md](../../CAPABILITY-MAP.md) if present in the skills repo checkout; otherwise use the table below.

## Capability table

| Need | Top-level skill |
| --- | --- |
| Shape an idea / stress-test a plan / pin domain language | `expanded-grill-with-docs` |
| Audit repo health / find integrity candidates / one disciplined fix loop | `codebase-integrity-audit-loop` |
| Parallelize a **known** mission across agent lanes | `human-directed-swarm-planner` |
| Deliver a user-selected queue end-to-end (design → PR) | `production-flywheel` |
| Unsure | stay on `loop-router` until one row fits |

## Routing algorithm

1. **If the user already named a top-level skill** → route there. Do not re-grill the choice.
2. **If the user selected candidates/queue items and wants them shipped** → `production-flywheel`.
3. **If the user has a mission and wants parallel lanes** (not a multi-item queue) → `human-directed-swarm-planner`.
4. **If the user wants a report, ledger, or single integrity fix loop** → `codebase-integrity-audit-loop`.
5. **If the work is still an idea, design, or decision tree** → `expanded-grill-with-docs`.
6. **If two rows still fit** → ask **one** clarifying question, then route. Prefer the less destructive skill until authorized (grill/audit before flywheel/swarm edits).

## Disambiguation cheatsheet

```text
idea / ADR / glossary / "grill me"     → expanded-grill-with-docs
"what's wrong with this repo"          → codebase-integrity-audit-loop
"parallel audit report"                → codebase-integrity-audit-loop --parallel-report
                                           (uses human-directed-swarm-planner Repo Audit)
"run a swarm on X"                     → human-directed-swarm-planner
"ship these recommendations"           → production-flywheel
"do everything"                        → STOP — ask for mission or queue selection
```

## Output format

```markdown
## Route

**Selected skill:** <name>
**Why:** <one or two sentences>
**Not selected:** <alternatives and why>
**Next command:** /<skill> [flags]
**Shared contracts to load:** list relevant shared/*.md
```

## Hard rules

- Route to **exactly one** top-level skill (or ask one question).
- Do not invent a sixth top-level skill.
- Do not start production edits from the router alone.
- Do not expand into vendoring external skills; point at [DEPENDENCIES.md](../../DEPENDENCIES.md) if a companion is missing.
