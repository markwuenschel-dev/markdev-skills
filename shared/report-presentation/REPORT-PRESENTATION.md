# Shared responsive report presentation

`shared/report-presentation` owns the zero-network responsive layout and analytical visualization primitives used by user-facing HTML reports.

## Invariants

1. Reports use the full viewport intelligently. The analytical canvas may grow to 3000px on large/ultrawide displays and supports four analytical panels across above the ultrawide density threshold while narrative prose remains bounded to a readable measure.
2. Quantitative information is visualized when comparison materially benefits. Missing values are labeled `Not scored` or `Unavailable`; never invent a number to fill a chart.
3. Generated reports are self-contained. No runtime CDN, remote font, external image, stylesheet, script, or analytics dependency is permitted.
4. Mobile, tablet, laptop, widescreen, ultrawide, print, keyboard, and screen-reader behavior are part of the report contract.
5. Canonical artifacts remain authoritative. Charts and tables are read-only projections from validated numbers.

## Responsive density tiers

- phone: one analytical column;
- tablet/small laptop: one to two columns;
- standard desktop: two to three analytical columns;
- large desktop/ultrawide: three to four analytical columns and expanded comparison tables;
- prose retains an approximately 82-character line measure instead of stretching across the canvas.

Report builders embed `responsiveCss()` and `progressiveScript()` into the final HTML and mark the root shell with `data-report-responsive="1"` and `class="rp-shell"`.

## Available primitives

- metric cards;
- horizontal score/ranking bars;
- stacked distribution bars;
- donut distributions;
- phase/runtime timelines;
- score/grade gauges;
- responsive tables, legends, details, and chart grids;
- zero-network and responsive report quality checks.
