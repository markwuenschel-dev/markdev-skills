# Accelerated integrity discovery and reporting

Accelerated discovery is the default for Stage 1–2 and for `--parallel-report`. Resolve:

- `shared/assessment-acceleration/ACCELERATION-MODEL.md`
- `shared/assessment-acceleration/THREADPOOL-EXECUTION.md`
- `shared/assessment-acceleration/concurrency-profile.js`
- `shared/assessment-acceleration/scheduler.js`

The execution model is a saturated bounded executor: many narrow read-only packets, `as_completed` fan-in, and immediate READY-queue refill. It preserves the one-candidate execution gate.

## Aggressive read-only pool

Do not use a fixed four-agent audit team.

Start repository identity, prior-report/cache lookup, instruction/ADR indexing, manifest/lockfile inventory, static-tool discovery, generated/protected-path discovery, and topology extraction concurrently when dependencies permit.

As soon as the minimum topology is known, derive non-overlapping evidence packets and submit every READY packet before awaiting any one result. On broad repositories, create enough packets to keep the agent pool saturated; use `queue_multiplier × agent_workers` as the backlog target when genuine independent surfaces exist.

Packet families include:

- runtime entrypoints, wiring, jobs, configuration, and state-update paths;
- schemas, DTOs, public contracts, generated mirrors, and cross-language seams;
- tests, fixtures, goldens, CI, and build visibility;
- stale paths, duplicate implementations, dead/reachable legacy code, and ownership history;
- static/data-flow/security checks;
- numerical, accelerator, GPU, or concurrency invariants when present;
- subsystem-specific hotspot packets when one broad family would become a straggler.

Split broad packets by subsystem/language/runtime when they would monopolize the critical path. Merge tiny surfaces when dispatch overhead would exceed useful work.

Workers return structured evidence, claims, candidate proposals, affected surfaces, and uncertainty only. The Integrity owner alone deduplicates, applies the canonical spine, scores, ranks, and emits the ledger.

## ThreadPool behavior

The audit captain behaves like `ThreadPoolExecutor`:

1. submit all currently READY evidence packets;
2. consume whichever packet finishes next;
3. merge its evidence incrementally;
4. unlock dependent packets;
5. immediately refill the free worker slot;
6. continue until no authorized evidence packet remains.

Do not introduce whole-wave barriers merely because several workers were launched together.

A failed packet becomes explicit unknown/uninspected coverage. Independent successful results remain usable.

## RIA nesting

When Integrity runs under RIA, RIA owns the global executor. Prefer owner-tagged packet flattening (`integrity:*`) into the RIA root pool. Do not create a second full-size nested swarm.

Approved command receipts supplied by the RIA baseline are single-flight inputs and must not be rerun.

## Cache and warm starts

Cache by evidence packet, not by whole report. Bind shards to repository identity, explicit input paths, dependency closure, instruction/context fingerprint, relevant manifests/lockfiles, environment/tool versions, contract version, revision, and dirty-tree fingerprint.

Validated `exact` and `content-stable` shards may support current findings. `warm-only` shards may seed stable candidate IDs, likely seams/hotspots, previous packet boundaries, useful search terms, expected tools, and prior uncertainty structure; they are not current evidence.

## Command pool

Tests, linters, static tools, builds, and other local commands use the smaller `command` executor class with explicit resource keys. Never let aggressive subagent concurrency multiply heavyweight local commands.

## Deterministic report fast path (only when elected)

The standalone verified candidate ledger is produced first. If the report election resolves to generate, compile the projection from structured data:

```bash
node assets/build-report.js --input <integrity-report-input.json> --output <integrity-report.html>
```

The deterministic builder verifies/ranks the canonical ledger, escapes prose, writes atomically, and performs no runtime network work.

## Execution-stage limit

Aggressive parallelism applies to read-only discovery and handoff preparation for one selected candidate. This skill emits exactly one candidate handoff per loop; any authorized mutation executes under `production-flywheel`. Parallelism is not permission for adjacent cleanup, multiple active candidates, or source edits by assessment workers.

Record worker/class budgets, queue target, planned task count, peak concurrency, cache reuse, invalidations, stage timings, elected report compile time (or zero/skipped), and wall time in the performance receipt.
