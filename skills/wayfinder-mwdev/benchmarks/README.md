# Benchmark evidence area

`runs/` — raw (`*.raw.json`, unmodified API responses + envelope) and normalized
(`*.normalized.json`) fresh-context execution records, written by
`scripts/benchmark_runner.py --run-all --fresh-context`.
`scores/` — evaluator-performed scorecards (`--score`).
`aggregate.json` / `REPORT.md` — aggregate report (`--report`).
`traceability.json` / `traceability.md` — evaluation-to-benchmark traceability
(`scripts/validate_release.py --traceability`).

This directory is evidence storage, not skill content: nothing here loads into
model context at skill invocation. Absence of runs is reported honestly by
`benchmark_runner.py --validate-results` (nonzero exit, WF211-* codes).
