# External dependencies

This repo **does not vendor** the full agent skill universe. Only the five top-level skills and `shared/` contracts live here.

When a top-level skill *invokes* or *assumes* another skill, pin it below by **author/lineage**, **repository**, **path**, and **version or commit** (or `local-unpinned` if it only exists on the machine).

Update this file when you change which external skill a top-level skill relies on.

---

## Lineage (who we depend on)

| Lineage | Who | Role in this inventory |
| --- | --- | --- |
| **Matt** | [Matt Pocock](https://github.com/mattpocock) — [`mattpocock/skills`](https://github.com/mattpocock/skills) | Composable engineering skills: grill, domain model, TDD, architecture deepening, wayfinder, tickets, triage |
| **Jeff** | [Jeff Bailey](https://jeffbailey.us) — fitness / graded review skills (`review-*`) | Scored quality rubrics; graded-integrity swarm lane; informs how we think about evidence-backed scores |
| **Obra** | [obra/superpowers](https://github.com/obra/superpowers) | Plan → execute → review → verify machinery (worktrees, subagents, verification gate) |
| **Local / family** | this machine or unreleased companions | `connected-impact-sweep`, `implementation-plan-contract`, etc. — pin when installed |

**Rule of thumb:** skill *folders and procedures* lean Matt; *scoring, fitness dimensions, and graded review* lean Jeff; *delivery harness* (plans, subagents, verify) leans Obra. Our top-level loops compose all three — they are not re-authored here.

Install Matt’s pack (example):

```bash
npx skills add mattpocock/skills
```

Browse: https://skills.sh/mattpocock/skills · https://skills.sh/obra/superpowers

---

## Matt Pocock (`mattpocock/skills`)

| Skill | Used by | Canonical source | Local path | Version / commit |
| --- | --- | --- | --- | --- |
| `improve-codebase-architecture` | `production-flywheel` Stage 1 report | `mattpocock/skills` | `~/.agents/skills/improve-codebase-architecture` | local-unpinned |
| `tdd` | `production-flywheel` new-behavior path | `mattpocock/skills` | `~/.agents/skills/tdd` | local-unpinned |
| `diagnosing-bugs` | flywheel + audit execute interrupt | `mattpocock/skills` | `~/.agents/skills/diagnosing-bugs` | local-unpinned |
| `to-tickets` (or Slice Contract fallback) | `production-flywheel` Stage 6 | `mattpocock/skills` | `~/.agents/skills/to-tickets` | local-unpinned |
| `grilling` | primitive under `expanded-grill-with-docs` | `mattpocock/skills` | `~/.agents/skills/grilling` | local-unpinned |
| `grill-with-docs` | alias / thinner grill+docs; flywheel may accept it | `mattpocock/skills` | `~/.agents/skills/grill-with-docs` | local-unpinned |
| `domain-modeling` | `expanded-grill-with-docs` glossary/ADR capture | `mattpocock/skills` | `~/.agents/skills/domain-modeling` | local-unpinned |
| `codebase-design` (design-it-twice) | flywheel when 2+ interface shapes | `mattpocock/skills` | `~/.agents/skills/codebase-design` | local-unpinned |
| `wayfinder` | flywheel scoping (too big for one slice) | `mattpocock/skills` | `~/.agents/skills/wayfinder` | local-unpinned |
| `prototype` | flywheel / audit prototype branch | `mattpocock/skills` | `~/.agents/skills/prototype` | local-unpinned |
| `triage` | flywheel triage sub-lane | `mattpocock/skills` | `~/.agents/skills/triage` | local-unpinned |
| `setup-matt-pocock-skills` | repo setup for tracker / domain docs | `mattpocock/skills` | `~/.agents/skills/setup-matt-pocock-skills` | local-unpinned |

---

## Jeff Bailey (fitness / graded review)

Jeff’s **scored fitness reviews** (`review-architecture`, `review-security`, `review-testing`, …) supply the graded-quality posture used by the Repo Audit **graded integrity** lane and by how this family thinks about dimension scores + evidence.

They are **not vendored** into this repo. Canonical ideas live on [jeffbailey.us/categories/fundamentals](https://jeffbailey.us/categories/fundamentals/); local installs typically sit under `~/.claude/skills/review-*` or `~/.agents/skills/review-*`.

| Skill / surface | Used by | Source | Path | Version / commit |
| --- | --- | --- | --- | --- |
| `review-architecture` | swarm graded-integrity lane (optional) | Jeff Bailey fundamentals + local `review-architecture` skill | `~/.claude/skills/review-architecture` (or agents pool) | local-unpinned |
| `review-maintainability` | same | same family | `~/.claude/skills/review-maintainability` | local-unpinned |
| `review-reliability` | same | same family | `~/.claude/skills/review-reliability` | local-unpinned |
| `review-security` | same | same family | `~/.claude/skills/review-security` | local-unpinned |
| `review-testing` | same | same family | `~/.claude/skills/review-testing` | local-unpinned |
| `review-data` / `review-performance` / `review-process` / `review-algorithms` / `review-accessibility` | optional lens depth | same family | `~/.claude/skills/review-*` | local-unpinned |

**In this repo (not a Jeff package — our synthesis):**

| Contract | Role | Note |
| --- | --- | --- |
| `shared/REPORT-SCORING.md` | Family scoring spine + report style | Jeff-style *scored, evidence-backed* posture; schema is ours |
| `shared/HUMAN-DECISIONS.md` | Auto-mode stop taxonomy | Complements graded review with explicit human forks |

When you promote a Jeff skill from “optional lane helper” to a hard dependency, pin its install source and commit/tag here.

---

## Obra Superpowers (`obra/superpowers`)

| Skill | Used by | Canonical source | Local path | Version / commit |
| --- | --- | --- | --- | --- |
| `writing-plans` | flywheel / audit plan stage | `obra/superpowers` | `~/.agents/skills/writing-plans` | local-unpinned |
| `executing-plans` | sequential delivery mode | `obra/superpowers` | `~/.agents/skills/executing-plans` | local-unpinned |
| `subagent-driven-development` | parallel task delivery | `obra/superpowers` | `~/.agents/skills/subagent-driven-development` | local-unpinned |
| `using-git-worktrees` | isolated delivery | `obra/superpowers` | `~/.agents/skills/using-git-worktrees` | local-unpinned |
| `requesting-code-review` / `receiving-code-review` | flywheel review | `obra/superpowers` | `~/.agents/skills/requesting-code-review` | local-unpinned |
| `verification-before-completion` | ship / completion gate | `obra/superpowers` | `~/.agents/skills/verification-before-completion` | local-unpinned |
| `dispatching-parallel-agents` | optional swarm fan-out | `obra/superpowers` | `~/.agents/skills/dispatching-parallel-agents` | local-unpinned |

---

## Local / missing companions (pin when installed)

| Skill / artifact | Used by | Source | Path | Version / commit |
| --- | --- | --- | --- | --- |
| `connected-impact-sweep` | audit execute calibration; swarm blast-radius; migration missions | **not installed here** | — | pin when installed |
| `implementation-plan-contract` | audit plan gate; planning swarm | **not installed here** | — | pin when installed |

### Shared fallbacks (this repo)

When those companions are missing:

| Missing external | Fallback |
| --- | --- |
| human-decision categories | `shared/HUMAN-DECISIONS.md` |
| implementation / slice handoff | `shared/ROLLOUT-CONTRACT.md` |
| lane merge protocol (core) | `shared/SWARM-LANES.md` |
| candidate scoring | `shared/REPORT-SCORING.md` |

Do **not** copy Matt, Jeff, or Obra skill trees into this repository. Pin them here; install them in the agent skills pool.

---

## How to pin a new dependency

```markdown
| short-name | used by | lineage (Matt / Jeff / Obra / other) | https://github.com/org/repo | path/in/repo | abcdef1 or tag |
```

Prefer a commit SHA over a floating branch name. Always name the lineage when the skill is Matt’s, Jeff’s, or Obra’s.
