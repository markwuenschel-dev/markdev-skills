---
name: implementation-plan-contract
description: "Convert one already-selected mission, candidate, issue, or vertical slice into an execution contract — the binding plan an implementer executes. Use between selecting work and starting implementation: when the user asks for an 'implementation plan,' 'execution contract,' or 'plan contract' for selected work, or when another skill needs a selected mission converted into an execution contract."
disable-model-invocation: false
---

# Implementation Plan Contract

One selected mission in, one execution contract out.

This skill is the middle of the chain. Discovery happens upstream: codebase-integrity-audit-loop finds and ranks candidates, connected-impact-sweep maps blast radius. Execution happens downstream: production-flywheel delivers; human-directed-swarm-planner shapes lanes when work runs in parallel. Here, the only deliverable is the contract document; implementation begins after the contract is approved.

A contract is not a roadmap. Every line in it is binding and checkable: named files, a named check, a named command whose output proves the task done. A statement that can't be verified or acted on belongs in Strategic meaning or nowhere.

## Model invocation policy

This skill is model-invokable: invoke it when its role is needed inside the current approved workflow, without waiting for the user to name it.

Model invocation does not expand scope. The active mission, selected candidate, queue item, or implementation contract carries over unchanged — starting a new audit, roadmap, queue, or unrelated cleanup takes a user request. If invoking this skill would change the user's authorization boundary, pause and ask.

## Hard rules

- Exactly one selected mission per contract. Work discovered while planning is recorded as a follow-up, outside scope.
- Every task carries its own verification. A task without a command that can go red is not contract-ready.
- File targets are grounded: read each path in the current baseline before naming it; mark genuinely new files `NEW`.
- Unknown verification commands become a numbered discovery task that precedes the implementation tasks.
- Human-decision categories (the canonical list under connected-impact-sweep's `## Human-decision categories` heading, plus policy/SME calls) are surfaced in Human decisions required, framed as forks with options, never resolved silently inside a task.
- Compatibility shims, thin wrappers, or fake backward compatibility appear in the contract only when explicitly selected as the mission.
- Broad cleanup stays out: adjacent smells the tasks brush against go to follow-ups.

## Inputs

Collect before drafting. A missing input becomes a question to the user or a discovery task — never an assumption:

- the selected mission: candidate card, issue, PRD slice, the user's statement, or one selected candidate from a family candidate ledger (schema in `REPORT-SCORING.md`, codebase-integrity-audit-loop skill folder)
- source report or ledger, if one exists
- current baseline: branch, clean/dirty state, pre-existing failures, and which verification commands are runnable here
- blast-radius map from connected-impact-sweep when the mission touches fan-out surfaces (schemas, public APIs, generated artifacts, fixtures/goldens, cross-language seams, runtime corpus docs) — run or request the sweep if it hasn't run
- constraints, allowed scope, and stated non-goals

## Consuming a candidate ledger

When the selected mission arrives as a ledger candidate with merged lane findings (a `--parallel-report` / Repo Audit Swarm product), the contract preserves them rather than rediscovering them:

- **lane evidence** — file:line observations carry verbatim into sections 2, 6, and 7 (baseline, blast-radius summary, contracts/seams)
- **scoring** — the candidate's scores and `priority_score` inform section 3 and the reasoning in section 12
- **blockers** — `rollup.blocked_by` entries land in section 8 as forks with options, never resolved silently
- **recommended execution mode** — `rollup.execution_mode` is the starting recommendation for section 12; the exception is `blocked-needs-human-decision`, which is **not** a section-12 mode — it sets the contract's **Status** to `blocked pending human decision` and defers the mode choice until the section-8 fork is answered
- **non-goals** — the candidate's boundary defines section 5; sibling candidates in its `duplicate_group` stay out as follow-ups (section 20)

## Blockers before drafting

The contract's quality is capped by unresolved design. Route these out before writing tasks:

- **More than one plausible design shape, no decision made** → run `/expanded-grill-with-docs` (or the project's design process) first; the contract then records the decided shape and the rejected alternatives.
- **One specific uncertainty gates the approach** (does this state model hold? does the API behave as assumed?) → the contract opens with a prototype task that answers exactly that question and is then deleted or absorbed; downstream tasks state which answer they assume.
- **An unresolved human-decision category** → issue the contract with status `blocked pending human decision`, the fork stated with options and a recommendation. Draft everything else so the decision is the only thing standing.

## Contract format

```markdown
# Execution Contract: <mission>

Status: ready | blocked pending human decision

## 1. Executive mission
## 2. Current baseline           <!-- branch, state, what runs today, pre-existing failures -->
## 3. Strategic meaning          <!-- why this mission, in two or three sentences -->
## 4. Scope
## 5. Non-goals                  <!-- explicit; "not broad cleanup" is almost always one -->
## 6. Blast-radius summary       <!-- from the sweep: consumers, mirrors, goldens affected -->
## 7. Contracts / seams involved <!-- authoritative definitions and their owners -->
## 8. Human decisions required   <!-- each a fork: options, tradeoffs, recommendation -->
## 9. Implementation strategy    <!-- the decided shape; rejected alternatives named -->
## 10. Task graph                <!-- IDs in dependency order; parallelizable groups marked -->
## 11. Task-by-task plan         <!-- per Task requirements below -->
## 12. Execution mode            <!-- one of three, with the reason -->
## 13. Required commands         <!-- exact build/test/lint/typecheck invocations -->
## 14. Verification gates        <!-- red/green expectations per phase -->
## 15. Failure codes             <!-- what executors report against -->
## 16. Negative fixtures         <!-- proofs that invalid input/state fails loudly -->
## 17. Review plan               <!-- two axes: spec compliance and code quality -->
## 18. Merge gate                <!-- acceptance commands + conditions to open the PR -->
## 19. Definition of done        <!-- testable: the commands answer done/not-done -->
## 20. Follow-ups                <!-- deferred/out-of-scope work found while planning: adjacent smells the tasks brushed against, sibling duplicate_group candidates, cleanup ruled out of this mission — each a one-liner pointer, not a task -->
```

## Task requirements

Each task in the task-by-task plan carries:

- **ID and dependencies** — `T3 (depends: T1)`
- **Purpose** — one sentence
- **Files** — exact paths, each grounded in the baseline or marked `NEW`
- **Action** — what changes in those files
- **Check** — the test or enforceable check added or updated
- **Verify** — the exact command and the observable result that proves the task done
- **Risk / rollback** — what could go wrong and how to back out

Size each task as a vertical slice: small enough to verify independently, cutting through the layers one behavior touches rather than sweeping one layer horizontally. A task stays inside its named files; anything it brushes against becomes a follow-up.

## Execution mode

Choose exactly one and record the reason in section 12:

- **Sequential** — the default: one agent works the task graph in dependency order.
- **Connected-impact sweep** — when the mission changes contracts, schemas, public APIs, artifact paths, generated outputs, fixtures/goldens, RAG corpus docs, cross-language seams, numerical/CUDA contracts, or deletes reachable code: execution follows connected-impact-sweep, with this contract supplying scope and gates.
- **Swarm** — only when the mission has multiple independent surfaces safely workable in parallel: hand the contract to human-directed-swarm-planner to shape and size the lanes; the contract's gates, failure codes, and merge gate carry over unchanged.

## Failure codes

Section 15 defines what executors report against. Start from these and add mission-specific ones:

```text
FAIL-SCOPE-CREEP — work expanded beyond the contracted mission.
FAIL-PHANTOM-TARGET — a task named a file absent from the baseline and not marked NEW.
FAIL-UNVERIFIED-TASK — a task was reported done without its verify command's output.
FAIL-FAKE-GREEN — a gate claims pass while a required check was skipped or weakened.
FAIL-BURIED-DECISION — a human-decision category was resolved inside a task instead of surfaced in section 8.
```

## Contract gate

Hand off the contract only when every line holds:

- Scoped to the one selected mission; non-goals explicit.
- Every task meets Task requirements — files, check, and verify present on each; every file target grounded.
- Every human-decision ambiguity sits in section 8 as a fork, and none hides inside a task.
- Acceptance commands in the merge gate are runnable in this environment, or a discovery task exists to make them so.
- Every new check has a planned negative fixture — a check never shown failing proves nothing.
- Definition of done is testable: a reader could run the listed commands and answer done or not-done with no judgment call.
- The contract exists as a file in the project's plan location (its convention, else `docs/plans/<mission>.md`), not only in chat.
