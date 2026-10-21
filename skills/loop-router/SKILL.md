---
name: loop-router
description: Historical experimental lifecycle prototype retained for explicit inspection and deterministic fixture testing. Non-production and unavailable for workflow routing.
disable-model-invocation: true
---

# Loop Router (experimental)

This package is dormant experimental infrastructure. It has no production authority and is not an entry point, control plane, lifecycle owner, scheduler, mutation owner, verification owner, or completion authority.

Production work uses explicit user/operator selection followed by direct invocation of the applicable canonical skill. Authorized repository mutation enters `production-flywheel`; multi-action execution may be delegated beneath it to `production-campaign`, `shared/action-graph-execution`, and `agent-executor-pool`. Assessment skills return their artifacts to the invoking caller. Nothing in this package may interpose on those paths.

## Permitted use

Use this package only when a human explicitly requests inspection of the historical prototype or execution of its deterministic tests. Its scripts, fixtures, schemas, route records, and lifecycle handoffs describe an experimental simulation and must not be treated as current production policy or authority.

Do not create or resume a production mission, reserve production work, dispatch another skill, mutate a target repository, or claim lifecycle completion from this package. For an attempted operational invocation, return `EXPERIMENTAL_NON_PRODUCTION` and direct the caller to select the canonical assessment or delivery skill explicitly.

Completion criterion: inspection or testing remains read-only with respect to the target repository and makes no production routing claim.
