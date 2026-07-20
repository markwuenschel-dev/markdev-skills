# Functional tests

Lightweight checks that the **repo inventory** is coherent. Run after structural changes.

## File inventory

| # | Check | Pass criteria |
| --- | --- | --- |
| F1 | Inventoried skill folders exist | `skills/{loop-router,expanded-grill-with-docs,codebase-integrity-audit-loop,human-directed-swarm-planner,production-flywheel,improve-codebase-architecture,prompt-forge}/SKILL.md` |
| F2 | Shared contracts exist | all six files under `shared/` listed in README |
| F3 | CAPABILITY-MAP table | needs map to all inventoried skills (including ICA + prompt-forge); matches `skills/*/SKILL.md` |
| F4 | DEPENDENCIES present | file exists; pins true externals; ICA listed as in-repo |
| F5 | Install script present | `scripts/install-skills.sh` / `.ps1` discover all `skills/*/SKILL.md` |

## Reference integrity

| # | Check | Pass criteria |
| --- | --- | --- |
| F6 | Scoring links | audit-loop and ICA link to `../../shared/REPORT-SCORING.md` |
| F7 | Flywheel branch files | `skills/production-flywheel/branches/{design,prototype,triage}.md` exist |
| F8 | Swarm types | `SWARM-TYPES.md` present beside swarm SKILL.md |
| F9 | Flat packaging | every skill dir has root `SKILL.md`; no accidental `skills/<name>/<name>/` nesting |

## Semantic smoke (agent)

| # | Prompt | Expected observable |
| --- | --- | --- |
| F10 | "Unsure which skill — shape an idea vs audit" | Router recommends grill vs audit with reasons |
| F11 | "Run integrity audit, no code yet" | Report + ledger path; no production edits |
| F12 | "Ship items 1 and 3 from the ledger" | Flywheel queue of two; design-lane gate before code |
| F13 | "Swarm a known migration mission" | Swarm plan with lanes, non-goals, captain |
| F14 | "Write a system prompt for our support agent" | Routes to `prompt-forge`; deliverable is a prompt |
| F15 | "Find deepening opportunities in this repo" | Routes to `improve-codebase-architecture`; HTML report path |

## Shell checklist

```bash
# from repo root
test -f CAPABILITY-MAP.md
test -f DEPENDENCIES.md
test -f shared/REPORT-SCORING.md
test -f shared/HUMAN-DECISIONS.md
test -f shared/REQUIREMENTS-LEDGER.md
test -f shared/ROLLOUT-CONTRACT.md
test -f shared/SWARM-LANES.md
test -f shared/LOOP-STATE.md
test -f skills/loop-router/SKILL.md
test -f skills/expanded-grill-with-docs/SKILL.md
test -f skills/codebase-integrity-audit-loop/SKILL.md
test -f skills/human-directed-swarm-planner/SKILL.md
test -f skills/production-flywheel/SKILL.md
test -f skills/improve-codebase-architecture/SKILL.md
test -f skills/prompt-forge/SKILL.md
test -f scripts/install-skills.sh
test -f scripts/install-skills.ps1

# flat packaging — no skills/<name>/<name>/SKILL.md
# (PowerShell)
# Get-ChildItem skills -Directory | ForEach-Object {
#   $nested = Join-Path $_.FullName $_.Name
#   if (Test-Path (Join-Path $nested 'SKILL.md')) { throw "nested: $nested" }
# }
```

Mark the session PASS only if F1–F9 hold and shell checklist is green.
