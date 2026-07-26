# Report scoring

Canonical scoring spine for every scored HTML report and candidate ledger in this skill family: the codebase-integrity-audit-loop report, the Repo Audit Swarm report, the production-flywheel report stage, and any scored report adapter. Score meanings, the priority formula, deduplication rules, and required report sections are defined here and nowhere else — other skills reference this file rather than restating it.

This file has two halves. The **scoring spine** (below) owns *what sections exist and how candidates are scored*. The **Report style** half (bottom of this file) owns *how the report looks* — the canonical visual system every scored report renders through. Other skills reference the relevant half by name rather than restating type, color, section, or component rules.

**One external dependency:** the human-decision taxonomy. `human_decision_risk`, `blocked_by`, and the *Human-decision blockers* report section are named against connected-impact-sweep's `## Human-decision categories` heading — that heading is the source of truth for the category names, so this spine assumes connected-impact-sweep is present in the family.

**Spine version: 3** — ledger islands emit `spine_version: 3`. v3 moved the scheduling fields into this canonical schema (`effort` as `S | M | L`, `depends_on`, `unlocks`, `status`) and made this file own the eligibility gates and the stable comparator (`## Eligibility and stable ranking`).

## Candidate schema

Every candidate in a ledger carries:

```yaml
candidate_id:
title:
lane_sources:            # which lanes contributed; omit for single-agent reports
  - deepening_seams
  - graded_integrity
  - blast_radius_lane      # provenance lane — distinct from the blast_radius score below
  - verification_readiness
summary:
root_cause:
evidence:                # required — see Evidence rule below
  - file:
    line:
    observation:
scores:                  # each 1–5, defined below
  severity:
  confidence:
  leverage:
  locality:
  testability:
  blast_radius:
  regression_risk:
  human_decision_risk:
rollup:
  priority_score:        # formula below
  recommended_action:    # direct-fix | design | prototype | fitness-check | triage | reject
  execution_mode:        # sequential | connected-impact-sweep | swarm | blocked-needs-human-decision
  blocked_by:            # human-decision forks, named against connected-impact-sweep's ## Human-decision categories
effort:                  # S | M | L — coarse implementation size; ranking tie-break only (see Scheduling fields)
depends_on:              # candidates that must be completed before this one is executable
  - candidate_id
unlocks:                 # informational reverse edges — work this candidate enables
  - candidate_id
status:                  # ready | blocked | needs-human-decision | rejected | completed
dedup:
  duplicate_group:
  merged_from:
```

**Evidence rule:** every candidate carries file/line evidence, unless it is explicitly marked architecture-level with a rationale for why no single location captures it. Findings are grounded in repository evidence gathered during this run — a claim without a fresh search, read, or command output behind it does not enter the ledger.

## Score definitions

All scores run 1 (low) to 5 (high).

- **Severity** — how bad the current issue is.
- **Confidence** — how certain the finding is.
- **Leverage** — how much improvement a fix likely produces.
- **Locality** — how contained the fix appears.
- **Testability** — how easy it is to prove the fix.
- **Blast radius** — how many connected surfaces may need coordinated change.
- **Regression risk** — how likely the fix is to break behavior.
- **Human-decision risk** — how likely the fix requires public-contract, migration, policy, architecture, deletion, or numerical-correctness judgment (the forks under connected-impact-sweep's `## Human-decision categories`).

## Priority rollup

One transparent formula, used identically by every report:

```text
priority_score = (severity + confidence + leverage + locality + testability)
               - (blast_radius + regression_risk + human_decision_risk)
```

Range −10 to +22; higher runs sooner. A candidate with `human_decision_risk ≥ 4` or a non-empty `blocked_by` queues behind its human decision regardless of priority_score: its `execution_mode` is `blocked-needs-human-decision` until the fork is answered.

**Two names, one state:** `execution_mode: blocked-needs-human-decision` ⇔ ledger `status: needs-human-decision`. Consumers (auto mode, sibling skills) may key off either; they mean the same blocked candidate. Separately, `recommended_action: reject` is **not** an execution branch — it maps to ledger `status: rejected` (recorded as rejected-out-of-scope; no Stage 5 branch runs).

## Scheduling fields

Scheduling is separate from scoring: none of these fields feeds `priority_score`, and no second weighted score exists.

- **`effort`** — `S | M | L`, coarse implementation size. Used only as the first ranking tie-break (`S` before `M` before `L`); a candidate without `effort` ranks as `M`.
- **`depends_on`** — candidates that must be `completed` before this candidate is executable. Dependencies gate readiness; they never raise or lower `priority_score`.
- **`unlocks`** — informational reverse edges naming work this candidate enables. Reports may display unlock information, but no consumer ranks or tie-breaks by unlock count.
- **`status`** — current queue state, one of:
  - `ready` — eligible and unresolved.
  - `blocked` — a dependency or other non-human operational blocker is open.
  - `needs-human-decision` — a human-decision blocker is open (⇔ `execution_mode: blocked-needs-human-decision`, per **Two names, one state** above).
  - `rejected` — out of scope (⇔ `recommended_action: reject`).
  - `completed` — successfully finished. Only the loop that finished the candidate stores `completed`; it is never derived.

When a ledger omits `status`, consumers derive it, in order: `rejected` if `recommended_action` is `reject`; `needs-human-decision` if `human_decision_risk ≥ 4` or `blocked_by` is non-empty; `blocked` if any `depends_on` candidate is not `completed`; otherwise `ready`. A stored status may be stricter than the derived one (a human holding a candidate back), never looser — `ready` stored on a candidate that derives `blocked`, `needs-human-decision`, or `rejected` is a validation failure.

## Eligibility and stable ranking

Candidate selection is two phases, and every consumer of a candidate ledger — the recommended queue, auto mode, any production-flywheel handoff, and any "top recommendation" that claims to represent execution priority — uses them identically. This section is the single authoritative eligibility rule and comparator: other files restate it only verbatim with a reference here, and `assets/ledger-verify.js` (improve-codebase-architecture) is its executable form.

**Phase 1 — eligibility.** A candidate is executable only when all of these hold:

- `status` is `ready`
- `recommended_action` is not `reject`
- `human_decision_risk < 4`
- `blocked_by` is empty
- every `depends_on` candidate is `completed`
- required repository/tool access and a trustworthy verification baseline are available
- the mission boundary is clear and no consumer hard stop applies

Safety, blockers, and dependency readiness are gates, not score adjustments: a high-scoring blocked candidate stays high priority in the ledger but is not eligible to run. Ineligible candidates stay listed — skipped, never dropped.

**Phase 2 — stable ranking.** Apply explicit human ordering first when the user supplied one. Human ordering decides between eligible candidates only: it cannot make a blocked, human-decision, or rejected candidate executable, and it never modifies `priority_score`. Then rank the remaining eligible candidates by:

1. `priority_score` descending
2. `effort` ascending (`S` before `M` before `L`)
3. `severity` descending
4. `confidence` descending
5. `candidate_id` ascending

Visual recommendation bands (`Strong`, `High`, `Worth exploring`, badge colors) are presentation only — never execution logic. A report may show a different editorial layout, but never a silently different ranking algorithm.

## Deduplication

Candidates that share a root cause, seam, behavior, file cluster, or implementation contract merge into one candidate. `duplicate_group` names the cluster; `merged_from` and `lane_sources` record provenance; each lane's observations are preserved under the merged candidate's evidence. Score the merged candidate fresh from the combined evidence rather than averaging its parts. Emit separate candidates for the same underlying issue only when their fixes are genuinely different.

## Report sections

Every HTML report built on this spine is self-contained and contains, in order:

1. **Executive summary**
2. **Overall repo grade** — a letter grade (A–F) justified from the scorecards, not asserted
3. **Lane scorecards** — per-lane health scores (single-agent reports substitute per-category scorecards)
4. **Top merged candidates**
5. **Candidate ledger** — full schema above; every candidate independently selectable
6. **Lane findings** — per-lane detail, preserved under merged candidates
7. **Cross-lane duplicate groups**
8. **Human-decision blockers** — each named against connected-impact-sweep's `## Human-decision categories`
9. **Quick wins** — high priority_score, high locality, low blast_radius
10. **High-leverage deep work** — high leverage with larger blast radius; worth a design pass
11. **Unsafe-to-auto-execute work** — high human_decision_risk or regression_risk
12. **Verification readiness** — the testability picture; harnesses that must exist before fixes can be proven
13. **Recommended queue** — eligible candidates in the stable ranking order (`## Eligibility and stable ranking` above), with blocked candidates listed as decisions-needed rather than dropped

---

# Report style

Canonical **visual** spine for every scored HTML report in this skill family (the codebase-integrity-audit-loop report, the Repo Audit Swarm report, the production-flywheel report stage, and any scored report adapter). This is the visual half of this file: the **scoring spine** above owns *what sections exist and how candidates are scored*; this half owns *how the report looks*. Other skills reference **Report style** (this half of `REPORT-SCORING.md`) rather than restating type, color, or component rules.

The aesthetic is **editorial-technical**: a light, paper-toned reading surface; one display face for headings, one grotesque for body, one mono for anything machine-derived (IDs, file paths, scores); a single accent; and a disciplined severity scale. No gradients, no emoji, no drop-shadow-heavy "dashboard" chrome. It should read like a well-set audit memo, not a SaaS dashboard.

## Non-negotiables

- **Inline styles only.** No stylesheet classes, no CSS framework. The only `<style>` content allowed is `@font-face`/font `<link>`, `@keyframes`, body/`a`/`code` resets, and scrollbar styling. Everything else is an inline `style=""`. (This keeps each report a single self-contained file that paints top-to-bottom as it streams.)
- **Semantic color, never decorative.** Color encodes severity/health/evidence-kind. Do not tint things for variety.
- **Tabular figures for all scores.** Any number in a table or matrix uses the mono face with `font-variant-numeric:tabular-nums` so columns align.
- **One accent.** Indigo by default. Do not introduce a second brand hue; the severity scale is the only other color family.
- **Minimum type sizes:** body 15px, small print/labels never below 10px, table body 13px. Line-height 1.55–1.6 for prose.

## Type

Load once, in the report's `<head>`/helmet:

```html
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Public+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
```

| Role | Family | Usage |
|---|---|---|
| Display | **Space Grotesk** (600/700) | h1, section titles, scorecard grades, big stat numbers. Tight tracking: `letter-spacing:-.02em` (h1 `-.03em`). |
| Body | **Public Sans** (400/500/600/700) | All prose, table cells, list items. |
| Mono | **IBM Plex Mono** (400/500/600) | Candidate IDs, file paths/`<code>`, all scores, kicker/eyebrow labels, column headers, metadata line. |

Kicker/eyebrow and table column headers are mono, uppercase, `font-size:10–11px`, `letter-spacing:.05–.09em`, color `--faint`.

## Color tokens

Declare these as the palette; use them by value inline (or via a `--*` block on the root wrapper — but the *reference implementation keeps them literal inline* so nothing depends on cascade during stream). Canonical values:

```
--paper   #F4F5F7   page background (with a faint radial indigo wash at top)
--panel   #FFFFFF   cards, tables, nav
--ink     #141821   primary text
--ink2    #4B5563   secondary text / table body
--faint   #8A93A3   labels, metadata, captions
--line    #E6E8EE   card & table outer borders
--line2   #EEF0F4   in-table row dividers
--code    #F2F3F7   inline code background

--accent      #2540E8   the one accent (indigo)
--accent-ink  #26327A   accent text on light (candidate IDs in tables)
--accent-bg   #EAEDFD   accent tint fill
```

**Severity / health / evidence scale** — the only other colors. Each is an ink + a tint-bg pair, used for chips and left-border card accents:

```
crit   ink #C0342B  bg #FBEAE8   absent / blocked / critical
high   ink #B45309  bg #FAEFE0   drift-prone / latent-risk / grade C‑ & C+
med    ink #15803D  bg #E6F3EB   fair / good / grade C
low    ink #516079  bg #EDF0F5   unknown / neutral
violet #6D3BD1               design-branch card accent
```

**Evidence-kind chips** map to this scale: `FACT`→med, `INF`→high, `UNK`→low. Render as mono, 10px, 600 weight, tint-bg pill.

Always set `a`/`a:hover` and `code` colors in the reset block so user-added links and inline code never fall back to browser defaults.

## Layout shell

- Centered column, `max-width:1060px`, `padding:56px 28px 120px`, on `--paper`.
- Faint top wash: `background-image:radial-gradient(120% 55% at 50% -8%, rgba(37,64,232,.05), transparent 60%)` — the *only* gradient permitted, and it must stay this subtle.
- One `rise` fade-in on the top wrapper (`@keyframes rise{from{opacity:0;transform:translateY(10px)}}`, `.5s ease both`). No other entrance animation.

### Masthead
Mono kicker → display h1 (≈40px) → one-line subtitle, with a right-aligned **stat cluster** (2–4 big Space-Grotesk numbers with mono labels underneath: candidate count, lane count, overall grade). Below: a mono metadata line (`date · branch · commit · mode`, each `white-space:nowrap`) and a row of pill chips summarizing the run. Keep the title block `flex:1 1 320px` so it wraps cleanly above the stats on narrow widths — never let the h1 collide with the stat cluster.

### Contents nav
A `--panel` card, `border-radius:14px`, two-column list (`columns:2`), each entry a mono two-digit index + link.

### Section headers
Every one of the scoring spine's numbered sections opens with the same masthead row: a `border-top:1px solid --line`, then a mono two-digit index beside a Space-Grotesk 23px title. This numbered rhythm is the report's signature — keep it identical across all sections.

## Components

**Card / panel** — `background:--panel; border:1px solid --line; border-radius:12–16px`. Optional `box-shadow:0 1px 2px rgba(20,24,33,.03)` (keep shadows this faint). For themed cards (exec-summary risks, candidate cards) add a **3px left border** in the relevant severity/action color.

**Tables** — wrap in an `overflow-x:auto` rounded `--panel` container with `min-width` so they scroll on mobile instead of crushing. Header row: mono uppercase 10–11px `--faint` labels, `border-bottom:1px solid --line`. Body rows divided by `border-top:1px solid --line2` (not full borders). Candidate IDs in `--accent-ink` mono; scores in tabular-nums mono. `vertical-align:top` for multi-line cells.

**Candidate cards** — one `<details>` per candidate; left-border color = recommended-action family (direct-fix/quick → med; design → violet; blocked → crit). `<summary>` (list-style removed) shows the mono candidate ID + Space-Grotesk title on the left and a mono `pri N · action` on the right. Body is a two-column `<dl>` (`grid-template-columns:150px 1fr`) with mono uppercase `--faint` terms (Category, Location, Friction, Seam/rule, Evidence, Branch/mode, Enforceable check, Human-decision, Lane sources, Dedup…). Support an `expandAll` prop that sets `open`.

**Health / status chips** — inline-block, `border-radius:6px`, `padding:2px 9px`, 11.5px 600, using a severity ink+bg pair. Labels: `absent`/`manual only`→crit, `drift-prone`→high, `fair`/`good`→med.

**Priority "heat" chip** — the priority_score rendered as a mono pill whose indigo fill deepens with priority. Reference mapping (priority range −10…+22 from the **Priority rollup** above):

```js
function heat(pri){
  const a = Math.max(0.10, Math.min(0.92, (pri + 3) / 25));      // alpha ramp
  return { priBg:`rgba(37,64,232,${a.toFixed(2)})`,
           priColor: a > 0.55 ? '#ffffff' : '#26327A' };          // flip text for contrast
}
```

Apply to both the Top-candidates table and the score-matrix `pri` column so a reader scans priority by ink density.

**Blocked marker** — a mono `BLOCKED` tag (crit ink/bg, 9.5px, 600) next to the title of any candidate with `human_decision_risk ≥ 4` or a non-empty `blocked_by`.

**Triage summary strip** — directly under the masthead, before the contents nav: a row of three `--panel` cards a reader can triage in five seconds, all derived from the candidate array (nothing codebase-specific).
1. *By recommended action* — a 9px segmented distribution bar (one colored slice per action, width = share of candidates) plus an inline swatch legend with counts. Action→color reuses the scale, not new hues: direct-fix→med, design→violet, triage→accent, prototype→low(slate), fitness-check→high(amber).
2. *By priority band* — three big Space-Grotesk counts: High ≥12 (ink), Mid 6–11 (ink2), Low ≤5 (faint). Bands are cut on the `priority_score`, so they hold for any repo. Bands are presentation only — never execution logic.
3. *Needs decision* — the blocked count as one big crit number, on a crit left-border card.

**Interactive index (filter + click-to-sort)** — the score matrix is the scannable, interactive index; the `<details>` cards remain the full detail. Two controls, driven from logic state `{ sortKey, sortDir, filter }`:
- *Filter chips* — a pill row: `All`, one per present action, and `Blocked`, each with a live count. Active chip = accent fill/white; inactive = panel/`--line` border. Chips carry `data-filter` and share one `onFilter` handler that reads `e.currentTarget.dataset.filter`.
- *Sortable headers* — build the `<thead>` from a `cols` array; each `<th>` carries `data-key` and one shared `onSort` handler (`e.currentTarget.dataset.key`). Clicking a column sorts by it (numeric for scores, `localeCompare` for id/title); clicking the active column flips direction. Show a ▼/▲ in accent on the active header. Default sort: `pri` descending.

Keep argument-free handlers: one `onSort`/`onFilter` reading a `data-*` attribute, never a per-cell closure in a template hole (holes are dotted lookups only). Filtering/sorting acts on a computed `visibleMatrix`; the cards below stay complete so no detail is ever hidden.

## Run-to-run diff

Because this is an audit *loop*, a report is far more useful when it shows the delta since the previous run. This is optional — render it only when a prior run's candidate array is available (persisted from the last report, or passed in as a `previous` prop); with no baseline, omit every diff affordance silently and the report reads exactly as a first run.

**Data model.** Diff the current candidate array against the previous by `id`. Each current candidate gets a `delta`:
- `new` — id absent from the previous run.
- `carried` — id in both; compute `priDelta = pri − prev.pri`.
Separately, previous ids missing from the current run are `resolved` (they were fixed or fell out of scope) — these have no current row, so surface them as a small list, not inline.

```js
function diff(cur, prev){
  const pmap = new Map((prev||[]).map(r=>[r.id, r]));
  const rows = cur.map(r=>{
    const p = pmap.get(r.id);
    return { ...r, delta: p ? 'carried' : 'new', priDelta: p ? r.pri - p.pri : 0 };
  });
  const curIds = new Set(cur.map(r=>r.id));
  const resolved = (prev||[]).filter(r=>!curIds.has(r.id));
  return { rows, resolved, hasBaseline: !!prev };
}
```

**Semantics → color.** Stay on the existing scale; diff is attention, not a new hue.
- `new` → **high** (amber) — arrived this run, wants a look.
- `resolved` → **med** (green) — gone since last run, good.
- `priDelta > 0` (got more urgent) → **high**; `priDelta < 0` (cooling off) → **low/slate**; `0` → no marker.

**Visual treatment.**
- *Strip:* add a fourth summary card, `Since last run`, with three mono counts — `+N new`, `−M resolved`, `Δk re-scored` (candidates whose `priDelta ≠ 0`). Omit the card entirely when `hasBaseline` is false.
- *Candidate marker:* next to the title (in both the matrix row and the `<details>` summary), a small mono tag. `new` → an `NEW` pill (high ink/bg, 9.5px, 600, same footprint as the `BLOCKED` tag). `carried` with a non-zero `priDelta` → a mono `▲+3` / `▼−2` in the delta color (`▲` up = high, `▼` down = slate), `font-variant-numeric:tabular-nums`. Unchanged carried candidates get nothing — keep the default quiet.
- *Resolved list:* a compact `--panel` card near the ledger top titled `Resolved since last run`, each entry a struck-through mono id + its old title in `--faint`, with a med left-border. Skip the card when the list is empty.
- *Filter:* add a `New` chip (and optionally `Re-scored`) to the interactive-index filter row when a baseline exists, using the same `data-filter`/`onFilter` mechanism (`delta==='new'`, `priDelta!==0`).

**Persistence for standalone reports.** When the report runs outside a harness that supplies `previous`, snapshot the current candidate array to `localStorage` under a per-repo key (e.g. `report:<repo>:lastRun`) on load, and read the prior value as the baseline before overwriting. Only ever write your own key; never clear others. In a skill/harness context, prefer an explicit `previous` prop over `localStorage` so the baseline is reproducible.

## Data-drive the repetitive parts

Drive the score matrix, top-candidates table, lane scorecards, triage strip, and filter chips from **one array in the logic** (one row object per candidate: `id, title, action, the eight 1–5 scores, priority_score, effort, status, blocked`), not hand-written rows — it keeps the priority-heat mapping, summary counts, and blocked markers consistent and makes re-scoring a data edit. Hand-author only the prose sections and the per-candidate `<details>` bodies (their evidence text is unique).

This is the generalization seam: **nothing in the strip, matrix, or filters is specific to any one codebase.** The row schema is exactly the candidate object from the **Candidate schema** above, so any repo's audit — Python, Go, a monorepo, a single service — produces the same components by populating that array. Language/tier-specific text lives only in the prose sections and card bodies.

## Tweaks to expose

On the report component, expose (via `data-props`): **accent color** (curated swatches, default `#2540E8`), **expand-all cards** (boolean), and **show score matrix** (boolean). These are code-only behaviors; do not add tweaks for copy or single colors the editor already handles.

## Reference implementation

`Codebase Integrity Report.dc.html` in this project is the built reference for every rule above — clone its masthead, section-header row, table treatment, candidate-card `<details>`, and the `heat()` mapping when generating a new report.
