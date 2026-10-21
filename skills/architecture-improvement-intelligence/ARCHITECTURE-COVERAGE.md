# Architecture Coverage Sweep

The sweep is mandatory for every substantive ICA run. It is distinct from evidence gathering: Evidence Recon asks what is supported; this sweep asks which structural decision/improvement dimensions deserve consideration.

For each lens record `considered`, `not-applicable` with reason, or one or more candidate/evidence references. Do not invent findings merely to populate the matrix.

## Lenses

1. **Authority / ownership** — Is each consequential state, lifecycle, policy, and artifact owned once? Are there parallel authorities or bypasses?
2. **Module depth / interface burden** — Does the interface hide substantial implementation complexity, or does understanding the module require knowing its internals?
3. **Locality / change propagation** — Does one conceptual change require bouncing across distant modules/files or coordinated edits that should be local?
4. **Dependency direction / cycles** — Are dependencies aligned with authority and stable abstractions? Do cycles or reverse dependencies leak decisions?
5. **Duplicate/parallel paths** — Are there alternate execution, persistence, validation, or orchestration paths that encode the same policy differently?
6. **State / lifecycle transitions** — Are transitions centralized enough to preserve invariants? Are completion/cancellation/retry semantics split across owners?
7. **Seams / adapters** — Is a seam real (multiple adapters/substitution pressure) or hypothetical? Is adapter logic located at the right authority edge?
8. **Shallow/pass-through modules** — Does a module mostly relay calls/arguments while adding little leverage? Apply the deletion test.
9. **Concentration / god-module risk** — Would proposed consolidation create an incoherent owner or excessive interface/state burden?
10. **Concurrency / transaction / failure ownership** — Who owns atomicity, ordering, idempotency, retries, ambiguous completion, rollback, and recovery?
11. **Tests / proof surface** — Can the desired behavior be verified through stable interfaces? Are tests coupled to internals because the architecture exposes the wrong surface?
12. **Generated / cross-language / runtime seams** — Are generated artifacts or language/runtime boundaries authoritative, duplicated, or bypassed?
13. **Migration / compatibility** — Would a structural change require dual paths, schema compatibility, rollout sequencing, data conversion, or deprecation ownership?
14. **Operations / recovery** — Are operator controls, observability, degradation, containment, and repair owned coherently?
15. **Change coupling / churn / hotspots** — Do frequently co-changing files reveal a missing owner or false seam? Is the hotspot architectural or merely active code?
16. **Locked constraints** — Do ADRs, domain language, public contracts, safety rules, or compatibility promises prohibit or reshape the candidate?

## Parallelization

Independent lenses/surfaces may be evaluated concurrently. Prefer topology-derived packets such as `subsystem-A × authority/locality`, `subsystem-B × depth/tests`, or `cross-cutting × persistence/concurrency` over fixed persona lanes.

The parent reconciles overlap and prevents the same structural issue from becoming several duplicate candidates.

## Closure

The sweep is complete when every materially relevant lens has a disposition and the parent has run a final adversarial sweep against the leading candidates. An empty candidate set is a legitimate outcome if the evidence supports it.
