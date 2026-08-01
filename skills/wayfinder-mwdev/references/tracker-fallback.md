# Local-Markdown Tracker (Fallback)

Load only when no tracker doc is provided for this repo or effort. When a repo supplies its own tracker doc with a "Wayfinding operations" section, that doc wins and this file stays unread. This fallback is self-contained: plain files, no external service, no dependencies beyond Python 3 for the two helper commands.

## Layout

```
.wayfinder/
  <map-slug>/
    map.md
    tickets/
      001-<slug>.md
      002-<slug>.md
```

`<map-slug>` is a kebab-case gist of the destination (`s3-artifact-store-migration`). Ticket filenames are the zero-padded id plus a kebab title slug; the next id is max existing + 1. In a git repo, commit `.wayfinder/` and make each lifecycle change one small commit — `wayfinder: <action> <name>` (e.g. `wayfinder: close 007 auth boundary`) — so concurrent agents merge trivially (state is per-ticket files) and history doubles as an audit trail. Outside git, the files alone carry state.

## map.md

```markdown
---
kind: wayfinder-map
state: open        # open | closed
driver: ""         # the human driving the map — default decision_owner for tickets
created: 2026-07-21
successor: null    # path or URL of the fresh map after a destination redraw
---
```

Body: the five sections from `assets/map-body.md`. In Decisions so far, refer by name with relative links: `[Auth boundary](tickets/007-auth-boundary.md) — gist`.

## Ticket files

```markdown
---
id: 7
title: "Where does the auth boundary sit?"
type: grilling     # research | grilling | design | prototype | task
state: open        # open | closed
claimed_by: ""     # worker identity of the agent holding the claim; empty = unclaimed
decision_owner: "" # human who confirms this decision; empty = the map's driver
blocked_by: []     # list of ticket ids, e.g. [3, 5]
created: 2026-07-21
closed: null       # date on close
---
```

Body: `## Question` (plus optional `## Context` links) from `assets/ticket-body.md`. On close, append `## Resolution` per `assets/resolution-comment.md`, set `state: closed` and the `closed` date.

## Operations

| Operation | How |
|---|---|
| Create map | Write `map.md` from the template |
| Create ticket | Next id, write the file; leave `blocked_by: []` on the first pass (create-then-wire) |
| Wire blocking | Second pass: edit `blocked_by` lists once ids exist |
| Claim / release | Set `claimed_by` to this agent's worker identity / back to `""` — never the human's handle |
| Comment | Append under a `## Notes <date>` heading (resolutions get `## Resolution`, nothing else does) |
| Close | Append the resolution, set `state: closed`, set `closed` |
| Frontier | `python ${CLAUDE_SKILL_DIR}/scripts/tracker.py frontier .wayfinder/<map-slug>` |
| Integrity check | `python ${CLAUDE_SKILL_DIR}/scripts/tracker.py check .wayfinder/<map-slug>` |

Frontier means: `state: open`, `claimed_by` empty, and every id in `blocked_by` closed — listed in id order. If Python is unavailable, apply that definition by reading frontmatter directly; the script is a convenience, not the definition.

## Blocking without a native relation

`blocked_by` **is** this tracker's blocking convention. Because nothing renders it visually, paste the script's frontier output for the human whenever they ask what's takeable, and keep the map's Not-yet-specified section current — those two views replace the tracker UI a native platform would provide.

## Concurrency

Files are last-write-wins. Claims still prevent double work because every agent claims before working (standing invariant 2), and because each agent claims under its **own worker identity** — a stable handle for the session, such as the environment's agent id or `<user>-<tool>-<seq>` (e.g. `mark-cc-0722a`) when none exists — so concurrent claims stay distinguishable and resume means resuming *your* claim. Legacy tickets carrying an `assignee` field are treated as claimed; `tracker.py check` flags them for renaming to `claimed_by`/`decision_owner`. Small, frequent commits shrink conflict windows; if two agents do collide on `map.md`, re-run the integrity check and repair per `references/recovery.md` — per-ticket state makes the merge mechanical.
