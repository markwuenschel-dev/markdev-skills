# Migrations

## 1.0.0 — extraction from repository-health-assessment

The generic vocabulary was extracted from the proven repository-health-assessment discipline without changing that skill's health grading schema or denominator:

- coverage: `inspected`, `sampled`, `inventory-only`, `uninspected`, `unavailable`, `not-applicable`;
- evidence quality: `strong`, `moderate`, `weak`, `none`;
- observations: `confirmed`, `inferred`, `unknown`.

RHA remains authoritative for its eleven health surfaces, criticality weights, weighted-coverage arithmetic, grade caps, and confidence formula. It consumes the shared primitive through a validated sidecar projection. Other adopters emit the canonical packet directly.
