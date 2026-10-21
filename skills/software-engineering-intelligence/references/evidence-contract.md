# Evidence contract

Read this reference when interpreting provenance, missingness, comparison, trend, or snapshot-reuse questions. The canonical machine contract is `shared/software-engineering-intelligence/intelligence.schema.json`; this reference explains how to use it without duplicating the schema.

## Evidence record

Every metric, rule result, profile signal, and derived conclusion carries a stable identity, family, subject/scope, value/unit, source collector and version, repository revision, observation window, measurement status/completeness/confidence, and comparability identity. A record without the required provenance is not a usable measured value.

Measurement status is one of:

- `measured` — directly collected with the declared source and method;
- `inferred` — derived from declared evidence and an explicit rule;
- `unavailable` — the source, tool, or artifact was not available;
- `not-applicable` — the declared scope does not apply;
- `unverifiable` — a claim or supplied evidence cannot be trusted or validated.

None of these states is a numeric zero. Preserve the status and its reason in the readout.

## Comparison and identity

Compare snapshots only when the metric identity, analyzer/collector identity, configuration, revision/window semantics, and compatibility contract agree. Analyzer drift, configuration changes, incomplete windows, or unmatched evidence make the trend `incomparable` or `insufficient-history`, not improving or worsening.

Automatic comparison uses the bounded immutable-snapshot inventory under the caller-selected output root and only a compatible strict Git ancestor. The persisted comparison metadata closes over baseline kind, snapshot/revision, prior value, factual delta, and the minimum prior/current confidence. The report may state those facts and comparability coverage, but direction and significance remain unassigned without a separate interpretation contract. An explicit `--baseline` overrides automatic discovery.

Snapshot identity is hash-bound to canonical evidence. Cache reuse requires the exact repository revision, configuration hash, schema version, collector versions, and relevant history boundary. Ephemeral report metadata does not authorize reuse of a different evidence payload.

## Interpretation boundary

Raw measurements and interpretations remain separate. A hotspot is an interpretable feature vector with a declared model status; a heuristic never becomes calibrated or validated without the required independent historical evidence. Generated-code exclusion and evidence completeness are part of the observed result, not cosmetic report filters.

Stop and report the applicable failure boundary when provenance is absent, missing evidence was converted to zero, comparison is incompatible, or a risk claim exceeds its calibration evidence. Do not repair the source repository merely to improve collection.
