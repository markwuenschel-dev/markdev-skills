---
name: improve-codebase-architecture
description: Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.
disable-model-invocation: true
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

This command is _informed_ by the project's domain model and built on a shared design vocabulary:

- Run the `/codebase-design` skill for the architecture vocabulary (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**) and its principles (the deletion test, "the interface is the test surface", "one adapter = hypothetical seam, two = real"). Use these terms exactly in every suggestion — don't drift into "component," "service," "API," or "boundary."
- The domain language in `CONTEXT.md` gives names to good seams; ADRs in `docs/adr/` record decisions this command should not re-litigate.

## Process

### 1. Explore

Read the project's domain glossary (`CONTEXT.md`) and any ADRs in the area you're touching first.

Then use the Agent tool with `subagent_type=Explore` to walk the codebase. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. Present candidates as an HTML report

Write a self-contained HTML file to the OS temp directory so nothing lands in the repo. Resolve the temp dir from `$TMPDIR`, falling back to `/tmp` (or `%TEMP%` on Windows), and write to `<tmpdir>/architecture-review-<timestamp>.html` so each run gets a fresh file. Open it for the user — `xdg-open <path>` on Linux, `open <path>` on macOS, `start <path>` on Windows — and tell them the absolute path.

The report uses **Tailwind via CDN** for layout and styling, and **Mermaid via CDN** for diagrams where a graph/flow/sequence reliably communicates the structure. Mix Mermaid with hand-crafted CSS/SVG visuals — use Mermaid when relationships are graph-shaped (call graphs, dependencies, sequences), and hand-built divs/SVG when you want something more editorial (mass diagrams, cross-sections, collapse animations). Each candidate gets a **before/after visualisation**, framed as one transform panel. Lead with an **editorial masthead** (serif repo name + stat strip + ranked ledger), give every surface a soft shadow on a slightly darker page plane, and hold the serif-prose / mono-chart split. Be visual.

**Number the candidates `1..N`** and show the number in each card heading and `id`. The number is the selection handle callers use to pick candidates (see step 3 and the flywheel skills that drive this report).

**Mermaid must be sanitized.** Never hand-write Mermaid source from candidate names — a slash, colon, arrow, quote, or bracket in a name will break the diagram and the page. Drive every Mermaid diagram through the data-driven helpers in [`assets/mermaid-safe.js`](assets/mermaid-safe.js) (synthetic node ids, escaped labels, per-diagram graceful fallback), and only use Mermaid where the visual is genuinely graph-shaped. See [HTML-REPORT.md](HTML-REPORT.md) → **Mermaid safety** for the required pattern and the regression fixture.

For each candidate, render a card with:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality and leverage, and how tests would improve
- **Rank rail** — the candidate number set large in the serif down a tinted left rail, coloured by strength band; this is the selection handle and the card's spine
- **Before / After diagram** — framed as a single transform panel (before → arrow node → deep box), custom-drawn, illustrating the shallowness and the deepening
- **Recommendation strength** — one of `Strong`, `Worth exploring`, `Speculative`, rendered as a **strength meter**: the icon+word, a banded track showing where `priority_score` lands on the scale, and a contribution histogram of the eight sub-scores (the display layer of the candidate's `priority_score` — see Scoring below). A bare coloured badge throws away the number; show the meter.

End the report with a **Top recommendation** section: which candidate you'd tackle first and why — and pull a compact version of it forward as a hero under the masthead, so the first decision is made before the reader scans. Group the ranked ledger into strength bands (Strong / Worth exploring / Speculative).

**Scoring — canonical spine.** This is a *scored* report in the family, so score every candidate per the family scoring spine: the **scoring-spine half** of [`shared/REPORT-SCORING.md`](../../shared/REPORT-SCORING.md) (candidate schema, the eight 1–5 scores, the `priority_score` formula, and dedup rules are defined there and nowhere else). Take that half only — this report keeps its own look in [HTML-REPORT.md](HTML-REPORT.md), not the file's *Report style* (visual) half. Each candidate carries a `candidate_id`, file/line `evidence`, the eight `scores`, and a `priority_score` rollup; the **Recommendation strength** badge is `priority_score` rendered for humans (`Strong` = high, `Worth exploring` = mid, `Speculative` = low), and the `1..N` numbering follows priority order. When this command drives `production-flywheel`, emit the candidate ledger and a recommended queue per the spine so the flywheel can build its queue directly; the editorial before/after cards are this report's presentation layer on top of that ledger. Emit that ledger as the report's **JSON island** and render every scoring display through the data-driven helpers in [`assets/ledger-verify.js`](assets/ledger-verify.js) — recomputed priorities, derived bands and fills, verified `1..N` order, and the masthead verification chip; see [HTML-REPORT.md](HTML-REPORT.md) → **Self-verifying ledger**. Never hand-write a scoring number and never re-derive the renderer.

**Use CONTEXT.md vocabulary for the domain, and the `/codebase-design` vocabulary for the architecture.** If `CONTEXT.md` defines "Order," talk about "the Order intake module" — not "the FooBarHandler," and not "the Order service."

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly in the card (e.g. a warning callout: _"contradicts ADR-0007 — but worth reopening because…"_). Don't list every theoretical refactor an ADR forbids.

See [HTML-REPORT.md](HTML-REPORT.md) for the full HTML scaffold, diagram patterns, and styling guidance.

Do NOT propose interfaces yet. After the file is written, ask the user which candidate(s) they want to pursue **by number**. When this command runs standalone, one candidate is the usual answer. When it runs inside a flywheel (`production-flywheel`), the user may pick one, several, all, or an explicit order (e.g. `4 then 1 then 3`) — that skill turns the answer into a queue. Either way, do not start implementation from this command; selection is not implementation approval.

### 3. Grilling loop

Once the user picks a candidate, run the `/grilling` skill to walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

Side effects happen inline as decisions crystallize — run the `/domain-modeling` skill to keep the domain model current as you go:

- **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term to `CONTEXT.md`. Create the file lazily if it doesn't exist.
- **Sharpening a fuzzy term during the conversation?** Update `CONTEXT.md` right there.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR, framed as: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing — skip ephemeral reasons ("not worth it right now") and self-evident ones.
- **Want to explore alternative interfaces for the deepened module?** Run the `/codebase-design` skill and use its design-it-twice parallel sub-agent pattern.
