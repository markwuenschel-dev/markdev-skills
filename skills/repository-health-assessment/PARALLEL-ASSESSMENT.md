# Parallel Assessment

The six health lanes are fixed measurement categories, not worker assignments. Build the complete surface inventory first, then derive non-overlapping read-only evidence lanes from the actual repository topology — or, when a caller one level up has already supplied a validated surface inventory (a `human-directed-swarm-planner` Repository Improvement Assessment run's wave-0 baseline is the standing case), adopt it verbatim and derive lanes from that instead of re-deriving one. A small repository may use three lanes (runtime/contracts, correctness/tests, build/ownership); a broad polyglot repository may use more than eight (entrypoints, domain modules, APIs, data, generated seams, security, numerical/GPU, tests, delivery, ownership). Grade calculation happens **once, in the parent, after the merge**.

## When to parallelize

Parallelize whenever the surface inventory exposes independent evidence surfaces. Choose packet count by topology, not by the six fixed grading lanes. On a broad repository, logical packets should normally outnumber active workers so the executor can refill idle slots as stragglers finish; on a compact repository, do not manufacture fake packets.

Construct the surface inventory itself with parallel deterministic enumeration where safe, then freeze the complete denominator **before final coverage adjudication and grading**. Subagents need that common denominator for composable coverage. An injected inventory satisfies this identically to a self-built one — but only for enumeration and weights. This parent still assigns its own `coverage` and `evidence_quality` per surface from what its own subagents actually inspect; it never adopts those two fields from whatever supplied the inventory.

## Work-conserving executor behavior

Before awaiting any evidence worker, submit every currently READY independent packet allowed by the shared concurrency profile. Treat completions like `as_completed`: after each result, merge its evidence, recompute dependencies, and immediately refill the free slot from the READY queue. Do not wait for an arbitrary launch batch to finish.

Use the `agent` class for read-only evidence workers and the smaller `command` class for tests/builds/static tools. Under RIA, flatten `health:*` packets into the root RIA pool whenever possible rather than creating a second full-size worker pool.

## Subagent contract

Each subagent gets one evidence lane and returns claims, evidence, observed surfaces, coverage observations, candidate findings, proposed maturity levels, and uncertainty — never a final lane score, grade, cap, confidence, or candidate rank.

**Dispatch to each:**

- the lane id and its dimension definitions from [HEALTH-GRADING.md](HEALTH-GRADING.md);
- the surface inventory, with the surfaces relevant to that lane marked — the parent's own, or the one it adopted from a supplying caller;
- the repository root, the assessed revision, and the excluded scope — again, the parent's own frame, or the one it adopted;
- the domain vocabulary from `CONTEXT.md`;
- the read-only constraint, restated in full — including that project commands run only in this run's isolated worktree, never in the repository and never from a subagent. "This run's" covers both a worktree this parent created and one a supplying caller already created at the same revision and handed down as recorded command results.

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


## Evidence Recon expedition contract

The health run is an Evidence Recon `expedition`: its evidence surface spans independent repository regions and source classes, but **this parent remains the only authority** for coverage reconciliation, lane maturity levels, caps, confidence, and candidate ranking.

Each evidence lane returns a bounded fragment containing its lane id, assigned surface, status, positive claim references, negative-claim references, contradiction references, sources, exclusions, and limitations. The parent may use `shared/evidence-recon/expedition-return.yaml` as the generic return shape, but it must retain RHA claim ids and lane names so `assets/evidence-recon-projection.js` can project the final health island without losing provenance.

A worker may report “not found in the assigned surface”; it may not upgrade that observation into evidence of repository-wide absence. Only the parent can mark `supports_absence: true`, and only after it has reconciled all relevant lanes and recorded the complete negative-claim receipt. A failed or blocked lane remains an explicit coverage limitation rather than a zero-scored finding.

The merged Evidence Recon packet is a sidecar. It does not replace the health inventory, health island, or parent-owned grading pass.

## Cross-lane findings

The most valuable findings are the ones no single lane could see: a schema owned in two places (contracts + architecture), a test suite that passes because it asserts the bug (verification + correctness), a build that reproduces only on one machine (build + operations). Reserve a merge pass specifically for these, and give them `lane_sources` with more than one entry. A finding with three lane sources is usually the report's most important candidate regardless of where its priority score lands.

## Termination

Stop when every lane has returned or failed. A lane that fails to return is **not** a lane scored 0 — mark its surfaces `uninspected`, let weighted coverage fall, and let the caps do their work. Substituting a fabricated low score for a missing assessment is the same error as fabricating an F for an ungradable repository, and it is harder to spot.
