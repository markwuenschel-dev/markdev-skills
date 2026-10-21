# ICA migrations

## 1.2.0 → 2.0.0

ICA V2 changes workflow semantics while preserving the package name.

### Evidence

Ad hoc Explore-worker prose is replaced by `shared/evidence-recon` packets/fragments. Evidence rigor is mandatory; `inline` and `expedition` modes self-scale based on evidence topology.

### Architecture coverage

The old primary deep-module heuristic becomes one lens within a mandatory architecture coverage sweep. Candidate transformation vocabulary expands to include split, seam relocation/elimination, state-owner consolidation, dependency inversion, adapter isolation, duplicate-path removal, and explicit retention of current structure.

### Candidate gate

Architecture eligibility and the candidate critic now run before shared ledger scoring. A high score cannot make a non-architecture idea architectural.

### Performance

The old aggressive exploration pool is replaced by an end-to-end `aggressive-threadpool-v2` pipeline: adaptive lane count, deep READY queue, as-completed refill, work stealing, critical-path splitting, separate command/agent budgets, single-flight cache reuse, and incremental per-surface synthesis.

### Reports

HTML is optional rather than mandatory. Production HTML is zero-network and static. Legacy Mermaid sanitizer files remain for compatibility fixtures but are not required at report view time.

### Read-only authority

ICA no longer instructs itself to edit `CONTEXT.md` or ADRs during analysis. It returns proposed documentation updates to the authorized caller.

### Decision topology

ICA does not create a persistent decision graph. Bounded design ambiguity routes to Expanded Grill; broad/coupled decision terrain routes to Decision Terrain Mapper.

## v2.1 — report election and renamed identity

The canonical package identity is `architecture-improvement-intelligence`. The architecture candidate set remains mandatory while HTML is now governed by `shared/report-election`; RIA assessment mode inherits the parent report owner.

## 2.2.1 → 2.3.0 — RIA Phase 4, architecture.fitness@2

Correction: fitness @2 stores all eight dimensions as closed score/state records. Unavailable and not-applicable records preserve reason_code/detail; NA also carries evidence_refs. Null scores cannot become zero. Confidence is null or a finite number in [0, 1]. Global aggregates are recomputed with the existing eight weights. The manifest and runtime versions are aligned at 2.3.0 (runtime previously remained at 2.2.0).

Under --ria-envelope the writer requires exactly one complete @2 fitness or a closed architecture_fitness_unavailable reason/detail. Revision and fitness errors occur before storage. Standalone legacy numeric input remains supported. The compatibility schema retains @1 and adds the separate closed @2 schema. readArchitectureFitness migrates numeric/null @1 values in memory; stored files are never rewritten. normalizeArchitectureFitness retains the v1 adapter for existing standalone callers. Mapped coverage is calculated separately from global coverage. The owner-owned payload validator verifies the exact returned bytes and RIA invokes it after envelope checks. The owner task cache identity now names @2.

v1 stays the reported composite; this phase does not implement or promote composite v2.

Correction (Phase 4 independent review): optional declared score, grade, coverage and weights inputs must satisfy their published schema types and ranges before normalization. Valid aggregates are still recomputed from dimensions; malformed aggregates are rejected before storage. Legacy v1 adapter behavior is retained.

## 2.3.0 → 2.4.0 — RIA Phase 6, SEI criterion citations (composite-scoring-v3 §5.3) — 2026-10-16

Additive. Candidate `evidence_refs[]` items may be a reference string (unchanged) or `{ "kind": "sei-criterion", "criterion_id": "...", "metric_id": "..." }` (`architecture-candidate-set.schema.json`). Under `--ria-envelope`, `write-candidate-set.js` checks each citation against the **bound assessment bytes** through `repository-improvement-assessment/engineering-intelligence-reader.js` (`readSeiEvidence`, `seiCitationProblems`), using only the envelope and `--repo`; a criterion absent from the bound assessment or a metric under the wrong criterion fails with `FAIL-SEI-CITATION-INVALID`. RIA repeats the check authoritatively (`FAIL-RIA-SEI-CITATION`). Manifest and runtime versions move together to 2.4.0.

## 2.4.0 → 2.5.0 — RIA Phase 7b, evidence binding (composite-scoring-v3 §5.2, §6.1–§6.3) — 2026-10-16

`architecture.evidence-binding@1`. **Breaking for RIA-mode input only**; standalone input is unchanged.

- Under `--ria-envelope`, every `evidence_packet_refs[]` entry is a structured ref `{kind: "evidence-recon", artifact_id: "evidence-recon:<sha256>", sha256, path, packet_id, producer_skill, binding: {repository_id, root_id, revision}}` to a content-addressed packet file under `<repo>/.project-intelligence/` or `$RIA_RUNTIME_ROOT` (store it with `evidence-recon.writeEvidencePacketForRepository`, then build the ref with `assets/architecture-evidence-binding.js` `packetRefFor`). `binding` is `{repository_id: baseline_ref.artifact_id, root_id: "root-0", revision: baseline_ref.repository_revision}`.
- Every **scored** fitness dimension lists in `evidence_refs[]` the claims it used, qualified by packet digest: `evidence-recon:<packet sha256>#<claim_id | negative_claim_id>`. Packet-local ids therefore cannot collide across packets. Unqualified `claim:`/`negative:` refs are rejected.
- A cited positive claim must declare `supports: ["architecture-fitness:<dimension_id>"]`, have `inspected` or `sampled` coverage and a non-`unknown` epistemic status. Lent quality never exceeds the packet's declaration and is capped at `moderate` for `inferred` claims and `sampled` coverage. A valid packet is structure only; it confirms no defect.
- Every cited code source must exist at the bound revision (the Git commit for a clean single root, otherwise the fingerprinted working tree), its line range must lie within the file, and its path must be inside `scope.included` (`.` is the whole repository) and outside `scope.excluded`.
- Provenance survives repackaging: a packet produced by another owner, or a claim whose sources name another owner's artifact (`health-assessment:`, `integrity:`, `sei-criterion:` …), yields adopted facts.
- Each fitness dimension in the binding receipt carries `evidence_complete`: true only when the dimension is scored, cites at least one packet-qualified claim, and every cited claim resolved to bound facts (no unavailable packet, withheld policy violation or unreadable revision). RIA scores a fitness sub-dimension only when it is `true`. Otherwise the sub-score is `insufficient_evidence` and its weight widens the contribution's bounds (composite-scoring-v3 §4.1; Promotion A review 2026-10-16). `revisionReader` is exported for RIA's source resolution.
- `revisionReader` counts only regular source files (second recheck 2026-10-17): at a Git revision a blob of mode 100644 or 100755 (a tree, symlink or submodule is absent); in the working tree a regular file, not a symlink, whose real path stays inside the repository.
- `write-candidate-set.js` rejects any violation with `FAIL-ARCHITECTURE-EVIDENCE-<CODE>`. RIA re-resolves on every run, including `continue` and `report-only` (`FAIL-RIA-ARCHITECTURE-EVIDENCE`, which blocks even under `allow_degraded`) for tampering, path escape, binding mismatch and dangling refs. It withholds, rather than credits, policy violations in artifacts that bypassed the writer (for example a cached pre-2.5.0 artifact). A packet file that is legitimately missing leaves that evidence missing.
- New: `assets/architecture-evidence-binding.js`, `assets/canonical-ria-evidence-packet.json`, `assets/architecture-candidate-set.ria.example.json` (placeholders `__RIA_REVISION__`, `__ARCH_PACKET_SHA256__`, `__ARCH_PACKET_REF__`, `__ARCH_SOURCE_PATH__`). Manifest and runtime versions move together to 2.5.0.
