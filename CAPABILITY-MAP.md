# Capability map

Canonical inventory for this skills repo. **Start here** when you are unsure which skill to run, or when agent memory is fragmented across pastes and local copies.

Inventory = every folder under `skills/` with a root `SKILL.md`.

```text
                    ┌─────────────────────┐
                    │     loop-router     │
                    │  (unsure which?)    │
                    └──────────┬──────────┘
     ┌──────────┬──────────┬───┴───┬──────────┬──────────┐
     ▼          ▼          ▼       ▼          ▼          ▼
 shape idea  audit      parallel  deliver  deepen     craft
 expanded-   integrity  / swarm   flywheel arch       prompts
 grill-      audit-loop           │        improve-   prompt-
 with-docs                        │        codebase-  forge
                                  │        architecture-mwdev
```

| Need | Top-level skill | Does **not** do |
| --- | --- | --- |
| Shape an idea / approved design package | `expanded-grill-with-docs` | Implement production code; open PRs; choose project priority |
| Audit repo health | `codebase-integrity-audit-loop` | Deliver a multi-item queue end-to-end |
| Parallelize a known mission | `human-directed-swarm-planner` | Autonomously pick the mission |
| Deliver approved work | `production-flywheel` | Start a new repo-wide report without user queue selection |
| Architecture deepening report | `improve-codebase-architecture-mwdev` | Implement chosen deepenings; open PRs |
| Write / repair / optimize prompts | `prompt-forge` | Perform the underlying task; author SKILL.md packages |
| Unsure which applies | `loop-router` | Execute work itself beyond routing |

## When to hand off

| From | To | Trigger |
| --- | --- | --- |
| `loop-router` | any inventoried skill | Need matches a single row above |
| `expanded-grill-with-docs` | `production-flywheel` or implement skills | Shared understanding / approved design package reached; user wants delivery |
| `codebase-integrity-audit-loop` | `production-flywheel` | User selected one or more ledger candidates to ship |
| `codebase-integrity-audit-loop` | `human-directed-swarm-planner` | User wants parallel report (`--parallel-report`) or a mission swarm |
| `human-directed-swarm-planner` | `codebase-integrity-audit-loop` | Repo Audit swarm produced a ledger; next is candidate loops |
| `human-directed-swarm-planner` | `production-flywheel` | Mission is a **queue** of separate items, not one milestone |
| `production-flywheel` | `grill-with-docs` (external) | Design-lane gate A (default) for a queue item |
| `production-flywheel` | `expanded-grill-with-docs` | User wants a deeper approved design/rollout package than the default grill |
| `production-flywheel` | `improve-codebase-architecture-mwdev` | Stage 1 architecture report / deepening candidates |
| `production-flywheel` | `human-directed-swarm-planner` | One milestone needs parallel lanes, not sequential queue items |
| `improve-codebase-architecture-mwdev` | `grill-with-docs` / `expanded-grill-with-docs` / `/grilling` | User selected a deepening candidate to design |
| `improve-codebase-architecture-mwdev` | `production-flywheel` | User selected a queue of candidates to ship |
| `prompt-forge` | (exit) | Prompt delivered; do not execute the prompted task unless the user separately asks |

## Shared contracts

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

1. **Inventory = every `skills/*/SKILL.md`.** Keep packages flat (no accidental `name/name/` nesting). True externals not owned here are listed in [`DEPENDENCIES.md`](DEPENDENCIES.md).
2. **Shared contracts are single sources of truth.** Skills link here; they do not fork scoring formulas or human-decision taxonomies.
3. **Human direction owns mission and queue.** Skills execute authorized work; they do not invent new roadmaps.
4. **Ship means open a PR, never merge**, unless the user explicitly says merge.

## Validation

- Triggers: [`tests/trigger-tests.md`](tests/trigger-tests.md)
- Boundaries: [`tests/boundary-tests.md`](tests/boundary-tests.md)
- Functional: [`tests/functional-tests.md`](tests/functional-tests.md)
