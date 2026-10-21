# Exhaustive Sweep-Driven Adaptive Grilling

Use this procedure to turn evidence, coverage findings, candidate decisions, and specialist-lane packets into high-bandwidth recommendation-led interview packets.

The governing objective is **maximum consequential decision coverage per user turn**, not minimum question count. Answer burden changes presentation, grouping, and response ergonomics; it does not justify suppressing an independent consequential decision.

## 0. Establish the evidence contract without over-dispatching

Every substantive grill starts with a validated `shared/evidence-recon` v1 packet. Use inline mode for bounded direct inspection; use expedition mode only when the evidence problem itself spans independent surfaces/source classes, demands broad completeness, carries high false-negative cost, or benefits from parallel reconciliation.

The packet separates coverage, evidence quality, and epistemic status. A failed search is not evidence of absence. Negative claims require explicit scope, methods, completeness, exclusions, sources, and sufficient coverage before `supports_absence` can be true.

Evidence Recon removes discoverable factual questions from the human interview. It does **not** replace Step 1's mandatory decision-coverage sweep, decide owner intent, or determine whether flat or graph topology exists.

## 1. Run the sweep before choosing the representation

The coverage sweep is mandatory on every substantive grill. It is the mechanism that asks: **what consequential decision is missing?**

Inspect the selected direction through the relevant lenses in `references/coverage-lenses.md` before deciding whether a graph is useful. Do not infer sweep depth from expected diff size, line count, ticket label, or apparent implementation simplicity.

Create candidate decision records only when different answers could materially change behavior, architecture, public contracts, failure handling, proof burden, migration, rollout, ownership, or accepted risk. Do not manufacture questions merely to fill a category.

Give each candidate a stable ID before question formulation.

## 2. Keep decision discovery separate from topology

A decision set and a dependency graph are not the same thing.

Use a **flat decision set** when the surviving consequential decisions are independently answerable and no relationship changes eligibility, interpretation, or branch validity.

Use a **decision dependency graph** only when meaningful topology exists, such as:

- prerequisite ordering;
- conditional branches;
- discoverable fact dependencies that gate human decisions;
- mutually exclusive paths;
- invalidation relationships;
- answers that unlock descendants;
- multi-round evolution where prior answers change what is eligible next.

A graph with no meaningful edges is a list wearing graph ceremony. Prefer flat mode instead.

Topology is discovered after evidence gathering, coverage discovery, and candidate consolidation; it is not dictated by whether the task is called architecture, migration, design, or “small.”

## 3. Promote flat state when topology appears

Flat mode is not a permanent classification.

If later evidence or an answer creates a meaningful dependency, promote the canonical state to graph mode. Preserve stable IDs, evidence, recommendations, quality receipts, answers, resolutions, and documents. Add only the relationships required to model the new topology.

Never restart the interview or re-ask settled decisions merely because the representation changed.

## 4. Research facts rather than interviewing for them

Never ask the user for a discoverable fact.

In graph mode:
- **Research frontier:** unresolved fact nodes whose prerequisites are settled and whose evidence can be gathered now.
- **Decision frontier:** unresolved human-decision nodes whose prerequisites are settled and whose required facts are available.

A running research task blocks only descendants.

In flat mode, complete discoverable research before presenting a decision if that fact materially gates the answer. If the gating relationship must remain open across rounds, that is meaningful topology and should trigger graph mode.

## 5. Overgenerate candidate questions

Do not immediately expose the first wording produced for a decision. Build a candidate pool first.

For each high-consequence decision, generate multiple formulations when useful, usually from different interrogation angles such as:

- boundary or invariant;
- failure or recovery;
- competing mechanism;
- authority or ownership;
- state-transition or completion semantics;
- migration or compatibility;
- concurrency, ordering, duplication, or ambiguous completion;
- observability or proof;
- irreversible consequence.

Parallel lanes may produce a substantially larger candidate pool than the final packet. Redundancy at this stage is acceptable. Redundancy in the user-facing packet is not.

## 6. Sharpen and quality-gate every candidate

Use `references/question-craft.md` and `assets/question-quality.yaml`.

A consequential user-facing question must:

1. represent a real human decision rather than a discoverable fact;
2. have materially different plausible answers;
3. be specific enough that the decision boundary is clear;
4. be grounded in available evidence and named assumptions;
5. expose a downstream consequence or unlock;
6. include a concrete recommendation;
7. justify that recommendation with design-specific reasoning;
8. be easy to answer without reconstructing hidden context.

Rewrite weak candidates before ranking them. Reject a candidate entirely when no plausible answer would change the design.

Hard failures include generic questions, generic recommendation slogans, asking the user for discoverable facts, cosmetically different options, unrelated compound questions, premature implementation detail, and recommendations that merely restate an option.

## 7. Rank decision value without suppressing breadth

Rank approximately by:

`decision impact × uncertainty × cost of being wrong × downstream choices affected`

Use answer burden only as a **packet-design factor**, not as a divisor that removes important questions.

Prefer questions that distinguish mechanisms, expose assumptions, define valid and invalid states, clarify authority, prevent expensive rework, or establish proof, failure, halt, recovery, rollback, concurrency, and completion semantics.

## 8. Pack the maximum coherent batch

The default grilling intensity is **exhaustive**.

In flat mode, ask every independent consequential open decision that passes the quality gate unless it is already evidenced, a semantic duplicate, harmlessly and explicitly deferred, or otherwise invalid.

In graph mode, ask every independent consequential **eligible frontier** decision that passes the quality gate, subject to the same exclusions.

There is no fixed maximum question count.

Typical packet sizes are descriptive, not caps:

- ordinary selected direction: about 8–15 questions;
- deep architecture or product contract: about 15–25 questions;
- broad or highly consequential design: 25+ questions is acceptable when the questions remain independent, sharp, and well organized.

Never pad a packet to hit a number. Never remove a consequential independent question merely because the packet is already large.

Group large packets under useful headings such as Product/Domain, Architecture/Data, Runtime/Concurrency, Failure/Recovery, Migration/Compatibility, Operations/Observability, and Verification/Rollout. Preserve globally stable question IDs.

## 9. Use shallow conditional subquestions to reduce conversational latency

A dependent decision normally waits until its prerequisite is settled. V3 permits **one level of explicit conditional branching** when:

- the parent question is in the current packet;
- the child is immediately understandable under a named parent answer;
- exposing the child cannot mislead the user about which branch is active;
- the branch does not recursively fan out into another tree.

Example:

```text
Q7 — Preserve legacy clients?
Recommended: No.

If YES → Q7a: What minimum dual-support window is required?
If NO  → Q7b: Is an atomic cutover acceptable, or is a read-only transition still required?
```

Do not use conditionals to bypass genuinely deep dependencies. Maximum conditional depth is one.

## 10. Make large packets easy to answer

Every packet should tell the user that concise responses are valid. Support:

- `accept all recommendations`;
- `accept all except Q4, Q9, Q13`;
- `Q1 A, Q2 accept, Q3 C, Q4 modify: ...`;
- direct prose answers keyed by question number;
- partial answers, leaving unanswered questions open.

Explicit bulk acceptance is a valid human decision bundle. Silence, omission, or failure to mention a question is never acceptance.

## 11. Adapt after each answer bundle

After each answer bundle:

1. classify every explicit response as evidence, decision, requirement, assumption, accepted risk, rejection, or deferral;
2. settle only questions actually answered or explicitly bulk-accepted;
3. update the canonical decision state and documents;
4. derive entailed requirements without asking redundant questions;
5. reconcile contradictions with evidence and prior decisions;
6. in graph mode, invalidate impossible branches and activate newly relevant branches;
7. ingest completed research without blocking unrelated decisions;
8. run a quick coverage-gap scan for consequences created by the new answers;
9. re-evaluate topology and promote flat mode if meaningful relationships appeared;
10. regenerate and sharpen candidates; recompute graph frontiers when in graph mode; pack the next maximum coherent batch.

Ask a follow-up only when ambiguity is consequential. Never silently convert a recommendation, vague preference, or omission into a requirement.

## 12. Close only after an adversarial final sweep

A flat one-round grill and an exhausted graph can both still be incomplete.

Before closure:

1. rerun the relevant coverage lenses;
2. ask an adversarial lane to search for silent assumptions, especially failure/recovery, concurrency/ordering, migration, operator control, and proof gaps when relevant;
3. convert genuine gaps into canonical decision records;
4. promote to graph mode if the new gap has meaningful topology;
5. verify every consequential record is settled, invalidated, accepted, or explicitly deferred with owner and revisit trigger;
6. present shared understanding and require explicit human confirmation.

Stop only when new candidate generation yields no consequential decision that survives the quality gate.
