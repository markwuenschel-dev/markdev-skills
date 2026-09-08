# Handoff: Repository Improvement Assessment (RIA) report page

## Overview

A single-page, read-only analytics report that presents a Repository Improvement
Assessment for the repository `Compounding-Quality-RAG`. It projects four owner
assessments (health, integrity, architecture, software engineering intelligence)
bound to one immutable revision, and presents an overall grade, per-owner scores,
lane scorecards, a ranked candidate portfolio, evidence certainty, a verification
baseline, runtime/performance data, and an appendix of hash-verified bindings.

The page is entirely offline: no network calls, no data fetching, no
authentication. All values are baked in as literals.

## About the Design Files

The files in this bundle are **design references created in HTML** — a prototype
showing intended look and behavior, **not production code to copy directly**.

`Repository Improvement Assessment.dc.html` is authored against a bespoke
in-house streaming-template runtime (`support.js`) that is specific to the design
tool it was made in. Do **not** port that runtime. Treat the HTML as a visual and
structural specification.

The task is to **recreate this design in the target codebase's existing
environment** (React, Vue, Svelte, plain templates, etc.) using its established
patterns, component library, and styling approach. If no environment exists yet,
pick the most appropriate framework for the project and implement it there.

Two notes specific to this design:

- All styling in the prototype is **inline** — a constraint of the authoring
  runtime, not a design intent. In a real codebase, move these to whatever the
  project uses (CSS modules, Tailwind, styled-components, a stylesheet). The
  token table below is the source of truth.
- The template uses custom control-flow elements (`<sc-for>`, `<sc-if>`). These
  are just `map` and conditional rendering. Replace them with the framework's
  native equivalents.

## Fidelity

**High-fidelity.** Final colors, typography, spacing, and interaction states are
all specified. Recreate the UI closely, substituting the codebase's own
primitives where they exist (cards, tables, badges). Exact hex values,
font stacks, and sizes are listed under Design Tokens.

## Data model

All content is static. The logic class builds these collections; port them as a
typed data module or fetch them from the real RIA artifacts if available.

| Collection | Shape | Count |
| --- | --- | --- |
| `nav` | `{href, label, num}` | 12 |
| `scoreboard` | `{short, owner, n, kind: 'canonical'\|'derived', basis, detail, grade}` | 4 |
| `metrics` | `{label, value, note}` | 12 |
| `seiHero` | `{label, unit, value, note}` | 3 |
| `seiKpis` | `{label, value, unit, note}` | 4 |
| `seiConsumers` | `{name, color}` | 3 |
| `suite` | `{label, n}` → stacked segments | 3 |
| `readDepth` | `{label, n, pct}` | 3 |
| `gateSegs` | `{label, n}` → stacked segments | 2 |
| `notCarried` | `{field, reason}` | 6 |
| `seiFields` | `{k, v}` | 6 |
| `lanes` | `{name, weight, score, level}` | 8 |
| `rubric` | `{g, range, anchor, meaning, on}` | 5 |
| `caps` | `{name, trigger, ceiling}` | 2 |
| `confTerms` | `{input, w, value, contrib, kind}` | 5 |
| `dims` | `{d, w, asks}` | 6 |
| `meters` | `{title, total, note, segs[]}` | 7 |
| `owners` | `{label, headline, rows[]}` | 3 |
| `candidates` | `{owner, id, name, priority, value, risk, band, disposition}` | 9 |
| `priorities` | `{rank, title, body, meta}` | 9 |
| `patterns` | `{title, owners[]}` | 4 |
| `routes` | `{label, count, items[], def}` | 5 |
| `evidence` | `{label, count, items[]}` | 4 |
| `gates` | `{kind, cmd, sec, result}` | 10 |
| `ownerRefs` | `{label, owner, fields[]}` | 3 |
| `blobs` | `{title, body}` — raw JSON strings | 3 |

### Derived values — port the formulas, not the outputs

Four things are computed, not hardcoded. Keep them computed so the page stays
correct if the data changes:

1. **Letter grades** — `gradeFor(n)`: `n>=90 'A'`, `>=75 'B'`, `>=50 'C'`,
   `>=25 'D'`, else `'F'`. These bands are anchored to a 0–4 maturity scale
   (level × 25) and are defined by the health rubric. Do not invent other cuts.
2. **Lane maturity level** — `score / 25`, displayed as `level N.N of 4`.
3. **Stacked bar segments** — for `suite`, `gateSegs`, and each `meters` entry:
   cumulative percentage offsets, `x = running total`, `w = n / sum * 100`.
4. **Gate duration bars** — `pct = sec / 30.7 * 100` (30.7s is the longest
   observed command). Skipped gates get `pct: 0` and render an em dash, never a
   zero-length bar with a number.

### Semantic color mapping

Score-to-color is a function, not a per-item choice:

```
< 50  → red    #f2606a
< 70  → amber  #e5a13d
< 80  → indigo #8b93ff
>= 80 → green  #3ecf8e
```

Applied to lane bars and the four scoreboard cells. Statuses map:
`pass`/`confirmed`/`strong` → green, `inferred`/`ready`/`execute` → indigo,
`unknown`/`needs-human-decision`/`MISS` → amber, `blocked`/`coverage gaps` →
red, `skipped`/`Not scored`/`Not carried` → dim gray `#5f6875`.

## Screens / Views

One continuously scrolling page, two columns.

### Shell

Three breakpoints, driven by a measured viewport width (a resize listener in the
prototype; use container queries or CSS media queries in production):

| Name | Width | Behavior |
| --- | --- | --- |
| mobile | `< 780px` | Single column. Rail becomes a sticky top bar: brand + grade pill in a row, nav as a horizontally scrolling chip row, section numbers and rail footer hidden. Page padding 16px. |
| laptop / desktop | `780–1899px` | Two columns, `nowrap`. Rail is a fixed 244px sticky column, full height, own scroll. Main flexes to fill, `border-left` divider, left padding `clamp(20px, 3.4vw, 58px)`. Max width 1680px. |
| ultrawide | `>= 1900px` | Rail widens to 292px, brand type to 30px, max width 2240px, grids gain columns. |

Grid column counts are explicit per breakpoint, not `auto-fit`, for the two
KPI strips — `auto-fit` produced an orphan cell at laptop width:

- scoreboard cells: 1 col `<620px`, 2 cols `<1500px`, else 4
- SEI KPI cells: 1 col `<560px`, 2 cols `<1500px`, else 4

All prose blocks are capped in `ch` units (`max-width: 62ch–88ch`) so ultrawide
does not produce unreadable line lengths.

### Left rail (sticky)

- Eyebrow `RIA · ASSESS`, 10px mono, `.16em` tracking, uppercase, `#5f6875`
- Repo name, 25px Instrument Serif, `-.015em`
- Grade pill: amber dot with a `0 0 0 3px` glow ring, `1px solid
  rgba(229,161,61,.34)`, `rgba(229,161,61,.07)` fill, fully rounded,
  text `Grade C · 67.9`
- Nav: 12 single-word links, 12px, 5px vertical padding, `nowrap`. Two-digit
  mono index at 9px. Active item is `#f7f9fc` with an indigo index; inactive
  `#7c8593` with `#3f4653`. Active state is driven by an IntersectionObserver
  over `section[id]` with `rootMargin: '-12% 0px -70% 0px'` — the topmost
  intersecting section wins.
- Footer: `revision f5ac818 / mode read-only / 2 blockers open`, 10px mono

### Header

Eyebrow with a 20px indigo rule, then the repo name at
`clamp(38px, 7vw, 104px)` Instrument Serif, `line-height .92`,
`letter-spacing -.032em`, with the hyphens tinted `#5f6875`. One 21px/300
standfirst, then four metadata chips (revision, baseline, mode, and a red
`2 blockers` chip). The whole header animates in with `rise` (10px translate +
fade, 550ms).

### Scoreboard band

Directly under the header. A rounded 20px container with a 160° amber-tinted
gradient wash.

- **Left cell**: 92px SVG dial, `r=50`, `stroke-width 8`, track
  `rgba(255,255,255,.08)`, amber arc via `stroke-dasharray "213.4 100.9"`
  rotated `-90deg`, letter `C` centered at 38px serif. Beside it: label,
  `67.9/100`, and a caption crediting Health as the sole source.
- **Right cells**: one per owner, separated by 1px gaps over a
  `rgba(255,255,255,.08)` background (the hairline-grid technique used
  throughout). Each has a colored dot, owner short name, a
  `canonical`/`derived` pill, the score at `clamp(28px,2.6vw,38px)` serif with a
  `/100` suffix and letter grade right-aligned, a 4px progress bar, the basis in
  mono, and detail in sans.
- **Footer strip**: explains that only Health is canonical, that the derived
  three are readiness ratios never averaged into the overall grade, and states
  the rubric bands plus the calibration caveat.

Current values: Health 67.9 C (canonical), Integrity 83.3 B, Architecture
66.7 C, Intelligence 60.0 C.

### Sections

Each section is `<section id>` with `scroll-margin-top: 28px`, a top hairline,
40px top padding, 56px top margin, and a header row of `NN — Title` in 11px
uppercase mono plus an optional right-aligned mono aside.

1. **01 Executive assessment** — a 46px serif pull-quote (`max-width: 30ch`),
   two body paragraphs, and a "Grade accounting" card listing raw grade, caps,
   confidence, cap ceiling, and weighted coverage.
2. **02 Signals at a glance** — 12 metric cells in a hairline grid, value at
   `clamp(26px,2.4vw,34px)` serif with `tabular-nums`.
3. **03 Software engineering intelligence** — a feature panel with a
   `radial-gradient` dot-grid overlay (`22px` cells, 40% opacity), a
   `shared input` pill, a serif lede, the four SEI-owned KPIs shown as
   *Not carried*, and consumer chips. Then three cards: declared suite (stacked
   bar, 718/201/111), read depth (three bars), gate observation (6 observed / 4
   configured-unobserved), not-carried fields, and the envelope binding.
4. **04 Quantitative assessment** — 8 lane rows (name, weight, critical flag,
   maturity level, score, colored bar), then three rubric cards: grade rubric
   with the active band highlighted, confidence composition, dimensions per lane.
   Then 7 stacked-bar meters.
5. **05 Health, integrity, architecture** — 3 owner summary cards.
6. **06 Ranked candidate portfolio** — 9-row table, `min-width: 900px`, scrolls
   horizontally, sticky header. Numeric columns right-aligned and
   `tabular-nums`; unscored rows show em dashes in `#4f5866`. Disposition is a
   pill colored by state.
7. **07 Highest-leverage priorities** — 9 cards, each a 44px + 1fr grid with a
   circled rank number; ring color keyed to owner (indigo integrity, green
   architecture, amber blocked).
8. **08 Cross-cutting synthesis** — 4 pattern cards in a hairline stack plus a
   downstream-disposition panel where each route carries its definition.
9. **09 Evidence certainty and gaps** — 4 cards (confirmed / inferred / unknown
   / coverage gaps), each a list of full-sentence findings.
10. **10 Verification baseline** — 10-row table with inline duration bars.
11. **11 Runtime and performance** — 3 cards: artifact reuse, work avoided,
    executor concurrency.
12. **12 Assessment status and next lifecycle** — a red-tinted tooling-defect
    card, an amber envelope-note card, and an indigo next-lifecycle card.
13. **13 Appendix** — 3 owner binding cards plus 3 collapsible `<details>`
    blocks of raw JSON in a `pre` with `white-space: pre-wrap` and
    `max-height: 420px`.

Then a footer with two mono lines.

## Interactions & Behavior

- **Scroll-spy nav** — IntersectionObserver as described above. Clean up the
  observer and the resize listener on unmount.
- **Anchor navigation** — `html { scroll-behavior: smooth }` plus
  `scroll-margin-top` on sections. Never use `scrollIntoView`.
- **Hover states** — metric and pattern cells lift from `#0b0c10` to `#101218`;
  table rows to `rgba(255,255,255,.025)`; priority cards shift border to
  `rgba(139,147,255,.34)`; scoreboard cells to `rgba(16,18,24,.7)`; nav links to
  `#f7f9fc`. No transitions are specified — add a `120ms ease` if the codebase
  does so by default.
- **Appendix disclosure** — native `<details>`/`<summary>` with the marker
  hidden (`summary::-webkit-details-marker { display: none }`) and a mono
  `JSON` tag on the right. Default collapsed.
- **Entry animation** — `rise` keyframe (opacity 0 → 1, `translateY(10px)` → 0)
  on the rail and header only. Respect `prefers-reduced-motion` in production;
  the prototype does not.
- **Print** — a `@media print` rule flips the body to white/`#111`. Not fully
  designed; if printing matters, treat it as new work.

There is no client state beyond the active section and the viewport width, no
forms, no validation, no loading or error states, no data fetching.

## Configuration flags

Two booleans, exposed as tweakable props in the prototype. Port as component
props with the same defaults:

- `showAppendix` (default `true`) — renders section 13 and its nav entry.
- `showChartNotes` (default `true`) — renders the small methodology footnotes
  under charts and cards.

## Design Tokens

### Color

| Token | Hex | Use |
| --- | --- | --- |
| Page background | `#08090b` | body |
| Raised surface | `#0b0c10` | grid cells, table headers |
| Hover surface | `#101218` | cell hover |
| Text primary | `#f7f9fc` | headlines, key numbers |
| Text high | `#eef1f5` | rail brand, table values |
| Text body | `#b6bdc9` | standfirst, body prose |
| Text muted | `#98a1ae` / `#9ba4b1` | secondary prose |
| Text dim | `#8f98a6` | labels, basis lines |
| Text dimmer | `#7c8593` / `#6f7885` | captions, section numbers |
| Text faint | `#5f6875` / `#5b6474` | units, tinted hyphens |
| Text faintest | `#4f5866` / `#3f4653` | asides, inactive indices |
| Accent indigo | `#8b93ff` | primary accent, bars |
| Accent indigo 2 | `#6b74d8` | second stack segment |
| Accent indigo 3 | `#464e9c` | third stack segment |
| Accent indigo 4 | `#2f3568` | fourth stack segment |
| Link | `#9aa2ff` → `#c3c8ff` hover | anchors, candidate ids |
| Success | `#3ecf8e` | pass, confirmed, strong |
| Warning | `#e5a13d` | grade C, caps, MISS, unknown |
| Danger | `#f2606a` | blockers, coverage gaps |

Hairlines: `rgba(255,255,255,.055)` (inner rows), `.07` (dividers, grid gaps),
`.09` (card borders), `.1` (feature panels). Fills:
`rgba(255,255,255,.015)`–`.03`. Semantic tints use the accent at `.04`–`.09`
with a border at `.24`–`.4`.

Page wash: `radial-gradient(1100px 620px at 78% -8%, rgba(139,147,255,.13),
transparent 62%)` plus `radial-gradient(760px 460px at 4% 4%,
rgba(62,207,142,.055), transparent 60%)`.

### Typography

Three families, from Google Fonts:

- **Instrument Serif** (400, italic available) — display: page title, section
  headlines, all large numbers
- **Libre Franklin** (300/400/500/600) — body prose, labels, list items
- **JetBrains Mono** (400/500/600) — all data, identifiers, hashes, table
  headers, eyebrows, section numbers

Scale actually used: display `clamp(38px,7vw,104px)/.92/-.032em`; pull-quote
`clamp(28px,3.1vw,46px)/1.12/-.02em`; card headline 25px/1.16; card title
18–20px/1.2; big number `clamp(26px,2.4vw,38px)/1`; body 15.5px/1.68;
secondary body 14.5px/1.7; small body 13.5px/1.62; caption 11–12px/1.5;
mono data 11–12.5px; mono label 9–10px with `.10–.16em` tracking, uppercase.

`font-variant-numeric: tabular-nums` on every number that sits in a column or
changes. `text-wrap: pretty` on prose, `balance` on the h1.

### Spacing, radius, other

- Section rhythm: 56px margin-top, 40px padding-top, 24–26px header margin
- Card padding 20–24px; feature panel `clamp(22px,2.6vw,38px)`; grid cell 18–20px
- Gaps: 1px (hairline grids), 14–16px (card grids), `clamp(20px,2.4vw,40px)`
  (two-column splits)
- Radius: 999px pills, 6–8px chips, 12–14px small cards and tables, 16px cards,
  20px feature panels
- Bar heights: 4px (scoreboard), 5px (inline table), 6px (lane), 8px (stacked)
- No box-shadows anywhere except the grade-pill dot glow. Depth comes from
  hairline borders and low-alpha fills.

## Assets

None. No images, no icon set, no logos. Every graphic is inline SVG built from
`<rect>`, `<circle>`, and `<text>` — dials, progress bars, and stacked bars.
All bars use `viewBox="0 0 100 1"` with `preserveAspectRatio="none"`, so widths
are literal percentages. Every SVG carries `role="img"` and a descriptive
`aria-label`.

## Accessibility notes

Keep these when porting: `role="img"` + `aria-label` on every chart, real
`<table>`/`<thead>`/`<th>` markup for both tables, native `<details>` for
disclosure, `<dl>/<dt>/<dd>` for binding fields, and semantic
`<section>`/`<article>`/`<h2>`/`<h3>` structure. Verify contrast if you darken
any of the faint grays — `#4f5866` on `#08090b` is already borderline and is
used only for non-essential asides.

## Files

- `Repository Improvement Assessment.dc.html` — the design reference. The
  template is the markup between `<x-dc>` tags; the logic class (the data and
  derived values) is in the `<script data-dc-script>` block at the end.
- `support.js` — the authoring runtime. **Reference only — do not port.**

## Source of the content

Every number and finding in this page comes from an RIA ASSESS report for
revision `f5ac818f09c0148f7ca8260d4b1f798a2db61cec` and from the owner skill
contracts (health grading rubric, coverage model, architecture routing). If you
wire this to live artifacts, the health grade, lane scores, caps, confidence
index, candidate ledger, and verification commands are all available in those
artifacts; the three derived owner scores in the scoreboard are computed by this
page and are labeled as such.
