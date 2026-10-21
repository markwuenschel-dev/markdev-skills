# Parallel report mode

Loaded from SKILL.md when `--parallel-report` is set. This mode replaces Stages 1–2 with a read-only **Repo Audit Swarm** and ends the invocation at the Stage 3 candidate gate. Analysis only: the repo is inspected, never edited — the mandatory output is the standalone candidate ledger; HTML is written only when the report election resolves to generate, plus any output files the user explicitly named.

## Flow

1. Load `PERFORMANCE.md` and the shared ThreadPool execution contract, then invoke `human-directed-swarm-planner` only for the **Repo Audit swarm** topology/merge contract.
2. Derive non-overlapping read-only evidence packets from the repository surface inventory. The historical audit lenses are coverage families, not worker assignments; split them by independent subsystem/language/runtime/hotspot until the bounded pool has enough READY work to stay saturated.
3. Submit every READY packet before awaiting one. Consume packet results as they complete and immediately refill free worker slots; do not impose a whole-wave barrier.
4. The captain incrementally merges evidence, then emits and verifies one standalone shared-spine v3 ledger after all required packets settle. Workers return evidence, claims, proposed candidates, and uncertainty; the captain alone deduplicates and scores.
5. Apply `shared/report-election`: ask once if direct and unspecified, or inherit the parent policy. If elected, render the candidate-discovery HTML from the same ledger. Print the ledger path and, when present, report path; then stop at the candidate gate.

**Non-recursion.** When this mode is itself running as one lane of `human-directed-swarm-planner`'s **RIA Assessment Topology** (its SWARM-TYPES.md `## RIA Assessment Topology` heading), step 1 above does not apply: this invocation does not re-enter `human-directed-swarm-planner` to run its own Repo Audit lane structure. Instead it runs that same Repo Audit lane structure in place, under the RIA captain already coordinating this run, and step 4's candidate gate is suppressed — the RIA captain owns candidate-gate timing for the whole assessment, not this lane alone. This mirrors the non-recursion rule `decision-terrain-mapper` and `architecture-improvement-intelligence` already apply to their own dispatched children.

**Wave-0 baseline.** Under an RIA lane assignment, adopt the assessed revision, surface inventory, and command-baseline records the RIA captain supplied instead of re-establishing them (`repository-health-assessment/SKILL.md` §§1–2, 4 make the identical adoption explicit for the sibling lane; the rule here is the same one). RIA supplies the closed `{ baseline_ref, engineering_intelligence_ref, sei_assessment_ref?, verification_baseline_ref, presentation_policy: "inherit", candidate_namespace: "integrity" }` envelope (`shared/ria-owner-return/owner-return.schema.json` `input_binding_echo`). Resolve `engineering_intelligence_ref` and an optional verified `sei_assessment_ref` only as closed, hash-verified baseline-bound evidence; they may inform claims but never transfer candidate authority, ranking, score, or selection from this lane. Echo every supplied binding exactly, `candidate_namespace` included, with the integrity-owned return reference. Mint candidate ids only with the `integrity:` prefix (the supplied `candidate_namespace`). **Adopt upstream candidates:** Health ledger rows routed to integrity enter this ledger keeping their `candidate_id`, `lane_sources`, and `claim_refs` unchanged — an adopted `health:` id is never re-minted; RIA rejects ids that two owners minted independently (`CANDIDATE_ID_CROSS_OWNER_DUPLICATE`).

## Report and ledger artifacts

Resolve the repository-local workspace through `shared/project-intelligence-workspace`. Write the canonical ledger first under `.project-intelligence/assessments/integrity/ledgers/` with `assets/write-ledger.js --repo <repository-root>`. If the report is elected, write it under `.project-intelligence/reports/integrity/` from the same structured input. The HTML embeds the exact ledger as `<script type="application/json" id="ledger">` for browser verification, but that island is a read-only projection copy; the standalone JSON is the machine handoff. Paste the body of `shared/candidate-ledger-spine/ledger-verify.js` into the report scaffold verbatim and call `LedgerVerify.runLedger({})` once the DOM is ready; never hand-write a score, count, or candidate array into report prose. A red generated report does not ship. A skipped report does not invalidate the standalone ledger.

## Hard rules

- Read-only: production code, tests, configs, generated artifacts, docs, and fixtures are inspected, never modified. Report/ledger artifacts are the only writes.
- The invocation ends at the candidate gate — even a trivially fixable candidate waits for selection in a later loop.
- Every candidate satisfies REPORT-SCORING.md's Evidence rule.
- Human-decision blockers are named against connected-impact-sweep's `## Human-decision categories`.
- Broad-cleanup opportunities are recorded as rejected-out-of-scope findings, exactly as in a normal Stage 2 report.

## After the report

The emitted standalone ledger is the normal Stage 2 output. A later invocation resumes at Stage 3 (candidate gate) in manual mode, or in auto mode only when the user explicitly passes `--auto` against this ledger — `--parallel-report` itself never selects a candidate. Under an RIA lane assignment, the child uses `presentation_policy.report: inherit`, returns its ledger to the RIA captain without its own election, and the candidate gate happens once at the end of the whole assessment.
