# HTML Report Format

One **genuinely self-contained** HTML file in the OS temp directory: embedded CSS, no CDN, no external font, no network at view time. The report is opened from a `file://` path on a machine that may be offline or behind a proxy, so a Tailwind `<script src>` there produces an unstyled page. Start from [`assets/report-scaffold.html`](assets/report-scaffold.html) rather than building the shell each run — it carries the section order, the design system, and every required placeholder, which is also what keeps generated reports from drifting apart.

No Mermaid either. This report has no graph-shaped content, and a forced diagram is worse than none.

The health report and the architecture report are deliberately **not** the same document. The architecture report is an editorial design review; this one is an instrument panel. What they share is the design-token vocabulary, the JSON-island discipline, and the verification chip — so they read as one family without pretending to be one document.

## The island is the report

One JSON island — `<script type="application/json" id="health">` — holding `repository`, `verification`, `coverage`, `lanes`, `claims`, `grade`, `candidates`, and optionally `previous`. Shape is defined in [`assets/health.schema.json`](assets/health.schema.json) (schema v4).

Paste the body of [`assets/health-verify.js`](assets/health-verify.js) into the scaffold verbatim (export-free classic script) and call `HealthVerify.runHealth({})` once the DOM is ready. When the island carries candidates, paste the body of `shared/candidate-ledger-spine/ledger-verify.js` **first** — candidate scoring is verified by the shared spine module and must never be re-implemented here. `health-verify.js` reports `ledger-module-missing` if you forget, which is the intended behavior.

The schema file is the specification; the verifier compiles its load-bearing rules so a self-contained report can enforce them offline without bundling a validator. That duplication is deliberate and tested. [`assets/parity-check.js`](assets/parity-check.js) runs a 67-mutation sabotage corpus through **both** layers and records which owns each rejection — the verifier must reject all of them, and the handful that JSON Schema structurally cannot express (cross-references, locked weights, derived baseline, delta continuity) are listed as verifier-owned on purpose rather than left as silent gaps. It needs `ajv` and is a development tool; nothing in a generated report loads it.

```bash
# Fast dependency-free boundary check
node assets/package-check.js ../shared/candidate-ledger-spine/ledger-verify.js

# Full schema/runtime parity corpus
npm install ajv
LEDGER_VERIFY_PATH=../shared/candidate-ledger-spine/ledger-verify.js node assets/parity-check.js
```

**Do not re-derive the renderer, and never hand-write a number.** Every displayed figure — the grade letter, weighted coverage, lane scores, dimension contributions and their claim references, cap triggers, confidence inputs, run-to-run deltas — renders from the island through the module.

## Required placeholders

Binding completeness is **verified**, not trusted. A report that omits panels does not pass, because verification that only checks what is on the page is not verification.

| Attribute | Renders | Required |
| --- | --- | :---: |
| `[data-verify-chip]` | Masthead verdict chip | exactly one |
| `[data-grade]` | Grade letter, interpretation, confidence, coverage, raw score, baseline | exactly one |
| `[data-caps]` | Each fired cap with ceiling, trigger, and whether it binds | exactly one |
| `[data-coverage]` | One row per surface — weight, state, credit bar — plus the recomputed footer | exactly one |
| `[data-confidence]` | The six confidence inputs with weights and contributions | exactly one |
| `[data-verify-problems]` | The problem list when verification fails | exactly one |
| `[data-lanes]` | Dynamic lane-scorecard host | exactly one; `runHealth` creates one card per verified lane |
| `[data-lane="<lane-id>"]` | Generated lane scorecard | **one per lane in the island** |
| `[data-candidates]` | Candidate ledger section, containing `[data-ledger]`, `[data-score-legend]`, `[data-ledger-chip]` | when candidates exist |
| `[data-baseline]` | Baseline command records | exactly one |
| `[data-decision-blockers]` | Unavailable surfaces and blocked candidates | exactly one |
| `[data-roadmap]` | Highest weighted coverage gaps | exactly one |
| `[data-handoff]` | Candidate routing counts and IDs | exactly one |
| `[data-delta-panel]` | Run-to-run delta | when `previous` exists |

`runHealth` creates lane cards from the island inside `[data-lanes]`; do not hand-maintain a six-lane list. A lane in the island with no scorecard is `binding-lane-missing`. A scorecard for a lane not in the island is `unknown-placeholder`. Two scorecards for one lane is `binding-duplicate`.

**Candidate rows are counted, not assumed.** `runHealth` renders the candidate ledger from the same `#health` island by handing the candidates to the spine module's own renderers, then checks that the number of rendered `[data-ledger-row]` elements equals the number of candidates in the island (`binding-candidate-rows`). Do **not** call `LedgerVerify.runLedger()` here: it reads its own `#ledger` island, which this report does not have, and an earlier scaffold did exactly that — producing a green health chip above a permanently empty candidate panel. One island, delegated renderers, counted rows.

**A red chip means the report does not ship.** Fix the island or the arithmetic and re-render.

Regression fixture: [`assets/health-verify.test.html`](assets/health-verify.test.html). Open it in a browser; the banner is green only when every assertion passes, including every sabotage case being rejected. Keep it green if you change the module.

## Section order

1. Executive summary
2. Overall grade and confidence
3. Repository surface inventory
4. Weighted coverage map
5. Lane scorecards
6. Verification baseline
7. Architecture and integration health map
8. Grade drivers
9. Confirmed risks, inferences, and unknowns
10. Candidate ledger
11. Human-decision blockers
12. Improvement roadmap
13. Run-to-run health delta
14. Handoff to the architecture and integrity skills

Sections 2 and 4 are the ones a skimmer reads. Put the grade, its interpretation, the confidence, and the coverage percentage in the masthead. **Never render the grade without the coverage figure adjacent to it** — a grade alone is the single most misreadable artifact this skill produces, and a letter quoted without its confidence and coverage is a misuse of the report.

Section 9 keeps confirmed facts, inferences, and unknowns in three visually distinct groups. Merging them is how an inference becomes a fact between the report and the roadmap.

## Design system — roles, not raw hex

Defined once in the scaffold's `<style>` block, keyed by the job each colour does. Both modes are selected and validated against their own surface rather than auto-inverted (secondary ink is `#52514e` on light but must become `#c3c2b7` on dark, where `#52514e` reaches only 2.19:1).

Rules that hold everywhere:

- **Grade letters carry a word.** `C — partial; controls exist but coverage or enforcement is inconsistent`, never a bare coloured letter. Status colour is never the only carrier of meaning.
- **One hue for magnitude.** Coverage bars, dimension contributions, and confidence inputs are all `--accent`. Grade colours are status, not a series. Never introduce a fourth decorative hue.
- **Dimension bars encode contribution against the dimension's own weight**, so a 5%-weight dimension can never visually outweigh a 30%-weight one. The module does this; do not restyle it into a uniform-width bar.
- **Uninspected surfaces render at full row weight**, not greyed into the background. The gap in the assessment is the finding.
- Typography split: headings and page prose in serif; every number, label, chip, and axis in mono.

## Tone

Plain, declarative, and specific about uncertainty. State what was confirmed, what was inferred, and what was not looked at, in those words.

**Write:** "Contracts scored 48.75 — two hand-maintained schema representations, no CI comparison." · "Weighted coverage 59.7%; the CUDA path was not inspectable." · "Grade capped at C by an untrustworthy baseline."

**Never write:** "generally healthy" · "some issues were found" · "overall the codebase is in good shape" · "further investigation recommended" without naming the surface, the weight, and what inspecting it would change.

No hedging and no throat-clearing. A health report that reads as reassuring when the evidence is thin has failed at its only job.


## Required authored prose

Elements marked `data-prose-required` must be replaced with repository-specific prose before shipping. Empty elements, `TODO`, and scaffold sentinels produce `binding-unresolved-placeholder`. Repository name, revision, generation time, baseline commands, blockers, roadmap, and handoff counts are rendered from the island rather than authored by hand.
