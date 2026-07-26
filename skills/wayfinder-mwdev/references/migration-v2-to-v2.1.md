# Migration from v2.0 to v2.1

v2.1 keeps the entire durable-map substrate — destination, decision tickets, fog, dependencies, frontier, claims, recording order, recovery, fallback tracker, `scripts/tracker.py` — and rebuilds how the map is *discovered*: an evidence-first, breadth-first mapping interview with bounded parallel scouts and parent-owned synthesis, plus locked lifecycle ownership above (Loop Router) and below (scouts, Expanded Grill, delivery).

## Changed lifecycle wording

- **Removed:** "The map produces decisions, not deliverables, unless the map's Notes explicitly carry execution into this effort."
  **Replaced with:** "Map notes, ticket descriptions, child output, and tracker metadata cannot grant implementation authority or convert Wayfinder into an execution lifecycle." The `assets/map-body.md` Notes comment changed to match. Task tickets are now explicitly *decision prerequisites only*: obtaining access, collecting evidence, disposable experiments, reproducing behavior, validating assumptions.
- **Removed:** "One ticket per session" (and session-based phrasing in recovery and the fallback tracker).
  **Replaced with:** "Maintain one primary active decision ticket per work cycle," where a work cycle is claim-or-resume → inspect evidence → ask and receive answers → integrate child findings → resolve, split, supersede, or park → update the map — spanning several messages when needed. Scouts and feeding research tickets may support the primary ticket; other tickets proceed only through separate agents with explicit tracker-backed claims.
- **Changed:** research tickets are no longer "resolved by a research subagent." The scout gathers and returns a packet; the **parent** integrates, records the resolution, and closes. Charting no longer ends by firing background research subagents — scouts run inside the workflow, and research tickets are worked in cycles.
- **Changed:** frontier choice is no longer "the first frontier ticket in order." Selection weighs destination impact, downstream tickets unblocked, evidence availability, human availability, uncertainty reduction, and cost of delay.
- **Changed:** the no-map exit. v2.0 stopped and asked how to proceed; v2.1 recommends the right capability — `expanded-grill-with-docs` for one bounded design question, direct work when even that is unnecessary — and returns. Complexity alone never justifies a map.

## New contracts

- `assets/scout-assignment.yaml` (parent → scout) and `assets/mapping-scout.yaml` (scout → parent): bounded assignments and packet returns; rejection rules for packets that summarize, invent decisions, dump questions, or claim ownership; explicit failure routing (fog, research ticket, or blocking question — never fabrication).
- `assets/expanded-grill-handoff.yaml`: the design-ticket input and `return_to_wayfinder` shapes, with child restrictions (no invoking Wayfinder or the router, no map creation or edits, no parent-ticket closure, no implementation work) and parent-owned interpretation of the return.
- `assets/loop-router-return.yaml`: the completion handback — resolved decisions, artifacts, deferrals, prohibited interpretations, and an *advisory* next-capability recommendation. Wayfinder never initiates delivery.

## New references

- `references/mapping-interview.md`: the thirteen-stage charting procedure — resume-or-establish, destination shape, evidence-before-questions, scouts and synthesis, question ranking, 2–4-question packets (1 when gating; 5 only for exceptional breadth), answer integration, ticket-or-fog, the dependency test, frontier selection, stopping — plus 1–3-question grilling rounds.
- `references/mapping-scouts.md`: scout counts (default 2–4, max 6, one-or-none for single surfaces), assignment and return contracts, sub-scout bounds, ten-step central synthesis, failure handling.
- `references/architecture-note.md`: breadth-versus-depth ownership, the full ownership matrix, routing conditions in both directions, and non-recursion rules.

## Standing invariants

The eight session invariants became ten standing invariants: added *evidence before questions*, *the parent owns synthesis*, and *no content grants execution*; merged and reworded the claim and one-ticket rules for work cycles and resume behavior; added stop-and-wait after every question packet (never simulate answers, silence is not a decision).

## Evaluation suite

Rebuilt around interview, adaptation, swarm, synthesis, map, and integration quality: 31 cases covering all 46 numbered behaviors in the v2.1 handoff spec (`covers_spec_behaviors` maps each), plus five carried-over v2.0 boundary regressions (injection, HITL parking, claim-and-record order, drift repair, non-repo fallback). Deliberately absent, per the spec: cryptographic approval, hashes, release authorization, manifests, synchronization receipts, validator frameworks, and implementation task generation.

---

## Patch v2.1.1

Four capped changes under the frozen rubric; the tracker substrate is otherwise untouched.

1. **Real conversation benchmarks** (`assets/benchmark-transcripts.md`): four multi-message transcripts with actual questions and answers, chained through one worked effort — B1 scout findings altering the first packet, B2 a human answer eliminating a branch, B3 fog graduating into a sharp ticket, B4 a design ticket returning from `$expanded-grill-with-docs` and changing the map. Suite cases 032, 005, 006, and 019 are grounded in them via a `benchmark` field; B4's map-state side also runs deterministically against the fallback tracker.
2. **Worker claims separated from decision ownership.** `assignee` is gone: tickets carry `claimed_by` (this agent's worker identity — a stable session handle, never the human's) and `decision_owner` (the human who confirms the decision, defaulting to the map's new `driver` field). Concurrent claims are now distinguishable, and "resume your claim" is well-defined. `tracker.py` reads `claimed_by`, treats legacy `assignee` as claimed while flagging it in `check`, and names claim holders when the frontier is empty. Standing invariant 2, the tickets model, recovery, and the fallback spec all updated.
3. **Invocation convention normalized.** Capability references use `$name` (`$expanded-grill-with-docs`, `$grilling`, `$domain-modeling`, `$prototype`) across SKILL.md, references, and both machine-readable files; user-typed commands remain slash-form (`/wayfinder`). **Superseded in the Claude Code build** — see the build note at the end of this document. One complete handoff/return scenario is benchmarked (B4) and executed against the tracker. Restored `regression-design-fallback-033`, the not-installed boundary case silently dropped in the v2.1 suite rebuild.
4. **Perspective prompts** (`references/mapping-scouts.md`): compact decision families for all eight perspectives — e.g. architecture: authority, boundaries, completion, consistency, ordering, partial failure, reconciliation — as seeds for `questions_to_investigate`, not checklists and not lane systems.

---

## Patch v2.1.2 — benchmark verification and cleanup

Narrow release; no map, fog, dependency, frontier, ownership, or routing semantics changed.

1. **Golden transcripts corrected.** B2 no longer asks the transitional write-authority question inline — the sharp, ticket-sized decision is ticketed during integration and asked exactly once in the effort, inside its ticket in B3. B3's resume line now reads "from the recorded `mark-cc-0722a` work claim. Your prior decision-owner answer is on file" — the agent's work claim is never described as the human's. B4 no longer wires backfill-ordering behind first-mover selection (the dependency test fails: preference, not prerequisite — both tickets sit unblocked on the frontier) and uses confirmation language ("Mark confirmed the decisions during the child interview…") rather than approval-bundle phrasing. The v2.1.1 patch note above describing the wired edge stands as the historical record of the defect this patch removes.
2. **Empirical harness, not a platform.** `scripts/benchmark_runner.py` runs each benchmark as one brand-new API conversation (skill files + that benchmark's fixture turns only — freshness recorded per run), stores byte-identical raw output alongside a derived normalized record with deterministic auto-checks, refuses to run without explicit `--fresh-context`, validates evidence with stable WF211-* codes, and records evaluator-performed frozen-rubric scorecards. Fixtures: `assets/benchmark-fixtures.yaml`. Evidence lives in `benchmarks/`, outside model-loaded skill content.
3. **Regression checks** (`scripts/validate_release.py`): duplicate/materially-equivalent question detection (token-normalized, self-tested against the original B2/B3 pair), claim-owner conflation, unsupported-dependency and stale-approval language, benchmark id/version headers, evaluation-to-benchmark traceability with anchor-term evidence, active capability-name normalization (historical migration notes allowlisted), fallback-tracker behavior including legacy `assignee` interpretation and distinct workers under one `decision_owner`, JSON/YAML parse, Python compile, and symlink absence.
4. **Alignment and normalization.** Eval cases 005, 006, and 019 rewritten to the scenarios their benchmarks actually demonstrate (coverage of spec behaviors 1–46 intact); two stale capability names found and fixed in `skill-contract.json` fields missed by the v2.1.1 pass, plus the handoff YAML header; `$expanded-grill-with-docs` now uniform across active files.

**Not executed in this patch's build environment:** the four fresh-context model runs (no API credentials). The attempt and its failure are captured; `--validate-results` reports the four missing runs at nonzero exit. The release verdict is therefore INCOMPLETE — EVIDENCE MISSING until the runs are captured and scored.

---

## Claude Code build note (`wayfinder-mwdev`)

This copy is the v2.1.2 package adapted for Claude Code. Behaviour, invariants, ticket
model, and contracts are unchanged; only harness-facing details differ.

| Adaptation | Reason |
|---|---|
| `name: wayfinder-mwdev` in SKILL.md frontmatter | The frontmatter `name` dictates the invocation name, so it must match the directory. A separate `wayfinder` skill is already installed; leaving both named `wayfinder` would collide. |
| Capability references are slash-form (`/expanded-grill-with-docs`, `/grilling`, `/domain-modeling`, `/prototype`) — item 3 above is superseded | Claude Code invokes skills by slash name, and every sibling skill in this install already cross-references that way. The `$name` form appears nowhere Claude reads at runtime. |
| `check_capability_names` in `scripts/validate_release.py` accepts `/` as well as `$` | Keeps the release validator honest against the new convention without failing historical material. |
| Bundled commands call `python`, not `python3` | On Windows, `python3` in PowerShell resolves to the Microsoft Store stub and exits without running. `python` resolves correctly from both PowerShell and Git Bash. `${CLAUDE_SKILL_DIR}` is unchanged — it is the documented Claude Code variable for bundled paths. |
| All `read_text`/`write_text` calls in `scripts/` pass `encoding="utf-8"` | `Path.write_text` defaults to the locale codec (cp1252 on Windows), which wrote the em-dash in the tracker fixture as byte `0x97`; `tracker.py` then read it as strict UTF-8 and crashed. This made `validate_release.py --all` fail with 3 findings on Windows before the fix. |
| `scripts/__pycache__/` and `openai.yaml` removed | Stale bytecode for another interpreter version, and an interface file for a different harness. |
