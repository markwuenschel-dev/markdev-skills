---
name: agent-executor-pool
description: "Generic subordinate concurrency runtime for agent work: bounded worker classes, dependency-DAG readiness, futures, resource semaphores, structured cancellation, work-stealing/refill, backpressure, and fenced worker leases. Mechanism only; never decides what work should exist or acquires lifecycle/production authority."
disable-model-invocation: true
---

# Agent Executor Pool

This capability is the reusable concurrency substrate. It intentionally knows nothing about candidate priority, production meaning, assessment meaning, or lifecycle state.

Its model is analogous to a bounded executor / Python `ThreadPoolExecutor`: submit authorized jobs eagerly, admit only dependency/resource-safe READY jobs under class budgets, observe future states, consume completions as they arrive, refill free capacity immediately, propagate cancellation through a parent scope, and reject stale worker completions with generation/fence tokens.

Assessment callers may deliberately use a much larger `read_only` budget than mutation/command budgets. The executor never invents a fixed worker count for them; the caller's concurrency profile is authoritative.

Read [EXECUTION-MODEL.md](EXECUTION-MODEL.md) for semantics. `runtime.js` is the pure deterministic scheduler; `worker-lease-store.js` provides durable fenced assignment leases.

## Hard boundary

Executor capacity never creates work. Callers own job meaning and authorization. A job with `executor_depth > 1` in a mutating class is rejected. Integration/publication classes default to capacity one.
