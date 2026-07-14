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
| **Obra** | [Jesse Vincent](https://github.com/obra) — [`obra/superpowers`](https://github.com/obra/superpowers) | Plan → execute → review → verify machinery (worktrees, subagents, verification gate, skill discipline) |
| **Local / family** | this machine or unreleased companions | `connected-impact-sweep`, `implementation-plan-contract`, etc. — pin when installed |

**Rule of thumb:** skill *folders and procedures* lean Matt; *scoring, fitness dimensions, and graded review* lean Jeff; *delivery harness* (plans, subagents, verify, worktrees) leans Obra / Superpowers. Our top-level loops compose all three — they are not re-authored here.

Install examples:

```bash
npx skills add mattpocock/skills
npx skills add obra/superpowers
```

Browse: [skills.sh/mattpocock/skills](https://skills.sh/mattpocock/skills) · [skills.sh/obra/superpowers](https://skills.sh/obra/superpowers) · [jeffbailey.us/fundamentals](https://jeffbailey.us/categories/fundamentals/)

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

## Jesse Vincent / Obra — Superpowers (`obra/superpowers`)

Obra’s **Superpowers** pack is the delivery harness this inventory assumes for planning, isolated branches, subagent execution, review loops, and “evidence before claims” verification. Flywheel Stages 7–11 and the audit loop’s plan/execute/verify path call these by name.

They are **not vendored** into this repo. Canonical package: [github.com/obra/superpowers](https://github.com/obra/superpowers) · [skills.sh/obra/superpowers](https://skills.sh/obra/superpowers).

| Skill | Used by | Canonical source | Local path | Version / commit |
| --- | --- | --- | --- | --- |
| `using-superpowers` | session discipline (invoke skills first) | `obra/superpowers` | `~/.agents/skills/using-superpowers` | local-unpinned |
| `writing-plans` | flywheel / audit plan stage | `obra/superpowers` | `~/.agents/skills/writing-plans` | local-unpinned |
| `executing-plans` | sequential delivery mode | `obra/superpowers` | `~/.agents/skills/executing-plans` | local-unpinned |
| `subagent-driven-development` | parallel task delivery | `obra/superpowers` | `~/.agents/skills/subagent-driven-development` | local-unpinned |
| `using-git-worktrees` | isolated delivery | `obra/superpowers` | `~/.agents/skills/using-git-worktrees` | local-unpinned |
| `requesting-code-review` | flywheel review (request) | `obra/superpowers` | `~/.agents/skills/requesting-code-review` | local-unpinned |
| `receiving-code-review` | flywheel review (respond) | `obra/superpowers` | `~/.agents/skills/receiving-code-review` | local-unpinned |
| `verification-before-completion` | ship / completion gate | `obra/superpowers` | `~/.agents/skills/verification-before-completion` | local-unpinned |
| `dispatching-parallel-agents` | optional swarm fan-out helper | `obra/superpowers` | `~/.agents/skills/dispatching-parallel-agents` | local-unpinned |

**In this repo (not an Obra package — our synthesis):**

| Surface | Role | Note |
| --- | --- | --- |
| `production-flywheel` execute path | Wires Superpowers skills into a queue loop | Does not re-implement Superpowers |
| `shared/ROLLOUT-CONTRACT.md` | Min plan/handoff shape | Compatible with Superpowers-style task plans |
| `shared/SWARM-LANES.md` / blast-radius lane notes | Parallel agent posture | “Obra-style” impact thinking; still pin Superpowers for fan-out |

When you promote another Superpowers skill from optional to required, pin it in the table above with source + commit/tag.

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
