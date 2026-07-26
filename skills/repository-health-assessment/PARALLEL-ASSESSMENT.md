# Parallel Assessment

The six health lanes are fixed measurement categories, not worker assignments. Build the complete surface inventory first, then derive non-overlapping read-only evidence lanes from the actual repository topology. A small repository may use three lanes (runtime/contracts, correctness/tests, build/ownership); a broad polyglot repository may use more than eight (entrypoints, domain modules, APIs, data, generated seams, security, numerical/GPU, tests, delivery, ownership). Grade calculation happens **once, in the parent, after the merge**.

## When to parallelize

Parallelize when the surface inventory shows independent evidence surfaces. Choose the number of evidence lanes by topology, not the number of fixed grading lanes; use one parent-only pass for a small repository when independent lanes would not add coverage.

Build the surface inventory **before** dispatching. Subagents need the same denominator, or their coverage states will not compose.

## Subagent contract

Each subagent gets one evidence lane and returns claims, evidence, observed surfaces, coverage observations, candidate findings, proposed maturity levels, and uncertainty — never a final lane score, grade, cap, confidence, or candidate rank.

**Dispatch to each:**

- the lane id and its dimension definitions from [HEALTH-GRADING.md](HEALTH-GRADING.md);
- the surface inventory, with the surfaces relevant to that lane marked;
- the repository root, the assessed revision, and the excluded scope;
- the domain vocabulary from `CONTEXT.md`;
- the read-only constraint, restated in full — including that project commands run only in the parent's isolated worktree, never in the repository and never from a subagent.

**Require back:**

- claims in the schema from [HEALTH-GRADING.md](HEALTH-GRADING.md) — `claim_id`, `lane`, `statement`, `result`, `evidence`, `observation` split into confirmed/inferred/unknown;
- proposed dimension levels 0–4, each with its **own** `claim_refs` and a written `rationale`. Every reference is `{claim_id, support}`, where `support` says what that claim evidences *for that dimension*. Reusing one claim across dimensions is fine; reusing it with the same support line is a rubber stamp and the verifier rejects it;
- coverage observations: which surfaces the lane actually reached, and at what state and evidence quality;
- candidate findings in the shared spine schema, tagged with this lane in `lane_sources` and the claims they rest on in `claim_refs`.

**Forbid:** any lane score, any grade, any cap judgment, any file modification, any command that mutates the repository. A subagent that returns a lane score has exceeded its contract; recompute from its dimension levels and discard the number.

## Read-only, repeated per subagent

The hard stop does not propagate by inheritance — restate it in every dispatch. A subagent that reads "assess the verification lane" and finds a broken test will fix it unless told not to, and a health assessment that modifies the repository has destroyed the thing it was measuring. The assessed revision must be identical at merge time to what it was at dispatch.

## Merge

1. **Claim ids must be globally unique.** Namespace them by lane prefix at dispatch (`CONTRACT-01`, `ARCH-01`) so the merge cannot silently drop a collision. A dimension may only cite claims from its own lane, so the prefix also makes foreign references obvious on sight.
2. **Reconcile coverage states by taking the strongest observation.** If the architecture lane inspected `contracts-and-wiring` and the contracts lane only sampled it, the surface is `inspected`. Coverage is a property of the assessment, not of any one lane.
3. **Deduplicate candidates per the shared spine's dedup rules**, which are defined in `REPORT-SCORING.md` and not restated here. When two lanes surface the same finding, merge into one candidate and **union the `lane_sources`** — that array is exactly what multi-lane provenance is for. Never emit the same finding twice under two ids; that is how one problem becomes three in the downstream ledger.
4. **Set dimension levels in the parent** from the merged claims, re-checking coherence: a level ≥ 3 needs a supporting claim resulting `pass` or `partial`, and a level ≤ 1 must not rest solely on passing claims. A subagent proposes; the parent decides, because only the parent can see that the contracts lane and the architecture lane are describing one boundary problem from two sides.
5. **Compute the grade once** — lane scores, weighted coverage, overall raw, caps, confidence — through `assets/health-verify.js`, from the merged island.

## Cross-lane findings

The most valuable findings are the ones no single lane could see: a schema owned in two places (contracts + architecture), a test suite that passes because it asserts the bug (verification + correctness), a build that reproduces only on one machine (build + operations). Reserve a merge pass specifically for these, and give them `lane_sources` with more than one entry. A finding with three lane sources is usually the report's most important candidate regardless of where its priority score lands.

## Termination

Stop when every lane has returned or failed. A lane that fails to return is **not** a lane scored 0 — mark its surfaces `uninspected`, let weighted coverage fall, and let the caps do their work. Substituting a fabricated low score for a missing assessment is the same error as fabricating an F for an ungradable repository, and it is harder to spot.
