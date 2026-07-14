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
| B6 | Flywheel design-lane gate | Present A = full expanded grill as default | Model elects shortcut B alone |
| B7 | Candidate too big for one slice | Recommend wayfinder; user elects | Model charts map without election |
| B8 | Multi-item delivery | production-flywheel queue | Single "do all items" execution swarm without human framing |

## Shared contract walls

| # | Scenario | Must happen |
| --- | --- | --- |
| B9 | New score dimension proposed | Change only via `shared/REPORT-SCORING.md` + skill pointer update |
| B10 | Auto mode hits public API change | Stop per `shared/HUMAN-DECISIONS.md` |
| B11 | Loop ends | Record exactly one state from `shared/LOOP-STATE.md` |
| B12 | External skill missing | Use DEPENDENCIES.md + shared fallbacks; do not vendor tree into repo |

## Inventory walls

| # | Scenario | Must **not** happen |
| --- | --- | --- |
| B13 | "Add superpowers and all review-* skills" | Hundreds of skills copied into `skills/` |
| B14 | Sixth top-level skill without CAPABILITY-MAP update | Skill added without map + tests + DEPENDENCIES if needed |

## How to run

Agent or human walks each scenario against the skill text. FAIL if a skill's SKILL.md instructs the forbidden behavior.
