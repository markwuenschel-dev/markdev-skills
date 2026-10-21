# Auto compatibility mode

`--auto` is not blanket mutation authority. It accepts only an explicit ordered list of immutable `integrity-candidate-handoff@1` artifacts whose authorization records independently bind candidate, repository, base revision, candidate hash, scope hash, and evidence hash.

Process at most `--max-turns` supplied handoffs, one candidate at a time:

1. Revalidate the handoff against current repository and candidate state.
2. Stop on stale revision, changed hash, broadened scope, missing authorization, unresolved human decision, dirty overlap, or unavailable verification.
3. Return the handoff to `production-flywheel`; never execute its tasks here.
4. Accept only an opaque Flywheel receipt followed by fresh independent-verification evidence.
5. Update the ledger before considering the next separately authorized handoff.

`--max-turns max` changes only the bound on already-authorized handoffs. It does not authorize a ledger, all executable candidates, adjacent findings, or new scope.

Legacy invocations that provide only `--auto`, a ledger, or a generated report return:

```json
{
  "status": "redirect-required",
  "code": "AUTO_REQUIRES_EXACT_HANDOFF_AUTHORIZATION",
  "mutation_performed": false,
  "next": "select one candidate and create an integrity-candidate-handoff@1 authorization"
}
```
