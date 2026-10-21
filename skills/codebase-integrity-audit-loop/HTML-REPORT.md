# Integrity HTML report contract

The integrity report is an optional user-elected projection compiled from structured data with `assets/build-report.js`. The standalone candidate ledger is canonical and must already validate before this renderer runs. The model supplies one `report_schema_version: 1` input matching `assets/report-input.schema.json`; it does not author a full HTML/CSS/JavaScript document.

The input contains repository identity, a concise summary, a high-level health map, confirmed/inferred/unknown observations, the canonical spine-v3 ledger, one editorial presentation record per `candidate_id`, and the optional performance receipt. The ledger is the only numeric source. Presentation records add category, location, friction, seam, integrity rule, evidence split, before/after framing, branch, lenses, enforceable check, and benefits.

Compile with:

```bash
node assets/build-report.js --input <integrity-report-input.json> --output <integrity-report.html>
```

The builder:

- resolves and executes the shared canonical verifier before writing;
- rejects an invalid ledger, missing presentation, duplicate id, or unknown presentation;
- sorts cards by the verifier's stable rank rather than input order;
- escapes every prose field;
- injects exactly one `<script type="application/json" id="ledger">` island;
- inlines the shared verifier;
- emits static CSS visuals with no CDN, font download, framework compiler, or view-time graph renderer;
- writes atomically and returns path, bytes, and SHA-256.

The browser runs `LedgerVerify.runLedger({})` once. A red chip means the report does not ship. Candidate cards use `content-visibility:auto`, but all candidates remain in the DOM and are included in card-order verification.

## Shared responsive analytics requirement

This report consumes `shared/report-presentation`. It must use the available viewport rather than a fixed narrow desktop column: single-column on phones, progressively denser analytical grids on tablets/desktops, and a wide/ultrawide dashboard canvas on large displays. Narrative prose remains line-length bounded; extra width is used for scorecards, charts, ranked tables, evidence panels, and side-by-side comparisons.

When canonical quantitative data exists and visualization improves comparison, render it through the shared zero-network SVG primitives. Do not invent scores to fill a chart. Missing values are displayed as unavailable or `Not scored`. The report must carry `data-report-responsive="1"` and pass the shared responsive-presentation gate before shipping.
