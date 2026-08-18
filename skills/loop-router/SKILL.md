---
name: loop-router
description: "Route a vague request to exactly one skill in the markdev-skills inventory. Use when the user is unsure which loop applies, asks 'which skill', 'what should I run', or describes a need without naming an inventoried skill."
disable-model-invocation: false
---

# Loop router

Route. Do not execute the destination skill's full loop unless the user also asked you to start it.

Read [CAPABILITY-MAP.md](../../CAPABILITY-MAP.md) if present in the skills repo checkout; otherwise use the table below.

## Capability table

| Need | Top-level skill |
| --- | --- |
| Chart a broad, foggy effort | `wayfinder-mwdev` |
| Shape a selected design / approved design package | `expanded-grill-with-docs` |
| Bind an approved plan into an execution contract | `implementation-plan-contract` |
| Grade repo health / find integrity candidates | `repository-health-assessment` / `codebase-integrity-audit-loop` |
| Diagnose one hard bug / regression | `diagnosing-bugs-mwdev` |
| Edit, fix, refactor, or add across an existing multi-file system | `connected-impact-sweep` |
| Parallelize a **known** mission across agent lanes | `human-directed-swarm-planner` |
| Deliver a user-selected queue end-to-end (design → PR) | `production-flywheel` |
| Land a local change or explicit PR queue; optionally release it | `land-pr` |
| Land a multi-PR queue and/or release each service to EC2 | `land-pr` (queue mode; add `-ec2` to also release) |
| Write, repair, port, or eval-optimize a prompt / system prompt / launch brief | `prompt-forge` |
| Design, audit, or harden a SKILL.md package | `skillwright-forge` |
| Checkpoint a long session before clearing context | `compact-session` |
| Unsure | stay on `loop-router` until one row fits |

## Routing algorithm

1. **If the user already named a top-level skill** → route there. Do not re-grill the choice.
2. **If the user asks to land or merge a local change or an explicit PR queue** → `land-pr`; use its `-ec2` overlay only when release is also requested — queue mode and the EC2 overlay are flags of the same skill, not separate packages. Do not confuse landing with `production-flywheel`, which delivers selected work before the landing phase.
3. **If the user asks to checkpoint before `/clear`** → `compact-session`; if they want a SKILL.md package designed or hardened → `skillwright-forge`.
4. **If the user selected candidates/queue items and wants them delivered end-to-end** → `production-flywheel`.
5. **If the user has a mission and wants parallel lanes** (not a multi-item queue) → `human-directed-swarm-planner`.
6. **If the user wants to grade repo health** → `repository-health-assessment`; for a repair candidate/loop → `codebase-integrity-audit-loop`; for one hard bug → `diagnosing-bugs-mwdev`.
7. **If the user asks to edit, fix, refactor, or add across an existing multi-file system** → `connected-impact-sweep`.
8. **If the user wants an architecture deepening / HTML deepening report** → `improve-codebase-architecture-mwdev`.
9. **If the user wants a prompt, system prompt, or launch brief written/fixed/ported** → `prompt-forge`.
10. **If the work is still a broad decision terrain** → `wayfinder-mwdev`; if it is a selected design or decision tree → `expanded-grill-with-docs`; if the design is approved and needs a binding delivery contract → `implementation-plan-contract`.
11. **If two rows still fit** → ask **one** clarifying question, then route. Prefer the less destructive skill until authorized (grill/audit/report before flywheel/swarm edits).

## Disambiguation cheatsheet

```text
idea / ADR / glossary / "grill me"     → expanded-grill-with-docs
big foggy effort / dependency map       → wayfinder-mwdev
"make this plan executable"             → implementation-plan-contract
"grade this repo"                       → repository-health-assessment
"what's wrong with this repo"          → codebase-integrity-audit-loop
"diagnose this regression"              → diagnosing-bugs-mwdev
"parallel audit report"                → codebase-integrity-audit-loop --parallel-report
                                           (uses human-directed-swarm-planner Repo Audit)
"run a swarm on X"                     → human-directed-swarm-planner
"ship these recommendations"           → production-flywheel
"land PRs 45, 47" / "merge this"      → land-pr
"checkpoint before /clear"              → compact-session
"author a SKILL.md package"             → skillwright-forge
"fix this across the app"              → connected-impact-sweep
"deepen modules" / architecture HTML   → improve-codebase-architecture-mwdev
"write/fix/port this prompt"          → prompt-forge
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

- Route to **exactly one** inventoried skill (or ask one question).
- Do not invent skills that are not in [CAPABILITY-MAP.md](../../CAPABILITY-MAP.md) / `skills/*/SKILL.md`.
- Do not start production edits from the router alone.
- If a companion external is missing, point at [DEPENDENCIES.md](../../DEPENDENCIES.md); do not dump unrelated skill universes into this repo.
