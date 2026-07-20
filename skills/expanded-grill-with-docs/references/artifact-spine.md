# Artifact spine and ownership

Load this reference when writing the durable change record or preparing the final delivery handoff.

## Durable spine

Use the repository's existing OpenSpec structure and local instructions when OpenSpec is active or required. Confirm the installed or repository-local interface before using commands or paths. The shaping lifecycle owns:

1. **Proposal** — why the selected direction should proceed, intended outcome, scope, non-goals, affected users and systems, and major risks.
2. **Delta specifications** — testable changed behavior, invalid states, boundary and error behavior, ownership, and proof surfaces.
3. **Design** — selected mechanism, affected boundaries, domain model, contracts, data and migration shape, runtime behavior, security, operations, observability, and tradeoffs.
4. **Rollout contract** — walking skeleton, wave sequence, entry and advance gates, halt criteria, rollback, cleanup, and accepted risks. Prefer the shared SoT: [`shared/ROLLOUT-CONTRACT.md`](../../../shared/ROLLOUT-CONTRACT.md). Requirements / candidate status prefer [`shared/REQUIREMENTS-LEDGER.md`](../../../shared/REQUIREMENTS-LEDGER.md).

Task generation belongs to the delivery lifecycle. Do not create an implementation queue, ticket backlog, or production plan in this skill.

## Supporting artifacts

Maintain these alongside the durable spine when consequential:

- preflight record;
- uncertainty ledger;
- canonical glossary and domain model;
- ADRs or decision records;
- accepted and rejected alternatives;
- requirements and decision ledger;
- design-option comparisons;
- walking-skeleton contract;
- observability and verification plan;
- readiness and consistency report;
- deferred-items ledger;
- approval record;
- delivery handoff.

## Destination rules

1. Prefer repository-native conventions over invented paths.
2. If OpenSpec or another required system is present, inspect its local instructions and active changes before writing.
3. If the required destination is unavailable or its structure cannot be confirmed, create a clearly marked unsynchronized review bundle in an approved documentation location and block final synchronization claims.
4. Preserve human ownership. A generated status remains DRAFT or BLOCKED until the named decision owner approves it.
5. Keep prototype artifacts separate from the durable change record. Record what uncertainty they tested, the result, and the disposal or quarantine action.

Use `assets/approved-design-rollout-contract.md` when the repository has no equivalent final review shape. Use `assets/change-preflight.yaml`, `assets/uncertainty-ledger.yaml`, and `assets/design-option.md` as adaptable starting structures.
