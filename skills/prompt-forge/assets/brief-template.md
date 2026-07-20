# Pseudo-Formal Brief Template

Copy, delete blocks that do not apply, fill the rest. Blocks marked (parallel) are needed only when an orchestrator manages concurrent workers. Guidance for filling each block: `references/agent-briefs.md`.

```text
DEFINITIONS

<Every load-bearing term an adversarial reader could interpret two
ways, degenerate and boundary cases included: the empty input, the
trivial solution, the duplicate, the disconnected case, the
zero-measurement. Empirical domains: units, populations, inclusion
criteria, measurement procedure.>

TASK

<One statement of the success predicate: what must be true of the
returned artifact, quantifiers and scope spelled out. Enumerate the
narrowing assumptions the solution is NOT allowed to make.>

<If a solution plausibly exists:> Assume for purposes of this task
that a complete solution exists.
<If existence is genuinely uncertain:> Either a complete solution or
a complete demonstration of impossibility counts; nothing in between
does.

DOES NOT COUNT

Partial progress does not count unless it implies exactly the
resolution above. In particular, the following are insufficient:
- results holding only for a narrowed scope or special case
- reductions to another unvalidated assumption, unproved statement,
  or unavailable dataset
- verification over any bounded subset of cases
- artifacts satisfying a requirement approximately where exact
  satisfaction is specified
- candidate counterexamples or refutations without a complete
  certificate
- plans, surveys, status summaries, or explanations of difficulty
<Add the near misses specific to this problem: predict what a capable
agent under pressure would return instead of a solution, and exclude
each by name.>

ORCHESTRATION (parallel)

Use concurrent agents aggressively and dynamically. No fixed
assignments such as "N agents for strategy X". Manage the search with
these heuristics:
- Open with a genuinely diverse portfolio of substantially different
  approaches: <the known families for this domain>.
- Keep most early-round agents blind to the currently favored
  approach; preserve independence.
- Maintain a registry of approach families grouped by underlying
  idea, not surface wording; redirect agents from crowded families
  toward underexplored ones.
- A route ending at a subproblem as hard as the original goal is not
  progress unless that subproblem is genuinely resolved.
- When a route stalls at a goal-strength gap, mark it blocked and
  record why; reassign to it only for a materially new mechanism.
- Keep several incompatible routes alive across rounds;
  cross-pollinate only after independent development has exposed
  each route's real strengths and gaps.
- The root agent repeatedly synthesizes, challenges, redirects, and
  launches new rounds. Do not stop after the first wave fails.

Every spawned worker task states: objective, output format, tool
guidance, and task boundaries.

VERIFICATION

Adversarial reviewer agents with fresh context throughout. Every
candidate is checked against:
<The domain-specific ways a candidate can look right and be wrong:
known confounders, degenerate cases, leakage paths,
too-good-to-be-true signatures — and always the domain's version of
circularity: satisfying the goal by assuming its equivalent.>

Workers return concrete artifacts: <lemmas, constructions, scripts,
datasets, measurements, counterexamples appropriate to the domain>.
Status reports, vague optimism, and "this step is routine" claims
are rejected. Every progress claim traces to a tool result or
artifact from the current session.

Structure the final artifact modularly so each part can be verified
in isolation, premises and conclusion stated locally.

RETURN CONDITION

Return only when a candidate has survived the adversarial audit
against the checklist above. Do not return a reduction, a partial
result, a plan, or an explanation of difficulty.

EFFORT

Spend at least <floor> before considering returning.

CONTAMINATION

External search may be used only for <background material>; never to
retrieve <the answer this result must be independent of>.
```
