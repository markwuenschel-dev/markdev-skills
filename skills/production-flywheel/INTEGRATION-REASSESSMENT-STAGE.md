# Integration reassessment (Stage 15)

This reference applies only after `--action-graph` execution has produced durable per-action receipts. It is not an assessment, graph-authoring, action-selection, publication, or lifecycle-transition stage.

## Authority

`production-flywheel` owns the authorized production integration boundary. It may invoke the shared reassessment mechanism only for the exact graph reference, cohort reference, repository revision, and authorization already admitted to the active delivery. It returns one immutable receipt or finding reference to the invoking caller.

The execution adapter must not:

- choose a treatment for a finding;
- mint, reshape, requeue, or claim an action;
- change a participant action's status, verdict, or verification requirement;
- promote a candidate, expand the authorization, push, open a PR, or merge.

A finding blocks the current campaign and returns to the invoking caller. A subsequent RGO/graph projection requires separate explicit reconciliation, and any resulting action graph requires a new or amended exact Flywheel authorization.

## Cohort and trigger

Reconstruct the complete cohort through `shared/action-integration-reassessment` from immutable action references. Run when either:

- the exact cohort membership or a participant head revision differs from the last concluded receipt for that cohort; or
- Flywheel requests reassessment for the named authorized cohort.

The trigger is cohort-based, never a guessed delta. A Stage 15 request fails closed for a missing graph reference, missing action receipt, stale repository revision, unresolved lease, in-flight participant, or cohort hash mismatch.

## D7 wave boundary

For `--parallel N`, every claimed batch retains its own action ids and complete-member cohort. When all batch members are terminal, the exact complete-member cohort must receive a concluded wave-boundary reassessment receipt before it receives candidate-completion credit or releases dependent work. A failed member is recorded separately and is not silently treated as complete.

The D7 receipt is additional to the general Stage 15 cohort receipt. Neither receipt creates a lifecycle transition or authorizes execution.

## Freeze and lease

Apply the canonical verification-freeze invariant in
[ACTION-GRAPH-MODE.md](ACTION-GRAPH-MODE.md#canonical-verification-freeze-invariant): an
in-flight action's named revision, worktree, branch, and verification scope remain immutable until
its verifier returns. A D7 peer may proceed only in a separately isolated worktree with disjoint
declared resources and a distinct packet.

The integration lease protects the reassessment claim path. Do not start reassessment while a live lease or an in-flight cohort participant exists. Do not start or credit dependent work until the reassessment result is durable. The lease is not a substitute for the action-local freeze.

## Return contract

Return an opaque immutable reference only:

```json
{
  "owner": "action-integration-reassessment",
  "stage": 15,
  "cohort_ref": { "artifact_id": "", "sha256": "", "repository_revision": "" },
  "receipt_ref": { "artifact_id": "", "sha256": "" },
  "outcome": "clean | finding | blocked"
}
```

`clean` is evidence that Flywheel may continue within the same closed authorization, not a completion or publish claim. `finding` names the immutable finding reference and blocks the campaign for caller disposition. `blocked` names the failed precondition. Every outcome leaves participant verdicts and status unchanged.

## Verification

Use `shared/action-integration-reassessment` as the sole mechanism owner. Its package-local checks prove lease behavior, exact-cohort reconstruction, conflict detection, and D7 wave-boundary gating. Flywheel records the immutable return reference and reports it to the invoking caller.
