---
name: connected-impact-sweep
description: "Run a connected-system impact analysis when the user explicitly requests this skill. Classifies a revision-bound change as skip, light, or full before loading detailed procedures."
disable-model-invocation: true
---

# Connected Impact Sweep

Use this skill only for an explicit connected-impact request. It is not an automatic prerequisite for ordinary edits and it does not grant mutation authority.

## Gate first

Build a Git-bound input for `evaluateImpactGate` in `impact-gate.js`:

- `repository_root`, `base_revision`, and `repository_revision`: a real repository plus exact full commit OIDs.
- `changes`: the exact Git-diff paths plus owning components, dependency fan-out, deployable units, and optional signal assertions.
- `dependency_graph`: optional `{nodes, edges}` bound to the same revision.
- `explicit_request: true` for a direct user invocation.

Signals are `public-api`, `exported-type`, `database-schema`, `event-schema`, `wire-schema`, `migration`, `shared-config-contract`, `auth-boundary`, `cross-repository-contract`, and the internally derived conservative fallback `semantic-boundary-unknown`. The gate recomputes paths and patches from Git, derives both path and semantic-content signals across common module, export, public-method, routing, and authorization syntax, rejects missing/extra caller paths and caller-only signals, and binds the patch-set digest into its receipt. Boundary-like syntax that is not understood forces a full sweep with `SEMANTIC_BOUNDARY_UNKNOWN`; it cannot fall through to local-only. Do not infer a signal merely because several files changed. The gate returns `skip`, `light`, or `full`, stable reason codes, affected components, and revision-keyed graph-cache metadata.

For a direct run, pass one JSON object on stdin to `node scripts/run-impact-gate.js`. Treat malformed input, graph revision mismatch, and graph drift as fail-closed errors.

## Act at the returned level

- `skip`: make no extra sweep. Record `LOCAL_IMPLEMENTATION_ONLY` if reporting the decision.
- `light`: inspect direct callers, tests, configuration references, and obvious sibling implementations. Load [light-sweep.md](references/light-sweep.md).
- `full`: enumerate consumers across the connected system, classify each as update-now, ambiguous, or unaffected, then verify the coherent change set. Load only the procedure matching the returned reasons:
  - public API, exported type, shared config, event, or wire reasons: [contract-sweep.md](references/contract-sweep.md)
  - database schema or migration reasons: [data-migration-sweep.md](references/data-migration-sweep.md)
  - authorization, cross-repository, high fan-out, multiple deployables, or explicit-request reasons: [cross-system-sweep.md](references/cross-system-sweep.md)

Pause for unresolved public-contract semantics, migrations/backfills, security boundaries, destructive retirement, or numerical correctness. Otherwise keep the work within the requested scope. Report the gate envelope, searches performed, affected components, changed dependents, and exact verification evidence. Never claim an unrun check.
