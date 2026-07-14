# Capability map

Canonical inventory for this skills repo. **Start here** when you are unsure which skill to run, or when agent memory is fragmented across pastes and local copies.

```text
                    ┌─────────────────────┐
                    │     loop-router     │
                    │  (unsure which?)    │
                    └──────────┬──────────┘
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
   shape idea          audit health         parallelize /
   expanded-grill-     codebase-integrity-  deliver
   with-docs           audit-loop           │
                                            ├─ human-directed-swarm-planner
                                            └─ production-flywheel
```

| Need | Top-level skill | Does **not** do |
| --- | --- | --- |
| Shape an idea | `expanded-grill-with-docs` | Implement production code; open PRs |
| Audit repo health | `codebase-integrity-audit-loop` | Deliver a multi-item queue end-to-end |
| Parallelize a known mission | `human-directed-swarm-planner` | Autonomously pick the mission |
| Deliver approved work | `production-flywheel` | Start a new repo-wide report without user queue selection |
| Unsure which applies | `loop-router` | Execute work itself beyond routing |

## When to hand off

| From | To | Trigger |
| --- | --- | --- |
| `loop-router` | any of the four workers | Need matches a single row above |
| `expanded-grill-with-docs` | `production-flywheel` or implement skills | Shared understanding reached; user wants delivery |
| `codebase-integrity-audit-loop` | `production-flywheel` | User selected one or more ledger candidates to ship |
| `codebase-integrity-audit-loop` | `human-directed-swarm-planner` | User wants parallel report (`--parallel-report`) or a mission swarm |
| `human-directed-swarm-planner` | `codebase-integrity-audit-loop` | Repo Audit swarm produced a ledger; next is candidate loops |
| `human-directed-swarm-planner` | `production-flywheel` | Mission is a **queue** of separate items, not one milestone |
| `production-flywheel` | `expanded-grill-with-docs` | Design-lane gate A (default) for a queue item |
| `production-flywheel` | `human-directed-swarm-planner` | One milestone needs parallel lanes, not sequential queue items |

## Shared contracts (Jeff-style)

Every top-level skill may reference these without redefining them:

| Contract | Path | Owns |
| --- | --- | --- |
| Scoring spine | [`shared/REPORT-SCORING.md`](shared/REPORT-SCORING.md) | Candidate schema, scores, priority, report sections/style |
| Requirements ledger | [`shared/REQUIREMENTS-LEDGER.md`](shared/REQUIREMENTS-LEDGER.md) | Trackable requirement/candidate status |
| Rollout contract | [`shared/ROLLOUT-CONTRACT.md`](shared/ROLLOUT-CONTRACT.md) | Implementation / slice handoff shape |
| Swarm lanes | [`shared/SWARM-LANES.md`](shared/SWARM-LANES.md) | Lane roles, captain rules, merge protocol |
| Human decisions | [`shared/HUMAN-DECISIONS.md`](shared/HUMAN-DECISIONS.md) | Categories that block auto mode |
| Loop state | [`shared/LOOP-STATE.md`](shared/LOOP-STATE.md) | Valid next starting points between loops |

## Boundaries (do not blur)

1. **This repo holds five top-level skills only.** Supporting files may live under a skill folder; external helpers are listed in [`DEPENDENCIES.md`](DEPENDENCIES.md), not vendored.
2. **Shared contracts are single sources of truth.** Skills link here; they do not fork scoring formulas or human-decision taxonomies.
3. **Human direction owns mission and queue.** Skills execute authorized work; they do not invent new roadmaps.
4. **Ship means open a PR, never merge**, unless the user explicitly says merge.

## Validation

- Triggers: [`tests/trigger-tests.md`](tests/trigger-tests.md)
- Boundaries: [`tests/boundary-tests.md`](tests/boundary-tests.md)
- Functional: [`tests/functional-tests.md`](tests/functional-tests.md)
