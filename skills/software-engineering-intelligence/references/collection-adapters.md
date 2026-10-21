# Collection policy and typed adapters

Read this reference only when configuring temporal co-change evidence or supplying already-normalized local adapter evidence. The canonical measurement, collector, and snapshot contracts remain model-opaque in `shared/software-engineering-intelligence`.

## Closed local configuration

The direct runner accepts these two optional closed configuration records in addition to the ordinary repository collection fields:

```json
{
  "temporal_coupling_policy": {
    "policy_id": "temporal-coupling-mass-change-v1",
    "policy_version": "1.0.0",
    "threshold": 32,
    "cap": 16,
    "action": "exclude"
  },
  "adapter_evidence": {
    "adapters": []
  }
}
```

`temporal_coupling_policy` has exactly the five shown fields. The collector validates the safe bound, rejects unsupported values, and writes its deterministic receipt into the temporal-coupling risk result. Mass changes retain file-frequency evidence even when pair generation is excluded or down-weighted; the receipt records the policy identity, hash, counts, action, and reason. `retain` does not authorize unbounded pair enumeration.

`adapter_evidence` has exactly one field, `adapters`. Each array entry is a normalized typed envelope—not a URL, provider instruction, or fetch request. The runner does no network access or provider discovery. It gives the envelope the resolved repository revision, primary collector configuration hash, and exact history boundary; M4 then independently validates its adapter identity/version, payload digest, revision/configuration/window binding, completeness, and coverage.

For local verification evidence, `verification_artifacts` is the separate, closed V2 input. It has `artifacts`, `completeness`, and `coverage`; each artifact is `{ "format": "junit-xml" | "lcov", "path": "..." }`, resolved relative to the configuration file. The runner reads only those explicit local files, parses JUnit XML test outcomes and LCOV statement/branch counters, and immediately converts them into the same typed `verification-summary` envelope. It stores only content-digest evidence references in the snapshot, never an artifact path. Unsupported formats, malformed artifacts, missing counters, or a non-current history window fail before output; the parser does not infer provider identity, test quality, retries, flakiness, or pipeline behavior.

## Autonomous revision-bound verification discovery

Every current-revision run performs bounded local discovery and a separate autonomous verification probe. Discovery lists paths and reads allowlisted blobs from the resolved Git revision with `git ls-tree` and `git cat-file`; mutable working-tree bytes, network services, CI APIs, package managers, and repository-defined scripts remain outside the boundary. Discovery recognizes conventional CI workflow files, explicit package/Python/Maven/Gradle test configuration and test-source paths, explicit coverage configuration, and at most 32 conventional committed JUnit XML/LCOV results. The path listing is capped at 100,000 entries, configuration inspection at 512 blobs, individual inspected blobs at 2 MiB, and serialized evidence paths at 256 while the metric retains the full discovered count.

## Autonomous revision-bound local verification

The probe first snapshots the source working tree with `git status --porcelain=v2 --untracked-files=all` (paths under the SEI output root are excluded; git-ignored files are not visible to this check). It then performs the bounded source/configuration scan directly from the immutable repository-index blobs of the resolved revision, before any test executes, so a test cannot alter what the scan reads. The scan is capped at 512 files and 32 MiB, and a blob over 2 MiB is never requested. It records structural failure-handling, observability, operational/recovery, manifest-lock, configuration-documentation, and high-confidence secret-pattern facts, and reports its own coverage: `coverage` is files actually analyzed over qualifying candidates, `complete` is true only when every candidate was read, and oversize, over-budget, unreadable, and path-escaping candidates are counted as `skipped_oversize`, `skipped_budget`, `unreadable`, and `escaped`. Only files actually read appear in `scan.paths`.

For test execution the runner archives the exact resolved revision into an ephemeral sandbox created under the OS temporary directory (`os.tmpdir()`), never inside the repository or its output workspace, and removes it once the probe settles. It selects at most four deterministic SEI-focused JavaScript test files (excluding analyzer, benchmark, and fixture suites) and runs one fixed command under Node's permission model: `node --permission --allow-fs-read=<sandbox> --allow-fs-write=<sandbox> --test --test-isolation=none --test-reporter=tap <files>`. No child-process permission is granted, so tests cannot spawn processes, and filesystem access outside the sandbox is denied. The child gets an allowlisted environment (only `PATH`, `SystemRoot`, and `windir` are inherited) with `HOME`/`USERPROFILE`/`TMP`/`TEMP` pointed inside the sandbox, `GIT_CEILING_DIRECTORIES` set to the sandbox, and `GIT_CONFIG_NOSYSTEM=1`. If the Node runtime cannot provide that containment, the Node tests are withheld and recorded as unavailable with reason `containment-unavailable`. Python tests are never executed, because pytest cannot be confined to the sandbox; when Python tests are the only candidates they are recorded as unavailable with reason `containment-unavailable`. The runner never evaluates `package.json` scripts, repository hooks, shell command strings, installs, network services, or mutable working-tree bytes. The command is bounded by a 60-second timeout and an output cap, and cancellation fails closed. After the sandbox is removed, the probe takes the git status snapshot again; if it differs, the probe fails with `FAIL-SEI-SOURCE-MUTATED` before writing its execution artifact. This is a second line of defence behind the sandbox, not a substitute for it.

The resulting TAP counts, structural facts, duration, command, exact revision, and content-addressed execution artifact are written under `execution-evidence/` and projected into canonical observations. A bounded selection is marked partial; a timeout, unsupported runtime, withheld (`containment-unavailable`) command, or missing test command remains unavailable, so CI/test configuration can remain CONFIGURED with results UNOBSERVED. Structural facts are explicitly inferred and bounded: they can describe repository code/configuration surfaces, but do not claim CI health, vulnerability absence, deployment success, review latency, recovery exercises, or human outcomes.

The structured collector mapping is stable: `ci-discovery`, `test-discovery`, and `coverage-discovery` use `available` for **OBSERVED** supported committed results, `degraded` for **CONFIGURED** configuration with execution/results unobserved, and `unavailable` for **UNAVAILABLE** evidence. Reasons explain exclusions or bounds but are not the state carrier. Workflow surfaces are lexical evidence only; full-line comments are removed before matching, and a configured surface is never reported as current health.

Conventional committed JUnit XML and LCOV are normalized through the existing typed `verification-summary` path with revision-bound blob bytes. Because repository-wide completeness and coverage cannot be established autonomously, the normalized measurements are degraded with zero completeness and confidence even when their observed numeric facts are retained. An explicit normalized `verification-summary` or `verification_artifacts` declaration takes precedence and is never duplicated or weakened by discovered results. Malformed, oversized, or over-count result candidates remain unobserved within the affected discovery capability and do not abort unrelated repository collection.

SARIF/static-analysis, dependency, and mutation-testing discovery are deliberately outside this slice. They remain Wave 2 work and must not be listed as observed or configured until a separate bounded parser, normalization contract, and public tests exist.

The typed families are dependency topology, verification summary, feedback timing, optional PR flow, generic deployment events, and the package-private `assessment-evidence` family. They produce only their declared facts. A generic deployment event is not DORA evidence, and PR/merge facts are not deployment, health, candidate, or lifecycle evidence.

`assessment-evidence` is the narrow trusted-integration bridge for evidence that the repository cannot derive locally (for example, an authoritative security scan, recovery exercise, operational-readiness check, or developer-feedback sample). It is still a closed, content-addressed envelope; it is not a free-form score injection. Its payload is:

The normal runner does not require this envelope for repository-bound facts. It automatically projects accepted committed configurations and result artifacts into revision-bound assessment observations first; this adapter is supplemental and is only needed for genuinely external evidence.

```json
{
  "adapter_id": "assessment-evidence",
  "kind": "assessment_evidence",
  "format": "assessment-evidence-v1",
  "adapter_version": "1.0.0",
  "artifact_ref": "file:security-and-operations.json",
  "artifact_sha256": "sha256:<canonical-payload-digest>",
  "repository_revision": "<current-full-revision>",
  "configuration_hash": "<current-configuration-hash>",
  "history_window": { "kind": "revision", "start": null, "end": "<current-full-revision>" },
  "completeness": { "state": "complete", "fraction": 1 },
  "coverage": { "scope": "repository", "fraction": 1 },
  "payload": {
    "facts": [
      { "metric_id": "assessment.security.verification", "value": true, "evidence_refs": ["artifact:scan-2026-08-15"] },
      { "metric_id": "assessment.reliability.recovery_evidence", "value": true, "evidence_refs": ["artifact:game-day-42"] }
    ]
  }
}
```

Only the declared assessment metric IDs are accepted; unknown facts, duplicate facts, foreign revisions/configurations, bad hashes, partial artifact bindings, and unsupported formats fail closed. The assessment layer maps these raw facts into stable semantic observation IDs and keeps the artifact references in the sidecar. A 90% criterion gate is therefore earned by bound evidence, not by lowering thresholds or by treating missing external evidence as a score.

## Missing, partial, and historical evidence

With a current-revision boundary, omitted adapters produce declared unavailable M4 collector/measurement slots rather than zeros. A partial supported envelope remains a degraded measured subset and unavailable remainder. Malformed, duplicate, foreign, or digest-mismatched typed envelopes become degraded/unverifiable only for their identifiable adapter family. Unsupported formats remain unavailable. None of these states is repaired by a fallback guess.

An adapter envelope is valid only when its history-window end is the resolved repository revision. For a non-current historical boundary, direct CLI collection does not rebind or reinterpret adapter evidence; omitted evidence remains unavailable and a supplied adapter configuration fails before an output artifact is written. Supply an exact current-revision run or a separately materialized canonical snapshot instead.

Do not attach arbitrary `artifact_ref` values to a profile, risk model, or policy result. The normalized metric remains the authority for evidence references, collector identity, revision, and configuration binding.
