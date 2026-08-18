# Accelerated health assessment

Every repository-wide health assessment uses the aggressive assessment executor. Resolve `shared/assessment-acceleration/ACCELERATION-MODEL.md` and `THREADPOOL-EXECUTION.md` before dispatch.

The six health lanes are grading categories, not worker assignments. Worker count and packet count come from repository topology and the concurrency profile.

## Parallel denominator construction

The complete surface denominator remains mandatory, but its construction is itself parallel.

Start these independent deterministic tasks together:

- repository and dirty-tree fingerprinting;
- manifest/lockfile/language/build-system inventory;
- project instruction, glossary, policy, and ADR indexing;
- generated/protected/vendor path classification;
- entrypoint/runtime discovery;
- test/build/delivery surface enumeration;
- prior-report/cache lookup.

Fan these into the canonical surface inventory. Freeze the complete denominator before final coverage adjudication and grade calculation.

Do not perform deep evidence analysis in the parent while constructing the denominator. The goal is to reach dispatchable topology quickly.

## Aggressive evidence fan-out

After the denominator exposes safe surface packets, derive as many non-overlapping read-only packets as useful.

Typical packets include:

- runtime/entrypoint families;
- domain modules by subsystem;
- schemas/contracts/data boundaries;
- APIs/adapters/integration seams;
- tests/fixtures/goldens;
- build/delivery/operations;
- security;
- generated/cross-language seams;
- numerical/GPU/performance surfaces;
- ownership/churn/history;
- focused hotspots identified by engineering intelligence.

On broad repositories, maintain a READY backlog large enough to keep the read-only agent pool saturated. Split a broad lane before dispatch when its independent subsystems would otherwise produce a critical-path straggler.

Each worker returns claims, evidence, observed surfaces, coverage observations, proposed maturity levels, candidate findings, and uncertainty. It never returns the final lane score, grade, cap, confidence, or candidate rank.

## `as_completed` merge

Submit all READY packets before awaiting. As each completes:

- merge claims into the owner namespace;
- update observed coverage;
- deduplicate provisional candidate identity;
- unlock dependent follow-up packets;
- immediately refill the free worker slot.

Do not wait for all workers from an arbitrary batch before admitting newly READY work.

Final lane scores, weighted coverage, caps, confidence, grade, and candidate ranking are computed once by the Health owner after all required packets settle.

## Command isolation

Project commands remain parent-owned, approval-bound, and isolated. Tests, builds, linters, coverage, and static tools use the smaller `command` class and explicit exclusive resource keys such as:

- `worktree`;
- `package-manager:<name>`;
- `coverage-output`;
- `build-output:<name>`;
- `gpu`.

Read-only subagents may continue at high concurrency while command resources serialize.

## RIA nesting

Under RIA, Health does not create an independent full-size pool. Return or submit owner-tagged `health:*` packets into the RIA root executor, or consume a bounded sub-budget supplied by RIA. Idle capacity may be reassigned across owners.

## Cache shards

Cache independently:

- surface inventory/path classification;
- context/ADR/policy packets;
- evidence packets and dependency closures;
- approved command receipts;
- merged claims/candidate identity;
- canonical health island;
- compiled report.

Only `exact` and validated `content-stable` shards may support current evidence. `warm-only` data may seed topology, candidate IDs, vocabulary, hotspots, and command selection but never a current claim, coverage state, maturity level, grade, or candidate score.

## Deterministic report (only when elected)

Compile the model's small structured input with:

```bash
node assets/build-report.js --input <health-report-input.json> --output <repository-health.html>
```

Record global/class budgets, queue target, packet count, peak concurrency, cache classifications, invalidations, stage timings, elected report bytes (or zero/skipped), and wall time. Operational performance never changes the health grade.
