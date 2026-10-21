# Improve Codebase Architecture V2.0.0

## Architectural changes

- Integrates `shared/evidence-recon` with inline/expedition modes and negative-claim receipts.
- Adds mandatory architecture coverage sweep distinct from evidence coverage.
- Expands architecture transformation vocabulary beyond deep-module merging.
- Adds an Architecture Candidate Critic before canonical scoring.
- Makes the canonical architecture candidate set the source of truth.
- Makes HTML rendering conditional and zero-network.
- Preserves strict read-only analysis; domain/ADR changes are proposals only.
- Routes bounded design ambiguity to Expanded Grill, broad decision topology to Decision Terrain Mapper, and empirical uncertainty to Prototype.

## Performance changes

- `aggressive-threadpool-v2` execution profile.
- Adaptive topology-derived subagent count rather than fixed personas or an arbitrary small cap.
- Aggressive read-only agent pool with separate conservative local-command pressure.
- READY queue saturation proportional to active agent capacity when genuine independent work exists.
- `as_completed` result consumption and immediate refill.
- Worker-agnostic work stealing.
- Critical-path straggler splitting when evidence semantics permit it.
- Incremental per-surface candidate synthesis while unrelated evidence remains in flight.
- Parallel alternative/critic passes for high-impact ambiguous candidates.
- Single-flight deterministic work and content-addressed cache shards.
- Structured cancellation of stale/superseded speculative work.
- Flattening into RIA's global executor to avoid nested swarm explosion.
- Required performance receipt with concurrency, queue, cache, critical-path, and timing data.

## Compatibility

The package name remains `improve-codebase-architecture-mwdev`. ICA 2.0 requires the shared packages listed in `MANIFEST.json`, including the newly adopted `shared/evidence-recon`.
