# Baseline and reuse contract

RIA v0.8 builds and validates one closed `ria.baseline@1` artifact before assessment work becomes READY. `baseline.js`, `baseline.schema.json`, `scripts/build-baseline.js`, and `scripts/verify-baseline.js` are the canonical implementation.

## Identity

The baseline binds:

- one or more canonical repository roots;
- the Git revision and tree per root, or a content-addressed tree identity in explicitly degraded non-Git mode;
- the working-tree fingerprint per root;
- generated/protected paths with `exact-existing`, `allowed-absent-generated`, or `pattern` semantics;
- command authorization as exactly `granted`, `denied`, or `inherited`;
- the verification contract;
- the centralized SEI compatibility binding;
- history, toolchain, and provenance inputs.

Its semantic `content_sha256` derives from the closed canonical body. The writer separately reports the exact `file_sha256`; consumers must not conflate semantic and byte identities.

`startup_mode` describes SEI baseline reuse; `owner_artifact_hits` describes independent per-owner reuse. Report them separately because a fresh SEI decision can coexist with exact reusable Health, Integrity, or Architecture artifacts.

## Reuse and invalidation

Reuse is per component: SEI, verification, Health, Integrity, and Architecture accept `auto`, `rerun`, or `require-reuse`. The execution plan binds every reusable task to a deterministic cache key. A `rerun` node and every graph descendant are invalidated; siblings remain eligible for exact reuse. A cache hit becomes scheduler-terminal `reused` and immediately satisfies its dependency edge.

Git-backed `head` mode may use exact or compatible-ancestor SEI lineage. Git `worktree` and non-Git `content-addressed-degraded` modes may use only exact content-identity reuse and set `ancestor_reuse_allowed` to false. A non-Git run must be reported as degraded even when all canonical owner artifacts are available.

## Ownership

RIA owns the parent baseline and graph reuse decision. Source owners may reject insufficient evidence, but RIA may not repair their artifacts by translating prose into grades, scores, or architecture judgment.
