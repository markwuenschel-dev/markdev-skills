# ICA V2 validation receipt

Validation performed against the shared skill-family packages available with the supplied skills bundle.

## ICA package

- `node assets/package-check.js` → `AII_V2_3_PACKAGE_OK`
- all package JSON files parse
- `EVALUATIONS.yaml` parses with 25 unique cases
- `assets/architecture-candidate-set.schema.json` passes Draft 2020-12 schema validation
- `assets/architecture-candidate-set.example.json` validates against the candidate-set schema
- `assets/build-report.js` and `assets/mermaid-safe.js` pass Node syntax checks
- active SKILL/PERFORMANCE/report contracts contain no CDN/network URL
- active skill contracts contain no legacy instructions to mutate `CONTEXT.md`

## Deterministic report integration

A one-candidate fixture was compiled using the real shared assessment report compiler and candidate-ledger verifier.

- builder result: success
- output size: 45,452 bytes
- output view-time network references: 0
- fixture SHA-256: `0e4e24e6d8e41f76b5ed723bf5f64451ffe0e1d7bab7a627b7f232d8d40b1868`

## Shared dependency checks

- `shared/assessment-acceleration` package check: PASS
- concurrency profile test: GREEN
- `agent-executor-pool` package check: GREEN 6/6
- executor runtime tests: GREEN 6/6, including as-completed refill/work stealing and structured cancellation
- `shared/evidence-recon` package check/tests: GREEN 14/14
- `shared/candidate-ledger-spine` package check: PASS

## Scope of validation

These are static/deterministic and shared-runtime unit/integration checks. No claim is made that a live LLM deployment reached a particular wall-time speedup or peak subagent count; actual concurrency is bounded by the runtime available to the invoking agent.
