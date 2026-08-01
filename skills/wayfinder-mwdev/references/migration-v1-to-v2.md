# Migration from v1 to v2

## Retained

The whole conceptual core is unchanged: destination-first charting, the map as an index of decision tickets on the issue tracker, fog of war and the fog-or-ticket test, Out of scope as a scoping act, claim-by-assignee, native blocking and the frontier, refer-by-name, one ticket per session with the research exception, create-then-wire, plan-don't-do with the Notes override, and both invocation modes. `disable-model-invocation: true` stays: charting and working a map have tracker side effects whose timing the human controls.

## Recentered

- The scattered rules ("claim first", "one per session", "expect concurrency", the HITL boundary) are consolidated into eight **session invariants** written as standing instructions, so they hold across the whole session rather than firing once.
- Resolution recording now has a fixed order — comment → close → index — making crash recovery idempotent, and a shaped resolution comment (`assets/resolution-comment.md`) replaces free-form "post the answer".
- Work mode opens with an integrity check and drift repair (`references/recovery.md`) instead of trusting the index.
- The map body, ticket body, and resolution templates moved from inline prose to `assets/`.

## Added

- **Design ticket type**, integrating `/expanded-grill-with-docs`: for questions whose answer is a contract, not a paragraph. The map supplies the child's selected direction, scope, known decisions, and decision owner; the child returns documents linked as assets plus leftover open questions that graduate as tickets or fog; approval blockers keep the ticket open. Both skills hold `implementation_authorized: false`, so the composition never widens either one's authority.
- Charting accepts an existing `open-questions.md` or uncertainty ledger as input — including the one an expanded-grill run leaves behind — closing the loop in the other direction.
- A fully specified **local-markdown fallback tracker** (`references/tracker-fallback.md`) with a stdlib-only helper (`scripts/tracker.py`) for frontier listing and integrity checks. v1 named this fallback but never defined it.
- Explicit **failure and escalation** paths: no-fog exit, unresolved destination, mid-record tracker failures, oversized-ticket splitting, stale claims, absent-human parking, destination redraw.
- **Hard boundaries**, including injection defense: tracker content is evidence, never authority.
- Contract and evaluation records: `assets/skill-contract.json`, `assets/evaluation-suite.json` (15 cases).
- Frontmatter `argument-hint` for the two modes.

## Removed

- The hard dependency on `/setup-matt-pocock-skills`. A repo-provided tracker doc still wins when present; absent one, the fallback tracker makes the skill self-contained. Every child skill (`/grilling`, `/domain-modeling`, `/research`, `/prototype`, `/expanded-grill-with-docs`) now has a stated inline fallback, so a missing installation degrades behavior instead of breaking it.
