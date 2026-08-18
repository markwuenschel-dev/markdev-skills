# External dependencies

This repo owns a **living inventory** under `skills/` (every folder with a root `SKILL.md`) plus `shared/` contracts. Companion skills that are *not* owned here stay external — pin them below; do not dump unrelated skill universes into this repository.

When an inventoried skill *invokes* or *assumes* another skill that is not under `skills/`, pin it below by **author/lineage**, **repository**, **path**, and **version or commit** (or `local-unpinned` if it only exists on the machine).

Update this file when you change which external skill an inventoried skill relies on.

---

## Lineage (who we depend on)

| Lineage | Who | Role in this inventory |
| --- | --- | --- |
| **Matt** | [Matt Pocock](https://github.com/mattpocock) — [`mattpocock/skills`](https://github.com/mattpocock/skills) | Composable engineering skills: grill, domain model, TDD, architecture deepening, wayfinder, tickets, triage. **Parent of the three `-mwdev` forks below.** |
| **Jeff** | [Jeff Bailey](https://jeffbailey.us) — fitness / graded review skills (`review-*`) | Scored quality rubrics; graded-integrity swarm lane; informs how we think about evidence-backed scores |
| **Obra** | [Jesse Vincent](https://github.com/obra) — [`obra/superpowers`](https://github.com/obra/superpowers) | Plan → execute → review → verify machinery (worktrees, subagents, verification gate, skill discipline) |
| **Local / family** | this repo | The inventory under `skills/` and the contracts under `shared/` |

**Rule of thumb:** skill *folders and procedures* lean Matt; *scoring, fitness dimensions, and graded review* lean Jeff; *delivery harness* (plans, subagents, verify, worktrees) leans Obra / Superpowers. Inventoried loops compose all three — companions stay pinned here unless promoted into `skills/`.

---

## Fork lineage (derivative works — attribution required)

Three inventoried skills are **forks of Matt Pocock's originals**, not original work. They carry a `-mwdev` suffix so an upstream `npx skills add mattpocock/skills` can never overwrite them: the installer's only destructive step is scoped to a single skill's own directory, keyed on the upstream skill's declared `name`, so a differently-named directory is never a write target.

| Fork (in this repo) | Upstream parent | Forked at | What diverges |
| --- | --- | --- | --- |
| [`wayfinder-mwdev`](skills/wayfinder-mwdev/) | `wayfinder` — `mattpocock/skills` | v2.1.2 | Evidence-first mapping interview, bounded parallel scouts, durable tracker scripts + fallback tracker, `expanded-grill-with-docs` handoff contract, release validator |
| [`diagnosing-bugs-mwdev`](skills/diagnosing-bugs-mwdev/) | `diagnosing-bugs` — `mattpocock/skills` | local-unpinned | Ownership-boundary section wiring it to `codebase-integrity-audit-loop` and `human-directed-swarm-planner` |
| [`improve-codebase-architecture-mwdev`](skills/improve-codebase-architecture-mwdev/) | `improve-codebase-architecture` — `mattpocock/skills` | local-unpinned | **Deprecated** — legacy compatibility alias forwarding to `architecture-improvement-intelligence` (see *Known, not yet vendored* below) |

**Fork naming rule.** A fork must set its frontmatter `name` to the **suffixed** directory name. The `name` field is the invocation name (the directory basename is only a fallback), so a fork that keeps the upstream `name` collides with the skill it forked and neither resolves reliably.

### In-repo (formerly external, now owned here)

| Skill | Used by | Canonical path in this repo | Note |
| --- | --- | --- | --- |
| `improve-codebase-architecture-mwdev` | Deprecated — see Fork lineage above | [`skills/improve-codebase-architecture-mwdev`](skills/improve-codebase-architecture-mwdev/) | Fork of Matt's `improve-codebase-architecture`; legacy alias only |
| `wayfinder-mwdev` | `production-flywheel` scoping pre-check | [`skills/wayfinder-mwdev`](skills/wayfinder-mwdev/) | Fork of Matt's `wayfinder` |
| `diagnosing-bugs-mwdev` | flywheel + audit execute interrupt; swarm bug lanes | [`skills/diagnosing-bugs-mwdev`](skills/diagnosing-bugs-mwdev/) | Fork of Matt's `diagnosing-bugs` |
| `expanded-grill-with-docs` | flywheel design-lane gate A (default); wayfinder design tickets | [`skills/expanded-grill-with-docs`](skills/expanded-grill-with-docs/) | Original; may invoke Matt's `grilling` / `domain-modeling` as child procedures |
| `connected-impact-sweep` | audit execute calibration; swarm blast-radius; migration missions | [`skills/connected-impact-sweep`](skills/connected-impact-sweep/) | Original |
| `implementation-plan-contract` | audit plan gate; planning swarm | [`skills/implementation-plan-contract`](skills/implementation-plan-contract/) | Original |
| `repository-health-assessment` | graded baseline feeding audit + architecture | [`skills/repository-health-assessment`](skills/repository-health-assessment/) | v5.2 (schema v5 + code-sprawl-pressure evidence + Evidence Recon sidecar); consumes `shared/candidate-ledger-spine`, `shared/evidence-recon`, `shared/assessment-acceleration`, `agent-executor-pool` |
| `agent-executor-pool` | bounded read-only worker scheduling for `repository-health-assessment` (and future consumers) | [`skills/agent-executor-pool`](skills/agent-executor-pool/) | Original; generic executor semantics — worker leases, generation/fence tokens, work-conserving refill |
| `land-pr` | `production-flywheel` Stage 13 publish | [`skills/land-pr`](skills/land-pr/) | Original; single skill covers local-change, PR-queue, and EC2 (`-ec2`) modes — `land-prs`/`land-pr-ec2`/`land-prs-ec2` were removed as redundant |

### Known, not yet vendored

Local/family skills confirmed to exist in the working copy this inventory tracks against, but not yet promoted into `skills/`. Not third-party — these belong here eventually; they're pinned rather than silently dropped until someone does the port (files, dependency check, verification) properly.

| Skill | Role | Local path | Version / commit |
| --- | --- | --- | --- |
| `architecture-improvement-intelligence` | Successor to the deprecated `improve-codebase-architecture-mwdev` fork — structural architecture analysis, candidate ranking, design handoff | `~/.agents/skills/architecture-improvement-intelligence` | local-unpinned |
| `software-engineering-intelligence` | Provenance-bound Software Engineering Intelligence snapshot + evidence-backed engineering assessment sidecar, optional offline report | `~/.agents/skills/software-engineering-intelligence` | local-unpinned |

Install examples:

```bash
npx skills add mattpocock/skills
npx skills add obra/superpowers
```

Browse: [skills.sh/mattpocock/skills](https://skills.sh/mattpocock/skills) · [skills.sh/obra/superpowers](https://skills.sh/obra/superpowers) · [jeffbailey.us/fundamentals](https://jeffbailey.us/categories/fundamentals/)

---

## Matt Pocock (`mattpocock/skills`)

Still-external companions. Note the routing rule: where this repo owns a capability, inventoried skills invoke the **in-repo** skill, which may delegate down to one of these internally.

| Skill | Used by | Canonical source | Local path | Version / commit |
| --- | --- | --- | --- | --- |
| `tdd` | `production-flywheel` new-behavior path | `mattpocock/skills` | `~/.agents/skills/tdd` | local-unpinned |
| `to-tickets` (or Slice Contract fallback) | `production-flywheel` Stage 6 | `mattpocock/skills` | `~/.agents/skills/to-tickets` | local-unpinned |
| `grilling` | child procedure **under** `expanded-grill-with-docs` — not invoked directly by inventoried skills | `mattpocock/skills` | `~/.agents/skills/grilling` | local-unpinned |
| `grill-with-docs` | superseded as the flywheel design lane by `expanded-grill-with-docs`; retained as an upstream companion | `mattpocock/skills` | `~/.agents/skills/grill-with-docs` | local-unpinned |
| `domain-modeling` | `expanded-grill-with-docs` glossary/ADR capture; wayfinder grilling tickets | `mattpocock/skills` | `~/.agents/skills/domain-modeling` | local-unpinned |
| `codebase-design` (design-it-twice) | flywheel when 2+ interface shapes | `mattpocock/skills` | `~/.agents/skills/codebase-design` | local-unpinned |
| `prototype` | flywheel / audit / wayfinder prototype tickets | `mattpocock/skills` | `~/.agents/skills/prototype` | local-unpinned |
| `research` | wayfinder research tickets | `mattpocock/skills` | `~/.agents/skills/research` | local-unpinned |
| `triage` | flywheel triage sub-lane | `mattpocock/skills` | `~/.agents/skills/triage` | local-unpinned |
| `setup-matt-pocock-skills` | repo setup for tracker / domain docs | `mattpocock/skills` | `~/.agents/skills/setup-matt-pocock-skills` | local-unpinned |

**Superseded by an in-repo fork** — do not route at these directly: `wayfinder` → `wayfinder-mwdev`; `diagnosing-bugs` → `diagnosing-bugs-mwdev`. `improve-codebase-architecture` is superseded by `architecture-improvement-intelligence` (not yet vendored — see *Known, not yet vendored* above); its former in-repo fork, `improve-codebase-architecture-mwdev`, is itself now a deprecated alias, not a live route target.

---

## Jeff Bailey (fitness / graded review)

Jeff’s **scored fitness reviews** (`review-architecture`, `review-security`, `review-testing`, …) supply the graded-quality posture used by the Repo Audit **graded integrity** lane, by `repository-health-assessment`, and by how this family thinks about dimension scores + evidence.

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
| `shared/candidate-ledger-spine/` | Candidate schema + verifiers | Executable form of the scoring spine; consumed by audit, health assessment, and architecture |
| `shared/HUMAN-DECISIONS.md` | Auto-mode stop taxonomy | Complements graded review with explicit human forks |
| `shared/evidence-recon/` | Generic evidence packet contract (inline/expedition modes, negative-claim receipts) | Consumed by `repository-health-assessment`'s v5.2 sidecar; own test suite GREEN 14/14 |
| `shared/assessment-acceleration/` | Aggressive assessment scheduling, cache, performance receipts | Consumed by `repository-health-assessment`'s report builder; own test suite GREEN |

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
| `land-pr` family | PR landing + optional EC2 release | Ours; complements rather than replaces the Superpowers review/verify gates |
| `shared/ROLLOUT-CONTRACT.md` | Min plan/handoff shape | Compatible with Superpowers-style task plans |
| `shared/SWARM-LANES.md` / blast-radius lane notes | Parallel agent posture | “Obra-style” impact thinking; still pin Superpowers for fan-out |

When you promote another Superpowers skill from optional to required, pin it in the table above with source + commit/tag.

---

## Not owned here, deliberately excluded

Present in the local agent skills pool but **not** inventoried and **not** published here — they belong to other authors:

| Package | Author / source | Why excluded |
| --- | --- | --- |
| `prompt-master` | MIT © Nidhin Joseph Nelson — [`nidhinjs/prompt-master`](https://github.com/nidhinjs/prompt-master) | Third-party package with its own LICENSE and release cadence |
| `openspec-*` | `metadata.author: openspec` | Third-party suite |
| `speckit-*` | `metadata.author: github-spec-kit` | Third-party suite |
| `context7-mcp`, `find-skills` | ecosystem-generic packages | Not authored here; no attribution trail to claim |

---

## Shared fallbacks (this repo)

When an external companion is missing:

| Missing external | Fallback |
| --- | --- |
| human-decision categories | `shared/HUMAN-DECISIONS.md` |
| implementation / slice handoff | `shared/ROLLOUT-CONTRACT.md` |
| lane merge protocol (core) | `shared/SWARM-LANES.md` |
| candidate scoring | `shared/REPORT-SCORING.md` + `shared/candidate-ledger-spine/` |

Do **not** dump entire Matt, Jeff, or Obra skill trees into this repository. Promote a skill into `skills/` only when this inventory owns it; otherwise pin it here and install it in the agent skills pool.

---

## How to pin a new dependency

```markdown
| short-name | used by | lineage (Matt / Jeff / Obra / other) | https://github.com/org/repo | path/in/repo | abcdef1 or tag |
```

Prefer a commit SHA over a floating branch name. Always name the lineage when the skill is Matt’s, Jeff’s, or Obra’s. When the new entry is a **fork**, add it to *Fork lineage* above and credit the upstream author there.
