# Production Flywheel — Triage Branch Procedure

Use when work starts from an issue or external pull request.

## Steps

1. Run `/triage`.

## Gate

- **Single State and Category**: The issue or PR has exactly one category and one state assigned.
- **Durable Brief**: If marked ready for agent, a durable agent brief exists detailing the scope.
- **Out-of-Scope Logging**: If rejected as an enhancement or out-of-scope, the reason is logged under `.out-of-scope/`.
