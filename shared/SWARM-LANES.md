# Swarm lanes

Shared lane protocol for human-directed swarms. Type-specific lane sets live in `skills/human-directed-swarm-planner/SWARM-TYPES.md`; this file owns rules every swarm must obey.

## Classes (never blur)

| Class | May edit production code? | Stops when |
| --- | --- | --- |
| **Repo Audit** | No (report/ledger only) | Scored report + candidate ledger emitted |
| **Execution Swarm** | Only inside human-selected mission scope | Mission definition of done met |

## Roles

- **Captain / integrator (Agent 0):** assigns lanes, merges findings, resolves or escalates conflicts, owns final handoff. Never leaves contradictory lane outputs unmerged.
- **Lane agents:** one concrete output each; no freelancing outside the lane brief.
- **Human:** mission, scope, edit permission, auto mode, and all HUMAN-DECISIONS forks.

## Default Repo Audit lanes

1. Deepening seams (module/interface leverage)
2. Graded integrity (scored quality)
3. Blast radius (connected impact, report-only)
4. Verification readiness (provability of fixes)

Merge: dedupe and score per `shared/REPORT-SCORING.md`. Name blockers per `shared/HUMAN-DECISIONS.md`.

## Lane brief minimum

```markdown
## Lane brief

**Swarm mission:**
**Lane name:**
**Allowed tools/skills:**
**Read-only?** yes/no
**Required output artifact:**
**Non-goals:**
**Report findings to:** captain
```

## Merge protocol

1. Collect lane outputs with evidence (file:line or command output).
2. Deduplicate by root cause / seam / contract (REPORT-SCORING rules).
3. Score merged candidates once from combined evidence.
4. Surface unresolved lane conflicts as human decisions — do not silently pick a side when safety-relevant.
5. Emit one integrated handoff (report, plan, or mission result).

## Failure codes (baseline set)

```text
FAIL-SCOPE-CREEP — work expanded beyond the human-selected mission.
FAIL-FAKE-GREEN — pass claimed while required checks were skipped.
FAIL-CONTRACT-DRIFT — producer and consumer schemas disagree.
FAIL-STALE-PATH — retired path still reachable.
FAIL-WEAK-VALIDATOR — validator accepts invalid fixture.
FAIL-UNVERIFIED-RUNTIME — runtime claim without smoke/playtest proof.
FAIL-MISSING-PROVENANCE — generated artifact lacks source/owner metadata.
FAIL-UNRESOLVED-LANE-CONFLICT — lanes disagree; captain did not resolve.
```

Swarms may add mission-specific codes; they may not remove the baseline meanings.

## Relationship to flywheel

- **Swarm:** one mission (possibly many parallel surfaces), one integrated result.
- **Flywheel:** ordered **queue** of separate items, each its own design gate and PR.

Do not run a multi-item delivery queue as a single execution swarm unless the human explicitly selected a **production implementation** milestone swarm for one milestone.
