# markdev-skills

Private inventory of the **five top-level agent skills** that matter, plus the **shared contracts** they reuse.

Not a dump of every skill on the machine — one place for routing, boundaries, and rubrics.

---

## Which skill?

| Need | Skill |
| --- | --- |
| Shape an idea | `expanded-grill-with-docs` |
| Audit repo health | `codebase-integrity-audit-loop` |
| Parallelize a known mission | `human-directed-swarm-planner` |
| Deliver approved work | `production-flywheel` |
| Unsure | `loop-router` |

Routing, handoffs, and non-goals: **[CAPABILITY-MAP.md](CAPABILITY-MAP.md)**  
External helpers (pinned, not vendored): **[DEPENDENCIES.md](DEPENDENCIES.md)**

---

## Layout

```
markdev-skills/
├── CAPABILITY-MAP.md      # start here
├── DEPENDENCIES.md
├── skills/                # one folder per top-level skill
├── shared/                # scoring, ledgers, decisions, loop state
├── tests/
└── scripts/
```

Each skill is a self-contained folder (`SKILL.md` + companions).  
Shared contracts live once under `shared/` and are referenced, not copied into each skill.

---

## Install

```bash
./scripts/install-skills.sh
./scripts/install-skills.sh --with-shared
```

```powershell
.\scripts\install-skills.ps1
.\scripts\install-skills.ps1 -WithShared
```

Installs only the five top-level skills (symlink, or copy if links fail). Default destination: `~/.agents/skills`.

---

## Rules

1. Keep **five** top-level skills here — do not vendor large external skill sets.
2. Pin externals in `DEPENDENCIES.md` (source, path, version/commit).
3. Change shared rubrics in `shared/`, not by forking them per skill.
4. Stay **private** while this inventory is still settling.
