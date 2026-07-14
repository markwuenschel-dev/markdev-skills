# External dependencies

This repo **does not vendor** the full agent skill universe. Only the five top-level skills and `shared/` contracts live here.

When a top-level skill *invokes* or *assumes* another skill, pin it below by **repository or local source**, **path**, and **version or commit** (or `local-unpinned` if it only exists on the machine).

Update this file when you change which external skill a top-level skill relies on.

## Required for full flywheel delivery

| Skill / artifact | Used by | Source | Path | Version / commit |
| --- | --- | --- | --- | --- |
| `improve-codebase-architecture` | `production-flywheel` Stage 1 report | local agent pool | `~/.agents/skills/improve-codebase-architecture` | local-unpinned |
| `tdd` | `production-flywheel` new-behavior path | local agent pool | `~/.agents/skills/tdd` | local-unpinned |
| `diagnosing-bugs` | `production-flywheel`, audit execute interrupt | local agent pool | `~/.agents/skills/diagnosing-bugs` | local-unpinned |
| `to-tickets` (or Slice Contract fallback) | `production-flywheel` Stage 6 | local agent pool | `~/.agents/skills/to-tickets` | local-unpinned |

## Conditional / companion skills

| Skill / artifact | Used by | Source | Path | Version / commit |
| --- | --- | --- | --- | --- |
| `connected-impact-sweep` | audit execute calibration; swarm blast-radius lane; migration missions | **not installed in this environment** | — | pin when installed |
| `implementation-plan-contract` | audit plan gate; planning swarm | **not installed in this environment** | — | pin when installed |
| `codebase-design` / design-it-twice | flywheel when 2+ interface shapes | local agent pool | `~/.agents/skills/codebase-design` | local-unpinned |
| `wayfinder` | flywheel scoping (too big for one slice) | local agent pool | `~/.agents/skills/wayfinder` | local-unpinned |
| `domain-modeling` | `expanded-grill-with-docs` glossary/ADR capture | local agent pool | `~/.agents/skills/domain-modeling` | local-unpinned |
| `grilling` | thin primitive under expanded grill | local agent pool | `~/.agents/skills/grilling` | local-unpinned |
| `prototype` | flywheel / audit prototype branch | local agent pool | `~/.agents/skills/prototype` | local-unpinned |
| `triage` | flywheel triage sub-lane | local agent pool | `~/.agents/skills/triage` | local-unpinned |
| `writing-plans` | flywheel / audit plan stage | local agent pool | `~/.agents/skills/writing-plans` | local-unpinned |
| `executing-plans` | sequential delivery mode | local agent pool | `~/.agents/skills/executing-plans` | local-unpinned |
| `subagent-driven-development` | parallel task delivery mode | local agent pool | `~/.agents/skills/subagent-driven-development` | local-unpinned |
| `using-git-worktrees` | isolated delivery | local agent pool | `~/.agents/skills/using-git-worktrees` | local-unpinned |
| `requesting-code-review` / `receiving-code-review` | flywheel review | local agent pool | `~/.agents/skills/requesting-code-review` | local-unpinned |
| `verification-before-completion` | ship gate | local agent pool | `~/.agents/skills/verification-before-completion` | local-unpinned |
| `dispatching-parallel-agents` | optional swarm fan-out helper | local agent pool | `~/.agents/skills/dispatching-parallel-agents` | local-unpinned |

## Shared contracts that replace missing externals

When `connected-impact-sweep` or `implementation-plan-contract` are not installed, use:

| Missing external | Fallback in this repo |
| --- | --- |
| human-decision categories | `shared/HUMAN-DECISIONS.md` |
| implementation / slice handoff | `shared/ROLLOUT-CONTRACT.md` |
| lane merge protocol (core) | `shared/SWARM-LANES.md` |
| candidate scoring | `shared/REPORT-SCORING.md` |

Do **not** copy those external skill trees into this repository. Pin them here when you add them elsewhere.

## How to pin a new dependency

```markdown
| short-name | which top-level skill | https://github.com/org/repo | path/in/repo | abcdef1 or tag |
```

Prefer a commit SHA over a floating branch name.
