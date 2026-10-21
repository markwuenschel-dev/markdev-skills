# Graph mode

Loaded from SKILL.md when `--graph` is set. This mode replaces Stage 2's queue-construction
prompt with a computed one, ingesting an already-approved shared-spine v3 ledger instead of a
numbered architecture report. Every stage from Stage 3 onward is **unedited** — one queue item,
one worktree, one A/B design-lane gate, one Stage 11 round, one PR, exactly as manual mode runs
them. This document owns only how the queue is built and how it advances; it does not touch how
any single item is delivered.

**Historical legacy scope: strictly serial.** One candidate-ledger item executes at a time. Its verifier
freezes only that item's worktree and revision; this legacy mode neither enables nor disables D7
for the separate canonical `--action-graph` path.
Concurrent execution across independent frontier nodes is a real, separately-authorized canonical D7
mode, not something this document implements. The reason: IV's identity checks are
worktree-scoped (`_iv.py`'s `revision_identity` runs `git -C <repo_root>` under the item's own
worktree), so nothing in the verification tooling would need to change — but nothing in it
checks whether two concurrently-running gates share machine-global state (a fixed database name,
a fixed port, a hoisted `node_modules`, a shared test container). That is a real, uncaught
failure mode, and v1 does not take it on.

## Input

An approved candidate ledger, shared-spine v3 shape, typically produced by one of:

- `remediation-graph-optimizer`'s report (the reconciled, cross-report graph)
- an explicit user-supplied legacy spine-v3 candidate ledger from a prior report
- any other spine-v3 ledger the user hands over directly, with `depends_on` populated

This is not a new authorization mechanism. `SKILL.md`'s Model invocation policy already
supports "candidates the user selected from a family candidate ledger… treat the user's
selection as the queue and skip the report stage" — an approved ledger with dependency edges
*is* that, extended with edges the flywheel now reads instead of ignoring.

## Ingestion

1. **Validate through the spine, not a private check.** Resolve
   `shared/candidate-ledger-spine/ledger-verify.js` repository-relatively or via
   `LEDGER_VERIFY_PATH`; missing or incompatible is a hard failure — this mode does not
   score, rank, or schedule from a partial envelope, the same rule every other consumer of
   this spine already follows.
2. **Refuse a `depends_on` cycle outright.** A cycle among graph-mode items is not a
   scheduling puzzle to solve — it means the candidates were never independently verifiable
   slices in the first place. Stage 6's own gate requires "one tracer-bullet vertical slice,
   independently verifiable"; two items that depend on each other failed that test when they
   were sliced, not when they were scheduled. Name the cycle's members, and route them back to
   their design gate (Stage 4) or to `/decision-terrain-mapper` if the combined premise is bigger than
   one slice — exactly what Stage 14's circuit-breaker guidance already prescribes for a
   different symptom of the same underlying problem ("the item goes back to its design gate,
   or to `/decision-terrain-mapper` if the premise turned out to be bigger than one slice").
3. **Derive `status` and eligibility exactly as the spine defines them.** `REPORT-SCORING.md`
   `## Scheduling fields` and `## Eligibility and stable ranking` are the only source for this
   — this skill does not invent a second status ladder or a second comparator. A candidate is
   eligible only when `status` is `ready`, `recommended_action` is not `reject`,
   `human_decision_risk < 4`, `blocked_by` is empty, and every `depends_on` candidate is
   `completed`.
4. **Compute the frontier.** The eligible set, in the spine's own stable order: `priority_score`
   descending, `effort` ascending, `severity` descending, `confidence` descending,
   `candidate_id` ascending. This is the ready-to-run list — the direct graph-mode analogue of
   the spine's own eligible queue (`ledger-verify.js`'s `queue` output), read one level up.

## The queue prompt, replaced

Stage 2's "Which recommendations do you want to run?" becomes:

```text
Graph-mode frontier (N eligible of M total candidates):
1. [candidate_id] — [title] — priority N
2. [candidate_id] — [title] — priority N
...

Blocked (not yet eligible): [count], listed below with what blocks each.

Pick items to run now (by number, several, or "top-ranked" to pre-authorize the
whole frontier in ranked order), or "top-ranked each time" to pre-authorize every
future frontier as it opens, without being asked again.
```

Blocked candidates are **listed, never dropped** — `REPORT-SCORING.md`'s own eligibility
section: "skipped, never dropped." A candidate blocked on a `depends_on` edge shows which
unfinished item blocks it; a candidate blocked on `blocked_by` (a human-decision fork) shows
the fork.

**This is a real reduction in user control from manual mode**, and it should be said plainly
when offering `--graph`: manual mode's queue is entirely user-typed (`1, 4, 5` / `4 then 1 then
3` / `all`); graph mode's ordering comes from the spine's comparator, and the user's choice is
which *eligible* items to run, not what order they run in relative to each other. Every item
still passes its own Stage 4 A/B design-lane gate at its turn — nothing here shortcuts that,
and "top-ranked each time" pre-authorizes *which item runs next*, never *how it is delivered*.

## State

Graph-mode run state persists to `.verification/graph/state.json` — inheriting the gitignore
requirement `SKILL.md` Stage 7 already states for `.verification/` generally. Contents:

```yaml
graph_state:
  graph_run_id: ""                 # distinguishes concurrent graph runs on one repo
  ledger_source: ""                # path or pointer to the ingested ledger
  ledger_content_hash: ""
  spine_version: 3
  default_branch_sha_at_start: ""
  elected_flags: { graph: true, parallel_n: 1, ship_granularity: "" }
  human_preauthorizations: []      # e.g. "A for the batch", "top-ranked each time"
  nodes:
    - candidate_id: ""
      status: ""                   # mirrors spine status, this run's local copy
      branch: ""
      worktree_path: ""
      baseline_ref: ""
      verify_ref: ""
      evidence_dir: ""
      round: 0
      verdict: ""                  # PASS | FAIL | BLOCKED-UNVERIFIABLE | ESCALATE | null
      verdict_exit_code: null
      packet_lock_sha256: ""
      pr_url: ""
```

> **Hard rule: `state.json` is never authoritative. Git and `verdict.json` are.** This file
> caches intent — which nodes were elected, in what order, with what pre-authorizations — and
> every completion claim inside it is re-derived on resume, never trusted. A node claiming
> `completed` is confirmed only against a real `verdict.json`: it must exist at the recorded
> path, exit `0`, carry `"verdict": "PASS"`, and its `packet_lock_sha256` must match — exactly
> the two checks Stage 13's ship gate already performs for the current item, applied here to
> every prior node on resume. A node claiming in-flight is treated as **unknown**, never
> resumed in place: re-run its round in a **new** evidence directory, never adopt an orphaned
> verdict whose producer and verifier identities cannot be established as distinct.

**Session dies mid-run.** On the next invocation with `--graph` against the same ledger:
consult `state.json` for what was *elected*, but re-derive what was *completed* per the rule
above. This is read-then-reverify, never read-then-trust. Two concurrent graph runs against one
repository share nothing but git — `graph_run_id` distinguishes them, and a node already
claimed by a live `graph_run_id` is not silently reclaimed (the same "never silently steal a
claim" discipline `decision-terrain-mapper` applies to its own tickets).

## Advancing the frontier (Stage 14, graph mode)

After an item ships (or is recorded blocked), recompute the frontier from the current node
states — a completed item may unblock others via `depends_on`. Print the updated frontier as
part of the completion footer, in the same shape as the initial prompt. Continue automatically
through pre-authorized items; stop to ask when the frontier contains eligible items the user
has not pre-authorized, or when it is empty.

**"Frontier empty" and "queue empty" are different states, and the completion message must say
which one occurred:** the frontier can be empty while blocked items remain (all blocked on
`depends_on` edges not yet satisfied by a completed item, or all on open human decisions) — that
is not the same as every candidate having reached a terminal state. Report the count and cause
of anything still blocked, exactly as the merged ledger's own "skipped, never dropped" rule
requires.

## Worktree and branch boundaries

One worktree per item, exactly as manual mode's Stage 7. A **`depends_on` edge is a real
branch-base constraint, not just an ordering hint**: an item may branch from a dependency's
branch only after that dependency's verdict reached `PASS` — branching from an in-flight
dependency and later rebasing risks exactly the stacked-branch-plus-amend hazard Stage 7's
existing branch-base guidance is written to avoid. When a dependency is already `completed` on
the default branch (its PR merged), the dependent branches from the default branch normally,
per Stage 7's unmodified branch-base rule.

Batched shipping (Stage 2's *Ship granularity*) and graph mode compose only **across**
independent frontier nodes, never inside one group: a batched group is still one shared branch
with strictly sequential per-item commits, exactly as *Ship granularity* already requires, and
nothing about graph-mode ordering changes that.

## What this document does not change

- The freeze rule, at any of its sites in `SKILL.md`.
- Stage 4's design-lane gate, or its user-election requirement.
- Stage 11's independent-verification protocol, packet shape, or circuit breaker.
- Stage 13's ship gate or the "never merge" rule.
- `shared/candidate-ledger-spine/` — no schema, verifier, or scoring change of any kind.
