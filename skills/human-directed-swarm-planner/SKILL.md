---
name: human-directed-swarm-planner
description: "Use when one selected mission needs parallel lanes, swarm decomposition, broad read-only multi-agent analysis, or execution-topology design. Run read-only swarms directly; for repository mutation, produce a conflict/resource-aware topology and hand it to production-flywheel, the sole mutating delivery owner. Not for direct implementation. Supports --auto --max-turns."
disable-model-invocation: false
---

# Human-Directed Swarm Planner

Use this skill to design, route, and coordinate human-directed swarms.

A swarm is a topology: independent questions/work units, dependencies, resource conflicts, barriers, lane contracts, and integration ownership. It is **not** a second implementation lifecycle.

## Ownership boundary

The human or explicit invoking caller chooses the mission, repository, scope, selected candidate/action, authorization boundary, allowed tools, and whether mutation is authorized.

`human-directed-swarm-planner` owns:

- swarm type selection;
- adaptive lane and subagent decomposition;
- dependency and conflict topology;
- write/resource ownership declarations;
- phase barriers and concurrency shape;
- captain/integrator assignment;
- verification topology and evidence-return contracts;
- read-only swarm execution and synthesis.

`production-flywheel` owns **all mutating production delivery**:

- worktree/branch setup;
- repository writes and implementation dispatch;
- commits;
- producer-side review/repair rounds;
- independent-verification boundaries;
- Stage 15 execution handoff;
- policy-gated push/PR behavior.

This planner never mutates source/config/test files, commits, pushes, opens PRs, or claims completion of downstream implementation. A specialist skill named by the topology may perform mutation only when invoked inside `production-flywheel`'s authorized delivery workflow.

The explicit caller retains mission and authorization ownership. RIA, Health, Integrity, Architecture, RGO, debugging, and other specialists retain their own domain authority. `production-flywheel` is the canonical mutating delivery owner.

## Core rule

The swarm is human-directed: it addresses the selected mission and nothing beyond it. Work discovered mid-swarm becomes a finding, closure question, or proposed next mission; it never silently expands scope.

For read-only work, this skill may dispatch and synthesize lanes itself. For mutating work, it stops at an **execution-topology handoff** to `production-flywheel`.

## Model invocation policy

This skill is model-invokable when topology materially improves the current approved workflow. Invocation does not create scope or delivery authorization.

Do not invoke it for a one-off single-surface edit or a problem with no meaningful independent lanes. Do not use it merely to increase agent count.

## Operating modes

Manual mode is the default. Choose exactly one:

- **Plan mode** — the human asks to plan, design, size, or prepare a swarm. Produce the full swarm plan and stop.
- **Read-only run mode** — the mission is structurally or electively read-only. Dispatch only read-only lanes, synthesize their evidence, and return the required report/owner references.
- **Execution-topology handoff mode** — mutation is requested or already authorized. Perform only the read-only premise/topology work needed to derive a safe execution topology, then hand that topology and the unchanged authorization boundary to `production-flywheel`. Do not perform the mutation here.

When ambiguous, use Plan mode. A direct request such as "implement this with a swarm" means **derive the swarm topology and route the authorized implementation to `production-flywheel`**, not "mutate from the planner."

## Auto mode

Auto mode may be enabled explicitly:

```text
--auto
--max-turns <N|max>
```

`--auto` without `--max-turns` defaults to one planner mission. `--max-turns N` counts planner missions, not implementation tasks.

A read-only auto mission may run to synthesis here. A mutating auto mission may advance past topology only when the caller supplies a matching exact delivery/action authorization for `production-flywheel`; otherwise stop with `MISSING_DELIVERY_AUTHORIZATION`.

When `--auto` is set, read [AUTO-MODE.md](AUTO-MODE.md) before selecting the first mission and execute the read-only `scripts/auto-guard.js` check. This planner never creates or claims canonical runtime state.

## Hard rules

- Human/caller authorization controls mission and scope.
- One planner mission at a time.
- Every swarm has a captain/integrator and concrete lane outputs.
- Parallel lanes exist only when independence is real and useful.
- Read-only lanes may gather evidence; mutating lanes are **described here and executed by `production-flywheel`**.
- Every mutating topology declares allowed/forbidden writes, shared/exclusive resources, dependencies, acceptance evidence, and failure conditions.
- Artifact-derived premises are rechecked on the execution revision before they become mutation-eligible.
- Auto mode stops on human-decision categories.
- No planner output may author a remediation/action graph, claim lifecycle state, select new candidates, or reinterpret delivery authorization.

## Swarm router

Route the selected mission to exactly one type, then read [SWARM-TYPES.md](SWARM-TYPES.md).

- **Repo Audit** — structurally read-only multi-lens candidate discovery. Formal health grades belong to `repository-health-assessment`.
- **RIA Assessment Topology** — subordinate read-only topology selected only by `repository-improvement-assessment` during ASSESS. RIA owns evidence materialization and assessment coordination; this planner only supplies/coordinates lane topology.
- **Explorer** — read-only terrain, seams, candidates, risks, and unknowns.
- **Review** — read-only pressure test of an existing change/artifact. Any requested repair becomes an execution-topology handoff.
- **Bug** — parallel diagnostic investigation only when a defect has genuinely independent surfaces. `adaptive-causal-debugging` owns the diagnostic protocol; this planner owns only parallel investigation topology. Any repository repair executes through `production-flywheel`.
- **Planning** — production-grade implementation topology/contract design; pairs with `implementation-plan-contract`.
- **Research** — read-only external/current evidence gathering.
- **Fitness-check** — design an enforceable check and, if implementation is authorized, emit its mutating topology to `production-flywheel`.
- **Migration / Connected-Impact** — derive blast radius and work topology; `connected-impact-sweep` provides specialist semantics, while mutation executes through `production-flywheel`.
- **Production execution topology** — decompose one already-authorized production item/action into independent work units for `production-flywheel`. This is never an alternative execution owner.

## Mutating execution-topology protocol

Before any downstream mutation, fill [assets/execution-topology.yaml](assets/execution-topology.yaml). It is a topology/handoff record, never an authority source.

1. **Bind authority.** Record mission identity, execution revision, selected action/item, and the immutable/user authorization reference that `production-flywheel` must consume. Do not create a new queue or graph.
2. **Recheck premises.** Classify artifact-derived premises as `confirmed`, `contradicted`, `stale`, or `unverifiable`. Only `confirmed` premises may produce mutating work units.
3. **Describe work units.** For every downstream mutating unit, declare inputs, allowed/forbidden writes, shared/exclusive resources, dependencies, specialist method, deliverable, acceptance evidence, and failure conditions. Also emit conservative `planned_impact` (allowed paths, expected symbols, resources, generated artifacts, global gates, confidence) when the caller requests campaign scheduling evidence; unknown impact is never guessed.
4. **Derive conflicts.** Write/write overlap, unsafe write/read coupling, exclusive-resource overlap, generated-state collision, and validation-environment collision require serialization or isolation.
5. **Schedule barriers.** Use only necessary phases: premise, mutation, integration, verification. Logical lanes may exceed runtime capacity. When `agent-executor-pool` is available, declare parallelism classes/resource capacities and let its bounded scheduler provide backpressure/refill; otherwise schedule conservative waves.
6. **Keep planner/captain mutation-clean.** If downstream integration requires edits, name an explicit Flywheel-owned integration/reconciliation work unit.
7. **Encode foreign-failure behavior.** A downstream lane encountering a failure on a foreign-owned surface reports `FOREIGN_FAILURE`; it must not repair that surface unless Flywheel reauthorizes/reshapes ownership.
8. **Classify discovered work.** Authorized work, bounded closure work, adjacent finding, or new scope. Only Flywheel may admit closure work into mutation, and only under the accepted predicate and existing authorization.
9. **Emit the handoff.** Target `production-flywheel`, preserve the caller's authorization/scope unchanged, and return the topology reference plus selected work-unit ids and resource/barrier summary. The planner's mutating mission is then complete.

For canonical `--action-graph` delivery, the action graph and its runtime remain authoritative for action readiness and cross-action concurrency. Planner topology may decompose work **inside an already authorized action or claimed wave**; it cannot rewrite the graph, change the frontier, or override D7 safety/resource proofs.

## Generic swarm output format

Every **Plan-mode** swarm plan includes:

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
## Dependencies / resource conflicts
## Required evidence / commands
## Gates
## Failure codes
## Negative fixtures / adversarial checks
## Report requirements
## Human decision points
## Integration topology
## Definition of done
## Final success statement
```

A **Read-only run** returns lane evidence, integrated findings/owner references, unresolved contradictions, known risks, deferred findings, and the next safe route. It reports no source-code mutation.

An **Execution-topology handoff** returns:

- mission/action identity and execution revision;
- preserved authorization reference;
- confirmed/excluded premises;
- logical lanes/work units;
- allowed/forbidden writes and shared/exclusive resources;
- conflict graph, waves, and barriers;
- integration and verification owners;
- specialist skills/methods to invoke downstream;
- `production-flywheel` handoff target;
- exact blockers/human decisions.

It does **not** report downstream implementation as complete.

## Failure codes

Use the smallest relevant set:

```text
FAIL-SCOPE-EXPANSION — topology moved beyond the authorized mission or valid closure boundary.
FAIL-UNVERIFIED-PREMISE — a mutating unit was derived from an unconfirmed artifact premise.
FAIL-OWNERSHIP-VIOLATION — topology assigns conflicting or undeclared ownership.
FAIL-DIRECT-MUTATION-OWNERSHIP — the planner attempted repository mutation instead of handing off to production-flywheel.
FAIL-FOREIGN-EDIT — a downstream lane modified a foreign-owned surface while handling a failure.
FAIL-UNATTRIBUTED-GATE-FAILURE — a complete-gate failure has no owner or affected surface.
FAIL-UNRESOLVED-LANE-CONFLICT — independent lanes cannot be safely reconciled.
MISSING_DELIVERY_AUTHORIZATION — mutation was requested but no valid Flywheel delivery/action authorization exists.
```

Add mission-specific failure codes only when they answer a concrete risk.

## Skill invocation discipline

This planner may invoke read-only specialists inside the selected mission. Examples include assessment owners under RIA, review/research lenses, `connected-impact-sweep` report-only analysis, or `adaptive-causal-debugging` / compatibility-fallback investigative lanes.

For mutating work, the planner **names** specialist methods/skills in the topology; `production-flywheel` invokes them under its delivery authorization. `tdd`, debugging repair, migration edits, implementation agents, and integration repair do not become independent delivery owners.

## Mission completion

Planner completion depends on mode:

- **Plan:** topology/plan is complete and ready for human/caller decision.
- **Read-only run:** lane evidence is integrated and required report/owner references are returned.
- **Execution-topology handoff:** a valid topology is bound to the selected authorization and handed to `production-flywheel`, or the exact blocker is reported.

Downstream implementation, commit, verification, publication, and lifecycle completion are not planner completion claims.
