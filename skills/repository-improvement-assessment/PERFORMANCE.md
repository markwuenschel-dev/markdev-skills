# RIA performance and execution contract

Repository Improvement Assessment owns one global, work-conserving execution DAG across baseline resolution, Software Engineering Intelligence, independent verification, Health, Integrity, Architecture, normalization, synthesis, report election, and optional report rendering.

Resolve `shared/assessment-acceleration/ACCELERATION-MODEL.md`, `THREADPOOL-EXECUTION.md`, `shared/assessment-runtime-contract/ASSESSMENT-RUNTIME-CONTRACT.md`, and `shared/assessment-verification-baseline/ASSESSMENT-VERIFICATION-BASELINE.md`.

The governing rule is:

> Verification is mandatory. Expensive discovery is conditional and reusable. Independent useful work starts as soon as its real prerequisites exist.

## Deterministic startup modes

RIA must call `scripts/startup-resolver.js`. An LLM does not choose the startup mode by intuition.

The resolver selects exactly one mode from validated repository identity, revision reachability, SEI engine/config/contract hashes, and artifact bytes:

- `EXACT_REUSE`: an exact compatible artifact exists at the current revision and its bytes match its declared SHA-256;
- `INCREMENTAL_REUSE`: no exact artifact exists, but a compatible hash-verified artifact exists at a reachable ancestor;
- `FRESH_BASELINE`: neither condition is true.

A valid exact artifact must be reused. A valid incremental base is preferred. Fresh recomputation requires explicit reason codes. Report renderer changes do not invalidate Health, Integrity, Architecture, or SEI artifacts.

## Source-owned runtime contracts

RIA reads each child's `RUNTIME-CONTRACT.json`, in parallel ordinary file I/O, rather than reading and summarizing the child's full `SKILL.md` before dispatch.

The child still owns and reads its full implementation contract when invoked. Parent-side runtime contracts are source-owned, schema-checked, content-hashed, and intentionally small. They remove repeated 150–500 line contract ingestion without substituting an untrusted parent summary.

## Global execution DAG

Generate `ria.execution-plan@2` with `scripts/build-execution-plan.js` and execute it only through `scripts/execution-runtime.js`, which consumes the plan through the bounded `agent-executor-pool`. Submit every READY node eagerly.

```text
resolve revision / baseline
        │
        ├──────── Software Engineering Intelligence ────┤
        │          exact | incremental | fresh           │
        │                                               │
        └──────── independent verification baseline ────┤
                                                        │
                            ┌───────────────────────────┘
                            ▼
             Health ║ Integrity ║ Architecture
                            │
                 consume as_completed
                            │
               normalize each owner immediately
                            │
                    validate ASSESS projection
                            │
                     one report election
                            │
               build report data → render, or skip
```

SEI and independent verification both depend on the resolved baseline revision, not on each other, so they run concurrently. All three owners become independently READY after their exact shared envelope dependencies settle and then run concurrently. A compatible verification artifact becomes a scheduler-terminal `reused` node and immediately releases dependents.

## Executor semantics

The root executor uses:

- a topology-derived READY queue;
- small, graph-width-derived class budgets bounded by the selected depth profile;
- `as_completed` consumption;
- immediate refill of released slots;
- separate budgets for `agent`, `heavy-tool`, and `local-deterministic` work;
- exact content-addressed reuse and graph-descendant invalidation;
- dependency and budget cancellation;
- flattened child lanes under RIA rather than three full nested swarms.

Cheap deterministic reads use ordinary parallel I/O. CPU-bound analyzers use thread/process pools. Independent semantic analyses use subagents. Central synthesis and authority decisions remain with the parent.

## Shared independent verification

RIA starts one `shared/assessment-verification-baseline` run in an isolated worktree/container as soon as the baseline revision is resolved. It may include Python, Java, TypeScript, build, lint, typecheck, test, container, and policy commands appropriate to the repository.

Health and Integrity consume the same immutable revision-bound receipt. They must not unconditionally rerun the entire suite. A targeted command or a second full pass is permitted only for a distinct owner-specific question, contradictory evidence, anomalous results, security-critical uncertainty, or explicit independent-reproduction policy.

This preserves independent assessment authority without paying twice for identical commands on every run.

## SEI reuse and progressive disclosure

SEI exact replay must work when report generation is skipped. The incremental manifest requires the canonical snapshot; `REPORT` is optional. If a later run elects a report and the exact bundle has no report bytes, SEI deterministically renders the report from the canonical artifact and assessment binding without rerunning analyzers.

SEI artifacts remain the canonical evidence store. Children should consume hash-bound role-specific projections or targeted queries when available rather than loading a complete multi-megabyte snapshot into every agent context.

Windows staging paths use a bounded, same-volume internal root. Output-directory depth must not cause `mkdtemp`/MAX_PATH failures.

## Content-addressed owner reuse

Health, Integrity, and Architecture artifacts are reusable when all of the following match:

- repository identity and exact revision;
- working-tree fingerprint;
- baseline SHA-256;
- engineering-intelligence SHA-256;
- owner skill version;
- owner `RUNTIME-CONTRACT.json` SHA-256;
- output schema/contract version;
- artifact bytes and declared SHA-256.

Use `scripts/owner-artifact-cache.js`. Exact validated hits bypass owner agents. `warm-only` information may accelerate topology discovery but cannot support a current grade, score, candidate, or owner reference.

## Incremental synthesis

Normalize each owner artifact as soon as it completes. Do not wait for the slowest owner before beginning report-data extraction, candidate joins, metric normalization, and convergence indexing.

The final report data model is built mechanically by `scripts/build-report-data.js` from byte-hash-verified child artifacts. Runtime must not hand-author hundreds of lines of report-input JSON, consult artifact-design on every assessment, or patch report CSS during a live run. Renderer design is reviewed and regression-tested when the package changes.

## Reports and presentation

Canonical ASSESS output is mandatory. The report remains elected through `shared/report-election`.

When elected, the report must:

- dereference and byte-hash verify the real child artifacts;
- recompute authoritative Health grading and Integrity scoring;
- preserve unscored Architecture values as `Not scored` rather than inventing numbers;
- include grades, scores, coverage, confidence, candidate rankings, routing, verification, and performance data when available;
- render quantitative visualizations when comparison benefits from them;
- pass the shared responsive presentation gate and use wide/ultrawide layouts without stretching prose to unreadable line lengths;
- reject demo baselines, placeholder hashes, unresolved child references, and analytically insufficient prose-only payloads outside fixture mode.

## Performance receipt

Build and validate the receipt with `scripts/performance-receipt.js` and `assets/performance-receipt.schema.json`; do not reconstruct it manually after the run. Emit a validated pre-presentation snapshot for report-data generation, then finalize the sibling receipt after render/skip. The finalized receipt is the postmortem authority; a deterministic report-only rebuild may project it into HTML without rerunning SEI or the three owners.

The current receipt is `ria.performance-receipt@2`. It is derived exclusively from scheduler-produced `ria.task-event@1` records. Metrics carry `measured`, `estimated`, or `unavailable` evidence; unavailable tool or token values remain unavailable rather than becoming zero. Receipt failure yields a nonblocking unavailable receipt and never changes owner judgment.

Record at minimum:

- total wall time and startup time;
- selected startup mode and reason codes;
- exact/content-stable/warm-only/miss counts for SEI and each owner;
- files/commits/relationships reused and recomputed where available;
- deterministic, agent, command, synthesis, and report worker budgets;
- peak READY queue, peak total/per-class concurrency, and refill events;
- SEI and shared-verification timings, including their overlap;
- owner start/end/duration, tool calls, tokens if exposed, cache disposition, and critical-path status;
- duplicate commands avoided by the shared verification baseline;
- normalization and final-reference-validation timing;
- report election, report-data build, and elected render timing;
- cancellations, critical-path splits, retries, failures, and fallbacks.

The receipt is observational. It cannot alter owner authority, canonical scores, or the ASSESS projection.

## Repository-local lineage

The default artifact-lineage index is `.project-intelligence/lineage/ria-artifacts.json`. `EXACT_REUSE`, `INCREMENTAL_REUSE`, and owner/verification cache hits should be resolved from this index before expensive work. Conversational memory may provide context but is not a correctness dependency.
