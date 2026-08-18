# Agent executor model

## Job states

`PENDING`, `READY`, `RUNNING`, `BLOCKED`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `STALE`.

The scheduler computes readiness from real dependencies rather than list position. A failed required dependency blocks downstream work unless the caller explicitly reshapes the graph outside this runtime.

## Parallelism classes

- `read_only` — high concurrency by default.
- `implementation` — bounded by mutation/risk/resource policy.
- `validation` — parallel when environments/resources permit.
- `integration` — normally capacity 1.
- `publication` — capacity 1.

## Resources

Jobs request named resources with `shared` or `exclusive` mode and permits. Shared jobs may coexist until capacity is exhausted. Exclusive acquisition requires the resource to be unused. Paths may be modeled as resource ids by callers when needed.

## Futures, `as_completed`, and work stealing

`complete(job)` frees its permits immediately. The caller should treat completions like `as_completed`: after every completion, call `schedule()` again and admit any newly READY job into the freed slot. No affinity to a particular worker is required; this is work-stealing/refill behavior over the READY queue.

For broad read-only assessment work, callers should normally materialize more logical jobs than active workers so the pool remains saturated despite uneven task durations. A queue is useful; an idle worker waiting for an arbitrary batch barrier is not.

## Backpressure

`max_buffered_jobs` limits materialized jobs. Callers with very large queues stream more jobs only as capacity becomes available.

## Structured cancellation

Jobs belong to a `scope_id`. Cancelling a scope cancels not-yet-running descendants and returns cancellation requests for running descendants. No child may outlive a closed parent scope.

## Adaptive concurrency

Budgets are mutable ceilings. A caller may lower an effective class budget in response to conflict/risk/resource pressure. The executor never raises a caller-declared ceiling and never interprets spare capacity as permission to enqueue additional work.
