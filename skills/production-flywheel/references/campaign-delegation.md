# Campaign delegation

Use when the caller has authorized a **closed multi-action set** or explicitly requests repeated production execution over an existing authorized set.

Flywheel remains the canonical execution owner. `production-campaign` is a subordinate scheduler/orchestrator; it does not receive lifecycle authority.

## Handoff

Pass only closed references/constraints:

- repository revision;
- action graph reference + source graph hash;
- action-set id / exact authorized action ids;
- maximum total actions;
- campaign publication policy;
- design policy;
- validation policy;
- worker budgets and optional maximum integration-epoch size;
- planned-impact set/reference when available;
- soft-stop/control reference.

Before delegation, call `production-campaign/plan-compiler.js#compilePlan` with the closed tasks. Every task declares `task_id`, `dependencies`, `read_set`, `write_set`, `resource_keys`, `risk`, `acceptance_commands`, and `expected_artifacts`. Bind both `compiled_plan_sha256` and `planned_impact_set_sha256` into authorization v2 with `independent_verification_policy: fresh-per-cohort-with-per-action-verdicts`, then call `CampaignRuntime.run(compiledPlan, authorizationV2)`.

Connected Impact is optional admission evidence, not a prerequisite. When available, Flywheel calls `connected-impact-sweep/impact-gate.js#evaluateImpactGate(input)` before campaign admission and binds its repository revision to the plan:

- `skip`: compile and admit with the declared task-local acceptance commands; do not invoke a separate impact sweep.
- `light`: add focused validation/review for `affected_components` that remain inside the authorized read/write scope.
- `full`: require the full Connected Impact workflow before campaign admission and bind its evidence reference into the Flywheel receipt.

Any affected component outside the closed authorization returns to reconciliation. The gate result does not authorize work, add actions, decide risk, populate undeclared read/write sets, or become a scheduler. Missing optional evidence does not block an otherwise complete plan; malformed or stale evidence that was supplied fails admission.

The campaign may ask `human-directed-swarm-planner` to derive missing topology/planned-impact declarations **after authorization is fixed**. Unknown impact remains fail-closed and may force single-action admission.

## Return

Campaign returns a closed campaign receipt with per-action worker receipts, verification references, integration-epoch receipts, unresolved/adjacent findings, and terminal classification. Flywheel validates the receipt against the authorization before returning lifecycle evidence upward.

Only `complete` with a current fresh Independent Verification PASS for every action plus a fresh canonical `integrated_iv` bound to the recomputed final Git tree is completion. Exact cached command PASS receipts remain producer evidence and cannot be promoted into IV.

## Hard rules

- No action outside the authorized set can enter the campaign.
- `max_total_actions` is a hard ceiling, not a target.
- `max_parallel_workers` is a capacity ceiling, not a promise to fill slots.
- `max_epoch_actions` may exceed worker count so the executor can refill free workers from an already-admitted, conflict-safe epoch; it may never exceed the closed authorized set.
- An integration epoch is a hard reassessment boundary. No successor epoch is admitted until the current epoch's required verification/integration receipt concludes.
- A worker finishing early may take another READY assignment in the same admitted epoch; this is work-stealing/refill, not a new action claim.
- Newly discovered consequential work returns to RECONCILE; it is never silently action N+1.
