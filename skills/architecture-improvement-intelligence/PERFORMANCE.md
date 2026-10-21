# ICA V2 Performance Model — Aggressive, Adaptive, Work-Conserving

ICA V2 is optimized for low wall-clock latency on repository-scale architecture work while preserving evidence and authority boundaries.

It uses the semantics of a bounded multithreaded executor even when the underlying workers are remote LLM subagents rather than OS threads:

```text
minimal denominator
      ↓
materialize READY work from real topology
      ↓
┌──────────── bounded executor ────────────┐
│ agent lanes       aggressive / I/O-bound │
│ deterministic     medium / local         │
│ command lanes     conservative / costly  │
│ synthesis         bounded                │
│ report            normally 1             │
└───────────────────────────────────────────┘
      ↓ as_completed
incremental reconcile + immediate refill
      ↓
critical-path split / new probes / synthesis
```

Resolve `shared/assessment-acceleration/ACCELERATION-MODEL.md`, `THREADPOOL-EXECUTION.md`, and `agent-executor-pool/EXECUTION-MODEL.md`. ICA does not maintain a private scheduler.

## 1. Adaptive cardinality, not fixed personas

Do not prescribe "4 agents" or "8 agents" as a workflow rule. Resolve the available concurrency profile and derive **as many non-overlapping logical packets as the repository/evidence topology supports**.

On broad work, read-only subagent work is intentionally aggressive. Remote/I/O-bound agent lanes may oversubscribe host parallelism when the runtime allows it. Local commands remain smaller because they contend for CPU, memory, package caches, worktrees, databases, ports, GPUs, and output paths.

Environment ceilings come from the shared profile:

- `REPOSITORY_ANALYSIS_MAX_WORKERS` (global; shared runtime maximum 64)
- `REPOSITORY_ANALYSIS_AGENT_WORKERS`
- `REPOSITORY_ANALYSIS_COMMAND_WORKERS`
- `REPOSITORY_ANALYSIS_DETERMINISTIC_WORKERS`
- `REPOSITORY_ANALYSIS_SYNTHESIS_WORKERS`
- `REPOSITORY_ANALYSIS_REPORT_WORKERS`
- `REPOSITORY_ANALYSIS_QUEUE_MULTIPLIER`

The actual runtime cap wins if lower.

## 2. Saturated READY queue

For broad repositories, create enough real independent packets that uneven lane durations do not leave workers idle. Target a READY/backlog depth of approximately:

```text
queue_multiplier × active_agent_workers
```

when that many genuine independent surfaces exist.

Do not invent redundant scans to hit the target. A shallow queue is correct when the architecture topology is genuinely narrow.

## 3. ThreadPool / `as_completed` semantics

Mandatory scheduling behavior:

```python
with ThreadPoolExecutor(max_workers=agent_workers) as pool:
    submit_all_currently_ready()
    while outstanding:
        result = next(as_completed(outstanding))
        merge_incrementally(result)
        recompute_readiness()
        split_stragglers_if_safe()
        submit_every_newly_ready_job()
```

The runtime need not literally use Python. The invariants are:

- submit every independent READY job before awaiting one;
- accept whichever result finishes first;
- free its capacity immediately;
- merge evidence incrementally;
- recompute dependent readiness after every completion;
- refill the slot immediately;
- never wait for a whole wave solely because jobs were launched together.

## 4. Parallel architecture topology

After the minimum safe denominator is known, derive packets from real surfaces. Typical independent packet families:

### Context / authority

- `architecture:domain-glossary`
- `architecture:adr-constraints`
- `architecture:ownership-policy`
- `architecture:runtime/generated-policy`

### Static topology

- imports/dependencies/call graph by subsystem;
- entrypoints and lifecycle paths;
- persistence/state owners;
- cross-language/generated boundaries;
- adapters/substitution points;
- tests/contracts/proof surfaces;
- churn/coupling/hotspots.

### Architecture lenses

- module depth/interface width by independent subsystem;
- locality/deletion-test surfaces;
- duplicate/parallel paths;
- state/transaction/concurrency ownership;
- seam maturity and adapter evidence;
- concentration/god-module risk;
- migration/compatibility surfaces;
- operational/recovery ownership.

A packet should be narrow enough to finish independently and return a coherent evidence fragment, but not so tiny that coordination dominates useful work.

## 5. Two-level fan-out without swarm explosion

ICA may use a second parallel level after evidence fan-in for **candidate alternatives/critics**, but only when the surface is high-impact or ambiguous and spare capacity remains.

Example:

```text
surface evidence settles
      ↓
┌──────────────┬──────────────┬──────────────┐
│ alternative A│ alternative B│ alternative C│
└──────────────┴──────────────┴──────────────┘
      ↓ as_completed
Architecture owner critic/reconciliation
```

Do not recursively spawn unbounded sub-swarms. All logical work should flow through the same bounded executor when the runtime supports it. Under RIA, flatten all ICA work into RIA's root pool.

## 6. Incremental synthesis / pipeline overlap

Do not impose a global "all evidence must finish before any architecture thinking starts" barrier.

A surface may enter candidate synthesis when its required evidence contract is satisfied. Candidate alternative/critic work can execute while unrelated evidence lanes continue.

Final ranking/recommendation still waits for all evidence required by the candidate's declared coverage and for relevant contradiction gates.

This creates a pipeline:

```text
Evidence lane A ──→ candidate A synthesis ──→ critic A ──┐
Evidence lane B ───────────────→ candidate B synthesis ──┼→ owner ranking
Evidence lane C ──→ extra probe C2 ──────────────────────┘
```

## 7. Work stealing and critical-path control

Treat the READY queue as worker-agnostic. A free worker takes the highest-priority compatible job; do not preserve artificial affinity to the lane that created it.

When a critical-path packet becomes a straggler:

1. determine whether its surface can be partitioned without overlapping claim authority;
2. split into independent child packets;
3. cancel/reshape the original packet when supported;
4. submit children immediately;
5. reconcile under the parent evidence/architecture owner.

Do not split a packet when doing so would create partial conclusions that cannot be meaningfully reconciled.

## 8. Separate command pressure from agent saturation

Architecture analysis is read-only, but deterministic tools and tests may still be executed for evidence. These belong to a smaller `command` budget with explicit resource keys.

Examples requiring serialization/resource constraints:

- one package manager cache;
- one mutable worktree;
- one database fixture;
- one coverage output path;
- one GPU;
- one fixed port;
- one report destination.

Read-only subagents continue running while a constrained command waits. Do not reduce agent concurrency merely because one local build is expensive.

## 9. Evidence Recon performance

`shared/evidence-recon` mode selection is based on the evidence question, not expected diff size.

### Inline

The parent may perform bounded reads/searches itself. No agent dispatch is required. Deterministic searches can still run concurrently when independent.

### Expedition

Create an expedition with independent source/surface lanes, aggressive pool saturation, fail-soft fan-in, and one parent reconciler. Lane results are evidence fragments, not final architecture claims.

A wide negative claim with high false-negative cost is a strong expedition signal even if the eventual implementation change would be one line.

## 10. Single-flight and cache shards

Use `shared/assessment-acceleration` cache/fingerprint facilities. Cache independently so a small change invalidates only the affected evidence:

- repository identity and working-tree state;
- glossary/ADR/constraint packets;
- dependency/call/state topology;
- subsystem module/interface/test topology;
- ownership/churn evidence;
- evidence-recon packets and negative-claim receipts;
- candidate identity/dedup groups;
- alternative/critic outputs;
- canonical candidate-set data;
- verified ledger;
- compiled HTML.

Reuse classes:

- `exact` — fully bound inputs match;
- `content-stable` — revision differs but all bound content/dependencies/environment remain identical;
- `warm-only` — may seed topology, vocabulary, likely hotspots/candidate IDs, rejected alternatives; cannot support a current claim/recommendation;
- `miss` — recompute.

Concurrent duplicate deterministic work is single-flight. Never launch several workers to compute the same fingerprint/inventory simply because the pool has room.

## 11. Fast deterministic paths before LLM lanes

Where a cheap deterministic operation can reduce search space, launch it immediately in the deterministic pool and allow its result to reshape queued agent work:

- file/symbol inventory;
- import/reference graph extraction;
- ownership/churn statistics;
- test inventory;
- schema/manifest parsing;
- ADR/glossary index;
- candidate-ledger verification.

Do not wait for deterministic work that is unrelated to already-safe agent packets; both classes may proceed concurrently.

## 12. Adaptive priority

Prioritize work that shortens the critical path or changes downstream topology:

1. authority/constraint blockers;
2. evidence needed to establish candidate eligibility;
3. high-leverage/hotspot surfaces;
4. probes that resolve contradictions;
5. alternative/critic work for likely leading candidates;
6. low-impact completeness work;
7. report rendering.

Completion of a high-priority result may reprioritize or cancel lower-value speculative probes.

## 13. Structured cancellation and scope control

All dispatched work belongs to one ICA run scope. If a candidate is rejected, superseded, or proven non-architectural, cancel not-yet-running descendant probes for that candidate. A worker must not outlive the parent scope.

Spare capacity is never permission to expand repository scope beyond the user's/caller's authority.

## 14. RIA flattening

Under `--assessment`, ICA does not start its own full-size nested executor. Submit owner-tagged `architecture:*` tasks into the RIA global pool.

Preferred topology:

```text
RIA root pool
  ├─ health:...
  ├─ integrity:...
  ├─ architecture:authority
  ├─ architecture:module-depth:subsystem-A
  ├─ architecture:module-depth:subsystem-B
  ├─ architecture:hotspots
  ├─ architecture:tests-seams
  └─ ...
```

If flattening is impossible, use an explicit ICA sub-budget whose sum with peer owners remains below the global ceiling, then return idle capacity when work completes.

## 15. Optional report fast path

The canonical candidate set is produced before HTML. Report work belongs to the `report` class and normally has capacity 1.

When the report election resolves to `generate`, compile deterministically:

```bash
node assets/build-report.js --input <architecture-report-input.json> --output <architecture-review.html>
```

The report must be self-contained and zero-network at view time. Report compilation must not block independent evidence/candidate work that does not require the report.

## 16. Performance receipt

Every accelerated run records at least:

```json
{
  "profile": "aggressive-threadpool-v2",
  "worker_budget": 0,
  "class_budgets": {
    "agent": 0,
    "command": 0,
    "deterministic": 0,
    "synthesis": 0,
    "report": 0
  },
  "queue_multiplier": 0,
  "planned_tasks": 0,
  "peak_ready_queue": 0,
  "peak_concurrency": 0,
  "peak_by_class": {},
  "cache": {
    "exact": 0,
    "content_stable": 0,
    "warm_only": 0,
    "miss": 0,
    "single_flight_coalesced": 0
  },
  "critical_path": {
    "stragglers_detected": 0,
    "packets_split": 0,
    "cancelled_speculative_jobs": 0
  },
  "timings_ms": {
    "denominator": 0,
    "evidence": 0,
    "candidate_pipeline": 0,
    "owner_reconciliation": 0,
    "report": 0,
    "wall": 0
  }
}
```

The receipt measures execution behavior only. More workers, higher cache reuse, or lower wall time never increase evidence quality, candidate score, or recommendation strength.
