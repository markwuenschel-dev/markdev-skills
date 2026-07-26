# Architecture Note: Breadth, Depth, and Who Owns What

Wayfinder and Expanded Grill with Docs are both interviewers; they differ on the axis that matters for routing. **Wayfinder is breadth**: it discovers and holds *terrain* — many dependent, partially visible decision surfaces whose resolution spans work cycles and must survive between them. **Expanded Grill is depth**: one bounded, evidence-backed design interview that turns one selected direction into a design contract within one engagement. The Loop Router sits above both and owns the choice; scouts sit below both and own nothing but bounded evidence; delivery lifecycles sit after both and own everything Wayfinder is forbidden to touch.

The parent-owned-synthesis rule is the same one Expanded Grill applies to its specialist lanes, lifted one level: independent perspectives see only slices of the terrain, so letting any child mutate shared state produces duplicated questions, contradictory terminology, local optimization, and unclear ownership. Every packet flows *up*; every decision about what a packet means is made by the owner of the state it would change.

## Ownership

- **Loop Router owns:** selecting Wayfinder; selecting Expanded Grill directly when Wayfinder is unnecessary; receiving completed Wayfinder results; selecting the next delivery lifecycle; transitions between major loops.
- **Wayfinder owns:** the destination; the durable map; decision tickets; fog; dependencies; frontier selection; charting scouts; mapping questions; ticket resolution state; integrating child results; deciding when the map is complete.
- **Expanded Grill owns (as a Wayfinder child):** one bounded design interview for one design-sized ticket; the design documents it produces; confirmed decision candidates; unresolved questions it discovers. It does **not** own Wayfinder map state, ticket closure, map dependencies, frontier selection, or Loop Router transitions.
- **Scouts own:** bounded evidence collection; candidate decision identification; suspected dependencies; contradictions; candidate human questions. They do **not** own map mutation, ticket creation or resolution, scope rulings, final terminology, human-facing output, or lifecycle transitions.
- **Delivery lifecycles own:** implementation planning, task generation, coding, migration execution, deployment, production verification, PR and release work. Wayfinder performs none of these.

## Routing into Wayfinder

The Loop Router selects Wayfinder when a selected effort contains multiple dependent decision surfaces; resolving one decision is expected to expose others; durable state across work cycles is necessary; one bounded Expanded Grill interview is insufficient; the effort carries substantial fog rather than only unanswered design questions.

It bypasses Wayfinder — routing directly to `/expanded-grill-with-docs` — when one bounded selected direction is already known, the relevant evidence can be inspected coherently, the problem needs depth rather than persistent breadth, and no durable multi-cycle map is needed. **Complexity alone is not sufficient reason to choose Wayfinder.** Wayfinder applies the same test on itself: invoked on an effort that turns out to be one bounded design question, it declines to chart and recommends `/expanded-grill-with-docs`; on an effort that fits direct work, it says so and returns.

If tracker mutation requires human authorization, the router's existing authorization boundary applies — Wayfinder adds no authorization machinery of its own.

## Returning from Wayfinder

A map is complete when the destination is mapped, all sharp decisions are resolved or deliberately deferred, and no meaningful fog remains. Wayfinder then assembles `assets/loop-router-return.yaml` — resolved decisions, design artifacts, deferred non-blocking items, prohibited interpretations, and a recommended next capability with its reason — and hands back.

**The recommendation is advisory.** The Loop Router selects the actual next lifecycle. Wayfinder never directly initiates the production flywheel, implementation planning, ticket generation, coding, deployment, or PR work — not from map completion, not from an approved design contract, not from anything written in map notes.

## Non-recursion

The chain is a tree, one level at a time: Router → Wayfinder → (scouts | Expanded Grill → its lanes). A child invoked by Wayfinder never invokes Wayfinder or the Loop Router; Expanded Grill run as a child never creates or edits any map; scouts never invoke top-level capabilities; there are no nested maps — child work gets tickets on the one map. This keeps every loop's state owned by exactly one agent and every transition visible at exactly one level.
