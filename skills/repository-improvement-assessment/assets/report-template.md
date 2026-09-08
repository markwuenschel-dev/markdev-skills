# Repository Improvement Assessment — ASSESS Report

Baseline: `{{baseline_id}}`
Revision: `{{revision}}`
Mode: `{{mode}}`

## Executive Assessment

Synthesize the repository-wide condition from the three validated owner artifacts. This is a read-only presentation judgment, not a new grade or candidate owner.

## Health

Summarize the health-owned grade, coverage, confidence, caps, and highest-leverage health findings. Preserve canonical health IDs and attribution.

## Integrity

Summarize the integrity-owned candidate set, highest-priority defects/seams, evidence certainty, and blocked human decisions. Preserve canonical candidate IDs and scores.

## Architecture

Summarize the `architecture-improvement-intelligence --assessment` findings and strongest viable structural opportunities. Preserve architecture owner IDs and do not turn this summary into implementation authorization.

## Cross-Cutting Synthesis

Identify relationships that span two or more owner artifacts. Attribute every component to its canonical owner. Cross-owner synthesis may connect findings; it may not merge identities or overwrite owner conclusions.

## Highest-Leverage Priorities

Present a human-readable cross-owner priority view derived from the validated artifacts. Each item names its source owner, canonical ID when available, why it matters, and downstream disposition. This presentation order does not replace canonical owner scoring or remediation-graph authority.

## Evidence Certainty and Gaps

Separate confirmed, inferred, unknown, and coverage-gap statements. Negative claims retain their coverage receipts through the owner evidence artifacts.

## Downstream Disposition

Group presentation-only dispositions such as ready, needs Expanded Grill, needs Decision Terrain Mapper, needs Prototype, or blocked. This is not a lifecycle transition or action-set selection.

## Coverage and Provenance

Record the baseline, repository revision, surface inventory, command records, index/reuse decision, the one opaque RIA-owned `engineering_intelligence_ref`, optional verified `sei_assessment_ref`, and exactly the three canonical `{ owner, artifact_id, sha256, repository_revision }` references. The evidence reference's `baseline_binding`, optional SEI `snapshot_binding.revision`, and each owner revision must match the report baseline.

## Assessment Status

State whether all three canonical owner references are present and hash-bound. Missing, stale, copied, or malformed references are a fail-closed ASSESS result.

## Next Lifecycle

Return the ASSESS projection to the invoking caller. Reconciliation and production delivery require separate explicit invocation and authorization; graph topology, action execution, verification, integration, publication, and merge are outside this report.
