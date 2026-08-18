# Assessment acceleration model

This package accelerates repository assessments without weakening evidence rules. It is the shared execution contract for repository health, integrity, architecture, and combined RIA work.

Read [THREADPOOL-EXECUTION.md](THREADPOOL-EXECUTION.md) for the mandatory work-conserving executor semantics.

## Core model

Treat an assessment as a bounded task graph with a saturated READY queue, not a prose checklist or a sequence of expert personas:

```text
identity/cache/context/topology prerequisites
                 │
                 ▼
      owner-tagged evidence packets
       ┌─────────┼─────────┐
       ▼         ▼         ▼
    worker     worker     worker
       │         │         │
       └──── as_completed ─┘
                 │
       immediate READY refill
                 │
        owner synthesis tasks
                 │
   deterministic verify + report
```

The root captain owns one global assessment budget. Read-only agent work is intentionally aggressive; command/test work has its own smaller budget. The default profile is resolved by `concurrency-profile.js`, not by an arbitrary fixed worker count.

The executor must remain work-conserving:

- submit all currently READY independent packets before awaiting one;
- consume completions as they arrive;
- after each completion, recompute dependency readiness and immediately refill idle capacity;
- keep enough queued work to absorb stragglers;
- split broad critical-path packets when the repository exposes safe independent sub-surfaces;
- never wait for a whole wave merely because several jobs were launched together.

## Task classes

Every task may declare `executor_class`:

- `agent` — read-only evidence/exploration subagent;
- `command` — tests, builds, linters, static tools, package-manager work;
- `deterministic` — inventories, fingerprints, parsers, graph extraction, cache operations;
- `synthesis` — owner merge, deduplication, alternative comparison;
- `report` — deterministic rendering and verification;
- `general` — compatibility fallback.

`class_budgets` constrain each class independently under the global ceiling. This is how assessment runs can saturate many remote subagents without launching the same number of heavyweight local commands.

Tasks still declare `id`, `owner`, `depends_on`, `weight`, `resources`, `priority`, and optional cache/timeout metadata. Resource keys are exclusive in `scheduler.js`; use them for worktrees, package-manager caches, coverage outputs, GPUs, report paths, and other surfaces that cannot safely overlap.

Represent plans with `task-graph.schema.json`. Preview a deterministic projection with:

```bash
node scheduler.js plan <task-graph.json> [max-parallel]
```

The CLI projection is for review/debugging. Live execution is `runPool()` and is not wave-barriered.

## Aggressive parallelism rules

1. Build only the smallest denominator needed to create safe packets. Do not finish the whole assessment in the parent before fan-out.
2. Derive packets from real repository topology rather than fixed scoring categories or fixed expert counts.
3. On broad repositories, create a READY backlog large enough to keep the agent pool saturated; the default target is `queue_multiplier × agent_workers`.
4. Dispatch all independent subagents before awaiting any one result.
5. Prefer several narrow packets to one giant explorer that becomes the critical-path straggler.
6. Start owner synthesis as soon as that owner's required evidence settles; unrelated owners need not finish first.
7. Use fail-soft fan-in. A failed packet becomes explicit unknown/uninspected coverage while independent evidence remains valid.
8. Coalesce deterministic duplicate work into single-flight tasks.
9. Never turn spare capacity into new scope. Parallelism changes execution topology, not assessment authority.
10. Do not create nested unbounded swarms. Under RIA, flatten Health, Integrity, and Architecture packets into one root pool whenever the runtime permits.

## RIA flattening

RIA owns the global pool for combined assessment. The three canonical owners retain their own evidence, grading, candidate, and architecture authority, but they do not each create an independent full-size executor.

Preferred:

```text
RIA pool
  ├─ health:runtime
  ├─ health:contracts
  ├─ integrity:wiring
  ├─ integrity:schemas
  ├─ architecture:module-depth
  ├─ architecture:hotspots
  └─ ...
```

Fallback when the runtime cannot flatten nested jobs: assign explicit owner sub-budgets whose sum stays under the global ceiling, then reallocate idle capacity as owners complete.

## Cache and warm starts

The cache lives outside the assessed repository. Cache baseline and evidence as independently invalidatable shards:

- repository identity and working-tree state;
- surface inventory and path classification;
- instruction, glossary, ADR, and policy context;
- environment/toolchain identity;
- approved command results;
- owner evidence packets;
- owner synthesis artifacts;
- deterministic report inputs/outputs.

Reuse classes:

- `exact` — revision and all bound fingerprints match;
- `content-stable` — revision moved but all bound content/dependency/environment inputs remain identical;
- `warm-only` — useful only for topology, vocabulary, candidate identity, likely hotspots, and command selection;
- `miss` — compute.

Warm-only content never supports a current claim, score, grade, rank, or recommendation.

`cache-store.js` provides content-hash verification and single-flight locking so concurrent workers do not duplicate identical deterministic work.

## Runner safety

`scheduler.js` passes an `AbortSignal` to each runner.

A timed-out Promise is not retried by default because JavaScript cannot forcibly stop a Promise that ignores cancellation; overlapping retry could duplicate a command or violate a resource lock. Use `retry_on_timeout: true` only for runners that synchronously honor the signal and release resources before retry.

Event retention remains opt-in with `collectEvents: true`; `onEvent` may consume live events without storing the hot-path trace.

## Deterministic report fast path

Models produce compact structured report data. Deterministic builders:

- escape prose;
- inject canonical data islands;
- inline verifiers;
- avoid runtime CDN/framework dependencies;
- write atomically;
- record output hashes and bytes.

Report speed never bypasses verification.

## Performance receipt

Every accelerated run records execution metadata, including global/class budgets, planned task count, peak concurrency, cache classification, invalidations, stage timings, and wall time.

These values are operational only. A faster or more parallel assessment is not automatically a better assessment.
