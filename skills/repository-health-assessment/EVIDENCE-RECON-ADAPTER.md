# Evidence Recon Adapter

Repository Health Assessment is the reference adopter for `shared/evidence-recon` because its coverage and observation discipline proved the generic vocabulary in production use.

This integration is deliberately **additive**:

- the health island remains schema v5 and remains the only authority for the eleven health surfaces, criticality weights, weighted coverage, lane maturity, grade caps, confidence, and candidate provenance;
- a validated Evidence Recon sidecar is emitted for generic downstream consumption;
- no evidence packet field may set or alter the health grade;
- the sidecar cannot replace RHA's complete default surface inventory.

## Projection

`assets/evidence-recon-projection.js` projects the health island into Evidence Recon packet v1:

- RHA lane claims become `confirmed`, `inferred`, or `unknown` generic claims;
- RHA coverage/evidence-quality values retain the shared vocabulary;
- each health lane becomes an expedition lane receipt;
- candidate claim references seed `possible_decision_surfaces` or `owner_intent_required` without authorizing a decision;
- negative-looking observations are projected conservatively into `negative_claims`.

The health island did not historically record search scope/method/completeness for negative claims. Therefore the adapter sets `supports_absence: false` unless the caller supplies an explicit `negative_claim_receipts` augmentation. This is intentional: “no guard found” is not allowed to become “no guard exists” merely because an older schema lacked the receipt.

## Run contract

1. Build and verify the ordinary health island exactly as before.
2. Project it with `projectHealthIslandToEvidencePacket`.
3. Add explicit negative-claim receipts gathered during the assessment where warranted.
4. Validate the sidecar with `shared/evidence-recon/evidence-recon.js`.
5. A failed sidecar validation blocks downstream evidence handoff, but it does not rewrite the already-computed health arithmetic. Fix the evidence packet or label that handoff unavailable.

The sidecar belongs beside the report in the OS temp directory or in the parent orchestrator's run envelope. Never write it into the repository under assessment.


## Atomic writer

For an executable handoff, run:

```bash
node assets/write-evidence-recon-sidecar.js <health-island.json> <output.json> [negative-receipts.json] [evidence-recon.js]
```

The writer projects and validates the packet before writing, refuses to overwrite an existing sidecar, writes through a same-directory temporary file, and renames atomically. The optional receipts file is an object keyed by original RHA claim id or projected negative-claim id. Use a timestamped output beside the HTML report in the OS temp directory.
