# Rollout contract

Canonical handoff shape before multi-task implementation or swarm lane fan-out.

Use when:

- audit loop Stage 7 needs a plan contract
- planning swarm must freeze execution shape
- flywheel has a slice that is more than a single obvious commit

If external `implementation-plan-contract` is installed, prefer its full format and keep this file as the **minimum compatible subset**.

## Contract template

```markdown
# Rollout contract: <title>

## Mission
One sentence. Human-selected. No scope expansion.

## Boundary
**In scope:**
**Out of scope:**
**Non-goals:**

## Current baseline
Commands and results that prove starting state (or why baseline cannot run).

## Desired end state
Observable behavior / integrity rule / check that must exist.

## Slice / tasks
Ordered list. Each task:
- description
- verification step
- files/surfaces likely touched

## Execution mode
sequential | subagent-driven | connected-impact-sweep | swarm

## Verification
**Commands:**
**Acceptance criteria:**
**Negative fixtures / adversarial checks:**

## Human decisions
List any forks from HUMAN-DECISIONS.md already resolved (with answers) or still open (blockers).

## Capture plan
Where durable knowledge lands (CONTEXT, ADR, check docs, report ledger).

## Definition of done
Bullets that are objectively checkable.

## Explicit success statement
One sentence the agent can restate after ship.
```

## Gates

- Mission is human-selected or maps 1:1 to a selected ledger/queue item.
- Out of scope is non-empty when ambiguity is high.
- Every task has verification.
- Human-decision blockers are empty **or** explicitly authorized with recorded answers.
- No broad cleanup tasks.

## Anti-patterns

- Contract that restates the whole roadmap
- Tasks without verification
- "Also clean up X" without a new selected item
- Shipping without acceptance criteria
