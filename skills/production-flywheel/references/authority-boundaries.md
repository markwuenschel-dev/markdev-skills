# Production authority boundaries

This reference is the ownership map behind the thin `production-flywheel/SKILL.md` entrypoint.

| Capability | Role | May mutate target repo? | May select/expand mission? | May integrate/publish? |
|---|---|---:|---:|---:|
| explicit user/operator | mission selection and authorization | no | yes | publication policy only |
| `production-flywheel` | canonical production owner | yes | no | integration yes; publication only by policy/request |
| `production-campaign` | subordinate domain orchestrator | through workers only | no | requests Flywheel-owned integration boundaries |
| `agent-executor-pool` | execution scheduler/mechanism | no direct repository writes | no | no |
| `production-action-worker` | bounded worker | yes, inside fenced assignment | no | no |
| `human-directed-swarm-planner` | topology owner | no | no | no |
| `independent-verification` | verification owner | evidence/internal state only | no | verdict only |

Delegation is downward from the explicit authorization. A lower layer never infers upward authority. In particular, executor capacity, worker discovery, a convenient adjacent fix, or a worker's local diagnosis can never mint new authorized production work.

## Recursion guard

Mutating executor depth is one. A `production-action-worker` may call read-only specialists or bounded implementation disciplines, but it may not instantiate `production-campaign`, another `production-flywheel`, or another mutating `agent-executor-pool`. Any discovered production action is returned as an adjacent finding for reconciliation.
