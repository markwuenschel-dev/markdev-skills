# Specialist and Question-Discovery Lanes

Use lanes when independent perspectives can resolve consequential decisions, expose missing categories, generate stronger interrogation angles, or reveal meaningful decision topology more efficiently or adversarially than one parent pass.

Select only relevant lanes. Common lenses include:

1. Product intent, user outcome, and non-goals
2. Domain semantics, invariants, and terminology
3. Repository and current-system evidence
4. Architecture, boundaries, and data contracts
5. Runtime behavior, parallelism, concurrency, ordering, and failure semantics
6. Migration, compatibility, lifecycle, and irreversibility
7. Operations, observability, security, privacy, and recovery
8. Verification, rollout, falsification, and adversarial challenge

For a deep grill, use as many **non-overlapping** parallel lanes as the uncertainty warrants. Do not hard-code a lane count and do not create parallel work merely to appear thorough. A lane should own a distinct evidence or interrogation surface.

Each lane receives stable decision IDs and/or named coverage lenses, bounded evidence surfaces, permitted tools, and explicit stopping conditions. When the parent selected Evidence Recon expedition mode, each evidence-producing lane also receives the shared expedition assignment and returns a validated v1 lane receipt inside `assets/lane-result.yaml`. The result carries claims, negative claims, contradictions, limitations, topology observations, candidate decision updates, and candidate questions including recommendations.

Question-discovery lanes should intentionally return more raw candidate formulations than the user will see when doing so improves quality. They may attack the same high-consequence decision from distinct angles, such as invariant, failure, concurrency, ownership, migration, or proof. The parent then merges and sharpens them.

Lanes may:

- research discoverable facts and emit shared Evidence Recon claim fragments;
- identify missing consequential decisions;
- identify prerequisite, conditional, invalidation, exclusion, unlock, or fact-gating relationships;
- compare mechanisms;
- generate alternate formulations for consequential decisions;
- critique recommendations and rationales;
- attack the emerging contract for silent assumptions.

Lanes do **not**:

- ask the user directly;
- settle human decisions;
- upgrade a lane-local “not found” into evidence of global absence;
- expose raw candidate-question dumps;
- decide whether the canonical representation is authoritative;
- synthesize canonical documents;
- expand product scope;
- approve the design;
- own lifecycle state.

Launch independent lanes in parallel. Sequence lanes only when one truly depends on evidence from another. Stop a lane when its assigned decisions/lenses are evidenced, disproved, invalidated, represented in the candidate pool, or explicitly deferred.

The parent remains the sole interviewer. It reconciles conflicts, deduplicates candidates, runs the question-quality gate, chooses flat or graph representation after the mandatory sweep, computes the maximum coherent user-facing packet, re-evaluates topology after answers, and preserves stable IDs across representation changes.


## Evidence-lane reconciliation

Inline mode needs no dispatch: the parent performs the bounded reads and validates one packet. Expedition mode is justified only by the evidence question's breadth, source heterogeneity, contradiction risk, completeness requirement, false-negative cost, reconciliation need, or parallelizability.

The parent validates every returned lane, reconciles duplicate claim ids and contradictions, determines whether the full search receipt supports any negative claim, and emits one canonical packet. The packet can seed facts and possible decision surfaces, but it cannot waive the mandatory decision-coverage sweep or settle owner intent.
