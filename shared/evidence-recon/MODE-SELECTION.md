# Inline vs Expedition Mode

Mode is selected from the **evidence question**, not the expected implementation diff, ticket label, file count alone, or desire to appear thorough.

## Inline

Use inline mode when a parent can establish the claim with a bounded, coherent evidence pass. Typical shapes:

- read a few named files and their tests;
- verify one export, route, schema, or configuration path;
- check a handful of numbers against primary records;
- run one deterministic search over a well-defined surface;
- reconcile a small number of sources without independent lanes.

Inline may still be rigorous or moderately large. It simply does not benefit from lane coordination.

## Expedition

Use expedition mode when the evidence topology itself is wide or heterogeneous and bounded lanes can reduce latency without fragmenting authority. Strong signals include:

- three or more independent evidence surfaces;
- several source classes that must be reconciled (code, tests, runtime, history, docs, external authority);
- high or critical contradiction risk;
- exhaustive completeness with high false-negative cost;
- a repository-wide negative claim such as “no alternate construction path exists”;
- parallelizable searches whose results must be merged under one parent.

The parent remains the sole reconciler and packet owner. Lanes return fragments; they do not publish facts directly to downstream consumers.

## Deterministic recommendation

`recommendMode(profile)` returns a recommendation and reasons. It is advisory, because the parent may know constraints the profile does not capture. An override must record `mode_rationale`.

Relevant inputs:

- number of independent surfaces;
- number of source classes;
- contradiction risk;
- required completeness;
- false-negative cost;
- need for cross-source reconciliation;
- whether the work can be partitioned without overlapping authority.

A light task does not earn expedition ceremony merely because a swarm is available. A one-line code change may still require expedition evidence when the factual claim is repository-wide and a false negative would be costly.
