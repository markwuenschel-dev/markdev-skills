# Conversation Benchmarks

Four multi-message behavioral benchmarks with the actual questions and answers — not expected-behavior descriptions. Run each in a fresh thread with the stated setup; judge behavior against the pass criteria, not phrase matching. All four walk one effort so state chains realistically:

> **Destination:** Produce a resolved migration direction and decision path for replacing per-service customer identity records with one canonical profile.

Fixtures use the fallback tracker; native trackers substitute their own operations. `[Wayfinder]` turns are the parent; scout packets shown are *inputs to synthesis*, never text shown to the human.

---

## B1 — Scout findings alter the first question packet

*Benchmark id `b1`, version 2.1.2.*

**Setup.** Fresh charting. Evidence on disk: `ADR-014` ("PostgreSQL is the sole canonical store — settled"), service docs claiming the billing identity table is read-only. Two scouts launched: *repository and current system*, *data and migration*.

**Scout packets (condensed, real content):**

```yaml
mapping_scout:                      # repository scout
  surface: repository-and-current-system
  evidence:
    - observation: "auth, billing, and support each write identity fields; no shared contract"
      source: "services/*/identity/*.kt"
      confidence: high
    - observation: "billing dual-writes legacy_identity despite docs calling it read-only"
      source: "billing/writers/LegacyIdentityWriter.kt"
      confidence: high
  contradictions:
    - statement_a: "docs: legacy_identity is read-only"
      statement_b: "code: billing writes it on every update"
      consequence: "migration sequencing cannot be decided until its status is ruled"
```

```yaml
mapping_scout:                      # data-and-migration scout
  surface: data-and-migration
  candidate_decisions:
    - question: "Which identity key is canonical: auth UUID or billing email?"
      why_it_matters: "gates matching, dedup, and every merge rule"
      sharp_enough_for_ticket: true
  fog_candidates:
    - area: "retention and deletion semantics for merged profiles"
      why_not_yet_sharp: "depends on which key is canonical and who may write"
```

**Transcript.**

> **[Wayfinder]** Relevant evidence or conflict: ADR-014 already fixes PostgreSQL as the sole canonical store, so storage isn't in question. The code contradicts the docs on one point: billing still writes `legacy_identity` although it's documented read-only.
>
> 1. Which identity key is canonical for the unified profile — the auth-service UUID or the billing email?
>    Why it matters: it gates matching, dedup, and every merge rule downstream.
> 2. Is billing's write path to `legacy_identity` load-bearing, or stale code the docs outran?
>    Why it matters: migration sequencing can't be decided while its status is contested.
> 3. When two services disagree about a profile field, whose semantics win?
>    Why it matters: it reveals where write authority will have to live.
>
> *(stops and waits)*

**Pass criteria.**
- No storage question is asked — ADR-014 answered it (evidence-before-questions).
- The dual-write contradiction, found only by the scout, appears as its own question — proof scout findings shaped the packet.
- Packet is 2–4 independently answerable questions with why-it-matters lines; raw packets are never shown; Wayfinder stops after asking.
- Retention stays fog (unsharp), not a manufactured ticket.

**Fail examples.** Asking "should we use Postgres?"; a nine-question dump; pasting scout YAML at the human; proceeding without answers.

---

## B2 — A human answer eliminates a branch

*Benchmark id `b2`, version 2.1.2.*

**Setup.** Continues B1; the packet above is outstanding.

**Transcript.**

> **[Human]** UUID from auth is canonical — email is just a mutable attribute. The legacy table is stale; nothing reads it, kill it whenever. On conflicts: auth wins for identity fields, the owning service wins for its own domain fields.
>
> **[Wayfinder]** Recorded three decisions: *[Canonical identity key](…)* — auth UUID, email demoted to attribute; *[Legacy identity table status](…)* — stale, not load-bearing; *[Field conflict authority](…)* — auth wins identity, owning service wins domain fields. That closes every email-as-key branch — the email-collision and email-change-propagation candidates are gone, not deferred. It also sharpens new terrain: with auth authoritative for identity, transitional write authority is now a sharp, ticket-sized decision — created *[Write authority during transition](…)* on the frontier rather than asking it here; it gets its round inside its own ticket.
>
> Relevant evidence or conflict: none new — this follows directly from your rulings. One mapping question remains, and it gates how the frontier is scoped:
>
> 1. Does decommission *sequencing* for the legacy table need a decision on this map, or is it delivery's problem once cutover lands?
>    Why it matters: it's a scope ruling — ticket here, or out of scope.
>
> *(stops and waits)*

**Map delta.** Decisions so far +3 indexed lines (each linking its closed ticket); email-branch candidates deleted; +1 ticket *[Write authority during transition](…)* on the frontier; fog updated: "retention/deletion semantics — now waits only on write authority."

**Pass criteria.**
- Every email-as-key branch disappears from candidates, tickets, and all later rounds — pruned, not re-asked.
- Three decisions are recorded once each, comment → close → index, gists on the map, detail in tickets.
- The next round builds on the answers — the ticket-sized write-authority decision is *ticketed*, not asked inline, so it is asked exactly once in the whole effort (inside its ticket, B3); the remaining packet is the scope ruling. Resumed from map state, no recharting.
- Decommission is framed as a scope question, not silently ticketed as delivery work.

**Fail examples.** A later round asking about email collisions; asking the write-authority question in a charting packet and again inside its ticket (duplicate); restating full decisions on the map; restarting the interview; turning "kill it whenever" into an implementation task.

---

## B3 — Fog becomes a sharp ticket

*Benchmark id `b3`, version 2.1.2.*

**Setup.** A later work cycle. *[Write authority during transition](…)* (grilling, `claimed_by: mark-cc-0722a`, `decision_owner: mark`) carries progress comments including one received decision-owner answer. Fog: "retention/deletion semantics — waits on write authority."

**Transcript.**

> **[Wayfinder]** Resuming *[Write authority during transition](…)* from the recorded `mark-cc-0722a` work claim. Your prior decision-owner answer is on file. Two related questions to close it:
>
> 1. Single write path on day one, or dual-write with reconciliation for a bounded window?
>    Why it matters: it's the decision this ticket exists to make.
> 2. If dual-write: who owns reconciliation conflicts — auth automatically, or human review above a threshold?
>    Why it matters: shows the cost of the second option before you pick it.
>
> **[Human]** Dual-write, 30-day window. Auth auto-resolves; weekly report, no human gate.
>
> **[Wayfinder]** Resolved and closed *[Write authority during transition](…)*: dual-write for a 30-day window, auth auto-resolves conflicts, weekly visibility report, no human gate — rationale and constraints in the resolution. That answer makes the retention fog sharp. Graduated it to a new ticket: *[Deletion scope for canonical profiles](…)* — "When a deletion request arrives during or after the window, does it mean per-service tombstones or global erasure with service acknowledgment?" — unblocked, on the frontier. The fog entry is cleared; it lives only as the ticket now. One primary ticket resolved this cycle — stopping. Takeable next: *[Deletion scope…](…)*, *[Migration and cutover shape](…)*.

**Pass criteria.**
- The grilling round is 1–3 related questions inside the ticket; the second reveals the first's consequences.
- Resolution recorded in order; the map gains exactly one gist line.
- The fog entry is removed and exactly one sharp ticket carries it (create-then-wire); no duplicate residence.
- The cycle stops after one primary decision ticket; next takeable tickets are named by name.

**Fail examples.** Resolving the freshly graduated ticket in the same cycle; leaving the fog entry alongside the new ticket; a five-question round; deciding for the human.

---

## B4 — A design ticket returns from `/expanded-grill-with-docs` and changes the map

*Benchmark id `b4`, version 2.1.2.*

**Setup.** Frontier ticket *[Migration and cutover shape](…)* (design, decision_owner `mark`). `/expanded-grill-with-docs` installed.

**Transcript.**

> **[Wayfinder]** *[Migration and cutover shape](…)* needs a bounded design interview, not one direct decision — invoking `/expanded-grill-with-docs` with the handoff contract:
>
> ```yaml
> expanded_grill_input:
>   parent_loop: wayfinder
>   map_id: canonical-profile-migration
>   ticket_id: 6
>   destination: "Produce a resolved migration direction and decision path for replacing per-service customer identity records with one canonical profile."
>   ticket_question: "What migration and cutover shape moves services onto the canonical profile?"
>   known_decisions: ["auth UUID canonical", "legacy identity table stale", "auth wins identity fields", "dual-write 30-day window, auth auto-resolves"]
>   decision_owner: "mark"
>   prototypes_allowed: false
>   implementation_authorized: false
> ```
>
> **[/expanded-grill-with-docs returns]**
>
> ```yaml
> return_to_wayfinder:
>   parent_map_id: canonical-profile-migration
>   parent_ticket_id: 6
>   resolution_candidate: "Expand-migrate-contract: dual-read behind a flag, per-service cutover, contract legacy reads last"
>   confirmed_decisions: ["cutover is per-service, not big-bang", "reads flip before writes per service"]
>   artifact_links: ["docs/design/canonical-profile-migration/design.md", "docs/design/canonical-profile-migration/decisions.md"]
>   new_sharp_questions:
>     - question: "Which service cuts over first, and what disqualifies a service from early cutover?"
>       why_it_matters: "ordering risk concentrates in the first mover"
>     - question: "Who owns backfill ordering when historical records conflict?"
>       why_it_matters: "backfill can silently overwrite reconciled fields"
>   remaining_fog:
>     - area: "support-service custom identity cache"
>       why_not_yet_sharp: "cache semantics undocumented; needs evidence"
>   blocking_human_decisions: []
> ```
>
> **[Wayfinder]** Integrating before anything closes: created *[First-mover cutover selection](…)* and *[Backfill ordering authority](…)* — both unblocked, side by side on the frontier: who owns backfill ordering can be decided before knowing which service goes first, so the dependency test fails and no edge is wired. Added fog "support-service identity cache — semantics undocumented"; linked both design documents from the ticket. Mark confirmed the decisions during the child interview, and that confirmation is recorded in the linked decisions document; no blocking human decisions remain — so now recording the resolution from the candidate, closing *[Migration and cutover shape](…)*, and indexing it. The map gained two tickets, one fog patch, and one decision. Not initiating any delivery — when the map completes, the recommendation goes back to the Loop Router.

**Pass criteria.**
- The input contract is populated from the map (destination, decisions, decision_owner; `implementation_authorized: false`).
- The child's return changes the map: two new tickets — create-then-wire correctly yields **no** blocking edge here, because backfill-ordering ownership is decidable before first-mover selection (preference or likely order is never a dependency) — one fog patch, linked artifacts.
- The parent interprets `resolution_candidate` and closes **last**, after integration; the child closed nothing, edited no map, invoked no router.
- Confirmation language, not approval-bundle language: the human confirmed during the interview and the linked document records it; the child is never represented as an approval or governance system.
- Had `blocking_human_decisions` been non-empty, the ticket stays open — verify by variant if desired.
- No implementation, planning, or delivery is initiated from the approved design.

**Fail examples.** Closing the parent before creating the tickets; wiring backfill behind first-mover (sequence preference, not a logical prerequisite); stale approval-bundle phrasing instead of confirmation language; treating the candidate as auto-recorded; the child writing map files; spawning a nested map for the support-cache area instead of fog.
