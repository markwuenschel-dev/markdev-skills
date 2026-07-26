# Capability map

Canonical inventory for this skills repo. **Start here** when you are unsure which skill to run, or when agent memory is fragmented across pastes and local copies.

Inventory = every folder under `skills/` with a root `SKILL.md`.

```text
                              ┌─────────────────────┐
                              │     loop-router     │
                              │  (unsure which?)    │
                              └──────────┬──────────┘
       ┌────────────┬───────────┬────────┴──┬────────────┬────────────┐
       ▼            ▼           ▼           ▼            ▼            ▼
    decide       assess     parallelize  deliver       land        craft
       │            │           │           │            │            │
  wayfinder-   repository-   human-    production-   land-pr     skillwright-
    mwdev        health-    directed-   flywheel     land-prs      forge
  expanded-    assessment     swarm-       │        land-pr-ec2  prompt-forge
    grill-     codebase-     planner       │        land-prs-ec2 compact-
  with-docs    integrity-                  │                      session
  implementa-  audit-loop                  │
  tion-plan-   improve-codebase-           │
  contract     architecture-mwdev    diagnosing-bugs-mwdev
                                     connected-impact-sweep
```

## Inventory

| Need | Top-level skill | Does **not** do |
| --- | --- | --- |
| Chart a big, foggy effort as a durable decision map | `wayfinder-mwdev` | Implement anything; generate delivery tickets; act as a todo list |
| Shape one design / approved design package | `expanded-grill-with-docs` | Implement production code; open PRs; choose project priority |
| Turn selected work into a binding execution contract | `implementation-plan-contract` | Select what to work on; write the code |
| Grade repository health / establish a baseline | `repository-health-assessment` | Implement fixes; propose architecture direction; review one diff |
| Audit and repair codebase integrity | `codebase-integrity-audit-loop` | Deliver a multi-item queue end-to-end |
| Architecture deepening report | `improve-codebase-architecture-mwdev` | Implement chosen deepenings; open PRs; grade repo health |
| Deliver approved work | `production-flywheel` | Start a new repo-wide report without user queue selection |
| Parallelize a known mission | `human-directed-swarm-planner` | Autonomously pick the mission |
| Diagnose one hard bug / regression | `diagnosing-bugs-mwdev` | Audit a repository; review architecture; plan a swarm |
| Change code without breaking neighbours | `connected-impact-sweep` | Decide what the change should be |
| Land one change through a PR | `land-pr` | Deploy anything |
| Land several open PRs as one queue | `land-prs` | Open PRs; deploy anything |
| Land one change + release to EC2 | `land-pr-ec2` | Land a multi-PR queue |
| Land a queue + release each service to EC2 | `land-prs-ec2` | Open PRs |
| Write / repair / optimize prompts | `prompt-forge` | Perform the underlying task; author SKILL.md packages |
| Design / audit / harden a SKILL.md package | `skillwright-forge` | Write ordinary prompts or application code |
| Checkpoint a long session before `/clear` | `compact-session` | Clear context itself; substitute for git commits |
| Unsure which applies | `loop-router` | Execute work itself beyond routing |

## When to hand off

| From | To | Trigger |
| --- | --- | --- |
| `loop-router` | any inventoried skill | Need matches a single row above |
| `wayfinder-mwdev` | `expanded-grill-with-docs` | A map ticket is design-sized — needs a bounded interview, not one direct decision |
| `wayfinder-mwdev` | `loop-router` | Decision terrain complete; router selects delivery |
| `expanded-grill-with-docs` | `implementation-plan-contract` | Design approved; needs a binding execution contract |
| `expanded-grill-with-docs` | `production-flywheel` | Approved design package reached; user wants delivery |
| `repository-health-assessment` | `codebase-integrity-audit-loop` | Graded baseline produced integrity candidates to repair |
| `repository-health-assessment` | `improve-codebase-architecture-mwdev` | Candidate is structural direction, not a defect |
| `codebase-integrity-audit-loop` | `production-flywheel` | User selected one or more ledger candidates to ship |
| `codebase-integrity-audit-loop` | `human-directed-swarm-planner` | User wants parallel report (`--parallel-report`) or a mission swarm |
| `codebase-integrity-audit-loop` | `diagnosing-bugs-mwdev` | A candidate is a live defect needing diagnosis, not a repair |
| `human-directed-swarm-planner` | `codebase-integrity-audit-loop` | Repo Audit swarm produced a ledger; next is candidate loops |
| `human-directed-swarm-planner` | `production-flywheel` | Mission is a **queue** of separate items, not one milestone |
| `human-directed-swarm-planner` | `diagnosing-bugs-mwdev` | Bug swarm lanes dispatch at the diagnosis skill |
| `production-flywheel` | `expanded-grill-with-docs` | Design-lane gate A — the default for every queue item |
| `production-flywheel` | `wayfinder-mwdev` | Candidate is too big for one slice; user elects to decompose (plan, don't build) |
| `production-flywheel` | `improve-codebase-architecture-mwdev` | Stage 1 architecture report / deepening candidates |
| `production-flywheel` | `diagnosing-bugs-mwdev` | Work goes red, flaky, slow, or unexplained |
| `production-flywheel` | `human-directed-swarm-planner` | One milestone needs parallel lanes, not sequential queue items |
| `production-flywheel` | `land-pr` | Stage 13 — open the item's PR (`land-prs` for leftover batches) |
| `improve-codebase-architecture-mwdev` | `expanded-grill-with-docs` | User selected a deepening candidate to design |
| `improve-codebase-architecture-mwdev` | `production-flywheel` | User selected a queue of candidates to ship |
| `land-pr` / `land-prs` | `land-pr-ec2` / `land-prs-ec2` | The landed service must also be released to EC2 |
| `prompt-forge` | `skillwright-forge` | The artifact is a SKILL.md package, not a prompt |
| `prompt-forge` | (exit) | Prompt delivered; do not execute the prompted task unless the user separately asks |

## Shared contracts

Every top-level skill may reference these without redefining them:

| Contract | Path | Owns |
| --- | --- | --- |
| Candidate ledger spine | [`shared/candidate-ledger-spine/`](shared/candidate-ledger-spine/) | Family candidate schema + verifiers (`candidate.schema.json`, `ledger-verify.js`, parity/package checks) |
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
5. **Inventoried skills route at inventoried skills first.** Where this repo owns a capability, its skills invoke the in-repo one — an in-repo skill may delegate down to an external companion internally, but the entry point is owned here. This is why the flywheel's design lane targets `expanded-grill-with-docs` and the `-mwdev` forks rather than their upstream parents.

## Validation

- Triggers: [`tests/trigger-tests.md`](tests/trigger-tests.md)
- Boundaries: [`tests/boundary-tests.md`](tests/boundary-tests.md)
- Functional: [`tests/functional-tests.md`](tests/functional-tests.md)
