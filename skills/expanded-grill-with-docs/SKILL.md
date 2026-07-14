---
name: expanded-grill-with-docs
description: "Relentless interview to shape an idea or design while writing glossary and ADR docs as decisions crystallize. Use when the user wants to grill a plan, stress-test thinking, pin domain language, produce ADRs/CONTEXT, or runs /expanded-grill-with-docs. Default design lane for production-flywheel."
disable-model-invocation: false
---

# Expanded grill with docs

Shape an idea until you and the user share an understanding — and **capture durable language and decisions in the target project** as you go.

This skill composes:

1. **Grilling** — one question at a time, recommended answer each time, walk the decision tree.
2. **Domain modeling** — challenge terms, update `CONTEXT.md`, offer ADRs only when warranted.
3. **Exit gate** — explicit shared understanding before any implementation skill runs.

It is **not** a delivery loop. No production feature work, no PR, no multi-item queue.

## When to use

- User wants to stress-test a plan, product idea, architecture fork, or ambiguous design.
- Flywheel design-lane gate A (default) for a selected queue item.
- Domain language is fuzzy and must stabilize before tickets or code.

## When not to use

| Situation | Route instead |
| --- | --- |
| User already selected ship work | `production-flywheel` |
| Repo health / integrity candidates | `codebase-integrity-audit-loop` |
| Known mission needs parallel lanes | `human-directed-swarm-planner` |
| Unsure | `loop-router` |

## Procedure

### 1. Frame the session

State in one short block:

- topic under grill
- what "done" means (shared understanding + docs)
- what is out of scope (implementation, PR, broad cleanup)

### 2. Grill (one question at a time)

Interview relentlessly about every aspect until shared understanding.

- Walk each branch of the decision tree; resolve dependencies one-by-one.
- For **each** question: provide your **recommended answer** with brief reasoning.
- Ask **one question at a time**. Wait for the answer. Multiple simultaneous questions are forbidden.
- If a *fact* is in the environment (repo, tools, files), look it up — do not ask.
- *Decisions* belong to the user — put each one to them and wait.

### 3. Domain capture (inline, not batched)

While grilling, actively maintain the domain model:

- Challenge terms against existing `CONTEXT.md` / glossary.
- Propose precise canonical terms for fuzzy language.
- Stress-test relationships with concrete scenarios.
- Cross-check claims against code when a codebase is available; surface contradictions.
- When a term is resolved, update `CONTEXT.md` **immediately** (glossary only — no implementation detail).
- Offer an ADR only when **all three** hold:
  1. hard to reverse
  2. surprising without context
  3. result of a real trade-off

If `domain-modeling` skill files are available (`CONTEXT-FORMAT.md`, `ADR-FORMAT.md`), follow those formats. If not, use the minimal templates below.

#### Minimal CONTEXT entry

```markdown
## <Term>

**Definition:**
**Also known as:** (optional)
**Not the same as:** (optional)
```

#### Minimal ADR skeleton

```markdown
# ADR NNNN: <title>

## Status
Proposed | Accepted | Superseded

## Context

## Decision

## Consequences
```

### 4. Decision ledger (session artifact)

Keep a running list (in chat or a scratch doc the user asked for):

| Decision | Choice | Rejected alternatives | Captured where |
| --- | --- | --- | --- |
| … | … | … | CONTEXT / ADR / deferred |

Unresolved forks stay visible. Do not pretend consensus.

### 5. Shared-understanding gate

Before ending or handing off to implementation:

```markdown
## Shared understanding

**Problem:**
**Chosen direction:**
**Explicit non-goals:**
**Open questions (must be empty or deferred with owner):**
**Docs written/updated:**
**Ready for:** none | tickets | flywheel item | audit candidate — (user confirms)
```

**Do not implement** until the user confirms shared understanding (and, if they want delivery, which skill next).

## Model invocation policy

Model-invokable when another authorized skill (especially `production-flywheel` design lane A) requires grilling. Do not self-start a grill on a shipping queue without the design-lane context.

## Hard rules

- One question at a time.
- Recommended answer on every question.
- Facts from the environment; decisions from the user.
- Capture durable terms/decisions in the **project**, not only in chat.
- No production code changes under this skill.
- On completion, if the user wants delivery, hand off via [CAPABILITY-MAP.md](../../CAPABILITY-MAP.md) (usually `production-flywheel` or tickets) — do not silently start coding.
