# ThreadPool-style assessment execution

This contract defines the default throughput model for repository assessment and architecture-discovery skills. It is deliberately analogous to Python's `ThreadPoolExecutor`: maintain a bounded pool, submit independent work eagerly, consume results as they complete, and immediately refill freed capacity from the READY queue.

## Default concurrency profile

Assessment work separates remote/read-only agent concurrency from local command pressure.

- `agent` — read-only evidence/exploration subagents. Aggressive by default.
- `command` — tests, linters, static tools, package-manager work. Conservative because these contend for CPU, RAM, caches, worktrees, and output paths.
- `deterministic` — fingerprints, inventories, parsers, graph extraction, cache work.
- `synthesis` — owner merges and alternative comparison.
- `report` — deterministic report compilation/verification.

Resolve limits through `concurrency-profile.js`.

Environment overrides:

- `REPOSITORY_ANALYSIS_MAX_WORKERS` — global ceiling, maximum 64.
- `REPOSITORY_ANALYSIS_AGENT_WORKERS` — read-only subagent ceiling.
- `REPOSITORY_ANALYSIS_COMMAND_WORKERS` — local command ceiling.
- `REPOSITORY_ANALYSIS_DETERMINISTIC_WORKERS` — deterministic local-task ceiling.
- `REPOSITORY_ANALYSIS_SYNTHESIS_WORKERS` — synthesis ceiling.
- `REPOSITORY_ANALYSIS_REPORT_WORKERS` — report/verification ceiling.
- `REPOSITORY_ANALYSIS_QUEUE_MULTIPLIER` — target queued READY work per agent worker.

When no explicit limit is supplied, the aggressive profile uses host parallelism as a floor signal rather than a hard equality: read-only agent work may oversubscribe the host because it is usually remote/I/O-bound, while local command work remains much smaller. If the actual agent runtime exposes a lower concurrency cap, that runtime cap wins. If a deployment supports a higher safe cap, use the environment override instead of editing skill prose.

## Executor semantics

Think in these terms:

```python
with ThreadPoolExecutor(max_workers=agent_workers) as pool:
    futures = [pool.submit(run_lane, lane) for lane in ready_lanes]

    for future in as_completed(futures):
        result = future.result()
        merge_incrementally(result)
        submit_every_newly_ready_lane_immediately()
```

The runtime need not literally use Python. The semantic requirements are:

1. Create the smallest denominator needed to make safe work packets.
2. Materialize enough independent packets to keep the pool saturated. For broad repositories, target at least `queue_multiplier × agent_workers` packets when real independent surfaces exist.
3. Submit every currently READY independent packet before awaiting any one packet.
4. Consume completions with `as_completed` behavior. A fast packet returning must free capacity immediately; do not wait for a whole wave.
5. Recompute dependency readiness after every completion and refill idle slots from the READY queue.
6. Split critical-path stragglers when their surface can be partitioned without losing evidence meaning.
7. Coalesce duplicate work with single-flight cache tasks rather than dispatching several agents to rediscover the same deterministic fact.
8. Keep owner synthesis authoritative. Workers gather evidence; they do not independently grade, rank, select, or publish.
9. Preserve fail-soft fan-in. One failed lane becomes explicit unknown/uninspected coverage while independent successful work remains valid.
10. Stop creating packets when the repository no longer exposes useful independent work. Maximum parallelism means maximum *safe useful* parallelism, not fake fragmentation.

## Lane granularity

Prefer many narrow evidence packets over a few broad expert personas.

Good packet boundaries are formed by real repository structure:

- subsystem/module;
- language/runtime;
- entrypoint family;
- contract/schema family;
- test/build/delivery surface;
- ownership/churn region;
- generated or cross-language seam;
- numerical/GPU/security specialist surface;
- a candidate hotspot that needs an independent second look.

Do not force one worker per fixed scoring category. Scoring categories are parent synthesis dimensions, not worker slots.

A useful topology on a broad repository may have dozens of packets even when only a fraction run simultaneously. Queue depth is intentional: it allows work stealing/refill to keep workers busy as packet durations vary.

## Critical-path scheduling

Prioritize:

1. denominator/topology tasks that unlock many descendants;
2. high-fan-out evidence packets;
3. long expected-duration packets on the dependency critical path;
4. high-value or high-uncertainty surfaces;
5. report ornamentation last.

Do not spend all workers on low-value scans while one prerequisite keeps synthesis blocked.

## Nested assessment rule

Repository Improvement Assessment owns one global assessment executor.

Health, Integrity, and Architecture remain separate evidence owners, but their worker packets share the RIA root pool. Prefer flattening owner-tagged packets into that pool.

Forbidden:

```text
RIA starts 32 workers
  ├─ Health starts another 32
  ├─ Integrity starts another 32
  └─ Architecture starts another 32
```

Allowed:

```text
RIA global executor
  ├─ health:* packets
  ├─ integrity:* packets
  └─ architecture:* packets
```

If the runtime only supports nested delegation, the root assigns explicit sub-budgets whose total cannot exceed the global ceiling and may reclaim/refill idle capacity across owners.

## Speculative read-only duplication

Redundant subagents are allowed only when they increase confidence on a high-impact ambiguous surface and spare capacity remains after coverage-critical packets are queued. They must be independently scoped and reconciled by the owner. Do not duplicate routine scans merely to make the worker count look high.

## Commands are a different pool

Agent saturation must not imply command saturation.

Tests, linters, builds, static analyzers, package-manager operations, coverage collectors, GPU jobs, and output-producing tools declare command/resource keys. Conflicting commands serialize even while read-only evidence agents continue in parallel.

This separation is what allows aggressive subagent use without melting the local repository environment.

## Performance receipt

Accelerated runs should record:

```json
{
  "worker_budget": 24,
  "class_budgets": {
    "agent": 24,
    "command": 4,
    "deterministic": 8,
    "synthesis": 3,
    "report": 1
  },
  "queue_multiplier": 3,
  "planned_tasks": 61,
  "peak_concurrency": 22,
  "peak_by_class": {
    "agent": 19,
    "command": 3,
    "deterministic": 6,
    "synthesis": 2,
    "report": 1
  }
}
```

These fields measure execution only. They never raise a health grade, candidate priority, evidence quality, or recommendation strength.
