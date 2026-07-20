# Readiness and consistency gates

Load this reference before the final readiness verdict and again before human approval.

## Requirements quality gate

Pass only when:

- critical questions are resolved or explicitly accepted by the human owner;
- assumptions are visible and owned;
- requirements are observable and testable;
- invalid states, boundary behavior, and error behavior are specified;
- non-goals and exclusions are unambiguous;
- system and human owners are named;
- performance, security, privacy, migration, operations, and compatibility expectations are explicit where applicable;
- manual-only criteria are justified;
- each requirement maps to a proof surface;
- another delivery agent can proceed without inventing requirements.

Use installed Spec Kit clarification and checklist procedures when their contracts match. Use cross-artifact analysis after the proposal, specifications, and design stabilize. Do not let a tool's output replace human ownership or repository evidence.

## Walking-skeleton gate

The walking skeleton is the smallest integrated path that proves both architecture and user-visible outcome through real boundaries. It identifies real adapters, integrations, data flow, minimum UI or API, observability, and verification. Reject a skeleton made only of disconnected stubs, mocks that bypass the risky boundary, or components that cannot prove the selected design.

## Rollout-wave contract

Every wave records:

- ID and objective;
- included and excluded scope;
- target users or systems;
- entry criteria;
- verification and observability;
- advance and halt criteria;
- rollback actions;
- cleanup obligations.

A rollback claim is valid only when the design preserves a real reversal mechanism or explicitly states that rollback is impossible and defines containment instead.

## Cross-artifact analysis

Compare the proposal, requirements, domain model, ADRs, design, rollout contract, walking skeleton, verification plan, and non-goals. Find and resolve:

- contradictory requirements;
- design elements with no requirement;
- requirements with no design coverage;
- rollout promises unsupported by observability;
- rollback claims unsupported by implementation shape;
- inconsistent terminology;
- missing ownership;
- untestable acceptance criteria;
- accidental compatibility promises;
- stale assumptions;
- unresolved decisions hidden inside later work.

## Approval gate

Only the human decision owner may set the final status to `APPROVED DESIGN/ROLLOUT CONTRACT`. Approval covers requirements, architecture direction, migration direction, rollout, rollback, non-goals, and unresolved accepted risks. Record the approver, date or revision marker, accepted risks, and any review triggers.
