# markdev-skills

Canonical inventory of **five top-level agent skills** and the **shared contracts** they share.

This is not a dump of every skill ever installed on a machine. It is a single private place to remember:

- what each top-level skill is for
- where one ends and another begins
- which rubrics and ledgers they all obey
- which external skills are optional dependencies (not vendored)

## Layout

```text
markdev-skills/
├── README.md
├── CAPABILITY-MAP.md          ← start here (memory / routing)
├── DEPENDENCIES.md            ← external skills, pinned by source
│
├── skills/
│   ├── loop-router/
│   ├── expanded-grill-with-docs/
│   ├── codebase-integrity-audit-loop/
│   ├── human-directed-swarm-planner/
│   └── production-flywheel/
│
├── shared/                    ← Jeff-style rubrics & contracts
│   ├── REPORT-SCORING.md
│   ├── REQUIREMENTS-LEDGER.md
│   ├── ROLLOUT-CONTRACT.md
│   ├── SWARM-LANES.md
│   ├── HUMAN-DECISIONS.md
│   └── LOOP-STATE.md
│
├── tests/
│   ├── trigger-tests.md
│   ├── boundary-tests.md
│   └── functional-tests.md
│
└── scripts/
    └── install-skills.sh
```

**Matt-style:** each skill is a composable folder with its own `SKILL.md` (and optional companions).  
**Jeff-style:** scoring, human decisions, ledgers, and loop state live under `shared/` once.

## Capability map (summary)

| Need | Top-level skill |
| --- | --- |
| Shape an idea | `expanded-grill-with-docs` |
| Audit repo health | `codebase-integrity-audit-loop` |
| Parallelize a known mission | `human-directed-swarm-planner` |
| Deliver approved work | `production-flywheel` |
| Unsure which applies | `loop-router` |

Full routing, handoffs, and non-goals: **[CAPABILITY-MAP.md](CAPABILITY-MAP.md)**.

## Install

```bash
# from this repo root (Git Bash / macOS / Linux)
./scripts/install-skills.sh

# optional: custom destination (default: ~/.agents/skills)
./scripts/install-skills.sh --dest "$HOME/.agents/skills"

# also install shared/ next to skills for offline agent paths
./scripts/install-skills.sh --with-shared
```

```powershell
# Windows PowerShell
.\scripts\install-skills.ps1
.\scripts\install-skills.ps1 -Dest "$HOME\.agents\skills" -WithShared
```

The installer **symlinks** (or copies when symlinks fail) only the five top-level skill folders into the agent skills directory. Shared contracts stay in this repo; skills reference them via relative paths when run from a checkout, or via the installed tree when you pass `--with-shared` / `-WithShared`.

## Rules of the road

1. **Do not vendor hundreds of external skills** into this repo.
2. **Record external dependencies** in `DEPENDENCIES.md` (repo, path, version/commit).
3. **Change scoring and human-decision taxonomies only in `shared/`**, then update skill references if needed.
4. Keep the repo **private** until the inventory stabilizes; messy iteration is the point.

## Visibility

Repository: **private** by default. Public visibility adds no immediate value for a personal capability inventory.
