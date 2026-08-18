# Migrations

## v5.1 → v5.2: shared Evidence Recon sidecar

Health island schema remains **v5** and candidate spine remains **v3**. This is an additive package integration, not a grading-schema migration.

- Install `shared/evidence-recon` v1 beside the skill.
- A full health run projects its validated health island through `assets/evidence-recon-projection.js`.
- Preserve RHA's eleven-surface inventory, criticality weights, weighted-coverage formula, lane scorecards, caps, and confidence exactly as before.
- Treat projected negative observations conservatively. They remain unresolved unless the current run supplies an explicit negative-claim receipt with scope, methods, completeness, exclusions, sources, and sufficient coverage/evidence quality.
- Emit the generic packet beside the HTML report or in the parent orchestration envelope; do not write it into the assessed repository.
- Downstream skills may consume `handoff.safe_to_assume`, `unresolved_facts`, `owner_intent_required`, and `possible_decision_surfaces`, but must retain their own decision-coverage or assessment-coverage sweep.

Existing v5 health islands remain valid. A missing Evidence Recon dependency now blocks the generic sidecar and package release check; it never licenses local reimplementation or hand-edited health arithmetic.

## Health island v4 → v5

v5 is a breaking contract revision. It keeps the health grade formula and shared candidate scoring formula unchanged — `HEALTH_SPINE_VERSION` stays 3, the shared candidate spine is untouched — but closes a sprawl-visibility gap: an island could report clean lane scores while stale, duplicated, or unowned reachable code sat unmentioned anywhere in the evidence.

1. Set `health_schema_version: 5`. `spine_version` stays `3`.
2. Add the required top-level `sprawl_pressure` object: five evidence arrays — `stale_reachable_paths`, `competing_authoritative_implementations`, `duplicated_contract_representations`, `unowned_compatibility_layers`, `abandoned_reachable_experiments` — plus two enums, `automated_sprawl_checks` (`none | partial | enforced`) and `assessment` (`low | moderate | high`). Empty arrays are valid; the key itself is not optional.
3. Every `sprawl_pressure` evidence entry carries a `claim_id` that must resolve to a claim in `claims[]` belonging to the `architecture-fitness` or `maintainability-and-ownership` lane (`sprawl-claim-unknown`, `sprawl-claim-foreign`). This is evidence, not a new lane: it carries no `criticality_weight`, contributes nothing to `overall_raw`, and triggers no cap.
4. `competing_authoritative_implementations[].members` and `duplicated_contract_representations[].locations` each require at least two entries — a single implementation cannot compete with itself, and a contract represented once is not duplicated.
5. Add the `[data-sprawl]` placeholder to custom report shells, immediately after `[data-lanes]`. `runHealth` renders it from the same island via `renderSprawlInto`; a report missing it fails binding (`binding-missing`).
6. If the repository genuinely has no sprawl findings, that is `assessment: "low"` with empty arrays and `automated_sprawl_checks` stating what (if anything) would catch one — never an omitted block.

The grade thresholds, dimension weights, lane weights, baseline ceilings, and priority formula did not change. `sprawl_pressure` informs the `architecture-fitness` and `maintainability-and-ownership` lane claims; it does not add a thirteenth lane or a seventh dimension. See [HEALTH-GRADING.md](HEALTH-GRADING.md#code-sprawl-pressure-as-lane-evidence).

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

## v5.3 — user-elected reports

The validated health island, candidate ledger, and Evidence Recon sidecar are now complete before presentation. Direct runs use `shared/report-election`; nested RIA runs inherit the parent report owner. Skipping HTML no longer affects grading or handoff semantics.
