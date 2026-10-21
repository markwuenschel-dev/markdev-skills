# Review lanes

The ten `review-*` skills are domain reviewers. Each one emits a `review-fitness-report/v1.1` (v1 is still accepted; schema: `shared/review-fitness-runtime/schemas/report.schema.json`). This file says which health lane each review dimension feeds, how review workers are dispatched, and how their reports become health **claims**.

A review report never becomes a lane score. Its findings become claims carrying `review_source`, and those claims merge like any other lane claims. The parent then cites them on dimensions under the usual coherence rules ([HEALTH-GRADING.md](HEALTH-GRADING.md#every-dimension-carries-its-own-support)). No review score is substituted for a lane score, folded into `overall_raw`, or used as a cap.

## Current state: hybrid proof (mechanical sub-rules, judged baselines)

Every review dimension has two kinds of rule in the runtime registry:

- **Mechanical sub-rules** (`<domain>.<dimension>.<slice>`). A deterministic analyzer in `shared/review-fitness-runtime/scripts/analyzers/` re-derives the fact from the source at the assessed revision (`bound-fact-v1`). A slice with no input in the target repository is recorded `not-applicable` with a rationale.
- **One judged baseline per dimension** (`<domain>.<dimension>.baseline`). The review subagent judges it; the runtime checks the judgment's signature and its binding to the source (`judged-fact-v1`), but nothing re-derives it. The report lists these rules in `coverage.judged_rules`.

A run on a real repository therefore yields claims, not just limitations. **Judged claims are weaker evidence.** The translator marks each claim with `review_source.proof_basis`: `mechanical` claims put their text in `observation.confirmed`, and `judgment` claims put it in `observation.inferred`.

What the parent does with them:

- Cite judgment claims like any other lane claim, but never as the only support for a level ≥ 3, and never as the `pass` behind a level 4.
- Never let a judgment claim make a surface `strong`, and never name one in `uncontained_critical_failure`.
- Never move a judgment claim's text into `observation.confirmed`.

The verifier enforces all of this ([HEALTH-GRADING.md](HEALTH-GRADING.md#judgment-evidence)). A runtime error such as `EVIDENCE_PROOF_ANALYZER_UNAVAILABLE` or `EVIDENCE_PROOF_SOURCE_MISSING` still fails closed: translate it with `--error-code`, so it contributes a limitation and no claims. Never score a lane higher, or a surface's coverage higher, merely because a review worker ran.

## Dispatch table

Each review dimension has exactly **one owning lane**. A dimension listed against two lanes in a looser reading is owned by the lane named here, and only that lane gets its claims.

| Review skill | Dimension (review id) | Owning health lane |
| --- | --- | --- |
| `review-algorithms` | `correctness-patterns`, `edge-case-handling`, `concurrency-safety` | `correctness-and-integrity` |
| `review-algorithms` | `algorithm-choice`, `complexity-awareness`, `data-structure-selection` | `performance-and-resources` |
| `review-architecture` | `coupling`, `cohesion`, `layering`, `modularity` | `architecture-fitness` |
| `review-architecture` | `api-design` | `contracts-and-integration` |
| `review-architecture` | `naming` | `maintainability-and-ownership` |
| `review-data` | `schema-design` | `contracts-and-integration` |
| `review-data` | `data-integrity`, `data-modeling`, `migration-safety`, `pipeline-quality`, `query-correctness` | `data-and-migrations` |
| `review-testing` | all six | `verification-readiness` |
| `review-reliability` | `ci-cd-maturity`, `container-deploy-hygiene` | `build-and-delivery` |
| `review-reliability` | `observability`, `incident-readiness`, `availability-design` | `build-and-delivery` |
| `review-reliability` | `timeout-retry-hygiene` | `correctness-and-integrity` |
| `review-reliability` | `capacity-planning` | `performance-and-resources` |
| `review-process` | `development-workflow` | `build-and-delivery` |
| `review-process` | `code-review-practices`, `documentation-quality`, `project-organization`, `technical-leadership`, `dependency-management` | `maintainability-and-ownership` |
| `review-process` | `portability` | `platform-compatibility` |
| `review-maintainability` | all five | `maintainability-and-ownership` |
| `review-security` | all six | `security-and-production-safety` |
| `review-performance` | all six | `performance-and-resources` |
| `review-accessibility` | all seven | `platform-compatibility`, else `maintainability-and-ownership` |
| — | — | `numerical-correctness`, `gpu-equivalence`: no review skill; RHA-native evidence only |

Dimension ids come from `shared/review-fitness-runtime/config/domains/<domain>.json` (`dimensions`). If a domain file gains a dimension this table does not list, its claims are dropped with a limitation naming the dimension until the table assigns an owner.

### Why the two judgment rows land where they do

**Operational behavior → `build-and-delivery`.** The `operational-behavior` surface (startup, shutdown, logging, health checks — [COVERAGE-MODEL.md](COVERAGE-MODEL.md#the-default-inventory-is-mandatory)) has no lane of its own. `build-and-delivery` assesses release confidence, the only required lane concerned with the shipped artifact's behavior after it leaves CI. Being required, it is always active, so observability evidence never loses its lane. Its weight (3, non-critical) matches the surface's default weight (3), so an observability gap lowers the mean without tripping `weakest-critical-lane` through a lane that does not define it. `timeout-retry-hygiene` is the exception: a retry or timeout bug is a reachable defect, which is `correctness-and-integrity`'s definition.

**Accessibility → `platform-compatibility`, else `maintainability-and-ownership`.** The twelve lanes are locked in the schema and verifier, so no accessibility lane can be declared. `platform-compatibility`'s level-3 anchor — every supported platform is built and tested — is the closest shape: browsers, viewports, and assistive technologies are supported runtimes. A repository with a frontend surface therefore usually activates `platform-compatibility`. If it is declared not-applicable anyway, accessibility claims fall back to `maintainability-and-ownership`. Both lanes have weight 2 and are non-critical, so accessibility evidence moves the grade without driving a critical-lane cap. Counter-argument: an inaccessible control on a public UI is a user-visible defect, which argues for `correctness-and-integrity` and would let accessibility bind the grade. Change this one row if that is the intended weight.

## When a review worker runs

- Dispatch a review skill when **at least one** of its dimensions has an owning lane that is active (required, or optional and declared `applicable`). Dimensions owned by an inactive lane are dropped, and the drop is a limitation on the worker.
- `review-accessibility` runs only when the inventory shows a frontend surface (rendered UI code under `runtime-code` or `domain-libraries`).
- A review skill with no active owning lane is not dispatched. Record that in the `lane_applicability` rationale of the inactive lane, not as a worker.

## Procedure

1. **Dispatch in parallel, as subagents, in the same wave as the topology evidence workers** ([PARALLEL-ASSESSMENT.md](PARALLEL-ASSESSMENT.md)). Each worker gets the review skill name, the repository root, the assessed revision, the read-only constraint restated in full, and the output path `.project-intelligence/evidence/health/reviews/<domain>-report.json`.
2. **Each worker runs `review-<domain>` against the same assessed revision** and returns the report path. It returns no claims, levels, or scores of its own.
3. **Validate each return.** The report must validate against `review-fitness-report/v1.1` (or v1), and its `repository_revision` must equal the assessed revision. A mismatch discards the report and marks the worker `failed`.
4. **Translate.** For each owning lane the report feeds, run:

   ```bash
   node <skills-root>/repository-health-assessment/assets/review-to-claims.js \
     --report <domain>-report.json --evidence <domain>-evidence.json \
     --lane <health-lane-id> --dimensions <owned-dims,comma-separated> \
     --claim-prefix <LANE>-RV-<DOMAIN> --revision <sha> --out <claims.json>
   ```

   Every claim carries `review_source: {domain, report_sha256, rule_id, dimension, proof_basis}`. `proof_basis` is `judgment` for a rule in the report's `coverage.judged_rules` (or with `model-judgment` proofs), else `mechanical`. Pass `--dimensions` with exactly the dimensions the table above assigns to `--lane`; the translator keeps only those and refuses an unknown dimension. Pass `--evidence` so passing rules become claims (reports carry only failures; without it, passes become limitations). For a fail-closed run that produced no report, use `--error-code <CODE> --domain <domain>` instead of `--report`. A report whose `fitness.status` is `insufficient-evidence`, or that fails to translate, yields zero claims and one limitation string for that lane.
5. **Merge** the kept claims into the island like any lane's claims ([PARALLEL-ASSESSMENT.md](PARALLEL-ASSESSMENT.md#merge)). **One claim per `rule_id` per report.** A rule maps to one dimension, and a dimension to one owning lane, so a finding is never counted in two lanes.
6. **Record the worker** in `evidence_workers[]`: `{worker_id, lane, status, limitations[]}`, where `lane` is the owning lane (one entry per owning lane the report feeds). `status` is `complete` when claims were produced, `partial` for insufficient evidence or a dropped dimension, and `failed`, `blocked`, or `timeout` per the failure table in [PARALLEL-ASSESSMENT.md](PARALLEL-ASSESSMENT.md#worker-failures).

Domain codes for `--claim-prefix`: `ALGO`, `ARCH`, `DATA`, `TEST`, `REL`, `PROC`, `MAINT`, `SEC`, `PERF`, `A11Y`. Lane prefixes are in [PARALLEL-ASSESSMENT.md](PARALLEL-ASSESSMENT.md#claim-id-prefixes). Example: `PERF-RV-ALGO-03`.

## Coverage

A review run does not change a surface's coverage state by itself. Coverage comes from what was inspected. Review claims that cite paths count as inspection evidence for those paths, exactly like topology-worker claims. A review run that yielded only limitations inspected nothing that this skill can credit.
