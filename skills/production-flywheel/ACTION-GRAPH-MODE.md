# Action-graph mode

Loaded from `SKILL.md` when `--action-graph` is set. This mode replaces Stage 2's
queue-construction prompt with a **computed** one, ingesting a `shared/action-graph-execution`-
shaped `execution_graph` envelope (`schema_version: 1`, `graph_kind: "remediation-action-graph"`)
instead of a candidate-shaped spine-v3 ledger. It is a second, additional ingestion path
alongside the existing candidate-shaped `--graph` path documented in
[GRAPH-MODE.md](GRAPH-MODE.md) — never an extension of `--graph`'s own meaning, and never a
replacement for it. Every stage from Stage 3 onward is **unedited**: one queue item, one
worktree, one A/B design-lane gate, one Stage 11 round, one PR, exactly as manual mode and
`--graph` mode both already run them. This document owns only how the queue is built and how it
advances; it does not touch how any single item is delivered.

**Default: one action.** `--parallel N` is the explicit D7 opt-in for a verified independent
batch; omitting it is intentionally serial. The canonical freeze invariant below is the sole
definition of verification isolation. Stage 13 remains policy-gated at every concurrency level;
a PASS never opens a PR by itself.

`shared/action-graph-execution` owns the mechanical D7 batch admission and capacity checks. This
guide consumes its result; it neither restores a serial-only invariant nor treats `maxParallel=1`
as evidence that a requested safe batch is invalid.

## Canonical verification-freeze invariant

During independent verification, the action's verified repository identity is frozen. No mutation
may alter that action's verification worktree, committed revision, branch, or declared verification
scope until its verdict is complete. Concurrent verification of another action is allowed only
when that action has a separately isolated worktree and revision, and all declared shared and
exclusive resources have been proven disjoint (or admitted by the resource scheduler). A Stage 15
wave-boundary receipt must name the exact completed action revisions and cohort; it cannot release a
dependent action or grant completion credit while a participant is still in flight. This invariant
applies to both default `N=1` execution and D7 `--parallel N`; only the number of independently
admitted actions changes.

## Input

An `execution_graph` envelope, `schema_version: 1`, `graph_kind: "remediation-action-graph"`,
produced one of two ways:

- **Projected from a `shared/remediation-graph`-shaped output.** `remediation-graph-optimizer`
  ships this shape today: action nodes with `covers` / `hard_requires` / `decision_requires` /
  `evidence_requires` edges over candidate references (`remediation-graph-optimizer/SKILL.md`
  `## Process`, step 3). `ActionGraphVerify.projectFromRemediationGraph(remediationVerified,
  sourceGraphEnvelope, meta)` turns an already-`ok: true` `RemediationGraph.verifyGraph()` result
  into a new `execution_graph` envelope — `candidate_refs` copied reference-only and
  byte-identical, `actions` gaining `covers_candidate_ids` / `hard_requires` /
  `decision_requires`, `human_decisions` gaining an execution-side `resolved: false` default,
  and a synthesized `verification_gates` entry per action plus one per `evidence_requires` edge.
  A missing or incompatible `shared/remediation-graph` module at projection time is a hard
  failure, never a reason to invent actions locally.
- **Hand-authored or directly produced.** Any other source — a human-authored envelope, or a
  future producer that emits `execution_graph` shape natively — is an equally valid input,
  provided it validates. This mode does not require the projection step; it requires only that
  the envelope validates through `ActionGraphVerify.verifyExecutionGraph`.

This is not a new authorization mechanism. `SKILL.md`'s Model invocation policy already supports
"candidates the user selected from a family candidate ledger… treat the user's selection as the
queue and skip the report stage" — an approved execution graph, however it was produced, *is*
that, extended with the three distinct edge-readiness rules the flywheel now reads instead of
ignoring.

## Ingestion

1. **Validate through the shared module, not a private check.** Resolve
   `shared/action-graph-execution/execution-graph-verify.js` repository-relatively or via
   `ACTION_GRAPH_VERIFY_PATH`; missing or incompatible is a hard failure — this mode does not
   score, rank, or schedule from a partial envelope, the same rule every other consumer in this
   family already follows. Call `ActionGraphVerify.verifyExecutionGraph(graph)`. A result with
   `ok: false` stops here; report every `problems[]` entry (`action-graph-shape`,
   `unsupported-graph-kind`, `schema-version-mismatch`, `dup-node`, `edge-dangling`,
   `decision-treated-as-action`, `status-mismatch`, `candidate-ref-restates`,
   `validation-coupled-boundary-mismatch`, `action-cycle`, `conflict-in-batch`, `unknown-property`)
   rather than
   guessing past it.
2. **Refuse a `hard_requires` cycle outright.** Identical posture to `--graph`'s
   `depends_on`-cycle refusal (see `SKILL.md` Hard Rules and [GRAPH-MODE.md](GRAPH-MODE.md)
   `## Ingestion` step 2): a cycle among actions is not a scheduling puzzle to solve — Stage 6's
   own gate requires "one tracer-bullet vertical slice, independently verifiable," and two
   actions that hard-require each other failed that test when they were decomposed, not when they
   were scheduled. `verifyExecutionGraph` fails closed on any cycle (`acyclic: false`,
   `layers`/`frontier` both `null`) rather than computing a partial schedule around it. Name the
   cycle's members (the `action-cycle` problem's `node_id` and the reported cycle path) and route
   them back to their design gate (Stage 4) or to `/decision-terrain-mapper` if the combined premise is
   bigger than one slice — exactly what Stage 14's circuit-breaker guidance already prescribes
   for a different symptom of the same underlying problem.
3. **Never call this `depends_on`.** This is the single most important rule in this document,
   restated mechanically from `EXECUTION-GRAPH-MODEL.md` `## Three distinct edge-readiness
   rules`: `hard_requires`, `decision_requires`, and `verification_requires` are three distinct
   edge types with three distinct readiness predicates, never merged into one flattened
   `depends_on` field the way candidate-shaped `--graph` mode's ledger does.

   | edge | readiness predicate | who resolves it |
   | --- | --- | --- |
   | `hard_requires` | every named action's durable `execution_state.actions[x].status === "complete"` | `production-flywheel`, by finishing the predecessor action |
   | `decision_requires` | every named decision's durable `execution_state.decisions[d].resolved === true` | a human, explicitly — never inferred from silence, time elapsed, or the decision merely existing in the graph |
   | `verification_requires` | every named gate has a **current** receipt: exists, `repository_revision` and `source_graph_hash` match this run's, and (for an `independent-verification`-kind gate) `verdict === "PASS"` with a matching `packet_lock_sha256` | `independent-verification` or an evidence task, via a gate receipt `state-store.js` records after that proof is produced |

   `verification_requires` names an **external** precondition — typically an evidence task's
   result — never an action's own completion proof. An action's own Stage-11 round is a
   **separate** rule (below), never added to its own `verification_requires`; that would make
   starting the action depend on a proof the action itself has not yet produced, a bootstrap
   deadlock.
4. **An action's own completion gate is a lifecycle rule, not a graph edge.** Every action gets
   exactly one synthesized gate, `verify::<action_id>`, registered in `verification_gates` for
   storage and traceability but never added to that action's own `verification_requires`. Reaching
   `complete` mechanically requires `ActionGraphVerify.completionGateSatisfied(graph, action_id)`
   — a current receipt for `verify::<action_id>` matching this run's `repository_revision` and
   `source_graph_hash`, with `verdict === "PASS"`. This is the graph-level mirror of Stage 11's
   own ship gate; it does not replace Stage 11, it is Stage 11's completion recorded durably so
   the frontier can read it.
5. **Compute the frontier.** `ActionGraphVerify.computeFrontier(graph)` (or the `frontier` field
   `verifyExecutionGraph` already returns) gives layer-0 actions whose durable status is `pending`
   or `ready` and for which all three readiness predicates above hold. Layers use the same
   longest-path algorithm as `shared/remediation-graph` (`layer(v) = 0` with no `hard_requires`
   predecessors, else `1 + max(layer(pred))`), but the frontier predicate is wider than that
   source package's, because this package — unlike `shared/remediation-graph` — has execution
   state to check readiness against, not merely edge presence. `layers`/`frontier` are always
   recomputed from `execution_state`, never trusted from a stored value.
6. **`conflicts_with` pairs landing in the same layer are flagged, never silently scheduled
   together.** `verifyExecutionGraph` reports `conflict-in-batch` for any `conflicts_with` pair
   sharing a layer; default N=1 claims at most one action, while D7 admission still rejects
   but the check is not skipped just because seriality already prevents the collision in practice.

## The queue prompt, replaced

Stage 2's "Which recommendations do you want to run?" becomes:

```text
Action-graph frontier (N ready of M total actions):
1. [action_id] — [title] — [action_type] — covers: [candidate_id, candidate_id, ...]
2. [action_id] — [title] — [action_type] — covers: [candidate_id, ...]
...

Blocked (not yet ready): [count], listed below with what blocks each.
  - [action_id]: waiting on hard_requires [action_id] (not yet complete)
  - [action_id]: waiting on human decision [decision_id]
  - [action_id]: [explainGateBlockers-shaped reason, e.g. "gate evidence::retry-policy-baseline has no recorded receipt"]

Pick actions to run now (by number, several, or "top-ranked" to pre-authorize the
whole frontier), or "top-ranked each time" to pre-authorize every future frontier as
it opens, without being asked again.
```

One queue item is one `action_id`, never a candidate. Print the action's title, its
`action_type` (`evidence | remediation | migration | fitness-check | verification | cleanup`),
and which candidates it covers (`covers_candidate_ids`) — a human deciding what to run next needs
to see both what kind of work this is and which findings it closes, especially because one action
can cover several candidates and one candidate can require several actions (see *Advancing the
frontier* below).

Blocked actions are **listed, never dropped** — the same convention
[GRAPH-MODE.md](GRAPH-MODE.md) already established for candidate-shaped graph mode's "Blocked
(not yet eligible)" list. Three distinct reasons an action can be blocked, and each prints its
own shape:

- **`hard_requires` blocked:** name the unfinished predecessor action(s).
- **`decision_requires` blocked:** print "waiting on human decision `<decision_id>`" — never
  invent a decision's answer from silence or elapsed time.
- **`verification_requires` blocked:** print the `explainGateBlockers`-shaped reason(s)
  (`verification-gate.js`'s `explainGateBlockers(graph, action_id)`) — one human-readable string
  per not-current gate, e.g. "gate `evidence::retry-policy-baseline` has no recorded receipt" or
  "gate `verify::action-b` is an independent-verification gate recording verdict FAIL, not PASS."
  This is the action-graph-shaped analogue of candidate-graph mode's "listed with what blocks
  each" convention, one level more specific because a `verification_requires` block can name
  exactly which receipt is stale or missing, not just that something is.

**This is a real reduction in user control from manual mode**, exactly as `--graph` already
states plainly for itself: manual mode's queue is entirely user-typed; action-graph mode's
ordering comes from the graph's own layering and readiness predicates, and the user's choice is
which *ready* action to run now, not what order actions run in relative to each other. Every
action still passes its own Stage 4 A/B design-lane gate at its turn — nothing here shortcuts
that, and "top-ranked each time" pre-authorizes *which action runs next*, never *how it is
delivered*.

## State

Action-graph run state persists to `.verification/action-graph/state.json` — the sibling
convention to candidate-graph mode's `.verification/graph/state.json`
([GRAPH-MODE.md](GRAPH-MODE.md) `## State`), gitignored the same way (`SKILL.md` Stage 7's
`.verification/` requirement applies here unchanged). Unlike candidate-graph mode — where
`production-flywheel` owns the state file's shape directly — this mode's durable state is owned
by `shared/action-graph-execution`'s own persistence layer (`state-store.js`, its
`recordGateReceipt` / `claimAction` / transition functions, and the `receipts/` directory it
writes gate receipts into), not hand-rolled here. `production-flywheel` is a consumer of that
state, not its author.

> **Hard rule, identical in spirit to `--graph`'s: on-disk state is never authoritative by
> itself. The durable `execution_state` (actions/decisions/candidate_resolution/gates) that
> `state-store.js` persists, and the real `verdict.json` a gate receipt is shaped from, are.** A
> node claiming `complete` is confirmed only by recomputing `durableActionStatus` against
> `execution_state.actions` and confirming `completionGateSatisfied` — exactly the two checks
> Stage 13's ship gate already performs for the current item, applied here to every prior action
> on resume. An action claiming in-flight (`active`/`verifying`) is treated as **unknown**, never
> resumed in place: re-run its round in a **new** evidence directory, never adopt an orphaned
> verdict whose producer and verifier identities cannot be established as distinct.

**Session dies mid-run.** On the next invocation with `--action-graph` against the same graph:
consult the state for what was *elected* (which actions were pre-authorized, in what order), but
re-derive what was *completed* by recomputing `execution_state` from disk and re-checking every
gate's currency — never trusting a cached `status` field, exactly as
`EXECUTION-GRAPH-MODEL.md`'s own `## Durable state and resumption` section requires
("read-then-reverify, never read-then-trust… nothing is ever resumed in place"). This mirrors
[GRAPH-MODE.md](GRAPH-MODE.md)'s own state discipline for `.verification/graph/state.json`
verbatim — the same rule, applied to the sibling file and the sibling package.

**Integration note:** `shared/action-graph-execution/state-store.js` and `STATE-AND-RESUMPTION.md`
now exist alongside `execution-graph-verify.js`, `verification-gate.js`, and
`candidate-resolution.js`. The claims above (single-active-claim enforcement, atomic receipts,
read-then-reverify resumption, the orphaned-active-claim rule) are exercised directly by
`shared/action-graph-execution/adversarial-tests.js` (tests 8–10 and 14) and by a dedicated
cross-process interruption/resume script (`interrupt-resume.test.js`) — both run and green as of
this package's integration, not merely specified. See those files for the actual pass/fail
evidence rather than this document's prose.

## Advancing the frontier

After an action ships (reaches `complete`) or is recorded `blocked`/`failed`, recompute the
frontier from the current `execution_state` — a completed action may unblock others via
`hard_requires`, and a resolved decision may unblock others via `decision_requires`. Print the
updated frontier as part of the completion footer, in the same shape as the initial prompt.
Continue automatically through pre-authorized actions; stop to ask when the frontier contains
ready actions the user has not pre-authorized, or when it is empty.

**This is different from, and more conservative than, candidate-graph mode — say so plainly, it
is the biggest behavioral difference between the two modes.** In `--graph`, a candidate *is* the
queue item: shipping the one item that represents it is what completion means, full stop. In
`--action-graph`, the queue item is an **action**, and a candidate's completion is **derived**,
never assumed just because one covering action finished:

1. every mandatory action covering the candidate (every action whose `covers_candidate_ids`
   names it) must be durably `complete` — not just the one action that just shipped;
2. all of the candidate's own candidate-specific verification obligations must hold a current
   receipt;
3. no covering action may remain unresolved (`pending`/`ready`/`active`/`blocked`/`verifying`/
   `failed`/`stopped` all count as "not yet");
4. the candidate's terminal record must carry at least one `verification_refs` entry — a
   candidate with zero recorded verification references is never `complete`, however many
   actions covering it say `complete`.

A candidate can require several actions (`candidate-resolution.js`'s many-to-many guarantee: one
candidate covered by several actions requires **all** of them, and one action covering several
candidates is never "spent" on the first one it satisfies). [GRAPH-MODE.md](GRAPH-MODE.md)'s
candidates, by contrast, only ever wait on other candidates via `depends_on` — there is no
"several actions must jointly complete one candidate" concept in candidate-graph mode at all.
Report candidate resolution using `candidate-resolution.js`'s computed
`execution_state.candidate_resolution` — never re-derive it by hand, and never claim a candidate
finished on the strength of one action's completion footer alone.

**"Frontier empty" and "queue empty" are different states, and the completion message must say
which one occurred** — identical to `--graph`'s own rule: the frontier can be empty while blocked
actions remain (unmet `hard_requires`, unresolved `decision_requires`, stale
`verification_requires` receipts), which is not the same as every action having reached a
terminal state. Report the count and cause of anything still blocked, exactly as this document's
own "listed, never dropped" rule requires.

**A completed action also re-checks the integration cohort, not just the frontier.** Every time
this section's recompute runs — an action shipped, or the queue is about to advance — also
reconstruct the current `integration_cohort` (`shared/action-integration-reassessment`'s
`materializeCohort`) and compare its `cohort_hash` against the last recorded Stage 15 run for that
hash. If ≥2 actions are durably `complete` and either the cohort's membership or any participant's
`head_sha` has changed since that last run, Stage 15 (see
[SKILL.md](SKILL.md) and [INTEGRATION-REASSESSMENT-STAGE.md](INTEGRATION-REASSESSMENT-STAGE.md))
fires before the next ready action is offered. **This is cohort-based, never delta-based** — the
trigger is never "check the action(s) that just finished against each other"; it is "rebuild the
complete cohort and compare its hash," the same expensive-but-correct rule
`INTEGRATION-REASSESSMENT-MODEL.md`'s `## Cohort reconstruction` commits to, for the identical
reason: a delta keyed only on "since the last run" can miss a real conflict between a
just-completed action and an earlier one that was never in that delta. Frontier recomputation and
cohort recomputation are two separate checks that happen at the same recompute boundary — a
frontier can be non-empty (more actions ready to claim) while a Stage 15 run is pending on the
just-changed cohort, and vice versa; neither substitutes for the other.

## Worktree and branch boundaries

One worktree per action, exactly as manual mode's Stage 7 and candidate-graph mode's own
worktree rule. A **`hard_requires` edge is a real branch-base constraint, not just an ordering
hint** — an action may branch from a predecessor action's branch only after that predecessor's
status durably reaches `complete` (never while `active` or `verifying`), for exactly the reason
[GRAPH-MODE.md](GRAPH-MODE.md)'s `depends_on` guidance already names: branching from an in-flight
predecessor and later rebasing risks the stacked-branch-plus-amend hazard Stage 7's branch-base
guidance is written to avoid. When a predecessor is already `complete` on the default branch (its
PR merged), the dependent branches from the default branch normally, per Stage 7's unmodified
branch-base rule.

`conflicts_with` is **enforced, not merely documented**, unlike `shared/remediation-graph`'s
detection-only posture: `state-store.js`'s `claimAction` refuses to claim an action while any
action it `conflicts_with` currently holds an **in-flight** status — `active` OR `verifying`, not
`active` alone (a Stage-11 round freezes the action's named worktree and revision, so it counts as
busy too). Under D7, this is the mechanical protection against unsafe overlap rather than prose
about a system-wide serial queue. See the verifier's batch resource proof before treating actions
as peers. This remains a real mechanical check
(`shared/action-graph-execution/state-store.js`'s `claimAction`, exercised by
`adversarial-tests.js` test 14 and a dedicated regression test), not something left to this
document's prose alone to prevent. See `EXECUTION-GRAPH-MODEL.md` `## conflicts_with: enforced,
not merely detected` for the full contract, including the correction note on why `verifying` is
included.

Batched shipping ([`SKILL.md`](SKILL.md) `## Stage 2` `### Ship granularity`) and action-graph
mode compose only **across** independent frontier actions, never inside one group: a batched
group is still one shared branch with strictly sequential per-action commits, exactly as *Ship
granularity* already requires, and nothing about action-graph ordering changes that.

## `--parallel N` (D7)

**Planner/Flywheel boundary.** D7's canonical action-graph machinery remains the authority for cross-action readiness, `computeConcurrencyBatch`, atomic claims, and resource/conflict safety. `human-directed-swarm-planner` may be invoked only *after* an action or wave is authorized/claimed to decompose its internal work into lanes. Its topology cannot change the frontier, batch membership, `action_effects`, `exclusive_resources`, action status, or claim state; `production-flywheel` remains the mutating executor.

**Additive to every section above.** `--parallel N` is only meaningful in combination with
`--action-graph` (it names how many actions from the computed frontier may execute concurrently);
it does not exist for manual mode or candidate-shaped `--graph` mode, neither of which this
document — or D7 — touches. Omitting the flag, or passing `--parallel 1`, is **completely
unchanged v1 serial behavior** — every rule stated above this section applies verbatim, at every N
= 1, because the unelected default routes through the exact same, unmodified `claimAction` function
this document already describes throughout. This is a structural fact, not an argued one: see
`shared/action-graph-execution/parallel-batch.test.js`'s required test proving `maxParallel=1`
reproduces `claimAction`'s own behavior byte-for-byte via the separate `claimBatch` code path too.

### What changes when N > 1

1. **The queue prompt offers a batch, not just a list.** Instead of "Pick actions to run now (by
   number, several, or 'top-ranked'...)" selecting items to run **one after another**, `--parallel
   N` additionally computes `ActionGraphVerify.computeConcurrencyBatch(graph, frontier,
   execution_state, N)` and offers running its result **concurrently** as one wave. The computed
   batch is never larger than what real evidence (`action_effects`, `exclusive_resources`) proves
   safe — see the fail-closed rules below — so a wave may legitimately contain fewer than N actions,
   or exactly 1, even when N ready actions exist and the user asked for N.
2. **Claiming a wave.** `StateStore.claimBatch(stateDir, graph, batch, claimant, control)` — never a loop of
   individual `claimAction` calls, which would not be atomic across the wave (see
   `EXECUTION-GRAPH-MODEL.md` `## D7` for why claimBatch's own fresh recomputation, inside one
   critical section, is the actual safety mechanism, not merely convenient batching).
   The router control probe is evaluated at this same boundary: requested,
   draining-current-wave, and integration-required soft-stop phases refuse a
   successor batch and return the boundary receipt; only an effective or
   explicitly resumed mission may claim a new wave.
3. **One worktree per action, still.** Nothing about D7 changes `## Worktree and branch boundaries`
   above — each concurrently-claimed action still gets its own isolated worktree, its own branch,
   its own A/B design-lane gate, its own Stage 11 round, and its own IV packet scoped to its own
   `diff_range`. D7 does not introduce any new sharing of a worktree, a branch, or a verification
   packet between two concurrently-executing actions.
4. **The freeze rule's actual scope.** The freeze rule protects *one action's own* Stage 11 round
   and the shared verdict-authority sequence around its named revision. It forbids a change in that
   action's worktree or verification scope while its verifier is in flight. Two actions in separate
   worktrees, each running its own Stage 11 round against its own revision inside the same batch, do not violate the freeze
   rule's actual purpose — they only appear to violate a stricter reading of "the next item" that
   assumed a single shared clock. Stage 13's ship gate stays strictly sequential regardless of how
   many actions executed concurrently (see the paragraph above this section).
5. **Mandatory wave-boundary integration reassessment.** Once every member of a claimed batch
   reaches a terminal state (`complete` or `failed`), the flywheel session MUST call
   `shared/action-integration-reassessment/wave-boundary-gate.js`'s
   `runWaveBoundaryIntegrationReassessment` for that batch before offering the next wave or
   reporting any of the batch's complete members' covered candidates as resolved — check
   `isWaveCandidateCoverageTrusted` first if only a read is needed (e.g. to decide whether to print
   a candidate as still-pending in a completion footer). This composes with, but is **not**
   satisfied by, the existing general Stage 15 trigger (`INTEGRATION-REASSESSMENT-STAGE.md`, "≥2
   actions durably complete... cohort changed since the last run") — that trigger fires on the
   whole-system cohort at any queue-advancement boundary and remains completely unedited; the D7
   wave-boundary gate is a narrower, additional obligation scoped to exactly the just-finished
   batch's own cohort. A `failed` batch member is simply excluded from that cohort (D6d's own,
   unmodified `materializeCohort` classification) and follows the ordinary, completely unmodified
   `reopenAction` reshape path like any other failed action. Before a terminal D7 batch receives
   candidate-completion credit or releases a dependent action, its exact complete-member cohort
   requires a concluded wave-boundary receipt. This is a barrier, not a best-effort report.
6. **Partial-wave outcomes are reported, never smoothed over.** If a batch member fails while its
   siblings complete, the completion footer names each member's own outcome individually (exactly
   the "listed, never dropped" convention this document already uses for blocked actions) —
   nothing about a wave collapses N distinct outcomes into one summary verdict.

### Fail-closed by construction, not by policy

`computeConcurrencyBatch` never guesses. In legacy D7 admission, an action with no `action_effects`
record (or no declared completion-gate resource evidence) cannot grow a multi-member batch. D8
campaign mode may instead supply a valid, hash-bound pre-mutation `planned_impact` declaration for
every member; absent either complete planned-impact evidence or the legacy observed-effects evidence,
the result still fails closed to a single action. See `shared/action-graph-execution/EXECUTION-GRAPH-MODEL.md` `## D7: parallel action
execution` for the full, mechanical rule set (`conflicts_with` checked in both directions,
`touched_paths`/`removes_symbols`/`references` overlap, `exclusive_resources` overlap) and
`parallel-batch.test.js` for its adversarial proofs.

### What `--parallel N` does not change

Everything `## What this document does not change` below already states, unedited, at every N —
plus: `shared/remediation-graph`'s own `conflicts_with` authoring/detection semantics (D7 only
reads it more strictly, in both directions, at claim time — never changes how that package
authors or detects it); `candidate-resolution.js`'s rules 1–5 (D6b, unmodified — the mandatory
wave-boundary gate is a genuinely separate, additional check a caller must also consult, never a
restatement of an existing one); and `integration-run.js`'s own mechanism (called verbatim by
`wave-boundary-gate.js`, never forked or reimplemented).

## D8: campaign planned-impact admission

D7 remains backward-compatible: absent campaign scheduling evidence, `--parallel N` uses its
existing observed-`action_effects`/completion-gate evidence and fails closed to one action when
disjointness cannot be proven. Campaign mode adds a **pre-mutation planned-impact sidecar** so a
new action does not need a previous implementation diff merely to prove that its declared scope
is disjoint from a sibling.

`planned_impact` is not stored as action-graph truth and never substitutes for observed
`ActionEffects`, independent verification, or the empirical integration gate. A campaign passes a
hash-bound `planned_impact_by_action` map to `claimBatch`; `claimBatch` validates the map/hash and
recomputes the concurrency batch inside the same claim critical section. Invalid, missing, stale,
or overlapping declarations fail closed.

A planned declaration names allowed path patterns, expected symbols, shared/exclusive resources,
generated artifacts, global gates, confidence, and provenance. Multi-action admission requires
every pair to have compatible declarations. After implementation, scope conformance compares the
real diff/observed effects against the declaration; drift is quarantined rather than retroactively
widening the plan.

Campaigns may distinguish `max_epoch_actions` from `max_parallel_workers`: an already-admitted,
conflict-safe epoch may contain more assignments than active worker slots, allowing executor
refill/work-stealing as workers finish. The existing mandatory terminal wave/integration
reassessment remains the barrier before successor-epoch admission.

## What this document does not change

- The freeze rule, at any of its sites in `SKILL.md`.
- Stage 4's design-lane gate, or its user-election requirement.
- Stage 11's independent-verification protocol, packet shape, or circuit breaker.
- Stage 13's ship gate or the "never merge" rule.
- `shared/remediation-graph/` — no schema, verifier, or scoring change of any kind; this mode
  only *consumes* its output via `ActionGraphVerify.projectFromRemediationGraph`, and never
  writes back to it.
- `shared/candidate-ledger-spine/` — no schema, verifier, or scoring change of any kind; every
  candidate reference this mode displays remains reference-only, scored solely by the shared
  spine.
- `GRAPH-MODE.md` and candidate-shaped `--graph` mode itself — the two modes are independent,
  additive ingestion paths and neither alters the other's mechanics, state file, or queue prompt.
- **Superseded by D7 (see `## --parallel N (D7)` above) — kept here for the historical record,
  not deleted or silently altered.** This bullet originally read: "No parallel execution in this
  release: exactly as the historical `shared/action-graph-execution` v1 cut list stated, a
  separately-authorized parallel mode would need disjoint mutation ownership, worktree isolation,
  atomic shared-state updates, conflict-aware batching, and partial-wave failure handling. Those
  prerequisites are now implemented by canonical D7 (see `## --parallel N (D7)`); the omitted flag
  remains the explicitly serial default (`N=1`).
