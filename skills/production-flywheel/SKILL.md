---
name: production-flywheel
description: "Canonical mutating delivery owner for already-authorized repository work. Use for one authorized item/action or an authorized action graph. It owns production policy, mutation, verification boundaries, integration, and policy-gated publication. Multi-action scale delegates downward to production-campaign; concurrency mechanics never acquire lifecycle or scope authority."
---

# Production Flywheel

`production-flywheel` is the **canonical mutating delivery owner**. Keep this entrypoint small: it defines authority, invariants, routing, and terminal behavior. Detailed mechanics live in conditional references and subordinate capabilities.

## Authority

Flywheel owns authorized production delivery: worktree/branch isolation, mutating implementation, producer review, independent-verification boundaries, integration/reconciliation, commits, and policy-gated push/PR behavior.

`human-directed-swarm-planner` owns **execution topology** only; Flywheel consumes and validates that topology before any mutation.

It does **not** own assessment, candidate selection, remediation-graph construction, human decision meaning, merge, or automatic publication. The explicit caller's authorization fixes mission and scope; Flywheel may not infer or expand either.

Read [references/authority-boundaries.md](references/authority-boundaries.md) only when delegation/topology ownership is material.

## Activation

Require an explicit authorized local delivery item or immutable action-graph/action-set reference. Missing authorization is `MISSING_DELIVERY_AUTHORIZATION`; do not scan for replacement work.

Choose one mode:

- **Manual queue** — load [references/queue-and-preflight.md](references/queue-and-preflight.md) and [references/manual-delivery.md](references/manual-delivery.md).
- **Legacy `--graph`** — explicit spine-v3 compatibility only; load [GRAPH-MODE.md](GRAPH-MODE.md).
- **Canonical `--action-graph`** — load [ACTION-GRAPH-MODE.md](ACTION-GRAPH-MODE.md).
- **Campaign delegation** — when a closed authorization covers multiple production actions or the caller explicitly requests repeated/scaled execution, load [references/campaign-delegation.md](references/campaign-delegation.md) and delegate scheduling to `production-campaign`. Flywheel remains the execution authority.

Single-action behavior remains the default. Campaign support never converts an unselected finding into authorized work.

An immutable `integrity-candidate-handoff@1` from `codebase-integrity-audit-loop` is admitted only through `integrity-handoff-admission.js#admitIntegrityHandoff`. That executable consumer authenticates the authorization HMAC against `PRODUCTION_FLYWHEEL_AUTHORITY_KEY_ID` and `PRODUCTION_FLYWHEEL_AUTHORITY_KEY`, derives current repository identity and revision from Git, compiles exactly one Campaign action, and binds the resulting delivery receipt to the handoff hash. A self-consistent producer handoff cannot mint authority. Use `executeIntegrityHandoff` for the producer-to-execution path; prose, a ledger pointer, or an IV-shaped object cannot substitute for this admission.

## Startup latency and staged preflight

Keep the first interactive gate fast without weakening delivery gates.

- **Fast admission (before the first report, selection, or design question):** validate the explicit authorization or supplied selected candidate/action graph carrying the required authorization envelope, resolve the mode, and confirm only the next required capability is available. When a valid approved contract or already-selected candidate is supplied, treat it as the queue, skip report generation, and go directly to its selected-candidate summary and A/B design-lane question. An invalid, stale, or unfenced supplied selection fails closed as `MISSING_DELIVERY_AUTHORIZATION`; it never triggers replacement work.
- **Deep readiness (before any mutation):** after the queue exists and the current item's lane/scoping choice is known, run the full active-route dependency, independent-verification, publish-capability, and per-item repository checks. Issue independent read-only probes concurrently where the runtime permits and return one compact receipt.
- **Optional Connected Impact admission:** when the caller supplies a base revision, target revision, exact changed-path metadata, and dependency evidence, or the active route already requires impact analysis, call `connected-impact-sweep/impact-gate.js#evaluateImpactGate(input)`. The gate recomputes the Git diff and semantic patch signals; caller signals cannot downgrade it. This is not a global prerequisite. `skip` adds no sweep; `light` adds affected-component validation/review inside the authorized scope; `full` requires the full Connected Impact path before admission. Any affected component outside the closed authorization returns to reconciliation rather than expanding scope.
- Do not load or probe conditional skills for branches the user has not selected. This is staged loading, not a waiver: a later branch must pass its capability gate before that phase begins. Missing capabilities remain hard blockers.

### Fast-path authorization provenance

An approved implementation contract or action-set may replace the report/selection exchange only when its immutable authorization envelope records: `authorization_ref`, issuer (`user` or lifecycle caller), mission and scope, exact candidate/action IDs, lifecycle status plus expiry/fencing, permitted mutation, and publication policy. A current user selection of an item/queue is authorization only when those same mission, scope, item, and policy facts are recorded. A report recommendation, design approval, stale pointer, or unfenced candidate is not authorization; missing provenance remains `MISSING_DELIVERY_AUTHORIZATION`.

## Non-negotiable invariants

- Scope/authorization is fixed before topology or mutation.
- `human-directed-swarm-planner` may propose topology and planned impact only; it never claims work or mutates the repository.
- `production-campaign` may schedule only the closed authorized action set; it cannot change mission, graph, candidate selection, completion meaning, or publication policy.
- `agent-executor-pool` is mechanism only. Spare capacity never creates work.
- `production-action-worker` receives exactly one fenced assignment and cannot select, enqueue, integrate, publish, or recursively create another mutating executor.
- Every selected item/action crosses the design gate. `expanded-grill-with-docs` remains the default interrogation path; campaign mode may batch shared questions under the policy in `production-campaign`.
- Use `tdd` for new behavior; characterize before behavior-preserving refactors; route unexplained red/flaky/slow behavior to `adaptive-causal-debugging`.
- Producer review is not independent verification. A producer never grades its own work.
- Repair only the reported gap under the existing authorized predicate. Consequential scope change returns to the caller/human boundary.
- `local_only`, `push_allowed`, and `pr_allowed` are distinct. No policy permits merge; publication is never automatic.
- Focused/new-change validation is the default during execution. Full-suite regression runs occur only when explicitly requested or required by a declared hard gate.
- A soft stop drains the currently admitted execution epoch and required verification/integration boundary, then refuses successor admission.

## Parallelism rule

Concurrency is **opportunistic; serialization is semantic**. Parallelize when dependency readiness, planned/observed impact, resource permits, isolation, risk policy, and worker budgets all allow it. Serialize only for a real dependency, shared/exclusive resource, integration boundary, human decision, publication boundary, or fail-closed uncertainty.

Cross-action admission remains governed by `shared/action-graph-execution`. Internal lane topology may use `human-directed-swarm-planner`; campaign execution uses `production-campaign` + `agent-executor-pool` without changing canonical action-graph truth.

## Lifecycle return

Return a compact closed receipt to the invoking caller: mode, item/action or campaign identity, authorization/action-set reference, topology/campaign reference when used, durable execution references, independent-verification reference(s), integration/Stage-15 reference when required, publication policy observed, terminal classification, and blocker/failure code. Never embed foreign owner payloads or claim authority beyond the supplied authorization.

## Conditional references

- [references/authority-boundaries.md](references/authority-boundaries.md) — delegation/ownership map.
- [references/campaign-delegation.md](references/campaign-delegation.md) — multi-action campaign handoff and return.
- [references/queue-and-preflight.md](references/queue-and-preflight.md), [references/manual-delivery.md](references/manual-delivery.md), [references/queue-advance.md](references/queue-advance.md) — manual mode.
- [GRAPH-MODE.md](GRAPH-MODE.md) — legacy graph compatibility.
- [ACTION-GRAPH-MODE.md](ACTION-GRAPH-MODE.md) — canonical action graph, atomic claims, D7/D8 concurrency.
- [INTEGRATION-REASSESSMENT-STAGE.md](INTEGRATION-REASSESSMENT-STAGE.md) and [references/action-graph-stage15-contract.md](references/action-graph-stage15-contract.md) — integration reassessment.

## Stop conditions

Stop without unauthorized mutation on missing/invalid authorization, scope-expanding topology, unknown required capability provenance, conflicting runtime reservation, failed hard gate, unresolved consequential human decision, unavailable required verifier, invalid/stale campaign fencing, soft-stop boundary, or runtime transaction rejection. Report the exact code/reference and safe resume condition.
