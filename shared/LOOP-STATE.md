# Loop state

Canonical **next starting points** after a skill turn completes. Prevents "half-remembered" continuation from chat only.

Record exactly **one** next state when a loop ends.

## Valid states

| State | Meaning | Typical resume command |
| --- | --- | --- |
| `stop` | Done; no implied next work | — |
| `fresh-report` | Re-scan / new architecture or integrity report | `/codebase-integrity-audit-loop` or flywheel Stage 1 |
| `existing-report-candidate-gate` | Report exists; wait for / perform selection | audit Stage 3 or flywheel Stage 2 |
| `selected-queue` | User ordered batch; continue flywheel queue | `/production-flywheel` (resume queue) |
| `follow-up-issue` | Work captured outside loop (issue/ticket) | human prioritizes later |
| `retry-failed-loop` | Same candidate/mission after failure fix | same skill with prior id |
| `rerun-after-context-change` | Dependency or baseline changed | re-baseline then resume |
| `human-decision-wait` | Blocked on HUMAN-DECISIONS category | resume after answer recorded |
| `swarm-mission-complete` | Swarm finished; next mission or stop | `/human-directed-swarm-planner` or stop |
| `shared-understanding` | Grill complete; user chooses delivery | tickets / flywheel / stop |

## Record format

```markdown
## Loop state

**Skill:**
**Closed at:** ISO-8601
**Outcome summary:**
**Artifacts:** paths to report, ledger, PR URLs, CONTEXT/ADR
**Ledger/queue snapshot:** ids + statuses (or path)
**Next state:** <one of Valid states>
**Next command:**
**Do not:** <common mistake to avoid, e.g. auto-select next candidate>
```

## Rules

1. Exactly one `Next state`.
2. No next candidate auto-selected unless auto mode is still active and within `--max-turns`.
3. Artifacts must be paths or URLs — not "in the chat above."
4. If the working tree is intentionally dirty for the next loop, say so under Outcome summary.
5. `stop` means stop — do not "helpfully" start another skill.
