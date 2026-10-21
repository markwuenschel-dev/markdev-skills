# Architecture Improvement Intelligence HTML Report

The HTML report is an **optional deterministic renderer** over the canonical architecture candidate set and verified candidate ledger. It is not the source of truth and is not required for every AII run.

The machine may **recommend** generation when multiple candidates benefit from visual comparison or a durable selection surface, but rendering occurs only after `shared/report-election` resolves to `generate` (or an inherited parent explicitly authorizes generation).

## Zero-network requirement

The shipped report must be self-contained and require **no view-time network access**. Do not use Tailwind CDN, Mermaid CDN, remote fonts, remote scripts, analytics, or external runtime assets.

The current deterministic builder uses `assets/report-scaffold.html`, embedded CSS, static HTML transform panels, the canonical ledger island, and the shared ledger verifier. `assets/mermaid-safe.js` and its historical browser fixture are retained only for compatibility/testing of legacy graph rendering; V2 production reports do not require a browser graph renderer.

## Source of truth

1. `assets/architecture-candidate-set.schema.json` defines the architecture artifact.
2. `shared/candidate-ledger-spine` owns candidate identity, score arithmetic, eligibility, and ranking.
3. `assets/report-input.schema.json` is a presentation input projection.
4. `assets/build-report.js` compiles presentation data into a static report.

No score may be handwritten into prose and treated as canonical.

## Candidate cards

For each candidate render:

- candidate number/rank;
- title and transformation category;
- affected files/modules;
- structural problem;
- proposed transformation;
- benefits in terms of locality/leverage/authority/interface burden;
- before/after static transform visual;
- ADR/conflict note where relevant;
- recommendation strength derived from the canonical ledger;
- verification chip from the ledger verifier.

The before/after panel is generic. It may represent merge/deepen, split, seam relocation, adapter isolation, state-owner consolidation, duplicate-path removal, or another eligible transformation. Do not force every "after" state to be a single deep module.

## Deterministic build

```bash
node assets/build-report.js --repo <repository-root> --input <architecture-report-input.json> --output <architecture-review.html>
```

The builder must:

- verify the ledger before rendering;
- escape prose;
- inline the ledger as safe JSON;
- write atomically via the shared report compiler;
- create no repository files;
- perform no view-time network work.

A red/failed verification state means the report does not ship.

## Styling

Keep the existing editorial architecture-review design: serif masthead/rank rail, mono metrics, soft surfaces, accessible light/dark tokens, sequential magnitude encoding, and status labels that never rely on color alone.

Visual style is presentation only; it must not change ranking or candidate semantics.

## Shared responsive analytics requirement

This report consumes `shared/report-presentation`. It must use the available viewport rather than a fixed narrow desktop column: single-column on phones, progressively denser analytical grids on tablets/desktops, and a wide/ultrawide dashboard canvas on large displays. Narrative prose remains line-length bounded; extra width is used for scorecards, charts, ranked tables, evidence panels, and side-by-side comparisons.

When canonical quantitative data exists and visualization improves comparison, render it through the shared zero-network SVG primitives. Do not invent scores to fill a chart. Missing values are displayed as unavailable or `Not scored`. The report must carry `data-report-responsive="1"` and pass the shared responsive-presentation gate before shipping.


When `--output` is omitted, the renderer writes to the repository-local `.project-intelligence/reports/` namespace via `shared/project-intelligence-workspace`. Pass `--repo` when the current working directory is not the assessed repository.
