# Requirements ledger

Canonical shape for tracking selectable work items (requirements, integrity candidates, flywheel queue items) across loops.

This is the **status + selection** companion to `REPORT-SCORING.md` (which owns scores and report sections). A ledger may be embedded in an HTML report or kept as a separate YAML/Markdown artifact — schema below is required either way.

## Entry schema

```yaml
id: REQ-001                    # stable id; candidate_id maps here
title:
source:                        # report | user | issue | swarm | other
  ref:
status: open                   # see Status enum
priority_score:                # from REPORT-SCORING when scored
recommended_action:            # direct-fix | design | prototype | fitness-check | triage | reject
execution_mode:                # sequential | connected-impact-sweep | swarm | blocked-needs-human-decision
blocked_by: []                 # HUMAN-DECISIONS category names
owner: human | agent | unknown
acceptance_criteria: []
verification_commands: []
out_of_scope: []
history:
  - at: ISO-8601
    event: created | selected | shipped | blocked | rejected | superseded
    note:
```

## Status enum

| Status | Meaning |
| --- | --- |
| `open` | Selectable, not started |
| `selected` | Chosen for the current loop / queue item |
| `in_progress` | Execution underway |
| `shipped` | PR opened (or equivalent delivery); not necessarily merged |
| `fixed` | Verified fixed without a PR if appropriate |
| `check-added` | Enforceable check added as the primary outcome |
| `rejected` | Out of scope / rejected (`recommended_action: reject`) |
| `superseded` | Replaced by another id |
| `blocked` | Cannot proceed for a non-human reason (tooling, baseline) |
| `needs-human-decision` | Blocked on `HUMAN-DECISIONS.md` category |
| `needs-rereport` | Stale; re-scan before selection |

## Rules

1. **Exactly one** `selected` / `in_progress` item per integrity audit loop.
2. Flywheel may have one `in_progress` queue item and many `selected` (queued) items.
3. Auto mode never selects `needs-human-decision` or `blocked-needs-human-decision` execution mode.
4. Every status transition appends `history`.
5. Durable rejection reasons live here or in project `.out-of-scope/` — not only in chat.

## Minimal Markdown rendering

```markdown
| ID | Title | Status | Pri | Action | Blocked by |
| --- | --- | --- | --- | --- | --- |
| C-012 | … | open | 9 | design | — |
```
