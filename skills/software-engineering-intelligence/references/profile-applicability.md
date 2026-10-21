# Profile applicability

Read this reference only when a framework profile is requested. Profiles interpret existing evidence; they do not collect authoritative data, own raw measurements, or produce a universal engineering score.

## Common rule

For every dimension, retain applicability, evidence source, status, completeness, confidence, and blind spots. Use `not-applicable`, `unavailable`, or `unverifiable` when evidence cannot support a conclusion. Never use profile vocabulary as proof that a practice is current.

The canonical snapshot deliberately has no free-form profile `source` or numeric profile-result field. A profile carries `profile_id`, `profile_version`, and `profile_contract_hash` (the profile definition hash); each displayed evidence item carries its source measurement's `metric_id`, `definition_id` as `kind`, and exact evidence references. The measurement remains the authoritative location for collector/source identity. Do not add aliases, scalar profile values, or an unbound source object.

## Typed framework authority

Framework applicability is fail-closed. A caller-supplied label, a README mention, an issue, a Git commit, or an unbound evidence reference is not framework evidence. A qualifying measurement must be observed, bound to an available collector, revision-bound, and carry its source evidence references.

| Framework evidence | Required authority identity | Required measurement identity |
| --- | --- | --- |
| DORA | `source.kind: typed-authoritative-deployment`; collector `dora-deployment-evidence`; analyzer `sei.dora-deployment-evidence@1` | `dora.<dimension>` / `sei.dora.<dimension>@1`, family `delivery_performance`, with a `deployment-record:` reference |
| Kanban workflow and transitions | `source.kind: typed-authoritative-work-item-flow`; collector `kanban-work-item-flow`; analyzer `sei.kanban-work-item-flow@1` | `kanban.definition_of_workflow`, `kanban.transition_records`, and `kanban.<dimension>` with the corresponding `sei.kanban.*@1` definitions |
| Human framework evidence | `source.kind: human-process-evidence`; collector `human-framework-evidence`; analyzer `sei.human-framework-evidence@1` | `sei.<profile>.<dimension>@1` / family `framework_profile`, or the declared Scrum adoption contract |

The legacy M4 `deployment-events-v1` envelope emits bounded `deployment.*` facts only. Those generic counts and percentiles are not DORA equivalence claims and must never promote a DORA dimension. A closed `deployment-events-v2` envelope may additionally materialize the separate `dora.*` measurements only when every production deployment record carries its identifier, change-set binding, environment, started/completed timestamps, terminal success/failure outcome, and any relevant rollback, rework, and recovery linkage. Its typed payload is limited to `production_environment`, `changes[{change_set, committed_at}]`, and `events[{event_id, change_set, environment, started_at, completed_at, status, rollback_of?, rework_of?, recovery_completed_at?}]`. Its change records supply the committed timestamp used for change lead time. The authoritative calculation is explicit: change lead time is the median committed-to-successful-production completion duration; deployment frequency is the successful-production count in the declared window; failed-deployment recovery time is the median failed-completion-to-recovery duration; change-fail rate is failed production deployments divided by all typed production deployments; and deployment-rework rate is succeeding production deployments explicitly linked with `rework_of`, divided by all typed production deployments. Missing typed change or recovery evidence leaves the affected DORA dimension unavailable; it is never estimated from merges, pull requests, or generic counts.

The closed `kanban-work-item-flow` adapter accepts an explicit Definition of Workflow (`workflow_id`, declared `states`, `start_event`, `finish_event`, `active_states`, `as_of`, `window_start`, and `window_end`) plus ordered typed work-item transitions (`transition_id`, `work_item_id`, `from`, `to`, and `occurred_at`). It deterministically materializes Definition-of-Workflow, transition-record, WIP, throughput, work-item-age, and cycle-time measurements. A missing active item or completed item leaves the corresponding age or cycle-time measurement unavailable rather than inferring it from open issues, branches, or repository activity.

## DORA

Show all five delivery measures individually: change lead time, deployment frequency, failed-deployment recovery time, change fail rate, and deployment rework rate. Each must have its own typed authoritative DORA measurement. Git merges, pull requests, branches, commits, and generic deployment-event counts are not deployments. A merge-tainted or missing dimension leaves the DORA profile `insufficient_evidence`; four measured dimensions cannot mask the fifth hard gate.

## Agile and Scrum

Agile is an evidence-limited alignment view, never a conformance, trust, or collaboration score. Machine evidence may support only the declared machine-bound dimensions. Customer collaboration, individuals and interactions, and responding to change remain unobservable until explicit human-process measurements are supplied. Repository activity cannot infer trust or customer collaboration.

Scrum applies only when the project explicitly and currently claims Scrum through the bound `scrum.current_adoption` / `sei.scrum.current_adoption@1` human-process measurement. That declaration is alignment evidence, not a conformance grade. Historical, revoked, incidental, or word-overlap references are `not_applicable` and do not establish current Scrum practice.

## Kanban

Use WIP, throughput, work-item age, and cycle time only with an explicit, metric-bound Definition of Workflow plus a metric-bound typed transition record set. The workflow declares start, finish, active states, `as_of`, and the measurement window. Transitions are RFC3339-with-offset records bound to `kanban.transition_records`; the four typed dimension measurements must match the deterministic calculation. Open branches or open issues alone are not WIP.

## SPACE and EngThrive

Keep SPACE multidimensional: Satisfaction & well-being, Performance, Activity, Communication & collaboration, and Efficiency & flow remain distinct. Human dimensions stay unobservable without supplied metric-bound human-process evidence. Do not infer wellbeing, satisfaction, or overall performance from commit activity, and never create a SPACE score or composite.

Treat EngThrive as experimental. Keep Speed, Ease, Quality, and Thriving visible as separate dimensions and do not make it a canonical productivity or repository-health score.
