# markdev-skills

<p align="center">
  <strong>Canonical skills inventory</strong><br/>
  <sub>Living catalog under <code>skills/</code> · shared contracts · private by design</sub>
</p>

---

One place to remember what each skill is for, where the edges are, and which rubrics they share.

Every skill in this repo lives under `skills/` with a root `SKILL.md`. True externals (companions not owned here) are pinned in `DEPENDENCIES.md`, not re-authored.

---

## Which skill?

```
                        ┌──────────────┐
                        │ loop-router  │
                        │   (unsure)   │
                        └──────┬───────┘
           ┌───────────┬───────┼───────┬───────────┬──────────┐
           ▼           ▼       ▼       ▼           ▼          ▼
    shape idea    audit    parallelize  deliver   deepen    craft
    expanded-     integrity / swarm    flywheel  arch       prompts
    grill-        audit-loop           │         improve-   prompt-
    with-docs                          │         codebase-  forge
                                       │         architecture
```

| Need | Skill |
| :--- | :--- |
| Shape an idea / approved design package | [`expanded-grill-with-docs`](skills/expanded-grill-with-docs/) |
| Audit repo health | [`codebase-integrity-audit-loop`](skills/codebase-integrity-audit-loop/) |
| Parallelize a known mission | [`human-directed-swarm-planner`](skills/human-directed-swarm-planner/) |
| Deliver approved work | [`production-flywheel`](skills/production-flywheel/) |
| Architecture deepening report | [`improve-codebase-architecture`](skills/improve-codebase-architecture/) |
| Write / repair / optimize prompts | [`prompt-forge`](skills/prompt-forge/) |
| Unsure which applies | [`loop-router`](skills/loop-router/) |

**Start here for routing and handoffs:** [`CAPABILITY-MAP.md`](CAPABILITY-MAP.md)  
**External dependencies:** [`DEPENDENCIES.md`](DEPENDENCIES.md)

---

## How it’s organized

| | |
| :--- | :--- |
| **`skills/`** | One folder per skill — composable, invokable; inventory = every folder with a root `SKILL.md` |
| **`shared/`** | Contracts used across skills — scoring, ledgers, decisions, loop state |
| **`tests/`** | Trigger, boundary, and functional checks |
| **`scripts/`** | Install helpers |

```
markdev-skills/
├── CAPABILITY-MAP.md          ← memory / routing
├── DEPENDENCIES.md            ← externals, pinned by source
│
├── skills/
│   ├── loop-router/
│   ├── expanded-grill-with-docs/
│   ├── codebase-integrity-audit-loop/
│   ├── human-directed-swarm-planner/
│   ├── production-flywheel/
│   ├── improve-codebase-architecture/
│   └── prompt-forge/
│
├── shared/
│   ├── REPORT-SCORING.md
│   ├── REQUIREMENTS-LEDGER.md
│   ├── ROLLOUT-CONTRACT.md
│   ├── SWARM-LANES.md
│   ├── HUMAN-DECISIONS.md
│   └── LOOP-STATE.md
│
├── tests/
└── scripts/
```

Skills own their procedure. Shared contracts own rubrics once — skills link in; they don’t fork copies.

---

## Install

Symlinks (or copies) **every** skill under `skills/` that has a root `SKILL.md` into your agent skills directory.

**Bash / macOS / Linux / Git Bash**

```bash
./scripts/install-skills.sh
./scripts/install-skills.sh --dest "$HOME/.agents/skills"
./scripts/install-skills.sh --with-shared
```

**Windows PowerShell**

```powershell
.\scripts\install-skills.ps1
.\scripts\install-skills.ps1 -Dest "$HOME\.agents\skills" -WithShared
```

Default destination: `~/.agents/skills`. Use `--with-shared` / `-WithShared` when contracts need to sit next to the install root.

---

## Rules

| | |
| :---: | :--- |
| **1** | Living inventory — every `skills/*/SKILL.md` is first-class; keep packages flat (no `name/name/` nesting) |
| **2** | Pin true externals in `DEPENDENCIES.md` (source · path · version/commit); do not dump unrelated skill universes here |
| **3** | Change shared rubrics under `shared/`, not per skill |
| **4** | Stay private while the inventory is still settling |

---

<p align="center">
  <sub>Private · iterate freely · open when it’s stable</sub>
</p>
