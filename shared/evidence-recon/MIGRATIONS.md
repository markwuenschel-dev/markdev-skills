# Migrations

## 1.2.0 — standalone negative-claim validation export

Additive and backward compatible. `evidence_packet_version` stays `1`.

- New export `validateNegativeClaim(claim, path?) → { ok, problems }`. It runs exactly the rules `validateEvidencePacket` already applies to each `negative_claims[]` entry (including the `supports_absence: true` requirements); no rule changes.
- Consumer: `codebase-integrity-audit-loop/assets/integrity-coverage.js` validates per-dimension negative claims in `integrity.coverage@2` (composite-scoring-v3 §7.1). Evidence Recon still owns no numerical credits or factors.

## 1.1.0 — structured producer artifact refs

Additive and backward compatible. `evidence_packet_version` stays `1`.

- `producer.artifact_refs` is a new optional array. Each item is closed: `{ "kind": "health-artifact", "artifact_id": <id>, "sha256": <64 lowercase hex> }`.
- `kind` is a closed enum, currently only `health-artifact`. A new kind needs another minor bump, so a consumer never meets a binding kind it cannot interpret.
- `validateEvidencePacket` checks the field only when it is present. Problem codes: `artifact-refs-invalid`, `artifact-ref-invalid`, `artifact-ref-key-unknown`, `artifact-ref-kind-invalid`, `artifact-ref-sha256-invalid`, `artifact-ref-duplicate`, plus `id-invalid` for `artifact_id`.
- Packets without the field validate exactly as they did under 1.0.0.

Producers and consumers:

- RHA's sidecar projection emits the structured ref. For one release it also keeps the legacy `handoff.consumer_notes` entry `health_artifact_ref artifact_id=… sha256=…`.
- RHA's `write-health-artifact.js --evidence-recon` accepts the structured ref, the note, or both. When both are present they must agree.
- RIA's `normalizeEvidenceRecon` checks a structured health-artifact ref against the bound health artifact's sha256. A legacy packet without the ref is still accepted, and its provenance is marked `evidence_recon_artifact_bound: false`.
- Removing the legacy note is a later release. Consumers that match the note must switch to `producer.artifact_refs` first.

## 1.0.0 — extraction from repository-health-assessment

The generic vocabulary was extracted from the proven repository-health-assessment discipline without changing that skill's health grading schema or denominator:

- coverage: `inspected`, `sampled`, `inventory-only`, `uninspected`, `unavailable`, `not-applicable`;
- evidence quality: `strong`, `moderate`, `weak`, `none`;
- observations: `confirmed`, `inferred`, `unknown`.

RHA remains authoritative for its eleven health surfaces, criticality weights, weighted-coverage arithmetic, grade caps, and confidence formula. It consumes the shared primitive through a validated sidecar projection. Other adopters emit the canonical packet directly.
