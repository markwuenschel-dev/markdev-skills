# Wayfinder v2.1.2 — release summary

**Verdict: INCOMPLETE — EVIDENCE MISSING.** All corrections, alignment, normalization,
harness, and validation work is complete and passing; the four required fresh-context
benchmark executions are not captured (no API credentials in the build environment),
and per the merge gate a benchmark represented only by its worked transcript does not
count as executed. No evidence was fabricated.

## Commands executed and exit codes

| command | exit | evidence |
|---|---|---|
| `python3 -m py_compile scripts/*.py` | 0 | all Python compiles |
| `python3 scripts/validate_release.py --all` | 0 | transcripts, traceability, capability-names, tracker, package all clean |
| `python3 scripts/validate_release.py --transcripts` (pre-fix) | 1 | caught quoted stale phrase; corrected |
| `python3 scripts/benchmark_runner.py --run-all --fresh-context` | 2 | WF211-RUNNER-NO-CREDENTIALS — attempt captured, nothing fabricated |
| `python3 scripts/benchmark_runner.py --validate-results` | 1 | WF211-BENCHMARK-MISSING-RAW-OUTPUT × 4 (b1–b4) |
| `python3 scripts/benchmark_runner.py --report` | 0 | `aggregate.json`, `REPORT.md` (raw MISSING / UNSCORED, honest) |

Dedup regression self-test: the detector catches the original B2/B3 duplicate pair and
does not false-positive on distinct questions (asserted inside `--transcripts`).

## Evidence artifacts

- Corrected golden transcripts: `../assets/benchmark-transcripts.md` (per-benchmark id + version 2.1.2)
- Fixtures and auto-checks: `../assets/benchmark-fixtures.yaml`
- Traceability: `traceability.json` / `traceability.md` — four links, all `exact`, no unresolved mismatch
- Aggregate: `aggregate.json` / `REPORT.md`
- Runs and scorecards: `runs/`, `scores/` — **empty pending execution**, reported at nonzero exit

## Completing the release (operator procedure)

In an environment with credentials (or Claude Code):

    export ANTHROPIC_API_KEY=...
    python3 scripts/benchmark_runner.py --run-all --fresh-context
    python3 scripts/benchmark_runner.py --validate-results        # raw + fresh + normalized
    # score each normalized record against the frozen rubric (performed, not inferred):
    python3 scripts/benchmark_runner.py --score benchmarks/runs/b1-<ts>.normalized.json \
        --evaluator mark --pass --dim interview=9 --dim adaptation=8.5 --dim swarm=9 \
        --dim map=8.5 --dim evolution=8.5 --dim integration=9 --dim boundaries=9 \
        --note "..." 
    python3 scripts/benchmark_runner.py --report
    python3 scripts/validate_release.py --all

Freshness: each run is one brand-new API conversation containing only the skill files
and that benchmark's fixture turns; the method is recorded in every run envelope. A
failed benchmark does not block the release; missing evidence does.

## Limitations and unresolved failures

- The four fresh-context executions and their scorecards are the sole open items.
- Auto-checks in normalized records are evidence for the evaluator, not scores; rubric
  scoring is performed via `--score` after runs exist.
- No strict-governance readiness is claimed; it is outside evaluated scope.
