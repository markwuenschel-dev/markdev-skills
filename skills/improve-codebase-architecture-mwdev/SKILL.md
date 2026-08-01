---
name: improve-codebase-architecture-mwdev
description: Analyze one selected structural architecture problem, compare alternatives, and return a decision-ready recommendation without implementation. Use for module depth, ownership, seam, or boundary decisions; not for repository health grading or repair execution.
disable-model-invocation: false
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

## Family handoff contract

This skill has two bounded modes: a standalone structural request limited to the user's stated problem (including any supplied hotspot or scope rule), or a health/flywheel/audit handoff limited to one validated spine-v3 candidate. In either mode, inherit mission, scope, non-goals, mutation posture, decision owner, and return owner; do not begin an unrelated repository-wide review.

For an inbound health candidate, validate the shared spine envelope, retain the exact `candidate_id`, provenance, and `implementation_authorized: false`, then derive non-overlapping evidence lanes from real architecture surfaces. Evidence workers return claims, evidence, affected surfaces, and uncertainty only. The parent owns deduplication, alternative comparison, synthesis, recommendation, report, and return. Never call `repository-health-assessment` during this handoff and never implement.

Return this packet to the caller or router:

```yaml
architecture_candidate_return:
  candidate_id: ""
  disposition: ready_for_integrity_loop | needs_expanded_grill | needs_wayfinder_mwdev | needs_prototype | blocked_needs_human_decision | rejected | superseded
  recommended_direction: ""
  alternatives_considered: []
  rejected_alternatives: []
  confirmed_architecture_findings: []
  inferred_findings: []
  unknowns: []
  affected_surfaces: []
  connected_impact_required: false
  implementation_constraints: []
  verification_obligations: []
  artifact_links: []
  updated_candidate: {}
```

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

**Scoring — canonical spine.** This is a scored report in the family, so use `shared/candidate-ledger-spine/REPORT-SCORING.md`, `candidate.schema.json`, and `ledger-verify.js`. Preserve spine v3 arithmetic, eligibility, ranking, provenance, and candidate identity; never keep a private verifier, hand-write a score, or re-derive the renderer. The architecture report remains editorially distinct from the health report.

**Use CONTEXT.md vocabulary for the domain, and the `/codebase-design` vocabulary for the architecture.** If `CONTEXT.md` defines "Order," talk about "the Order intake module" — not "the FooBarHandler," and not "the Order service."

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly in the card (e.g. a warning callout: _"contradicts ADR-0007 — but worth reopening because…"_). Don't list every theoretical refactor an ADR forbids.

See [HTML-REPORT.md](HTML-REPORT.md) for the full HTML scaffold, diagram patterns, and styling guidance.

Do NOT propose interfaces yet. After the file is written, ask the user which candidate(s) they want to pursue **by number**. When this command runs standalone, one candidate is the usual answer. When it runs inside a flywheel (`production-flywheel`), the user may pick one, several, all, or an explicit order (e.g. `4 then 1 then 3`) — that skill turns the answer into a queue. Either way, do not start implementation from this command; selection is not implementation approval.

### 3. Grilling loop

Once the user picks a candidate, run the `/expanded-grill-with-docs` skill to walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

For a standalone request, keep decisions in the architecture report. Do not mutate the repository or domain model while analyzing; the architecture skill stops before implementation and returns its recommendation to the caller.

- **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term to `CONTEXT.md`. Create the file lazily if it doesn't exist.
- **Sharpening a fuzzy term during the conversation?** Update `CONTEXT.md` right there.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR, framed as: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing — skip ephemeral reasons ("not worth it right now") and self-evident ones.
- **Want to explore alternative interfaces for the deepened module?** Run the `/codebase-design` skill and use its design-it-twice parallel sub-agent pattern.
