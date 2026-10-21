# Shared Assessment Verification Baseline

One independent verification execution can be consumed by multiple assessment owners without transferring their analytical authority.

## Contract

- The baseline is immutable, content-addressed, revision-bound, and isolated from source mutation.
- RIA starts verification as soon as the baseline revision is resolved; it runs concurrently with Software Engineering Intelligence.
- Repository Health and Integrity consume the same verified artifact. They do not unconditionally rerun the whole suite.
- Targeted re-verification is allowed when an owner identifies a distinct command, conflict, anomaly, or high-risk uncertainty.
- A second full verification pass is conditional on contradictory evidence, an anomalous receipt, or explicit independent-reproduction policy.
- The artifact records commands and evidence. It does not interpret health, integrity, architecture, or completion.


## Storage

Use `writeVerificationBaselineForRepository()` for normal project runs. It writes immutable `assessment-verification-baseline@3` artifacts under `<repo>/.project-intelligence/verification/assessment-baseline/<revision>/` through `shared/project-intelligence-workspace`. The artifact owns a semantic `content_sha256`; the writer receipt separately records the exact serialized `file_sha256`. Reuse validates both values. Explicit output paths remain available for tests and controlled integrations.

`@2` remains readable so artifacts written before `trust` existed still verify, but it is never written and is not reusable as a verification baseline — a `@2` artifact carries no verdict, and reusing one would reinstate the state this field exists to remove.

### `trust` — the verdict, not the receipt

`summary` counts command outcomes. It was written on every run and read by nobody, so a baseline whose only command failed was byte-indistinguishable from one that passed, and a task that ran a failing gate still reported `completed`. `@3` states the conclusion:

| `trust.state` | when |
|---|---|
| `trustworthy` | every command passed |
| `partial` | nothing failed, but something was skipped or unavailable |
| `untrustworthy` | a command failed or timed out |
| `not-run` | no commands were declared |

Consumers refuse on `trust.state`, never on the artifact's mere existence.

### `health_verification` — the seam, machine-produced

`repository-health-assessment` derives its baseline from commands shaped `{command_id, kind, command, result}`; this module records `{id, status, exit_code}`. Nothing in code translated between them, so an agent was instructed to copy receipts across by hand — and omitting that copy yielded `not-run`, a *softer* verdict than reporting the failure. `health_verification.commands` is that array, already translated, to be adopted verbatim.

Each command also carries `kind` and `kind_inferred`. A caller may declare `kind`; otherwise it is derived from the command string and `kind_inferred` is `true`. An unrecognised command derives `other`, never `test`, because a wrong `test` tightens Health's grade cap on evidence that does not exist.

`isolation.overlay` records the uncommitted changes layered over a detached checkout when the baseline scope was `worktree`.

Isolation vocabulary is shared across consumers: `worktree`, `copy`, `container`, `read-only-source`, `caller-attested`, or `none`. Historical aliases such as `isolated-worktree` and `container-copy` are not accepted by the v2 writer.
