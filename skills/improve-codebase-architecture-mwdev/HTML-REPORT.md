# HTML Report Format

The architectural review is rendered as a single self-contained HTML file in the OS temp directory. Tailwind and Mermaid both come from CDNs. Mermaid handles graph-shaped diagrams reliably; hand-built divs and inline SVG handle the more editorial visuals (mass diagrams, cross-sections). Mix the two — don't lean on Mermaid for everything, it'll start to look generic.

**Mermaid is fragile with real candidate names — never hand-write Mermaid source.** Candidate names come from a real codebase and contain slashes, parentheses, colons, arrows (`->`, `→`), brackets, quotes, `#`, and markdown. Written into raw Mermaid, any one of them is a syntax error that replaces the whole page with a red error splash. This report drives every Mermaid diagram through the sanitizer in [`assets/mermaid-safe.js`](assets/mermaid-safe.js) so the safety is enforced by code, not by author discipline. See **Mermaid safety** below — it is a hard requirement, not a style note.

Colour and mark rules: colours are chosen by the **job** they do and **validated, not eyeballed** (the numbers are recorded in the **Palette validation record** below), so a report reads as one system in both light and dark and stays colourblind-safe. Apply them where the report genuinely encodes data (the mass diagram and cross-section are magnitude encodings; badges are a status scale; leak/deep are reserved states) — and *don't* force chart machinery onto the schematic diagrams. A Mermaid dependency graph or a boxes-and-arrows sketch is a **schematic, not a chart**: it takes the colour roles and the accessibility pass, but not axes, tooltips, or a legend box of its own.

## Scoring spine — from `REPORT-SCORING.md`, with stamped deviations

Per [SKILL.md](SKILL.md), every candidate is scored by the **scoring-spine half** of [`shared/REPORT-SCORING.md`](../../shared/REPORT-SCORING.md) — the candidate schema (`candidate_id`, file/line `evidence`, the eight 1–5 `scores`, the `priority_score` rollup), the priority formula (`priority_score = (severity + confidence + leverage + locality + testability) − (blast_radius + regression_risk + human_decision_risk)`, range −10…+22), and the dedup rules — defined there and nowhere else. The abbreviations in this file map to those score names: `sev·cnf·lev·loc·tst` / `bla·reg·hdr` (`hdr` = `human_decision_risk`). The spine's **Report style** (visual) half is **not** adopted: the design system in this file is its own, on purpose — don't restyle this report to match the spine.

Three deviations from the spine are deliberate — stamped here so they never read as drift:

- **Own section list.** The spine's scoring half prescribes a 13-section report; this report renders masthead → hero → ranked ledger → candidate cards → top recommendation instead. The editorial cards are a presentation layer over the spine-schema ledger, not a replacement: when this command drives `production-flywheel`, the emitted ledger and recommended queue follow the spine.
- **Band cut.** `✓ Strong ≥13` / `◐ Worth exploring 6–12` / `○ Speculative ≤5` — one point stricter at the top than the spine style-half's triage bands (`High ≥12` / `Mid 6–11` / `Low ≤5`). Architecture changes earn "Strong" at a higher bar. Do not align this to the spine's ≥12.
- **No execution rollup on screen.** `recommended_action` / `execution_mode` / `blocked_by` are not rendered in the cards — every candidate here is a proposal headed for the grilling loop, not an execution queue. The machine ledger emitted for the flywheel still follows the spine schema; `human_decision_risk` always scores as a risk input.

If the spine's formula or range ever changes, this file's meter math (`(priority_score + 10) / 32`, the 47%/72% stops) changes with it — that is the one accepted drift surface — and `assets/ledger-verify.js` owns the math (`fillPercent`, `bandStops`), so the change lands in one constant. (Checked against `REPORT-SCORING.md` **v2** and `SKILL.md`, 2026-07-19.)

## Self-verifying ledger — from `assets/ledger-verify.js`

The report carries **one JSON island** — `<script type="application/json" id="ledger">` — holding `{ spine_version, generated, candidates: [...] }` per the spine schema: `candidate_id`, `title`, `evidence`, the eight `scores`, `rollup.priority_score`, plus `effort`, `depends_on`/`unlocks`, and `blocked` where known. The island is the single source for every number on the page **and** the machine ledger `production-flywheel` consumes — never write a second copy of any score, anywhere.

Paste the body of [`assets/ledger-verify.js`](assets/ledger-verify.js) into the scaffold verbatim (export-free classic script, same contract as `mermaid-safe.js`) and call `LedgerVerify.runLedger({})` once the DOM is ready. **Do not re-derive the renderer.** The 2026-07-19 field report re-implemented it from prose and shipped two fill formulas in one page (`/22` in the ledger, `(p+10)/32` in the meters), hand-typed stops of 48/71 against the derived 46.9/71.9, and a Strong tick sitting off its own band edge — rendering through the module is *less* work than that and cannot disagree with itself.

The module renders every numeric display from the island via placeholders: `[data-ledger]` (ranked rows — rank, serif title, ⚖ when `hdr ≥ 4`, S/M/L effort chip, `unlocks N` chip, axis bar, mono priority), `[data-score-legend]` (the visible abbreviation legend with the formula line), `[data-meter="id"]` (verdict line, derived band track, **diverging** histogram — value bars up, risk bars down — captioned with the recomputed `Σ value − Σ risk` equation), and `[data-rank="id"]` (band-coloured rail number). Prose, diagrams, and card layout stay hand-authored; each card carries `data-candidate="id"` so its order can be checked.

What is enforced: `priority_score` recomputed from the eight scores (a stored value that lies is flagged and the computed value displayed), bands, fills, and stops derived from one config, the spine v2 tie-break (`priority` desc → `effort` asc → `severity` → `confidence` → id), card order, evidence shape, effort range, `depends_on`/`unlocks` references, and unknown-id placeholders. The masthead carries the verification chip (`[data-verify-chip]`); **a red chip means the report does not ship.** Regression fixture: [`assets/ledger-verify.test.html`](assets/ledger-verify.test.html) — keep it green.

## Design system — roles, not raw hex

Define the palette once as CSS custom properties keyed by the **job** each colour does, then reference roles everywhere. Light and dark are **both selected and validated** against their own surface — dark is not an automatic flip of light (e.g. secondary ink is `#52514e` on light but must become `#c3c2b7` on dark, where `#52514e` only reaches 2.19:1). Put this in the `<style>` block and never write a raw diagram hex again.

```css
.report-root {
  /* surfaces */
  --surface-1:   #fcfcfb;  /* card / diagram surface */
  --page:        #f9f9f7;  /* page plane behind cards */
  /* ink — text ALWAYS wears these, never a mark colour */
  --ink-primary: #0b0b0b;
  --ink-secondary:#52514e;
  --ink-muted:   #898781;  /* schematic labels, axis, faded internals */
  --hairline:    #e1e0d9;  /* recessive grid / dividers */
  --baseline:    #c3c2b7;  /* the line marks anchor to */
  --border:      rgba(11,11,11,.10);
  /* accent = magnitude (one hue, sequential blue) */
  --accent:      #2a78d6;  /* light 4.30:1 — data fills */
  --accent-deep: #256abf;  /* emphasis / consolidated band */
  --accent-faint:#86b6ef;  /* near-surface ordinal floor (still ≥2:1) */
  /* status = reserved state, ALWAYS icon+label, never a series */
  --good:     #0ca30c;   /* Strong */
  --warning:  #fab219;   /* Worth exploring / ADR-conflict caution */
  --serious:  #ec835a;
  --critical: #d03b3b;   /* leak */
  --deep-fill:#2c2c2a;   /* the heavy "deep module" box */
}
@media (prefers-color-scheme: dark) {
  .report-root {
    --surface-1:   #1a1a19;
    --page:        #0d0d0d;
    --ink-primary: #ffffff;
    --ink-secondary:#c3c2b7;   /* NOT #52514e — fails on dark */
    --ink-muted:   #898781;
    --hairline:    #2c2c2a;
    --baseline:    #383835;
    --border:      rgba(255,255,255,.10);
    --accent:      #3987e5;  /* dark 3.94:1 */
    --accent-deep: #1c5cab;
    --accent-faint:#184f95;
    --deep-fill:   #000000;
    /* status hexes are fixed — never themed — and stay as above */
  }
}
```

Non-negotiables (they hold in every report):

- **Sequential = one hue, light→dark.** Magnitude (interface vs implementation size, layer count) is the blue accent ramp — never a rainbow, never one-hue-per-thing.
- **Status is reserved and never a series.** `good / warning / serious / critical` carry recommendation strength and leak/ADR state only, and always ship with an **icon + label** — colour never carries meaning alone (on light, `warning` and `serious` sit below 3:1 by design; the label is the mitigation).
- **Text wears text tokens.** Values, labels, and legends use `--ink-*`; a coloured mark sits *beside* them to carry identity. Never set label text in the mark colour.
- **Validate before shipping — compute, don't eyeball** (see the last section).

## Scaffold

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review — {{repo name}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      // Inline the contents of assets/mermaid-safe.js here (the report is
      // self-contained — it cannot reference a sibling file at view time).
      // Paste the file body verbatim — it is export-free by design (a classic
      // script exposing globalThis.MermaidSafe), so it drops in here unchanged
      // *and* loads via <script src> in the test fixture from file://.
      /* … escapeLabel, nodeId, buildFlowchart, renderInto, renderAllGraphs … */

      // startOnLoad:false — we render each diagram ourselves so one bad diagram
      // falls back to text instead of blanking the page.
      mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "loose" });
      window.addEventListener("DOMContentLoaded", () => renderAllGraphs("[data-graph]", mermaid));

      // Paste the body of assets/ledger-verify.js here too (same export-free
      // contract), then render every scoring display from the JSON island —
      // never hand-write a score, a fill, a stop, or a rank:
      window.addEventListener("DOMContentLoaded", () => LedgerVerify.runLedger({}));
    </script>
    <style>
      /* role tokens: paste the .report-root + dark block from
         "Design system — roles" above, verbatim. */
      /* small custom layer for things Tailwind doesn't cover cleanly: */
      .seam  { stroke-dasharray: 4 4; stroke: var(--baseline); }
      .leak  { stroke: var(--critical); stroke-width: 2px; }
      .deep  { background: var(--deep-fill); color: #fff; }
      /* texture channel (CVD / print / forced-colors) — 45° + 135° only */
      .tx-lines { background-image: repeating-linear-gradient(
        45deg, transparent 0 5px, var(--border) 5px 6px); }
    </style>
  </head>
  <!-- data-palette exposes the categorical hexes to any contrast/CVD checker -->
  <body class="report-root font-sans"
        style="background:var(--page); color:var(--ink-primary)"
        data-palette="#2a78d6,#1baf7a,#eda100,#008300,#4a3aa7,#e34948,#e87ba4,#eb6834">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

Cards and diagram surfaces use `background:var(--surface-1)` and `border-color:var(--border)`. Because the report is one page adopting one palette, this is also the report's **legend key** — see the header.

**Surfaces have gentle lift.** Every card and diagram surface carries one soft shadow — `box-shadow: 0 1px 2px rgba(11,11,11,.04), 0 8px 24px -12px rgba(11,11,11,.12)` — and a generous corner (`border-radius:16px` cards, `12px` inner panels). The page plane behind cards is one step darker than the card surface (`--page` `#f4f4f1` under `--surface-1` `#fcfcfb`) so cards read as objects on a plane, not boxes drawn on paper. This is the single biggest lever on "looks flat vs. looks built" — apply it everywhere, uniformly. In dark mode the shadow stays (it still separates `#1a1a19` cards from `#0d0d0d`); do not raise its opacity.

## Header — editorial masthead

The header is a masthead, not a toolbar. Three stacked pieces, each its own card:

1. **Masthead card.** A mono eyebrow (`Deepening opportunities · architecture review`), the repo name set **large in the serif** (`font-serif`, ~40px, `font-weight:600`, `letter-spacing:-.025em`), and one *italic serif* standfirst sentence naming what was surveyed ("Nine deepenings surfaced across …"). Below a hairline, a three-cell **stat strip** — `candidates` / `strong` / `top priority` — each a big serif numeral over a mono label, divided by `--hairline` rules. The `strong` count wears `--good`, the top score wears `--accent-deep`; everything else is ink. This replaces the old right-aligned number cluster.
2. **Ranked ledger card.** The full `1..N` candidate list as rows: rank number (coloured by strength band), candidate name in the serif, an **inline score bar** (a `--hairline` track filled to `(priority_score + 10) / 32` — the score's position on the −10…22 axis — in the band colour), and the score in mono. This is the at-a-glance scan and the selection index in one — it carries the numbering the caller picks by. **Group the rows under quiet band headers** (`✓ Strong ≥13` / `◐ Worth exploring 6–12` / `○ Speculative ≤5`, each a mono label + hairline rule + threshold, cut per **Scoring spine** above) so the page reads as three movements rather than one long list.
3. **Legend line.** The accessibility guarantee, every encoding named in words, so identity is never colour-alone: solid box = module, dashed line = seam, **red arrow labelled "leak"** = leakage, thick dark box = deep module, and the badge scale (`Strong` / `Worth exploring` / `Speculative`). Keep it compact — one wrapping row. No introduction paragraph — masthead, ledger, legend, then straight into the candidates.

## Candidate card

The diagrams carry the weight. Prose is sparse, plain, and uses the glossary terms (from the `/codebase-design` skill) without ceremony.

Each candidate is one `<article>` and **carries a stable number**. Number the candidates `1..N` in the order they appear, show the number in the card heading (e.g. "3. Collapse the Order intake pipeline"), and set it as the `id` (`<article id="candidate-3">`). The number is the selection handle: a workflow driving this report (e.g. `production-flywheel`) asks the user which candidates to run *by number*, so the numbering must be unambiguous and match the Top-recommendation references.

The card is a **two-part layout: a rank rail + a body.**

- **Rank rail** — a narrow left column (~60px) tinted with the strength band colour at ~9–12% (`color-mix(in srgb, var(--good) 9%, var(--surface-1))`). It holds the candidate number set **large in the serif** (~44px), a mono `RANK` label, the dependency **category set vertically** down the rail (`writing-mode:vertical-rl`, mono, `--ink-muted`) so type is scannable along the page edge, and the strength icon (✓ / ◐ / ○) pinned to the bottom. Make the whole rail an `<a href="#candidate-N">` so clicking the numeral deep-links the card — matching the pick-by-number workflow. This replaces the old inline left-border stripe.
- **Title** — short, names the deepening, in the **serif** (~22px, `font-weight:600`, `letter-spacing:-.015em`). The number lives in the rail, so the title no longer needs the `N.` prefix (keep it in prose references and Top-recommendation).
- **Tag chips** — the dependency category (`in-process`, `local-substitutable`, `ports & adapters`, `mock`) and a fact or two (`5 call sites`, `pri 12`) as mono chips: `font-size:10px`, `border:1px solid var(--hairline)`, `--ink-secondary`. The strength is carried by the meter below, not repeated as a coloured pill.
- **Strength meter** — the scoring display (see next section). This is the badge's replacement: it shows *where on the scale* the candidate sits and *what drives it*, not just a word.
- **Files** — monospaced list, `font-mono text-sm`, in `--ink-secondary`.
- **Before / After diagram** — the centrepiece, framed as a **transform panel** (see Diagram patterns). See patterns below.
- **Problem** / **Solution** — one sentence each, set in the **italic-capable serif** (`font-serif`, ~14px) in a two-column grid under a hairline, each with a mono uppercase label. Serif prose beside mono diagram labels is the intended texture — page prose reads editorial, chart text stays system-mono.
- **Wins** — bullets, ≤6 words each, mono, prefixed with a `+` in `--good`. e.g. "locality concentrates", "delete 4 messages", "one predicate, N surfaces".
- **ADR callout** (if applicable) — one line in a `--warning`-tinted box **with a ⚠ icon and the word "ADR"** (status colour + icon + label, per the rule).

No paragraphs of explanation. If the diagram needs a paragraph to be understood, redraw the diagram.

## Scoring display — the strength meter

The recommendation strength is the display layer of `priority_score`. **A single coloured word throws away the number.** Render it as a compact **strength meter** so the reader sees the band, the value, and the eight sub-scores that produced it — without a table.

Three stacked rows, ~a third of the card's width to full width:

1. **Verdict line.** The strength icon + word in the serif (`✓ Strong`), and on the right the score in mono: `priority 14 / 22`. Colour: `--good` / `--warning` / `--ink-muted` on the icon only — the word wears ink.
2. **Band track.** A 12px rounded bar whose *background* is the three bands as a hard-stop gradient (`speculative` grey `0–47%`, `worth exploring` `--warning`-tint `47–72%`, `strong` `--good`-tint `72–100%` — the stops are the band thresholds on the −10…22 range). A solid `--good`/`--warning` **fill** overlays it from the left to `(priority_score + 10) / 32` — the same −10…22 axis as the band stops. (*Not* `priority_score/22`: that misplaces every score — 14 would fill to 64%, visually inside Worth-exploring under a ✓ Strong verdict — and goes negative below 0.) Mark the **Strong threshold** with a 2px `--ink-primary` tick riding the bar (at ~72%) and label the axis ends (`−10` … `Strong ↑` … `+22`) so "14" reads as *just over the line*, not merely "far right".
3. **Contribution histogram.** Two small bar groups on a shared baseline, split by a mono `−`: the **five value scores** (`sev·cnf·lev·loc·tst`) in the blue accent ramp, then the **three risk scores** (`bla·reg·hdr`) in `--serious` at ~55% opacity. Each bar's height is `score/5`. Under each group runs a 2px **asymmetry cue** underline — `--good` when value dominates, `--warning` when risk is tall relative to value — so "high leverage but risky" (e.g. #5, #8) is legible without reading numbers. A mono caption labels the two groups (`value` / `risk`). Bars carry a `title` with the exact dimension + score (the one place a tooltip earns its keep, per the mark rules).

The meter is *reserved-status + magnitude together*: the icon+word keeps identity non-colour-alone, the histogram carries the numbers. Keep the band track and histogram to ~34–38px tall so the meter tucks under the title without dominating.

## Diagram patterns

Pick the pattern that fits the candidate. Mix them. Don't make every diagram look the same — variety is part of the point. Two kinds live here, and they take the design system differently:

- **Schematics** (Mermaid graphs, boxes-and-arrows) show *structure*. They take the colour roles and the accessibility pass — nothing more. No axes, no tooltips, no per-diagram legend box.
- **Magnitude diagrams** (mass diagram, cross-section) encode *how much*. These are real data marks: apply the mark specs (thin marks, rounded data-ends on a baseline, a 2px surface gap between adjacent fills, one-hue sequential, direct labels).

### Transform panel — the before/after frame

Whatever pattern the two sides use, **frame them as one transformation, not two loose columns.** Wrap the before and after in a single inset panel (`background:var(--page)`, `border:1px solid var(--hairline)`, `border-radius:12px`) laid out as a three-column grid: `before | arrow node | after`. The **arrow node** is a 28px `--accent` circle holding `→`, centred on a thin `--hairline` connector that runs above and below it — it reads as "this becomes that". The after side is almost always the **deep box** (`--deep-fill`, white text, its own soft shadow) so the eye lands on the consolidated result; put a mono **`−N` win counter** in `--good` on the after label (`−4 sites`, `deletes 3 wrappers`) to quantify what the collapse buys. Mono uppercase mini-labels (`Before · re-typed 5×` / `After · one seam`) cap each side. Use this frame for schematic before/afters (boxes-and-arrows, collapse); the magnitude diagrams (mass, cross-section) keep their shared-baseline framing instead, since the baseline *is* their frame.

### Mermaid graph (schematic — the workhorse for dependencies / call flow)

Use a Mermaid `flowchart` or `graph` when the point is "X calls Y calls Z, and look at the mess." Wrap it in a card so it doesn't feel parachuted in. Colour it from the **roles**: leakage edges `--critical` **and labelled "leak"**, the deep module `--deep-fill`. Sequence diagrams work well for "before: 6 round-trips; after: 1."

**Do not hand-write the Mermaid source.** Declare the graph as data in a `data-graph` attribute and let `renderAllGraphs()` (from `assets/mermaid-safe.js`) build and render it. Node ids are assigned synthetically (`n0`, `n1`, …) and every label is escaped, so a candidate named `Order/Intake (v2): parse→validate` cannot break the parser. The container gets a graceful text fallback if rendering ever fails.

```html
<div class="rounded-lg p-4 mermaid-graph" style="background:var(--surface-1);border:1px solid var(--border)"
     data-graph='{
       "direction": "LR",
       "nodes": [
         {"name": "OrderHandler"},
         {"name": "OrderValidator"},
         {"name": "OrderRepo", "role": "leak"},
         {"name": "PricingClient", "role": "leak"}
       ],
       "edges": [
         {"from": 0, "to": 1},
         {"from": 1, "to": 2},
         {"from": 2, "to": 3, "label": "leak", "kind": "dotted"}
       ]
     }'></div>
```

Author the graph as `{direction, nodes, edges}`:

- `nodes[i].name` is the human label (any characters — it gets escaped). `nodes[i].role` may be `"deep"` or `"leak"` for the reserved role styling; `nodes[i].shape` may be `"round"` / `"stadium"` (keep it simple — box is the default).
- `edges` reference nodes by index. `edge.kind` is `"solid"` (default), `"dotted"`, or `"thick"`; `edge.label` is escaped and optional. Edges to a missing index are dropped, never emitted as broken source.

The `leak` edge label is not optional — it is the non-colour channel that lets a red-blind reader (or a forced-colours render) still read the leakage. Same rule for the deep module: the **thick border + dark fill + the word "deep"** carries it, not the colour.

## Mermaid safety (hard requirement)

Candidate names break naïve Mermaid. Every diagram in the report MUST satisfy all of the following, and the [`assets/mermaid-safe.js`](assets/mermaid-safe.js) helpers give you all of them for free — use them rather than reinventing:

- **Node ids are synthetic, never derived from names.** `nodeId(i)` returns `n0`, `n1`, … A name can never produce an invalid identifier or an id collision.
- **Labels are escaped and quoted.** `escapeLabel()` collapses whitespace, truncates long names, and replaces `"` `#` `<` `>` `&` `` ` `` with Mermaid entity codes (`#quot;`, `#35;`, `#lt;`, `#gt;`, `#amp;`, `#96;`), then the builder wraps the result in quotes. Slashes, parentheses, colons, arrows, brackets, quotes, and markdown all pass through safely. (The backtick escape matters: a raw `` ` `` makes Mermaid v11 treat the label as a *markdown string* and reject it.)
- **Diagrams are data-driven.** Describe `{nodes, edges}`; `buildFlowchart()` produces the source. Safety is enforced by code, not discipline.
- **Rendering degrades gracefully.** `renderInto()` / `renderAllGraphs()` validate with `mermaid.parse` and render each diagram individually inside a `try/catch`. A diagram that still fails is replaced with a readable text fallback (`.mermaid-fallback`) — it never blanks the page or throws a console syntax error.
- **Prefer simple diagrams over clever ones.** Plain `flowchart LR/TD` with boxes and labelled edges. Avoid exotic shapes, subgraph nesting, and inline HTML in labels — those are where fragility lives.
- **If a section isn't graph-shaped, don't use Mermaid at all.** Mass diagrams, cross-sections, and collapse visuals are hand-built divs/SVG (see below). Reserve Mermaid for genuine graphs (dependencies, call flow, sequence). A forced diagram is worse than none.

Add the sanitizer to the page by pasting the body of `assets/mermaid-safe.js` into the scaffold's module script (the report is self-contained and can't `import` a sibling file at view time), then call `renderAllGraphs("[data-graph]", mermaid)` on `DOMContentLoaded`.

**Acceptance:** no Mermaid syntax errors in the browser console; ugly candidate names render or fall back, never break the page. The regression fixture [`assets/mermaid-safe.test.html`](assets/mermaid-safe.test.html) exercises the exact names that used to break diagrams (slashes, parens, colons, `->`/`→`, brackets, quotes, `#`, backslashes, the reserved word `end`, empty, overlong, emoji). Open it in a browser: the banner is green only when every assertion passes and every diagram renders or degrades cleanly. If you change the sanitizer, keep that fixture green.

### Hand-built boxes-and-arrows (schematic — when Mermaid's layout fights you)

Modules as `<div>`s with borders and labels. Arrows as inline SVG `<line>`/`<path>` over a relative container. Reach for this when the "after" should feel like one thick-bordered deep module with greyed-out internals — internals in `--ink-muted`, the survivor in `--ink-primary`. Where an arrowhead crosses a mark, give it a **2px `--surface-1` ring** so the overlap reads cleanly.

### Cross-section (magnitude — good for layered shallowness)

Stack horizontal bands to show layers a call passes through. This is a **count encoding**, so: **one hue** for the layers (they're all "a layer" — never a rainbow), a **2px `--surface-1` gap between bands**, and a direct label on each. Before: 6 thin `--accent-faint` bands each doing nothing. After: 1 thick `--accent-deep` band labelled with the consolidated responsibility. Height carries the magnitude — don't also recolour by position.

### Mass diagram (magnitude — good for "interface as wide as implementation")

Two rectangles per module — interface surface area vs implementation. Both in the **one accent hue**; distinguish the two measures by the **texture channel** (`.tx-lines` on the interface rect) or a lighter sequential step, not a second hue. Round the data-end (`rounded` 4px) and anchor both to a shared baseline. Before: interface rectangle nearly as tall as implementation (shallow). After: interface short, implementation tall (deep). Direct-label both with the actual surface area in `--ink-secondary`.

### Call-graph collapse (schematic)

Before: a tree of function calls as nested boxes. After: the same tree collapsed into one box, the now-internal calls faded inside it in `--ink-muted`.

## Style guidance

- Lean editorial, not corporate-dashboard. Generous whitespace, and every surface carries the soft shadow + page-plane contrast from the scaffold (that lift is what separates "built" from "flat").
- Headings and page prose (masthead, card titles, Problem/Solution) are **serif**; diagram labels, values, chips, and the ledger scores are **mono/system-sans**. Holding that split is most of the editorial feel.
- **Colour by role, sparingly.** The blue accent is the only "series" colour — it means magnitude. Everything else is status (reserved) or ink. Never introduce a fourth decorative hue.
- Keep diagrams ~320px tall so before/after sits comfortably side by side without scrolling.
- Module labels inside diagrams: `text-xs uppercase tracking-wider` in `--ink-muted` — they should read as schematic, not as UI. Values (surface areas, counts) in `--ink-secondary` with `tabular-nums` if they align in a column.
- Grid/dividers are recessive (`--hairline`); the baseline marks anchor to is `--baseline`.
- **Typography split, on purpose:** chart-layer text — diagram labels and values — is system-sans (`font-sans`, ink tokens). Editorial **headings** may still use `font-serif` with stone/slate — that's page prose, outside the chart layer, and the split is deliberate, not drift.
- The only scripts are the Tailwind CDN and the Mermaid ESM import. The report is otherwise static. Hover tooltips are **not** required; if you add one, put it only on the magnitude marks (mass rects, cross-section bands) where a precise value helps — never on the schematics.

## Accessibility pass

Before calling the report done, confirm:

- **Identity is never colour-alone.** The header legend names every encoding in words; leak edges carry the label "leak"; the deep box carries "deep"; badges carry an icon + a word. ✔ by construction if you followed the patterns.
- **Dark mode is selected and validated** against `#1a1a19` — the dark ink/accent steps above, not an auto-inverted light palette.
- **Texture is available** (`.tx-lines`, 45°/135°) for the mass diagram's two measures and for any `forced-colors` / print render — so lightness is never the only difference.
- **Status contrast is mitigated, not ignored.** `warning`/`serious` sit below 3:1 on the light surface; the icon + label pairing is what makes that legal.

## Palette validation record

The colour part is computable, so it was computed — don't re-litigate it by eye. The role palette above is already validated: both modes pass (light CVD ΔE 24.2; dark CVD 10.3 — the floor band, legal here because every magnitude mark is direct-labelled). The blue accent clears 3:1 in both modes (4.30 / 3.94). Status colours are single values checked with WCAG *text* contrast, not the categorical six — `warning` at 1.79:1 on light is the by-design sub-3:1 case the icon+label covers. If you swap any hex, re-validate before shipping (WCAG text contrast for status/ink pairs, a CVD-distance check for the categorical slots) — and expect a good sequential ramp to FAIL a categorical-distance check on purpose (ramps span the band); don't "fix" it.

## Top recommendation section

One larger card. Candidate name, one sentence on why, anchor link to its card. That's it. **Pull it forward as a hero** — place a compact version (a `Start here` eyebrow, the `✓ pri N` badge, the serif title as an anchor link, one italic-serif sentence, `--good` left border) directly under the masthead and above the ledger, so the reader's first decision is made before they scan. Keep the fuller version at the end for the sequencing note.

## Tone

Plain English, concise — but the architectural nouns and verbs come straight from the `/codebase-design` skill. Concision is not an excuse to drift.

**Use exactly:** module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality.

**Never substitute:** component, service, unit (for module) · API, signature (for interface) · boundary (for seam) · layer, wrapper (for module, when you mean module).

**Phrasings that fit the style:**

- "Order intake module is shallow — interface nearly matches the implementation."
- "Pricing leaks across the seam."
- "Deepen: one interface, one place to test."
- "Two adapters justify the seam: HTTP in prod, in-memory in tests."

**Wins bullets** name the gain in glossary terms: *"locality: bugs concentrate in one module"*, *"leverage: one interface, N call sites"*, *"interface shrinks; implementation absorbs the wrappers"*. Don't write *"easier to maintain"* or *"cleaner code"* — those terms aren't in the glossary and don't earn their place.

No hedging, no throat-clearing, no "it's worth noting that…". If a sentence could be a bullet, make it a bullet. If a bullet could be cut, cut it. If a term isn't in the `/codebase-design` glossary, reach for one that is before inventing a new one.
