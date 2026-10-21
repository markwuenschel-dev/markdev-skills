# Consequential Coverage Lenses

Use these lenses to discover missing consequential decisions before and after major grilling packets. They are a search space, not a mandatory questionnaire. The sweep itself is mandatory on every substantive grill, but a lens produces a user question only when different human answers would materially change the selected direction. Expected implementation diff size is not a reason to skip or shallow the sweep.

## Product intent and boundaries

- exact outcome and observable success;
- explicit non-goals and prohibited behavior;
- actors, beneficiaries, operators, and external consumers;
- acceptable tradeoffs among speed, correctness, cost, ergonomics, and reversibility;
- authority for exceptions and policy overrides.

## Domain semantics and invariants

- canonical terminology and ambiguous synonyms;
- entities, identities, ownership, and lifetimes;
- valid and invalid states;
- invariants that must hold across failures and retries;
- completion, cancellation, abandonment, expiry, and reconciliation semantics.

## Interfaces, data, and contracts

- public versus private boundaries;
- API/schema compatibility and versioning;
- source of truth and derived/cache state;
- persistence, retention, deletion, and auditability;
- idempotency keys, operation identity, uniqueness, and conflict behavior.

## Runtime behavior, parallelism, and concurrency

- ordering guarantees and where ordering is deliberately absent;
- duplicate, simultaneous, stale, and out-of-order work;
- locks, leases, ownership transfer, races, and deadlock/livelock risks;
- fan-out/fan-in, backpressure, queue saturation, admission control, and cancellation;
- retry semantics after ambiguous completion;
- thread/process/agent safety and isolation boundaries;
- consistency expectations under concurrent readers/writers.

## Failure, degradation, and recovery

- partial success and partial failure;
- timeout versus explicit failure;
- retryable versus terminal errors;
- poison work, quarantine, dead-letter, and reconciliation paths;
- degraded modes and safe fallback;
- operator halt, containment, resume, rollback, and cleanup;
- irreversible transitions and disaster recovery assumptions.

## Performance and capacity

- latency/throughput objectives that actually influence design;
- expected and worst credible workload shape;
- burst behavior, concurrency ceiling, and resource contention;
- cost envelopes and scaling constraints;
- whether performance claims require measurement before approval.

## Security, privacy, abuse, and trust

- trust boundaries and privilege model;
- authentication/authorization ownership;
- secret and sensitive-data handling;
- misuse, abuse, replay, tampering, or confused-deputy paths;
- auditability and incident investigation needs.

## Migration and compatibility

- legacy clients, historical data, or old behavior that must survive;
- dual-read, dual-write, shadow, bridge, or atomic-cutover policy;
- reversibility window and irreversible point;
- backfill/reindex/recompute semantics;
- coexistence duration and removal criteria.

## Observability and operations

- what proves healthy, degraded, stalled, or corrupt behavior;
- operator-visible state and diagnostics;
- alerting thresholds and false-positive tolerance;
- manual intervention authority and safeguards;
- runbook-worthy recovery paths and audit trail.

## Verification and proof

- acceptance criteria and invalid-behavior tests;
- unit, integration, end-to-end, property, load, concurrency, fault-injection, or migration proof as relevant;
- evidence required to claim readiness;
- observability needed to prove rollout behavior;
- assumptions that cannot be verified pre-production and how they will be bounded.

## Rollout and lifecycle

- sequencing and blast-radius controls;
- advance, halt, and containment criteria;
- rollback versus roll-forward policy;
- cleanup and removal of transitional machinery;
- long-term owner, revisit trigger, and deprecation path.

## Irreversibility and future constraint

- decisions that permanently constrain public contracts or data shapes;
- lock-in to a vendor, protocol, storage model, or orchestration mechanism;
- one-way migrations or destructive transforms;
- choices expensive enough that uncertainty should be reduced before commitment.

## Coverage rule

The parent should be able to say which relevant lenses were considered and why any apparently important lens produced no user question. Do not expose this whole checklist to the user unless it improves understanding.
