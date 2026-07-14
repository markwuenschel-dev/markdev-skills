---
name: human-directed-swarm-planner
description: "Plan and run human-directed agent swarms: parallel subagent lanes executing one human-selected mission. Use when the user asks for a swarm of any type (repo-audit report, exploration, review, bug, planning, research, fitness-check, migration, production implementation), a multi-agent plan, agent lanes, or a parallel execution topology — or when another skill needs a mission or contract decomposed into parallel lanes, or needs broad repo-wide analysis without edits. Supports --auto --max-turns."
disable-model-invocation: false
---

# Human-Directed Swarm Planner

Use this skill to design, route, and run human-directed agent swarms.

A swarm is an execution topology, not autonomous project selection.

The human chooses:

- mission
- repo/project
- target candidate, question, branch, failure, or report
- allowed scope
- allowed skills/tools
- whether agents may edit code or only report findings
- whether auto mode is allowed

The swarm planner chooses:

- swarm type
- lane structure
- subagent decomposition
- gates
- failure codes
- verification plan
- merge/capture protocol

## Core rule

The swarm is human-directed: it executes the human-selected mission and nothing beyond it. Work discovered mid-swarm becomes a reported finding or a proposed next mission, never new scope.

## Model invocation policy

This skill is model-invokable: invoke it when its role is needed inside the current approved workflow, without waiting for the user to name it.

Model invocation does not expand scope. The active mission, selected candidate, queue item, or implementation contract carries over unchanged — starting a new audit, roadmap, queue, or unrelated cleanup takes a user request. If invoking this skill would change the user's authorization boundary, pause and ask.

## Operating modes

Manual mode is the default.

Manual mode:

1. Clarify or infer the selected mission.
2. Choose the appropriate swarm type.
3. Produce one swarm plan.
4. Stop for user approval unless the user explicitly asked for execution instructions only.

Auto mode may be enabled explicitly:

```text
--auto
--max-turns <N|max>
```

`--auto` without `--max-turns` defaults to `--max-turns 1` (a single mission). For this skill, a turn means one complete swarm mission:

```text
mission selected → lanes assigned → subagents briefed → findings integrated → verification/capture defined → next mission selected or stopped
```

Examples:

```text
/human-directed-swarm-planner --auto --max-turns 3
```

Plan or run the top 3 recommended swarm missions from the selected report/ledger, in order.

```text
/human-directed-swarm-planner --auto --max-turns max
```

Continue through all executable swarm missions from the selected report/ledger until exhausted or blocked.

Auto mode consumes an existing report/ledger or a report produced at the user's direction. It does not create new scope. When `--auto` is set, read [AUTO-MODE.md](AUTO-MODE.md) before the first mission — mission sources, ranking, hard stops, and the stop report live there.

## Hard rules

- Human direction controls mission and scope.
- One swarm mission per turn.
- Cleanup is a mission only when the human names it and its boundary.
- Each swarm must have a captain/integrator.
- Each lane must have a concrete output.
- Every swarm must define gates, failure codes, report requirements, and definition of done.
- If code changes are allowed, verification commands are required.
- If code changes are not allowed, findings must be classified and evidence-backed.
- Auto mode must stop on human-decision categories.

## Swarm router

Two swarm classes exist, and they never blur. **Repo Audit** is the read-only class: it inspects the whole repo and produces one scored HTML report plus one candidate ledger, writing nothing but those artifacts, and stops there. Every other type is an **Execution Swarm**: it works one human-selected mission and may edit files only inside that mission's scope — under an approved implementation contract when one exists.

Route the human-selected mission to exactly one swarm type, then read [SWARM-TYPES.md](SWARM-TYPES.md) for that type's goal, lanes, outputs, and hard rules:

- **Repo Audit** — read-only, repo-wide: another skill (e.g. `codebase-integrity-audit-loop --parallel-report`) or the user needs broad multi-lens analysis without edits; four default lanes, merged into one scored report + candidate ledger per the family's scoring spine (`shared/REPORT-SCORING.md`), then stop.
- **Explorer** — problem shape unknown; map terrain, seams, candidates, risks, unknowns.
- **Review** — a change, branch, PR, or generated artifact exists and needs pressure-testing before merge.
- **Bug** — failing test, production bug, flaky behavior, mysterious regression, unexplained red state.
- **Planning** — target known, execution plan must be production-grade; pairs with implementation-plan-contract.
- **Research** — work depends on external facts, libraries, standards, or current information.
- **Fitness-check** — make one recurring failure mode impossible or immediately visible via an enforceable check.
- **Migration / Connected-Impact** — a schema, path, public API, enum, artifact format, taxonomy, or contract changes; pairs with connected-impact-sweep.
- **Production implementation** — deliver one selected production *milestone* as parallel lanes with full-shield gates. Boundary: this is **one milestone decomposed into parallel surfaces**; a *queue* of separate items delivered sequentially, each as its own per-item PR, is `production-flywheel`'s job, not a swarm. Opens a PR and stops — never merges.

## Generic swarm output format

Every swarm plan must include:

```markdown
# Swarm Plan: <mission>

## Executive mission

## Human-selected boundary

## Current baseline

## Strategic meaning

## Scope

## Non-goals

## Allowed skills/tools

## Agent lanes

## Subagent decomposition

## Required commands

## Gates

## Failure codes

## Negative fixtures / adversarial checks

## Report requirements

## Human decision points

## Merge / integration gate

## Definition of done

## Final success statement
```

**Read-only swarms** (Repo Audit, Explorer, Review, Research — anything where the human disallowed code edits) omit or mark **N/A** the sections that presuppose edits: *Required commands*, *Merge / integration gate*, and edit-verification. This matches the Hard rules — verification commands are required *only* when code changes are allowed; when they aren't, findings must instead be classified and evidence-backed.

## Non-goals requirement

Every swarm must state explicit non-goals.

Examples:

- Not broad cleanup.
- Not a compatibility-wrapper migration.
- Not a documentation-only project.
- Not validator weakening.
- Not demo-first shortcutting.
- Not autonomous roadmap selection.
- Not unrelated refactors.

## Failure codes

Every swarm should define failure codes appropriate to the mission.

Examples:

```text
FAIL-SCOPE-CREEP — work expanded beyond the human-selected mission.
FAIL-FAKE-GREEN — report claims pass while required checks were skipped.
FAIL-CONTRACT-DRIFT — producer and consumer schemas disagree.
FAIL-STALE-PATH — retired path remains reachable from active entrypoint.
FAIL-WEAK-VALIDATOR — validator accepts invalid fixture.
FAIL-UNVERIFIED-RUNTIME — runtime behavior claimed without smoke/playtest proof.
FAIL-MISSING-PROVENANCE — generated artifact lacks source/owner metadata.
FAIL-UNRESOLVED-LANE-CONFLICT — lanes disagree and the captain did not resolve it.
```

## Report requirements

Final swarm handoff must include:

- swarm type
- human-selected mission
- allowed scope
- agents/lanes used
- subagents assigned
- findings by lane
- integrated decision
- files changed, if any
- commands run and results
- skipped checks
- known risks
- blocked decisions
- deferred unrelated findings
- next recommended command

## Skill invocation discipline

This swarm may invoke other skills only inside the human-selected mission.

Allowed examples:

- `codebase-integrity-audit-loop` for report/candidate ledger and integrity candidates
- `connected-impact-sweep` for migration/contract/coherence execution
- `implementation-plan-contract` for converting the selected mission into an execution contract before lanes are shaped
- review/static/research skills only when the mission calls for them

Skills run as lanes inside the mission, never as independent autonomous missions, unless the user explicitly directs it.

## Turn completion

A turn is complete only when:

- the selected swarm mission has produced its required output
- lane findings are integrated
- conflicts are resolved or surfaced as human decisions
- verification/capture requirements are stated or executed
- next mission state is explicit
- auto mode ledger is updated when applicable
