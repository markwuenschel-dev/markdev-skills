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
       ┌────────────┬───────────┬────┴─────┬────────────┬────────────┐
       ▼            ▼           ▼          ▼            ▼            ▼
    decide       assess     parallelize  deliver      land        author
       │            │           │          │            │            │
  wayfinder-   repository-   human-    production-   land-pr     skillwright-
    mwdev        health-    directed-   flywheel     land-prs      forge
  expanded-    assessment     swarm-       │        land-pr-ec2  prompt-forge
    grill-     codebase-     planner       │        land-prs-ec2
  with-docs    integrity-                  │
  implementa-  audit-loop                  │
  tion-plan-   improve-codebase-           │
  contract     architecture-mwdev          │
                                    diagnosing-bugs-mwdev
                                    connected-impact-sweep
```

### Decide

| Need | Skill |
| :--- | :--- |
| Chart a big, foggy effort as a durable decision map | [`wayfinder-mwdev`](skills/wayfinder-mwdev/) |
| Shape one design / approved design package | [`expanded-grill-with-docs`](skills/expanded-grill-with-docs/) |
| Turn selected work into a binding execution contract | [`implementation-plan-contract`](skills/implementation-plan-contract/) |
| Unsure which applies | [`loop-router`](skills/loop-router/) |

### Assess

| Need | Skill |
| :--- | :--- |
| Grade repository health, establish a baseline | [`repository-health-assessment`](skills/repository-health-assessment/) |
| Audit and repair codebase integrity, one loop per candidate | [`codebase-integrity-audit-loop`](skills/codebase-integrity-audit-loop/) |
| Architecture deepening report | [`improve-codebase-architecture-mwdev`](skills/improve-codebase-architecture-mwdev/) |

### Build

| Need | Skill |
| :--- | :--- |
| Deliver an approved queue end-to-end | [`production-flywheel`](skills/production-flywheel/) |
| Parallelize a known mission into agent lanes | [`human-directed-swarm-planner`](skills/human-directed-swarm-planner/) |
| Diagnose a hard bug or performance regression | [`diagnosing-bugs-mwdev`](skills/diagnosing-bugs-mwdev/) |
| Change code without leaving the system incoherent | [`connected-impact-sweep`](skills/connected-impact-sweep/) |

### Land

| Need | Skill |
| :--- | :--- |
| Land one change through a PR | [`land-pr`](skills/land-pr/) |
| Land several open PRs as one confirmed queue | [`land-prs`](skills/land-prs/) |
| Land one change and release its service to EC2 | [`land-pr-ec2`](skills/land-pr-ec2/) |
| Land a queue and release each affected service to EC2 | [`land-prs-ec2`](skills/land-prs-ec2/) |

### Craft

| Need | Skill |
| :--- | :--- |
| Write / repair / optimize a prompt | [`prompt-forge`](skills/prompt-forge/) |
| Design, audit, or harden a SKILL.md package | [`skillwright-forge`](skills/skillwright-forge/) |
| Checkpoint a long session before `/clear` | [`compact-session`](skills/compact-session/) |

**Start here for routing and handoffs:** [`CAPABILITY-MAP.md`](CAPABILITY-MAP.md)  
**External dependencies and lineage:** [`DEPENDENCIES.md`](DEPENDENCIES.md)

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
├── DEPENDENCIES.md            ← externals + fork lineage, pinned by source
│
├── skills/
│   ├── loop-router/
│   │
│   ├── wayfinder-mwdev/                    ← decide
│   ├── expanded-grill-with-docs/
│   ├── implementation-plan-contract/
│   │
│   ├── repository-health-assessment/       ← assess
│   ├── codebase-integrity-audit-loop/
│   ├── improve-codebase-architecture-mwdev/
│   │
│   ├── production-flywheel/                ← build
│   ├── human-directed-swarm-planner/
│   ├── diagnosing-bugs-mwdev/
│   ├── connected-impact-sweep/
│   │
│   ├── land-pr/                            ← land
│   ├── land-prs/
│   ├── land-pr-ec2/
│   ├── land-prs-ec2/
│   │
│   ├── prompt-forge/                       ← craft
│   ├── skillwright-forge/
│   └── compact-session/
│
├── shared/
│   ├── candidate-ledger-spine/   ← family scoring spine (schema + verifiers)
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

## Forks

Three skills are **derivative works** of [Matt Pocock's](https://github.com/mattpocock/skills) originals, kept under a `-mwdev` suffix so an upstream update can never overwrite them:

| Fork | Upstream parent |
| :--- | :--- |
| [`wayfinder-mwdev`](skills/wayfinder-mwdev/) | `wayfinder` (forked at v2.1.2) |
| [`diagnosing-bugs-mwdev`](skills/diagnosing-bugs-mwdev/) | `diagnosing-bugs` |
| [`improve-codebase-architecture-mwdev`](skills/improve-codebase-architecture-mwdev/) | `improve-codebase-architecture` |

A fork must set its frontmatter `name` to the **suffixed** directory name — `name` is the invocation name, so a fork keeping the upstream `name` collides with the skill it forked and neither resolves reliably. See [`DEPENDENCIES.md`](DEPENDENCIES.md) for lineage and attribution.

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
| **4** | A `-mwdev` fork renames its frontmatter `name` to match its directory, and its upstream parent is credited in `DEPENDENCIES.md` |
| **5** | Stay private while the inventory is still settling |

---

<p align="center">
  <sub>Private · iterate freely · open when it’s stable</sub>
</p>
