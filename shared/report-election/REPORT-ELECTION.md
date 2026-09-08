# Shared report election

This package owns the common interaction contract for optional human-facing report rendering.

## Core invariant

**Canonical machine artifacts are mandatory. Human-facing reports are user-elected.**

A report-capable skill must never weaken, skip, or delay its core analysis merely because the user skips presentation. The machine artifact must exist and validate independently of any HTML/Markdown report projection.

## Policy

Every report-capable invocation resolves one presentation policy:

- `ask` — compute a machine lean, explain it, and ask the user to choose A/B before rendering.
- `generate` — render without asking because the user explicitly requested a report or a parent explicitly authorized it.
- `skip` — do not render because the user explicitly declined it.
- `inherit` — child skill does not ask and does not render; a parent workflow owns the report election.

Direct user invocation defaults to `ask` unless the user already expressed an explicit preference.
Nested report-capable children default to `inherit` when the parent declares `report_owner`.

## Election timing

Prefer this order:

1. complete and validate canonical machine artifacts;
2. compute report utility from the actual result;
3. present the machine lean;
4. ask A/B;
5. render only if the user chooses A.

When a legacy producer cannot defer rendering without rerunning the expensive analysis, it may ask immediately before the atomic producer runs, but must still provide a machine lean and must support a true skip mode. This exception should disappear when a separate report renderer becomes available.

## User-facing shape

Use one concise election:

> Analysis is complete and a human-facing report is available.
>
> **A. Generate the full report.**
> **B. Skip the report and return the canonical artifacts + concise summary.**
>
> **My recommendation: A —** [result-specific reason].
>
> Choose A or B.

The machine must recommend `generate` or `skip`; it may not present a neutral choice.

## Lean guidance

Lean `generate` when a report materially improves understanding or durable review, especially when there are:

- multiple findings/candidates or meaningful comparisons;
- cross-cutting relationships across owners or surfaces;
- rankings, scorecards, coverage/confidence, or substantial uncertainty;
- visual/topological structures that prose compresses poorly;
- a broad repository-wide assessment;
- a likely need to revisit or share the result.

Lean `skip` when:

- one narrow result dominates;
- the report would mostly repeat the concise response;
- a parent report will synthesize the same child material;
- the renderer adds little decision value relative to its presentation cost.

Report cost can affect the lean; it must never affect the rigor of the underlying analysis.

## Explicit overrides

The following are authoritative examples:

- "give me the full report" -> `generate`
- "no HTML/report" -> `skip`
- parent envelope `{ report: "inherit", report_owner: "repository-improvement-assessment" }` -> `inherit`

Do not ask when the user already chose.

## Nested workflows

One user-visible workflow gets at most one report election.

If RIA invokes Health, Integrity, and Architecture, those children receive:

```yaml
presentation_policy:
  report: inherit
  report_owner: repository-improvement-assessment
```

They emit their canonical machine artifacts and concise child receipts, but do not ask and do not render. RIA asks once for the combined report.

## Authority boundary

A report is a read-only projection. It does not become the source of truth, change candidate ownership, modify lifecycle state, or authorize execution.

Skipping a report must never erase:
- evidence or coverage receipts;
- canonical health/assessment artifacts;
- candidate ledgers/sets;
- graph/action-set references;
- provenance;
- lifecycle state already validly produced.

## Report-capability declaration

A user-facing skill should adopt this contract only if it has a real report renderer or durable report projection. Benchmark reports, internal receipts, and disabled adapters do not trigger an election.
