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

Use `writeVerificationBaselineForRepository()` for normal project runs. It writes immutable `assessment-verification-baseline@2` artifacts under `<repo>/.project-intelligence/verification/assessment-baseline/<revision>/` through `shared/project-intelligence-workspace`. The artifact owns a semantic `content_sha256`; the writer receipt separately records the exact serialized `file_sha256`. Reuse validates both values. Explicit output paths remain available for tests and controlled integrations.

Isolation vocabulary is shared across consumers: `worktree`, `copy`, `container`, `read-only-source`, `caller-attested`, or `none`. Historical aliases such as `isolated-worktree` and `container-copy` are not accepted by the v2 writer.
