# Human decisions

Canonical taxonomy of **human-decision categories** for this skill family.

Used by:

- `shared/REPORT-SCORING.md` (`human_decision_risk`, `blocked_by`, Human-decision blockers section)
- auto modes in `codebase-integrity-audit-loop` and `human-directed-swarm-planner`
- any execute path that must pause instead of guessing

When the external skill `connected-impact-sweep` is installed (see `DEPENDENCIES.md`), treat its human-decision section as a **superset expansion** of this file for edit-coherence details — but **do not fork category names** here without updating scoring consumers.

## Categories (auto mode must stop)

Any of these hit mid-loop → stop auto mode, surface the fork, wait for the human:

1. **Public / external contract** — public API, CLI flag, event schema, HTTP contract, or anything external consumers depend on.
2. **Migration / default / backfill** — data migration, default value change, backfill strategy, dual-write/read cutover.
3. **Deletion of reachable code** — removing paths still reachable from an entrypoint, config, or docs.
4. **Numerical correctness** — tolerances, floating-point contracts, quant/ML thresholds, deterministic seeds.
5. **GPU / CPU equivalence** — kernel parity, device-specific behavior, precision differences.
6. **Security or production safety** — authz, secrets, PII, safety routing, destructive ops in prod-like paths.
7. **Escalation / safety-routing ambiguity** — unclear whether to page, block, or auto-remediate.
8. **Policy / SME judgment** — product policy, legal, compliance, or specialist domain call.
9. **Architecture direction** — hard-to-reverse structural choice (store, boundary ownership, multi-tenant model).

## Edit-coherence rules (summary)

When executing changes that touch contracts or shared surfaces:

- Distinguish **passthrough consumers** (must stay compatible) from **value-branching logic** (may need intentional updates).
- Golden files and fixtures change only with explicit behavior-change intent.
- Prefer reachability beyond static imports (config, reflection, string paths, generated code).
- Hand-maintained mirrors and runtime prose / RAG corpus count as contract surface.
- Staged edits are not completed edits — verification runs on the integrated result.

## Scoring linkage

- `human_decision_risk` 1–5 reflects how likely the fix requires one of the categories above.
- `human_decision_risk ≥ 4` **or** non-empty `blocked_by` ⇒ `execution_mode: blocked-needs-human-decision` ⇔ ledger `status: needs-human-decision`.
- Name each blocker with a category from this file (or a clearly scoped sub-label under one).

## Agent output when blocked

```markdown
## Human decision required

**Category:**
**Question:**
**Recommended answer:**
**If deferred:** impact on queue/ledger
**Blocked candidates / missions:**
```
