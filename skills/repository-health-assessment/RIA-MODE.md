# RIA mode

Read this when the skill is invoked **with an RIA envelope** — the JSON file `repository-improvement-assessment` writes at `owner_rendezvous.envelopes["health"]` during its owner rendezvous. No envelope means standalone mode, and this file does not apply.

In RIA mode this skill is the Health **owner**: RIA orchestrates and binds evidence; this skill still owns the health grade, coverage, caps, confidence, and health candidates. Every step of [SKILL.md](SKILL.md) runs as written except where this file says otherwise.

`RUNTIME-CONTRACT.json` (`input_profiles.ria`) is the parent-facing summary RIA reads instead of this whole skill.

## The envelope

RIA builds one closed envelope per owner (`repository-improvement-assessment/scripts/ria.js`, `ownerEnvelope`):

```json
{
  "baseline_ref": {},
  "engineering_intelligence_ref": {},
  "sei_assessment_ref": {},
  "verification_baseline_ref": {},
  "presentation_policy": "inherit",
  "candidate_namespace": "health"
}
```

| Field | Required | Handling |
| --- | :---: | --- |
| `baseline_ref` | yes | The shared baseline. Its repository revision is the assessed revision. |
| `engineering_intelligence_ref` | yes | Closed, hash-verified, baseline-bound evidence. It may inform claims; it never sets, caps, or replaces the health grade. |
| `sei_assessment_ref` | no | Consume read-only only after its schema, digest, snapshot, and baseline-revision binding verify. Echo it in the return. It never sets, caps, or replaces the health grade. |
| `verification_baseline_ref` | yes, for Health | The commands RIA already ran in its isolated worktree. See [Verification](#verification). |
| `presentation_policy` | yes | Always the **string** `"inherit"`. Any other value, including an object, is a malformed envelope. |
| `candidate_namespace` | no | The id namespace RIA assigns this owner; for Health it is always the string `"health"`. When present, prefix every `candidate_id` this run mints with `health:` (for example `health:CONTRACT-007`). Any other value is a malformed envelope: `write-health-artifact.js` echoes the envelope as the return's `input_binding_echo`, and `shared/ria-owner-return` rejects a namespace that is not Health's. |

Fail closed — stop and return the typed blocker instead of assessing — when:

- any field outside this table is present, or a required field is missing;
- `verification_baseline_ref` resolves to anything other than `assessment-verification-baseline@3` — `@2` is rejected;
- the baseline's semantic-content hash or serialized-file hash does not re-hash to the referenced value;
- the revisions bound by `baseline_ref`, `verification_baseline_ref`, and `engineering_intelligence_ref` disagree with each other or with the assessed revision.

`write-health-artifact.js --ria-envelope` re-checks the hash and revision bindings when writing the return; checking first only saves a wasted run.

### Reading and citing SEI evidence (composite-scoring-v3 §5.3)

Read SEI evidence through the one reader RIA names in its rendezvous (`contract.sei.reader`): `require("<skills>/repository-improvement-assessment/engineering-intelligence-reader.js").readSeiEvidence({ repository_root, envelope })` returns `{ snapshot, assessment, assessment_status }`, with the snapshot and the scored criterion assessment both hash-verified and cross-bound to the envelope. `assessment_status: "missing"` means no `sei_assessment_ref` was bound; any thrown `FAIL-SEI-*` / `FAIL-ENGINEERING-INTELLIGENCE-*` error is a typed blocker, never missing evidence. To cite one SEI metric, add `{ "kind": "sei-criterion", "criterion_id": "<criteria[].criterion_id>", "metric_id": "<an observation_id or source_metric_ids entry of that criterion>" }`. Cite only what is in `assessment.criteria` of the bound bytes, not the rubric; the writer rejects anything else (`FAIL-SEI-CITATION-INVALID`) and RIA re-checks it (`FAIL-RIA-SEI-CITATION`). SEI citations are adopted evidence: a contribution whose consumed evidence is at least half SEI citations counts as dependent on SEI in RIA's composite v2, not as an independent measurement. In a Health claim the citation is one entry of `claims[].evidence[]`.

## What changes from standalone mode

| Step | Standalone | RIA mode |
| --- | --- | --- |
| 1. Frame | Establish it | Adopt the revision bound in `baseline_ref`. Still record your own HEAD and clean-tree observation in `freshness_evidence`; if HEAD has moved, the run is `stale` — evidence-backed, never asserted from the hand-off. |
| 2. Inventory | Build it | Build it. Coverage state and evidence quality are always this run's own, from what this run inspected. |
| 3. Lanes | Topology workers + review workers | Same. Submit `health:*` packets into RIA's root pool or a sub-budget it supplies ([PERFORMANCE.md](PERFORMANCE.md#ria-nesting)). |
| 4. Baseline | Approve, isolate, run | Adopt RIA's commands — [Verification](#verification). |
| 6. Candidate ledger | Unprefixed `candidate_id`s | With `candidate_namespace`, every newly minted `candidate_id` is `<candidate_namespace>:<local>` (`health:<local>`), so RIA can tell Health's ids from Integrity's and Architecture's. A candidate carried over from a `previous` health run keeps the id it already has: continuity matches ids exactly. |
| 7–7a. Artifact, sidecar | Write both | Write both, then return — [Returning](#returning). |
| 8. Report election | Ask / generate / skip | **Skipped.** RIA is the report owner and holds the single election. Do not ask, do not render. |
| 9. Handoff packets | Architecture packet, ledger rows | **Skipped.** RIA reconciles the three owners; the candidate ledger travels inside the health artifact. |

## Verification

RIA runs `verification_contract.commands` once, in its own `worktree` or `copy` isolation, and hands the result over as `verification_baseline_ref`. That is the single adoption procedure:

1. Resolve and validate the immutable `assessment-verification-baseline@3` artifact, re-hashing both its semantic-content and serialized-file hashes.
2. **Adopt every entry of `health_verification.commands` verbatim into `verification.commands`.** From `@3` the artifact carries that array already in this skill's shape — `{command_id, kind, command, result}` — with exit code and elapsed time, so there is nothing to translate. Never a subset: dropping a failing command can only raise the grade ceiling.
3. Do not re-derive commands from the artifact's top-level `commands[]`. That array uses RIA's vocabulary (`status`, `exit_code`), and hand translation is how a failed gate once reached a health island as no gate at all.
4. An entry with `kind_inferred: true` had its `kind` derived from the command string. Treat an inferred `other` as unclassified, not as proof that no test ran.
5. Record the isolation mode the baseline declares.
6. **Derive `verification.baseline` yourself** from the adopted commands by this skill's rules ([HEALTH-GRADING.md](HEALTH-GRADING.md#the-verification-baseline-is-derived-not-declared)). The artifact's `trust.state` answers a different question — did every declared command pass? — and can legitimately differ: all-passing commands with no `test` command are `trust.state: trustworthy` there and `partial / no-test-command` here. Use `trust.state` only as a floor: if it is `untrustworthy`, your baseline must not come out better than `untrustworthy` or `partial`.

Do **not** rerun the full repository suite to obtain an independent Health copy. Run only targeted additional commands that a Health-specific gap, contradiction, anomaly, security-critical uncertainty, or explicit independent-reproduction policy requires — with approval and isolation per Hard stop 2 — and record each separately.

## Review lanes under RIA

`review-testing` no longer replaces the `verification-readiness` lane, and RIA no longer substitutes a testing-fitness score into its composite. Like every other `review-*` skill, it runs as a lane-mapped review worker and its report enters the island as `verification-readiness` claims through `assets/review-to-claims.js` ([REVIEW-LANES.md](REVIEW-LANES.md)). `--testing-fitness` is deprecated.

## Returning

The sidecar must exist before the single writer call that produces the owner return, so in RIA mode run step 7a against the island the writer will persist (the sidecar writer verifies the island itself), then write the artifact and the return in one call:

```bash
node <skill>/assets/write-evidence-recon-sidecar.js --island <island.json> --repo <repository-root>
node <skill>/assets/write-health-artifact.js --input <island.json> --repo <repository-root> \
  --ria-envelope <owner_rendezvous.envelopes.health> \
  --return-out <owner_rendezvous.return_paths.health> \
  --evidence-recon <sidecar.json>
```

- The writer returns `ria.owner-return@1`, echoing the supplied bindings with the health artifact reference. The health artifact itself stays schema-pure — no orchestration fields.
- **`--return-out` is mandatory here.** Without it the return goes to stdout, the file RIA waits for is never created, and the run is indistinguishable from an owner that never ran. The writer refuses to overwrite an existing return file.
- `--evidence-recon` attaches the sidecar as a hash-bound `specialist_refs` entry of kind `evidence-recon` — the sidecar's RIA consumer.
- Output paths must sit under `RIA_RUNTIME_ROOT` or `<repository-root>/.project-intelligence/`.

Then stop. RIA resumes with `lifecycle: "continue"`.
