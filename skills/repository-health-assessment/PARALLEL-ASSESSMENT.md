# Parallel Assessment

The six health lanes are fixed measurement categories, not worker assignments. Build the complete surface inventory first, then derive non-overlapping read-only evidence lanes from the actual repository topology, and dispatch the lane-mapped `review-*` workers from [REVIEW-LANES.md](REVIEW-LANES.md) in the same wave. A small repository may use three lanes (runtime/contracts, correctness/tests, build/ownership); a broad polyglot repository may use more than eight (entrypoints, domain modules, APIs, data, generated seams, security, numerical/GPU, tests, delivery, ownership). Grade calculation happens **once, in the parent, after the merge**.

## When to parallelize

Parallelize whenever the surface inventory exposes independent evidence surfaces. Choose packet count by topology, not by the six fixed grading lanes. On a broad repository, logical packets should normally outnumber active workers so the executor can refill idle slots as stragglers finish; on a compact repository, do not manufacture fake packets.

Construct the surface inventory itself with parallel deterministic enumeration where safe, then freeze the complete denominator **before final coverage adjudication and grading**. Subagents need that common denominator for composable coverage. This parent assigns `coverage` and `evidence_quality` per surface from what its own subagents actually inspect.

## Work-conserving executor behavior

Before awaiting any evidence worker, submit every currently READY independent packet allowed by the shared concurrency profile. Treat completions like `as_completed`: after each result, merge its evidence, recompute dependencies, and immediately refill the free slot from the READY queue. Do not wait for an arbitrary launch batch to finish.

Use the `agent` class for read-only evidence workers and the smaller `command` class for tests/builds/static tools. Under RIA, flatten `health:*` packets into the root RIA pool whenever possible rather than creating a second full-size worker pool.

## Subagent contract

Each subagent gets one evidence lane and returns claims, evidence, observed surfaces, coverage observations, candidate findings, proposed maturity levels, and uncertainty — never a final lane score, grade, cap, confidence, or candidate rank.

**Dispatch to each:**

- the lane id and its dimension definitions from [HEALTH-GRADING.md](HEALTH-GRADING.md);
- the surface inventory, with the surfaces relevant to that lane marked;
- the repository root, the assessed revision, and the excluded scope;
- the claim-id prefix for its lane ([table below](#claim-id-prefixes));
- the domain vocabulary from `CONTEXT.md`;
- the read-only constraint, restated in full — including that project commands run only in this run's isolated worktree, never in the repository and never from a subagent. In RIA mode the commands were already run by RIA and arrive as recorded results ([RIA-MODE.md](RIA-MODE.md#verification)).

**Require back:**

- claims in the schema from [HEALTH-GRADING.md](HEALTH-GRADING.md) — `claim_id`, `lane`, `statement`, `result`, `evidence`, `observation` split into confirmed/inferred/unknown;
- proposed dimension levels 0–4, each with its **own** `claim_refs` and a written `rationale`. Every reference is `{claim_id, support}`, where `support` says what that claim evidences *for that dimension*. Reusing one claim across dimensions is fine; reusing it with the same support line is a rubber stamp and the verifier rejects it;
- coverage observations: which surfaces the lane actually reached, and at what state and evidence quality;
- candidate findings in the shared spine schema, tagged with this lane in `lane_sources` and the claims they rest on in `claim_refs`.

**Forbid:** any lane score, any grade, any cap judgment, any file modification, any command that mutates the repository. A subagent that returns a lane score has exceeded its contract; recompute from its dimension levels and discard the number.

## Read-only, repeated per subagent

The hard stop does not propagate by inheritance — restate it in every dispatch. A subagent that reads "assess the verification lane" and finds a broken test will fix it unless told not to, and a health assessment that modifies the repository has destroyed the thing it was measuring. The assessed revision must be identical at merge time to what it was at dispatch.

## Merge

1. **Claim ids must be globally unique.** Namespace them by lane prefix at dispatch ([Claim-id prefixes](#claim-id-prefixes)) so the merge cannot silently drop a collision. A dimension may only cite claims from its own lane, so the prefix also makes foreign references obvious on sight.
2. **Reconcile coverage states by taking the strongest observation.** If the architecture lane inspected `contracts-and-wiring` and the contracts lane only sampled it, the surface is `inspected`. Coverage is a property of the assessment, not of any one lane.

   **Evidence quality follows the observation that set the coverage state**, not the strongest quality seen anywhere: take the quality reported by the worker whose observation won. When two workers report the same coverage state with different qualities, take the **weaker** quality unless the stronger one cites a `claim`, `command`, `path`, or `inventory` ref the weaker one lacks. A conflict between two workers' claims about the same fact stays a recorded contradiction in the sidecar; it is never resolved by picking the more confident worker.
3. **Deduplicate candidates per the shared spine's dedup rules**, which are defined in `REPORT-SCORING.md` and not restated here. When two lanes surface the same finding, merge into one candidate and **union the `lane_sources`** — that array is exactly what multi-lane provenance is for. Never emit the same finding twice under two ids; that is how one problem becomes three in the downstream ledger.
4. **Set dimension levels in the parent** from the merged claims, re-checking coherence: a level ≥ 2 needs a supporting claim resulting `pass` or `partial`; level 4 needs a `pass`; a dimension supported only by `unknown` claims cannot exceed level 1; and a level ≤ 1 must not rest solely on passing claims. A subagent proposes; the parent decides, because only the parent can see that the contracts lane and the architecture lane are describing one boundary problem from two sides.
5. **Compute the grade once** — lane scores, weighted coverage, overall raw, caps, confidence — through `assets/health-verify.js`, from the merged island.


## Evidence Recon expedition contract

The health run is an Evidence Recon `expedition`: its evidence surface spans independent repository regions and source classes, but **this parent remains the only authority** for coverage reconciliation, lane maturity levels, caps, confidence, and candidate ranking.

Each evidence lane returns a bounded fragment containing its lane id, assigned surface, status, positive claim references, negative-claim references, contradiction references, sources, exclusions, and limitations. The parent may use `shared/evidence-recon/expedition-return.yaml` as the generic return shape, but it must retain RHA claim ids and lane names so `assets/evidence-recon-projection.js` can project the final health island without losing provenance.

A worker may report “not found in the assigned surface”; it may not upgrade that observation into evidence of repository-wide absence. Only the parent can mark `supports_absence: true`, and only after it has reconciled all relevant lanes and recorded the complete negative-claim receipt. A failed or blocked lane remains an explicit coverage limitation rather than a zero-scored finding.

The merged Evidence Recon packet is a sidecar. It does not replace the health inventory, health island, or parent-owned grading pass.

## Cross-lane findings

The most valuable findings are the ones no single lane could see: a schema owned in two places (contracts + architecture), a test suite that passes because it asserts the bug (verification + correctness), a build that reproduces only on one machine (build + operations). Reserve a merge pass specifically for these, and give them `lane_sources` with more than one entry. A finding with three lane sources is usually the report's most important candidate regardless of where its priority score lands.

## Termination

Stop when every lane has returned or failed. A lane that fails to return is **not** a lane scored 0 — mark its surfaces `uninspected` (or `unavailable` when the cause was access, toolchain, or hardware), let weighted coverage fall, and let the caps do their work. If one of those surfaces is core, the repository is Not gradable either way: both `uninspected` and `unavailable` core surfaces trigger it. Substituting a fabricated low score for a missing assessment is the same error as fabricating an F for an ungradable repository, and it is harder to spot.

## Claim-id prefixes

Assign at dispatch. Review-derived claims add `-RV-<DOMAIN>` ([REVIEW-LANES.md](REVIEW-LANES.md#procedure)).

| Lane | Prefix | Lane | Prefix |
| --- | --- | --- | --- |
| `correctness-and-integrity` | `CORE-` | `data-and-migrations` | `DATA-` |
| `architecture-fitness` | `ARCH-` | `security-and-production-safety` | `SEC-` |
| `contracts-and-integration` | `CONTRACT-` | `numerical-correctness` | `NUM-` |
| `verification-readiness` | `VERIF-` | `gpu-equivalence` | `GPU-` |
| `build-and-delivery` | `BUILD-` | `performance-and-resources` | `PERF-` |
| `maintainability-and-ownership` | `MAINT-` | `platform-compatibility` | `PLAT-` |

A topology worker whose packet feeds several lanes uses each claim's own lane prefix, never one packet-wide prefix.

## Lane-return schema

Each evidence worker returns one fragment that validates against `shared/evidence-recon/expedition-lane.schema.json` (generic shape: `shared/evidence-recon/expedition-return.yaml`). Its health claims must also validate against the `claims` items of `assets/health.schema.json`, keeping RHA claim ids and lane names so `assets/evidence-recon-projection.js` preserves provenance. Review workers return a `review-fitness-report/v1` path instead ([REVIEW-LANES.md](REVIEW-LANES.md)).

## Worker failures

Every dispatched worker ends with exactly one `evidence_workers[]` entry, `{worker_id, lane, status, limitations[]}`. Schema-validate each return before merging anything from it.

| Situation | Action | `status` |
| --- | --- | --- |
| Return validates, revision matches | Merge | `complete` |
| Worker exceeds its timeout budget, nothing usable returned | Retry once; on second timeout, record | `timeout` |
| Worker exceeds its budget but returned a valid partial fragment | Merge what validates; limitation names the unreached surfaces | `partial` |
| Return fails schema validation | Retry once with the validation errors; on second failure, discard | `failed` |
| Return's assessed revision differs from the dispatch revision | Discard entirely, no retry (the tree moved or the worker read the wrong tree) | `failed` |
| Worker crashed or returned nothing | Retry once; on second failure, record | `failed` |
| Worker could not start (permission, missing toolchain, unavailable skill) | Record the blocker; no retry | `blocked` |

At most **one retry** per worker. Surfaces a non-`complete` worker was assigned and nobody else reached become `uninspected` (or `unavailable` for a `blocked` access/toolchain cause). A core surface in either state makes the repository Not gradable — the same verdict, whichever state applies.
