# Boundary tests

Pass/fail cases for **scope walls** between top-level skills and shared contracts.

## Cross-skill walls

| # | Scenario | Must happen | Must **not** happen |
| --- | --- | --- | --- |
| B1 | Grill session reaches shared understanding | Ask user before coding | Start implementing in expanded-grill-with-docs |
| B2 | Audit produces ledger | Stop at candidate gate (manual) | Edit production code before selection |
| B3 | `--parallel-report` finishes | Stop at candidate gate | Co-passed `--auto` executes candidates same invocation |
| B4 | Swarm mission discovers adjacent bug | Report as finding / next mission | Expand mission scope silently |
| B5 | Flywheel batch selected | Auto-advance queue after each PR | Merge PRs; stop after each PR to re-ask "continue?" |
| B6 | Flywheel design-lane gate | Present A = full `/grill-with-docs` as default | Model elects shortcut B alone |
| B7 | Candidate too big for one slice | Recommend wayfinder; user elects | Model charts map without election |
| B8 | Multi-item delivery | production-flywheel queue | Single "do all items" execution swarm without human framing |
| B9 | ICA HTML report ready | Ask user which candidate(s) by number | Start implementing deepenings from the report |
| B10 | Prompt-forge deliverable ready | Hand back the prompt | Perform the underlying task unless separately asked |
| B11 | Landing request without explicit merge/deploy authority | Stop after proposing the queue | Merge or deploy merely because a PR is ready |

## Shared contract walls

| # | Scenario | Must happen |
| --- | --- | --- |
| B12 | New score dimension proposed | Change only via `shared/REPORT-SCORING.md` + skill pointer update |
| B13 | Auto mode hits public API change | Stop per `shared/HUMAN-DECISIONS.md` |
| B14 | Loop ends | Record exactly one state from `shared/LOOP-STATE.md` |
| B15 | External companion missing | Use DEPENDENCIES.md + shared fallbacks; do not dump unrelated trees into repo |

## Inventory walls

| # | Scenario | Must **not** happen |
| --- | --- | --- |
| B16 | "Add superpowers and all review-* skills" | Hundreds of skills copied into `skills/` without ownership intent |
| B17 | New skill folder without inventory update | Skill added without CAPABILITY-MAP row + install discovery + trigger/functional tests (+ DEPENDENCIES if still external) |

## How to run

Agent or human walks each scenario against the skill text. FAIL if a skill's SKILL.md instructs the forbidden behavior.
