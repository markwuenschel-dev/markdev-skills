# Recovery and Repair

Load when: the work-mode integrity check found drift; a ticket overran its work cycle; claims look stale; a tracker write failed mid-record; the human is redrawing the destination.

## Integrity check (work mode, step 1)

Scan for: closed children absent from Decisions so far; index lines pointing at open, missing, or out-of-scope tickets; `blocked_by` (or native blocking) referencing missing tickets; blocking cycles; open tickets carrying a Resolution; closed tickets missing one; duplicate ids. On the fallback tracker, `scripts/tracker.py check` performs all of these and exits nonzero with actionable findings; on native trackers, run the equivalent queries the tracker doc names. A clean check costs seconds — never skip it to save time, because every later step trusts the index.

## Repair order

1. **Finish half-recorded resolutions first** — complete whichever of comment → close → index is missing, using the ticket's own content as the source of truth (the map only indexes; it is never the source).
2. **Then fix index lines:** add missing ones, remove orphans, move out-of-scope entries to the Out of scope section.
3. **Then blocking edges:** drop references to deleted tickets; surface cycles to the human with the ticket names involved — never break a cycle silently, because which edge is wrong is a decision.
4. **Only then take new work.**

## Resuming an interrupted work cycle

A ticket whose `claimed_by` matches your own worker identity and carries progress comments resumes from that recorded state: re-read the comments, the answers already received, and any child packets linked, then continue the cycle — never restart the interview or re-ask what the record answers.

## Crash mid-resolution

- Resolution comment exists, ticket still open → close it, then index it.
- Ticket closed, no index line → append the line, gisted from the resolution.
- Assets exist but no resolution comment → the decision was **not** recorded. Treat as partial work: comment what exists and where, leave the ticket open, clear any dangling `claimed_by`.

## Stale claims

A claim with no progress commented is not stealable by an agent on its own — another agent's work cycle may be live right now. Surface it by ticket and worker name: "*[Auth boundary](…)* is claimed by `mark-cc-0718b` with nothing commented since the claim — release it?" Release only on the human's word; your own worker identity's stale claim is simply resumed. If the frontier is empty solely because of claims, say exactly that rather than reporting the map done or picking a blocked ticket.

## Splitting an oversized ticket

When a ticket overruns one work cycle, the split **is** the cycle's work for that ticket:

1. Comment the partial findings on the original — everything learned, nothing decided.
2. Create the narrower child tickets (create-then-wire), typed and sized.
3. If the original question was mis-sized and dissolves into the children, close it with resolution "superseded by *<names>*" and index that line.
4. If the question stands but needs the children answered first, keep it open and block it on them.
5. Release any claim you can't carry forward; stop.

Never resolve one of the new children in the same cycle — the one-primary-ticket invariant holds.

## Destination redraw

The destination is immutable per map. When the human redraws it: close this map issue with a pointer to its successor (fallback tracker: set `successor` in `map.md` frontmatter), chart a fresh map — prior Decisions-so-far becomes charting input — and carry forward only the tickets that survive the new scope, as **new** tickets linking their ancestors. Out-of-scope work from the old map re-enters, if at all, only through the new charting pass.

## Failed tracker writes

Report which of comment → close → index completed. All three are idempotent re-run targets: re-run the missing tail, verify, and only then proceed to graduation. If the tracker itself is down, stop and tell the human what state the ticket is in — a half-recorded resolution left silent is the one failure this file exists to prevent.
