# RIA-owned engineering intelligence evidence

This reference defines the canonical ASSESS use of Software Engineering Intelligence (SEI). RIA first establishes its canonical baseline, reads its immutable baseline-to-intelligence binding, and only calls the SEI materialization seam when no valid binding exists. A valid established baseline therefore has one pinned artifact even if a later callback would produce different bytes. SEI may also supply an optional verified engineering-assessment sidecar; RIA and its three specialist owners retain assessment authority.

## Closed reference

The public `engineering_intelligence_ref` has exactly these fields:

```json
{
  "artifact_id": "engineering-intelligence:<sha256>",
  "owner": "repository-improvement-assessment",
  "kind": "engineering-intelligence",
  "schema_version": "1.0.0",
  "sha256": "<lowercase sha256>",
  "repository_revision": "<revision>",
  "mission_id": "<mission>",
  "scope_hash": "<lowercase sha256>",
  "baseline_binding": {
    "artifact_id": "<baseline artifact>",
    "sha256": "<lowercase sha256>",
    "repository_revision": "<revision>"
  }
}
```

The reference deliberately has no path, raw payload, alias, health grade, candidate, score, recommendation, graph, lifecycle, verification, or publish field. `artifact_id` is derived from the byte digest; it is not a caller-selected storage location.

## Storage, resolution, and immutability

`engineering-intelligence-writer.js` resolves only the repository-owned canonical root `.project-intelligence/evidence/engineering-intelligence/`. Before computation it reads the closed immutable baseline pin at `baseline-pin/<binding-hash>.json` and the closed canonical index at `baseline-index/<binding-hash>.json`, where the binding hash derives only from schema version, index kind, baseline ref, revision, mission, and scope. The baseline pin is the independent first-minted binding and contains that binding plus one closed `engineering_intelligence_ref`; the index carries the same closed reference and its first-minted identity must equal the pin. Neither contains owner payload or authority fields. The writer creates the immutable pin after the content-addressed `<sha256>.json` artifact and before the index, so a missing partner, different pre-existing byte sequence, or replacement index ref is a fail-closed conflict.

When a binding exists, RIA validates both pin and index canonical bytes, closed shapes, binding hashes, exact baseline/revision/mission/scope, their mutual reference agreement, and the referenced artifact before it can reuse the reference. Corrupt, noncanonical, stale, substituted, mismatched, missing, or hash-invalid pinned/indexed evidence is a blocker; RIA never silently recomputes or overwrites it. Only when both pin and index are absent may a deterministic single-writer lock establish the first artifact, pin, and index; an active lock blocks rather than running a second compute.

`engineering-intelligence-reader.js` derives the artifact path from the closed reference rather than from caller input, verifies containment, rehashes bytes before parsing, validates the closed artifact plus the M2 snapshot, and requires exact mission, scope, revision, and baseline binding. A ref cannot be used to select a path or inject a payload.

## SEI engineering-assessment sidecar

An ASSESS run may additionally carry the optional, verified `sei_assessment_ref` below. This is an additive v2 envelope field: v1 envelopes without it remain valid.

```json
{
  "schema_version": "sei.engineering-assessment@1",
  "assessment_id": "",
  "snapshot_binding": { "snapshot_id": "", "revision": "", "repository_id": "", "digest": "" },
  "evaluator": { "id": "sei.engineering-assessment", "version": "" },
  "rubric": { "id": "", "version": "", "digest": "" },
  "standard": { "id": "", "version": "", "digest": "" },
  "config_digest": "",
  "applicability_digest": "",
  "artifact_path": "",
  "artifact_sha256": ""
}
```

RIA resolves the sidecar path, rehashes canonical bytes, parses the sidecar, and requires every provenance field to echo the reference. Its `snapshot_binding.revision` must equal the RIA baseline revision. A forged digest, unknown schema version, non-SEI evaluator, unreadable/noncanonical sidecar, or stale repository/snapshot binding is a fail-closed ASSESS blocker. The sidecar remains evidence only: it cannot mint a health grade, integrity candidate, architecture finding, lifecycle state, or a fourth owner reference.

## Owner envelope and authority

RIA passes the byte-identical closed `{ baseline_ref, engineering_intelligence_ref, sei_assessment_ref? }` envelope to exactly `repository-health-assessment`, `codebase-integrity-audit-loop`, and `architecture-improvement-intelligence --assessment`. Each child consumes available evidence read-only and returns its own reference plus an identical binding echo. Health retains grade authority, Integrity retains candidate authority, and Architecture retains judgment authority.

The RIA projection carries the RIA-owned evidence reference and optional SEI assessment evidence alongside exactly three owner references. It never adds SEI to `assessment_refs`, production runtime fields, remediation-graph input, a supporting-artifact list, or a lifecycle return.


Legacy `.autonomous-loop/assessment-artifacts/engineering-intelligence/` state may be read and explicitly migrated after byte/hash/binding verification; new writes use the project-intelligence workspace only.
