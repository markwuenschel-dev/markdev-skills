# ICA V2 Parallel Lane Protocol

This protocol turns the aggressive concurrency model into concrete subagent work packets. Lanes are derived from repository topology, not fixed personas.

## Lane assignment

Each lane receives a bounded assignment:

```yaml
architecture_lane_assignment:
  run_id: ""
  lane_id: "architecture:<surface>:<concern>"
  scope_id: ""
  executor_class: agent
  priority: 0
  depends_on: []
  surface:
    include: []
    exclude: []
  evidence_question: ""
  architecture_lenses: []
  source_authority: []
  required_completeness: targeted | representative | exhaustive
  negative_claims_expected: []
  cache_inputs: []
  stop_conditions: []
  forbidden:
    - repository mutation
    - candidate scoring
    - final recommendation
    - scope expansion
```

A lane may perform organic reads/searches inside its bounded surface. It must not wander into another lane's authority merely because it sees something interesting; return a `followup_probe` proposal instead.

## Lane return

```yaml
architecture_lane_return:
  run_id: ""
  lane_id: ""
  status: succeeded | partial | failed | cancelled
  evidence_fragment_ref: ""
  confirmed_claims: []
  inferred_claims: []
  unknowns: []
  contradictions: []
  negative_claim_receipts: []
  architecture_observations:
    - lens: ""
      observation: ""
      affected_surfaces: []
      possible_transformations: []
      confidence: ""
  followup_probes: []
  coverage_gaps: []
  cache_outputs: []
  timing_ms: 0
```

The parent validates/merges evidence and owns candidate identity, eligibility, critic decisions, scoring, routing, and final recommendation.

## Lane generation rules

Prefer independent units such as:

- subsystem × module-depth/locality;
- state owner × lifecycle/concurrency;
- persistence path × duplicate-authority search;
- public interface × test/proof surface;
- integration boundary × adapter/seam evidence;
- hotspot cluster × change-coupling evidence;
- ADR/domain constraint extraction;
- generated/runtime policy surface.

A broad repository can produce dozens of logical packets when the surfaces are truly independent. This is desirable when it keeps the pool saturated. Do not cap lane count merely because a traditional agent workflow uses a small named team.

## Alternative/critic lanes

Once a surface has sufficient evidence, the parent may spawn parallel transformation challengers:

```yaml
architecture_alternative_assignment:
  candidate_seed_id: ""
  evidence_refs: []
  role: generate_alternative | adversarial_critic | simpler_local_challenger | failure_migration_challenger
  constraint: "Return analysis only; do not score or choose the final recommendation."
```

Use these lanes for high-impact/ambiguous candidates. Two to four distinct challenge angles are often useful; use more only when they remain genuinely non-overlapping and the runtime has spare capacity after coverage-critical work.

## Fail-soft behavior

One failed read-only lane does not invalidate independent completed lanes. Preserve the failure as unknown/uninspected coverage and determine whether the candidate can still be supported. If the failed surface is required for an absence claim or high-confidence recommendation, the parent must block/downgrade rather than infer success.

## Refilling

After every lane completion:

1. merge the fragment;
2. update contradictions/coverage;
3. enqueue newly justified probes;
4. start eligible candidate synthesis/critic jobs;
5. cancel stale speculative work;
6. immediately refill every compatible free slot.

There are no artificial round barriers.
