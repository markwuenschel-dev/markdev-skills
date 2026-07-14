# markdev-skills

<p align="center">
  <strong>Canonical skills inventory</strong><br/>
  <sub>Five top-level skills · shared contracts · private by design</sub>
</p>

---

One place to remember what each skill is for, where the edges are, and which rubrics they share.

Not a dump of every skill on the machine. Externals are pinned, not vendored.

---

## Which skill?

```
                        ┌──────────────┐
                        │ loop-router  │
                        │   (unsure)   │
                        └──────┬───────┘
           ┌───────────────────┼───────────────────┐
           │                   │                   │
           ▼                   ▼                   ▼
    shape an idea        audit health        parallelize
    expanded-grill-      codebase-           / deliver
    with-docs            integrity-              │
                         audit-loop       ┌──────┴──────┐
                                          ▼             ▼
                                       swarm         flywheel
                                       planner
```

| Need | Skill |
| :--- | :--- |
| Shape an idea | [`expanded-grill-with-docs`](skills/expanded-grill-with-docs/) |
| Audit repo health | [`codebase-integrity-audit-loop`](skills/codebase-integrity-audit-loop/) |
| Parallelize a known mission | [`human-directed-swarm-planner`](skills/human-directed-swarm-planner/) |
| Deliver approved work | [`production-flywheel`](skills/production-flywheel/) |
| Unsure which applies | [`loop-router`](skills/loop-router/) |

**Start here for routing and handoffs:** [`CAPABILITY-MAP.md`](CAPABILITY-MAP.md)  
**External dependencies:** [`DEPENDENCIES.md`](DEPENDENCIES.md)

---

## How it’s organized

| | |
| :--- | :--- |
| **`skills/`** | One folder per top-level skill — composable, invokable |
| **`shared/`** | Contracts used by every skill — scoring, ledgers, decisions, loop state |
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
│   └── production-flywheel/
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

Symlinks (or copies) **only** the five top-level skills into your agent skills directory.

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
| **1** | Keep five top-level skills here — do not vendor large external sets |
| **2** | Pin externals in `DEPENDENCIES.md` (source · path · version/commit) |
| **3** | Change shared rubrics under `shared/`, not per skill |
| **4** | Stay private while the inventory is still settling |

---

<p align="center">
  <sub>Private · iterate freely · open when it’s stable</sub>
</p>
