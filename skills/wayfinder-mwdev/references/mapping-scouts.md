# Mapping Scouts

Load when charting could use parallel evidence collection, or when a research ticket or an active decision ticket needs scout support. A scout is a bounded subagent that inspects one surface and returns a packet. Scouts inform the map; they never touch it.

## When to launch — and when not to

- **Two or more scouts** when two or more *independent* surfaces can be investigated concurrently and each can improve the map. Default **2–4**; up to **6** only for genuinely broad efforts, with the reason stated.
- **One scout or none** when the destination is narrow, one evidence surface dominates, repository inspection already exposes the likely frontier, or parallelism would only duplicate work. Never force multiple scouts on a single-surface effort.
- Scouts run **inside the current workflow** — launch, wait, synthesize. Never describe or treat scout execution as background work.

Perspectives to draw from — optional angles, not mandatory lanes: product and user outcome; domain and terminology; repository and current system; technical and architecture; data, API, schema, and migration; UX and operational workflow; risk, security, and failure modes; verification, rollout, and observability.

## Perspective prompts

Compact decision families per perspective — seeds for a scout's `questions_to_investigate`, so packet quality depends less on improvisation. Pick the families the destination touches; they are prompts, not checklists, and never all fire at once:

- **Product and user outcome:** who succeeds, what changes for them, perceived completion, value thresholds, acceptable degradation, explicit non-goals.
- **Domain and terminology:** canonical terms, entity identity, state lifecycles, invariants, forbidden synonyms, who owns a term's meaning.
- **Repository and current system:** actual current behavior, load-bearing seams, implicit contracts, doc-versus-code drift, decisions already embedded in code.
- **Architecture:** authority, boundaries, completion, consistency, ordering, partial failure, reconciliation.
- **Data and migration:** ownership, identity stability, compatibility, partial migration, cutover, backfill, rollback.
- **UX and operational workflow:** operator tasks, handoffs, interruption and resume, error surfaces, manual overrides, runbook reality.
- **Risk, security, and failure modes:** trust boundaries, authentication and authorization, blast radius, data exposure, abuse paths, harm under partial failure.
- **Verification, rollout, and observability:** proof surfaces, success and halt signals, staging, reversibility, monitoring ownership, cleanup obligations.

## The assignment

Every launch states the bounded contract — adapt `assets/scout-assignment.yaml`:

- the surface and the current destination;
- the specific questions to investigate;
- permitted evidence surfaces (paths, docs, systems — nothing broader);
- known decisions and constraints, relevant existing tickets and fog;
- explicit non-goals;
- the expected return: a `mapping_scout` packet.

A scout may use sub-scouts beneath it only when its surface itself contains independent evidence areas, the scout owns synthesis of its children, total parallelism stays bounded, and no child output mutates lifecycle state. No uncontrolled recursive swarms; no scout invokes Wayfinder, the Loop Router, or another top-level capability.

## The return packet

Scouts return `assets/mapping-scout.yaml`: evidence with sources and confidence; candidate decisions with why-it-matters, sharpness judgment, suspected dependencies, and affected destination conditions; fog candidates with why-not-yet-sharp and evidence needed; contradictions with consequences; recommended human questions with the decision each unlocks; scope findings (in, out, uncertain).

**Reject a packet** — return it or discard the offending part — when it merely summarizes the domain, contains implementation task lists, invents human decisions, dumps unbounded questions, attempts to edit the map, or claims lifecycle ownership. Scouts do not own map mutation, ticket creation or resolution, scope rulings, final terminology, human-facing output, or lifecycle transitions.

## Central synthesis

The parent synthesizes all returned packets **before** asking the human anything or changing the map:

1. Normalize terminology across packets.
2. Separate evidence from inference.
3. Merge duplicate candidate decisions — two scouts naming the same decision in different words become one canonical candidate.
4. Combine related perspectives into layered questions (example in `references/mapping-interview.md`).
5. Preserve material contradictions — a genuine scout disagreement about scope or facts becomes one precise human question, not a silent pick.
6. Identify likely dependencies.
7. Identify candidate tickets.
8. Preserve unsharp regions as fog.
9. Identify scope disputes.
10. Rank the next human questions (Stage 7 of the interview).

Raw scout output is never copied into the map, never presented to the human, and never treated as authoritative. Scout findings *should* visibly shape the next question packet — synthesis that changes nothing was not synthesis.

## Scout failure

When a scout fails, times out, or lacks access: preserve the limitation explicitly; continue with the other packets where safe; never fabricate the missing findings; then decide whether the gap becomes **fog** (the question isn't sharp yet), a **research ticket** (a sharp fact-question for a later cycle), or a **blocking human question** (the human can supply what the scout couldn't reach).

## Research scouts during work cycles

A research ticket is resolved the same way at smaller scale: the parent claims the ticket, launches one bounded scout with the assignment contract, waits, integrates the packet, records the resolution, and closes — the scout never closes the ticket or writes the resolution itself. Scouts supporting an active decision ticket return their packets into that ticket's evidence; they resolve nothing.
