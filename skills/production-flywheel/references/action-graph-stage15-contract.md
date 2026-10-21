## Stage 15 — Integration reassessment (`--action-graph` only)

Applies only under `--action-graph` (*Operating modes*) — manual mode and `--graph` mode's
candidate-shaped ledgers have no action-graph cohort to reassess and are unaffected by anything
below. Read [INTEGRATION-REASSESSMENT-STAGE.md](../INTEGRATION-REASSESSMENT-STAGE.md) in full before
this stage first fires; in outline:

1. At every frontier recompute (Stage 14, or an explicit user request), also reconstruct the
   complete integration cohort — every currently `complete`, non-superseded action aimed at the
   same integration target — via `shared/action-integration-reassessment`'s `materializeCohort`.
   **Cohort-based, never delta-based**: the trigger is "the reconstructed cohort's membership or
   any participant's head sha changed since the last run for this `cohort_hash`," never "check the
   action(s) that just finished." See [ACTION-GRAPH-MODE.md](../ACTION-GRAPH-MODE.md) `## Advancing
   the frontier` for where this check sits relative to ordinary frontier recomputation.
2. Never begins while a live `integration_lease` exists or any action is `active`/`verifying` —
   the lease (`beginIntegrationLease`/`heartbeatIntegrationLease`/`concludeIntegrationLease`/
   `recoverStaleIntegrationLease`, `shared/action-graph-execution/state-store.js`) is a distinct
   mechanism from the freeze rule above: the freeze rule guards one action's Stage 11 round; the
   lease guards this whole cohort-level run's claim path, acquired and released under a short
   critical section rather than held for the run's duration. See
   [INTEGRATION-REASSESSMENT-STAGE.md](../INTEGRATION-REASSESSMENT-STAGE.md) `## Composing with the
   freeze rule and the lease`.
3. Merges the cohort into a disposable `integration/<run_id>` worktree, runs the union of every
   participant's declared gates plus the cross-branch ratchet, and records any
   `IntegrationFinding`. **An open finding holds the affected candidate(s) open — via
   `coverage_roles`/`candidate-resolution.js` rule 5 — without touching any implicated action's own
   `status` or its own `verdict.json`.** Nothing here re-verifies a participant's own isolated
   round; the Stage 15 gate id (`integration::<run_id>`) is recorded like any other gate receipt
   and is never added to any participant's own `verification_requires`.
4. A human elects a treatment per open finding (`sequence`, `reconciliation-action`,
   `merge-actions`, `revise-one`, `supersede`, `escalate-human-decision`) — never the flywheel
   session on its own. For treatments that authorize new implementation work
   (`sequence`/`revise-one`/`reconciliation-action`, and `merge-actions` in its rarer synthetic-
   survivor shape), this stage mints the actual new/reshaped action node the applied treatment's
   `action_lineage` entry names — composing `ActionGraphVerify.validateReshape` and
   `verifyExecutionGraph` (both already exported by `shared/action-graph-execution`) rather than
   inventing a new primitive. See
   [INTEGRATION-REASSESSMENT-STAGE.md](../INTEGRATION-REASSESSMENT-STAGE.md) `## Treatment
   application: minting or reshaping a real action node` for the full mechanism, per treatment
   kind, with file:line citations into both the D6b machinery it calls and the D6d `applyTreatment`
   it composes with.
5. A minted action re-enters the queue as an entirely ordinary `--action-graph` item — its own
   preflight, its own design-lane gate, its own Stage 11 round, its own PR. **This is the
   reconciliation this family's existing rule requires, restated plainly, not contradicted:** the
   "batching does not batch verification" rule (above, in Stage 13's *Ship* section) already
   establishes that every item computes its own verdict at its own revision and never has an
   earlier item's verdict recomputed for it — see specifically "Recomputing an earlier item's
   verdict at group-PR time will always block, and blocking there would be a false negative." An
   integration reassessment honors the identical principle one level up: it computes a **brand-new
   verdict about the combined state**, at the reassessment's own revision (the integration head, or
   a minted action's own new branch) — it never recomputes, reopens, or overwrites what an earlier,
   independent Stage 11 round already proved for any participant action on its own. The two rules
   are the same rule, applied at two different granularities (an item inside a shipped batch; an
   action inside a reassessed cohort), not two rules in tension.

Gate:
- A Stage 15 run only fires when the cohort trigger condition holds, or on an explicit user
  request — never on a bare delta of "actions that finished since last time."
- No claim is attempted while a live `integration_lease` blocks it; `claimAction`'s refusal is
  respected, not worked around.
- Every open finding is reported, never dropped, with the candidate(s) it blocks named.
- No treatment is applied without an explicit human election.
- A minted action node passes `verifyExecutionGraph` clean before being persisted; a mint that
  fails re-verification is reported as a blocker, never silently retried into a different shape.
- No participant action's own `verdict.json`, `status`, or completion gate is ever edited by this
  stage — only new state (`integration_findings`, `action_lineage`, `coverage_roles`, and a newly
  minted action's own fresh state) is ever written.
