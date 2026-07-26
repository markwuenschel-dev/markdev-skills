# Migrations

## Health island v3 → v4

v4 is a breaking contract revision. It keeps the health grade formula and shared candidate scoring formula unchanged, but closes report-integrity and handoff gaps.

1. Set `health_schema_version: 4` and `spine_version: 3`.
2. Add top-level `generated`.
3. Add `repository.name`, `repository.revision`, and `repository.freshness_evidence` with `assessment_revision`, `head_revision`, `working_tree_clean`, and `observed_at`.
4. Add a stable `command_id` to every verification command.
5. Add one or more `{kind, ref}` `evidence_refs` to every coverage surface.
6. Emit complete shared-spine v3 candidates: `summary`, `root_cause`, complete `rollup`, `effort`, `depends_on`, `unlocks`, `status`, and `dedup`, in addition to health provenance.
7. For prior candidates that disappear, record a status-specific terminal resolution:
   - `completed`: `completed_at` and non-empty `verification_refs`
   - `superseded`: `superseded_by`
   - `rejected`, `deferred`, or `out-of-scope`: `reason`
8. Replace static lane cards in custom report shells with one `[data-lanes]` host.
9. Fill every `data-prose-required` block. Empty prose turns verification red.

The grade thresholds, dimension weights, lane weights, baseline ceilings, and priority formula did not change.
