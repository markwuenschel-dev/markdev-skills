# Grilling Question Craft

The interview is the primary product. A good question does not merely gather preference; it exposes a consequential decision boundary, gives the user enough context to decide, and carries an expert recommendation whose reasoning is inspectable.

## Quality standard

A strong grilling question has eight properties:

1. **Decision leverage** — materially different answers change the contract, architecture, behavior, rollout, or proof burden.
2. **Specificity** — the exact ambiguity is named rather than hidden behind a broad topic.
3. **Discriminative power** — the options lead to meaningfully different consequences.
4. **Evidence grounding** — known facts and assumptions are used instead of making the user rediscover them.
5. **Downstream unlock** — the question names what can be decided or derived afterward.
6. **Recommendation quality** — one concrete default is proposed unless evidence truly forbids a default.
7. **Rationale quality** — the recommendation is justified by a mechanism and consequence, not a slogan.
8. **Answerability** — the user can answer directly without reconstructing hidden technical context.

## The sharpening move

When a candidate sounds broad, ask: **what specific ambiguity underneath this topic would force two different designs?** Ask that instead.

Weak:

> How should retries work?

Sharper:

> If a worker times out after submitting a write but before receiving acknowledgment, may a retry issue the write again immediately, or must the system first establish whether the original operation committed?

Why sharper: it identifies the ambiguous-completion state that determines idempotency, operation identity, and reconciliation.

Weak:

> Do we need backwards compatibility?

Sharper:

> Must clients on the current public API continue to function without modification during the migration, or may the rollout require a coordinated client cutover?

Why sharper: “compatibility” is converted into an explicit consumer contract with migration consequences.

Weak:

> What should happen on errors?

Sharper:

> When one item in a 100-item batch fails validation, should the batch be atomic, partially commit valid items with per-item results, or quarantine the entire batch for operator review?

Why sharper: the question defines state-transition semantics and the unit of atomicity.

## Recommendations must do real work

A recommendation is not a decorative label. It should reduce user effort by bringing expert judgment to the decision.

Weak rationale:

> Recommend B for reliability.

Strong rationale:

> Recommend B because the caller cannot distinguish “failed before commit” from “committed but response lost.” A durable operation record makes retries and reconciliation deterministic, whereas blind replay turns duplicate side effects into a normal recovery condition.

A strong rationale usually names at least one concrete downstream consequence such as:

- additional persistent state;
- a public compatibility promise;
- inability to roll back after a certain point;
- duplicate or lost work under retry;
- operator burden during recovery;
- proof complexity;
- concurrency races or ordering constraints;
- data migration cost;
- observability needed to detect failure.

## Options should be genuinely different

Do not offer cosmetic variants.

Bad:

- A. Retry automatically.
- B. Automatically retry after a delay.
- C. Retry automatically with backoff.

These may all represent the same policy choice.

Better:

- A. At-most-once: never replay ambiguous work automatically.
- B. At-least-once: replay and require idempotent effects.
- C. Durable reconciliation: record operation identity and determine committed state before replay.

Options need not be exhaustive. Include an escape hatch such as “modify” when the decision space is open.

## Split compound decisions

Bad:

> Should we keep legacy clients and use a dual-write migration with a 30-day rollback window?

This hides three decisions: compatibility policy, migration mechanism, and rollback duration.

Better:

> Q1 — Must legacy clients remain compatible during migration?
>
> If YES → Q1a — Is a bounded dual-support window acceptable, or is indefinite compatibility required?

The migration mechanism can then follow once compatibility is settled.

## Ask for policy, not implementation trivia

Weak:

> Should this use a ThreadPoolExecutor with 16 workers?

Better:

> Should work execute concurrently up to a bounded per-process limit, and must task ordering be preserved within the same entity/key?

The implementation can choose ThreadPoolExecutor, async workers, agents, or another mechanism later unless the mechanism itself changes the contract.

Implementation-specific questions are valid when the choice is intentionally part of the selected direction or creates an irreversible constraint.

## Ask the user only what the user owns

Do not ask:

> Which table currently stores operation status?

if repository inspection can answer it.

Ask instead:

> The repository currently treats `operations` as the durable source of truth. Do you want that authority preserved, or should the new orchestration layer become authoritative for lifecycle state?

The fact is supplied; the authority choice is asked.

## Use evidence to make the question denser, not longer

Include only evidence needed to understand the choice.

Good:

> Current callers retry after 30 seconds, while the write path has no idempotency key. If a response is lost after commit, should duplicate prevention become a hard server guarantee or remain a caller responsibility?

This is more useful than pasting the entire retry implementation.

## Interrogate boundaries and failure paths

Many weak interviews spend all their questions on the happy path. For every central mechanism, consider:

- what counts as complete;
- what can happen twice;
- what can happen out of order;
- what happens when only half completes;
- who owns recovery;
- what is irreversible;
- what proves the system is healthy;
- what the operator can halt or override.

Only ask the questions that survive the consequentiality test.

## Example set

### Completion semantics

Weak:

> When is a job done?

Strong:

> Should a job become `complete` when all side effects are durably committed, when the orchestrator has merely dispatched them, or only after downstream acknowledgment is recorded?
>
> Recommended: after all required durable effects and acknowledgments are recorded.
>
> Rationale: declaring completion at dispatch creates a state where the control plane reports success while downstream work can still fail invisibly. Waiting for durable acknowledgment increases latency but makes completion a trustworthy invariant for retries, audit, and operators.

### Concurrency ownership

Weak:

> Can multiple workers run at once?

Strong:

> May two workers process different operations for the same customer concurrently, or must work be serialized per customer while remaining parallel across customers?
>
> Recommended: serialize only within the smallest key whose invariants can conflict, and allow parallelism across independent keys.
>
> Rationale: global serialization wastes throughput, while unconstrained same-key concurrency risks write races and order-dependent state. Key-scoped serialization preserves local invariants without giving up system-wide parallelism.

### Cancellation

Weak:

> Should cancellation be supported?

Strong:

> Once an operation has begun committing external side effects, should cancellation mean “stop starting new work and reconcile what already happened,” or must the system attempt compensating actions to restore the pre-operation state?
>
> Recommended: define cancellation as halt-plus-reconciliation unless every side effect has a proven safe compensating action.
>
> Rationale: promising rollback where external actions are not reversible creates false guarantees. Halt-plus-reconciliation makes partial completion explicit and testable.

### Migration

Weak:

> How do we migrate?

Strong:

> During migration, must old and new readers observe identical data continuously, or is a bounded period of eventual convergence acceptable?
>
> Recommended: require identical reads only for externally visible contract fields; permit bounded convergence for internal derived state.
>
> Rationale: demanding lockstep equivalence for all internal state can force unnecessary dual-write complexity, while relaxing externally visible behavior risks breaking clients.

### Source of truth

Weak:

> Where should status live?

Strong:

> When the orchestration ledger and downstream system disagree about operation status, which one is authoritative for deciding whether work may be retried?
>
> Recommended: the orchestration ledger should own operation intent and attempt identity, while downstream durable state is reconciled before replaying ambiguous side effects.
>
> Rationale: blindly trusting either side alone can duplicate work or strand committed operations. The split authority makes retry decisions explicit and auditable.

### Rollout halt

Weak:

> When should rollout stop?

Strong:

> Which observed condition should automatically halt expansion: error-rate regression, reconciliation backlog growth, latency breach, data-integrity mismatch, or only operator judgment?
>
> Recommended: define automatic halt for integrity mismatches and runaway reconciliation backlog, with operator-controlled halt for softer latency/error regressions.
>
> Rationale: integrity failures compound with traffic and should not wait for human interpretation; softer service-level regressions often need contextual judgment to avoid unnecessary rollback.

### Proof burden

Weak:

> How should we test concurrency?

Strong:

> Is deterministic proof of same-key serialization required before rollout, or is probabilistic stress testing sufficient if production detects invariant violations?
>
> Recommended: deterministic invariant tests plus targeted stress/fault injection for scheduler races.
>
> Rationale: stress alone can miss rare interleavings, while deterministic invariant tests establish the contract and stress testing explores integration behavior the model cannot enumerate.

### Ownership

Weak:

> Who handles failures?

Strong:

> When automatic retries are exhausted, should the item enter an operator-owned recoverable state, a developer-owned incident state, or a terminal customer-visible failure?
>
> Recommended: operator-owned recoverable state for known reconciliation paths; escalate to developers only when invariants or tooling fail.
>
> Rationale: making every exhausted retry a developer incident does not scale, while terminal failure without recovery ownership strands work the system still understands how to repair.

### Retention

Weak:

> How long should logs be kept?

Strong:

> What minimum history must remain available to prove whether an ambiguous operation committed and to investigate duplicate side effects after the normal retry window has expired?
>
> Recommended: retain operation identity and terminal outcome longer than the maximum retry/reconciliation horizon; retain verbose diagnostic payloads for a shorter operational window.
>
> Rationale: the durable identity record is part of correctness, while verbose logs are mainly diagnostic and can be governed by cost/privacy constraints.

### User-visible semantics

Weak:

> What should users see while processing?

Strong:

> If an operation has committed locally but downstream confirmation is delayed, should the user see `success`, `processing`, or an explicit `reconciling` state?
>
> Recommended: expose `reconciling` when the ambiguity can affect user action.
>
> Rationale: reporting success can cause users to proceed on a result that may still fail; reporting generic processing hides that the system is specifically resolving uncertain completion.

## Question critic checklist

Before a question reaches the user, ask:

- Is there a sharper ambiguity underneath this wording?
- Could repository evidence answer this instead?
- Would at least two plausible answers produce different behavior or architecture?
- Are the options actually distinct?
- Does the recommendation commit to a default?
- Does the rationale explain a mechanism and consequence?
- What downstream decisions, requirements, or branches does this answer settle or unlock?
- Is this secretly more than one decision?
- Is the user being asked for implementation trivia rather than policy or contract?
- Would an adversarial reviewer ask a stronger failure, concurrency, migration, or proof question here?

If the answer exposes a flaw, rewrite the question before presentation.
