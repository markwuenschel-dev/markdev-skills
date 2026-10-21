# Readiness, Closure, and Consistency Check

A contract is ready for shared-understanding confirmation when:

- the mandatory final coverage sweep has run, regardless of whether the canonical state is flat or graph-shaped;
- every consequential decision-state record is settled, invalidated, accepted, or explicitly deferred;
- when graph mode is active, the graph is coherent and acyclic and the decision frontier is empty;
- when flat mode is active, no unresolved relationship has appeared that should have triggered graph promotion;
- a fresh candidate-question pass produced no additional question that survives the quality gate;
- no user-facing question asked for a discoverable fact or bypassed its prerequisites except a valid one-level conditional child;
- critical assumptions and non-goals are visible;
- recommendations, user decisions, and derived requirements are distinguishable;
- recommendation rationales explain concrete mechanisms and consequences rather than generic best-practice claims;
- partial answers and bulk-acceptance instructions were reconciled exactly, with omissions left unresolved;
- requirements and invalid states are testable;
- human and system owners are known;
- every requirement has design coverage and a realistic proof surface;
- concurrency/ordering/failure semantics have been considered when the design introduces parallel or asynchronous work;
- rollout promises have observability and advance/halt signals;
- rollback or containment is supported by the design shape;
- compatibility and migration promises are intentional;
- terminology is consistent across artifacts;
- accepted risks and deferrals have consequences, owners, and revisit triggers;
- another delivery agent can proceed without inventing core behavior.

Before approval, present a concise summary of the selected direction, decisive requirements, non-goals, mechanism, ownership, migration, verification, rollout, recovery, accepted risks, and deferrals. Require explicit human confirmation that it matches their intent. Then request approval or record exact blockers.

Use a lightweight checklist by default. Escalate to strict machine validation only when the user or governing process explicitly requires a tamper-evident authorization bundle.
