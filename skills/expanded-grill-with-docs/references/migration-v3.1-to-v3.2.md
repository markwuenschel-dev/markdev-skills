# Migration: v3.1 to v3.2

V3.2 extracts evidence semantics into `shared/evidence-recon` v1. The interview, mandatory decision sweep, flat/graph policy, and stable decision IDs remain unchanged.

- Install `shared/evidence-recon` v1.
- Convert ad hoc evidence notes into one validated packet or durable packet reference using `assets/evidence-recon-ref.yaml`.
- Use inline mode for bounded reads; use expedition mode only when evidence breadth, heterogeneous source classes, contradiction risk, completeness, false-negative cost, reconciliation, or parallelism justify it.
- Evidence-producing specialist lanes return the shared expedition-lane shape embedded in `assets/lane-result.yaml`.
- Do not promote negative observations to safe facts without explicit coverage receipts.
- Do not treat a complete evidence packet as completion of the mandatory decision-coverage sweep.
- Existing v3.1 flat sets and graphs remain resumable. Attach the packet reference on the next evidence refresh; preserve all stable decision IDs and resolutions.
