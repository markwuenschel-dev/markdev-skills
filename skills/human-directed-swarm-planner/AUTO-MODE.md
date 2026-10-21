# Auto mode

Loaded from SKILL.md when `--auto` is set. It governs mission sources, eligibility, ranking, hard stops, and the stop report.

For this skill, one auto turn is one **planner mission**:

```text
mission selected → topology/evidence lanes derived → read-only synthesis OR Flywheel handoff → next planner mission selected or stopped
```

`--max-turns N` counts planner missions. It does not make this skill a delivery owner and does not count Flywheel implementation tasks.

Repo Audit is not an auto-selected mutation source. It runs read-only, produces report/ledger artifacts, and stops at the candidate gate. Auto mode may consume that ledger only when the user separately authorizes doing so.

## Direct-authorization guard

Before reading a source or ranking a mission, run `scripts/auto-guard.js` with the canonical repository root. Without a delivery authorization it admits read-only topology only.

Mutation is never inferred from repository or assessment state. A mutating topology handoff must supply an exact authorization binding `authorization_ref`, issuer, mission, scope hash, repository revision, `owner: production-flywheel`, and `permitted_mutation: true`. The guard validates that closed envelope and returns `direct-authorized-handoff`; any missing or mismatched field stops before handoff.

- Without delivery authorization, auto mode may evaluate a human-provided source under the remaining rules here.
- With valid delivery authorization, the planner may hand the bound topology to `production-flywheel`; it still performs no mutation itself.
- A **mutating** selected mission may leave this skill only as a handoff to `production-flywheel`, and only when the caller supplies a matching delivery/action authorization. Otherwise stop with `MISSING_DELIVERY_AUTHORIZATION`.
- With an invalid, incomplete, or mismatched envelope, stop on the guard's exact reason code.

The guard is read-only. `human-directed-swarm-planner` never creates production state or performs mutation.

## Mission sources

Auto mode may consume:

- candidate ledger from `codebase-integrity-audit-loop`;
- report from an explorer swarm;
- review finding ledger;
- bug queue;
- fitness-check backlog;
- user-provided ordered list.

A source that is not a canonical candidate ledger must carry explicit human ordering or be normalized by its owning workflow before ranking. The planner never invents a competing priority score.

## Mission eligibility and ranking

For canonical integrity candidate ledgers, use their owned eligibility/ranking contract. Do not re-weight priority dimensions here.

A mission is eligible only when:

- executable status is ready;
- recommended action is not reject;
- human-decision risk is below the source's stop threshold;
- blockers are empty;
- dependencies are complete;
- required access/evidence is available;
- no hard stop below applies.

Explicit human ordering applies only among eligible missions.

## Mutation ownership in auto mode

Auto mode may run read-only missions directly. For a mutating mission it may:

1. recheck reported premises read-only;
2. derive the execution topology;
3. bind it to the caller's existing authorization;
4. hand it to `production-flywheel`.

It may **not** create worktrees, edit repository files, commit, push, open PRs, or self-certify downstream completion. A Flywheel result may be consumed as input for deciding whether the next planner mission is eligible, but the mutation remains Flywheel-owned.

## Hard stops

Stop immediately when:

- mission boundary is unclear;
- a product/policy/SME/architecture decision is required;
- required repo/tool access is missing;
- prior downstream execution leaves dirty/unintegrated state;
- verification baseline is untrustworthy;
- two missions cannot be safely separated;
- report/ledger integrity is suspect;
- lane evidence is contradictory and unresolved;
- next mission would expand scope;
- mutation lacks a valid `production-flywheel` authorization/reference.

## Stop report

Report:

- planner missions completed;
- read-only results and/or Flywheel handoff refs;
- current blocked mission;
- reason for stop;
- evidence gathered;
- topology produced;
- downstream execution state if supplied by the caller;
- recommended human decision.
