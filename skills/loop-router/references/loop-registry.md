# Loop Registry

> Historical experimental routing catalog. It is not loaded by the active
> Loop Router entrypoint and defines no production authority or dependency.

Load this after the state scan (to map artifacts to owners) and at handoff (to verify entry preconditions and pick fallbacks). One card per routable lifecycle. Cards describe only what routing needs — entry signature, precondition, owned state, mutation posture, exit — not the loop's internals; the loop's own SKILL.md remains the source of truth for how it runs.

## Cards

### expanded-grill-with-docs
- **Route in when:** a direction is selected but still needs definition — rough idea, unresolved requirements, no approved contract.
- **Entry precondition:** the user has picked the direction. The router never picks it.
- **Owned state:** idea inputs under `docs/ideas/`; session `STATE.md` while a shaping session is open; the emerging spec/contract draft.
- **Mutation posture:** read_only — creates its own governed planning/spec artifacts (allowed under `read_only` per the mutation_mode definition); never production code.
- **Exits when:** an approved design and rollout contract exists → normally hands to production-flywheel; or the direction proves too large → hands to wayfinder.
- **Name collision — do not confuse:** the flywheel's internal `/grill-with-docs` stage is a narrow interface/seam interview that fires per queue item *inside* production-flywheel. It is not a routing target. Routing "needs shaping" work always means `expanded-grill-with-docs`, the upstream intake loop.

### repository-health-assessment
- **Route in when:** the user asks for a repository health grade, health baseline, or re-grade.
- **Entry precondition:** a repository to assess. Project commands need the user's approval and run only in an isolated copy/worktree.
- **Owned state:** a temporary read-only health report, coverage map, lane scorecards, and candidate ledger; it does not own repair execution.
- **Mutation posture:** read_only — never changes the assessed repository.
- **Exits when:** the grade and candidate ledger are emitted; candidate repair routes to codebase-integrity-audit-loop and structural questions route to architecture work.

### codebase-integrity-audit-loop
- **Route in when:** repository health or scope is unknown, or the concern is broad integrity rather than one already-selected change.
- **Entry precondition:** a repository to inspect. Candidate execution additionally requires explicit human candidate selection and mutation authorization.
- **Owned state:** audit reports and scored candidate ledgers (including `--parallel-report` Repo Audit Swarm ledgers; `REPORT-SCORING.md` defines score meanings — cite scores, never restate them), the active selected candidate, candidate worktree/branch state, verification evidence, and capture records.
- **Mutation posture:** begins `read_only` during scanning and reporting; may transition to `write` only after the human selects exactly one candidate and authorizes repair. The full cycle is scan → report/ledger → human selects one candidate → design/triage → worktree → execute → review → verify → capture.
- **Exits when:** report-only mode (`--parallel-report`) stops at candidate selection; full mode exits after one selected candidate is repaired, independently verified, and captured. A selected candidate mid-repair is **this loop's** continuation (P0) — do not reroute it to production-flywheel.
- **Hard boundary:** the router and the audit loop never choose the candidate for the human; delegating "pick the best one" does not satisfy this.

### human-directed-swarm-planner
- **Route in when:** the user has named exactly one mission and it benefits from parallel agents; or the P1 sub-branch chose **Bug swarm** (flaky, mysterious, or wide-blast-radius defects).
- **Entry precondition:** a human-named mission with a human-named boundary. One swarm mission per turn.
- **Owned state:** swarm plan documents (`# Swarm Plan: <mission>` headers) with lanes, gates, failure codes, definition of done.
- **Mutation posture:** mission-dependent — its plan declares whether code changes are allowed; the router passes through `mutation_mode` from the user's authorization, never sets it.
- **Exits when:** the mission's definition of done is met, or a hard stop / human-decision category fires.

### production-flywheel
- **Route in when:** an approved design contract exists or the user selected a delivery queue/batch.
- **Entry precondition:** approved contract or selected queue. A contract file marked approved is evidence; the user's selection in conversation is the authorization.
- **Owned state:** the running queue; per-item branches/worktrees **when corroborated** (see the glossary — git activity alone never proves flywheel ownership); open unmerged PRs; its Stage-1 architecture report when it generated its own queue.
- **Mutation posture:** write — but only inside its own stage gates, and only when the routing record carried `mutation_mode: write`. Selected with `read_only` (`route_status: authorization_required`): preflight and validate entry conditions only; do not implement until mutation authorization is obtained. It opens PRs and never merges.
- **Exits when:** the queue is exhausted or the user stops it. An in-flight item that changes character (defect discovered, premise gone stale) routes back through this router.

### diagnosing-bugs
- **Route in when:** a concrete failing behavior, regression, or production defect is known and a single track can reproduce and isolate it.
- **Entry precondition:** the failure is identified (a failing test, a reproducible behavior, a specific regression) — not a vague "something feels off" (that is P6, the audit loop).
- **Owned state:** none persistent that the router tracks; the defect description and repro are the input artifacts.
- **Mutation posture:** read_only for diagnosis; the fix itself needs user authorization (and often routes onward to a flywheel item or swarm).
- **Sub-branch rule (P1):** single reproducible track → here; unknown blast radius, flaky, cross-boundary, or parallel lanes materially help → human-directed-swarm-planner, Bug swarm type.

### wayfinder
- **Route in when:** a selected direction cannot fit one shaping session — multi-slice, multi-quarter, or structurally undecomposed.
- **Entry precondition:** direction selected by the user; too large is a size judgment the router states in `reason`.
- **Owned state:** frontier/decomposition artifacts; wayfinder frontier work may append items to a flywheel queue.
- **Mutation posture:** read_only.
- **Exits when:** the direction is decomposed into slices that each fit a shaping session → `return_condition:` back to expanded-grill-with-docs.

### prototype
- **Route in when:** a factual or feasibility question must be answered by experiment before any loop can commit (the experiment override). Always a detour, never a destination.
- **Entry precondition:** the blocking question is stated crisply enough to be answered by one experiment.
- **Owned state:** the experiment artifact and its answer; explicitly throwaway relative to production code.
- **Mutation posture:** read_only — throwaway experiment artifacts outside production code are allowed under `read_only`; production code and delivery state are untouched.
- **Exits when:** the question is answered → `detour_of:` names the calling loop control returns to.

### independent-verification
- **Route in when:** a user asks to establish whether completed work is actually verified, ready, or done.
- **Entry precondition:** a completion claim and a verification packet with a baseline, observable criteria, and declared gates.
- **Owned state:** a verification packet and external/ignored evidence directory; it does not own the implementation or select what ships.
- **Mutation posture:** read_only for production implementation; a fresh verifier grades the packet.
- **Exits when:** it emits PASS, FAIL, or BLOCKED-UNVERIFIABLE. A PASS still requires the human merge/release gate.

## Artifact glossary (state scan → owner)

| Scanner finding | Owning loop | Active means |
|---|---|---|
| `STATE.md` | expanded-grill-with-docs (or the loop it names inside) | session open, decisions unresolved |
| `*contract*.md` with a status field | production-flywheel entry (authored upstream, e.g. by expanded-grill-with-docs) | `approved` and not yet delivered |
| `# Swarm Plan:` documents | human-directed-swarm-planner | definition of done not yet met |
| Audit ledger / scored candidates | codebase-integrity-audit-loop | candidates exist that the user has not dispositioned |
| Non-default branch, dirty tree, extra worktrees | **unknown — corroboration required** | classify as a specific loop only when corroborated: `flywheel/*` or `audit/*` branch prefix (or your convention), a contract slug matching the branch, a loop state/queue file, a queue item ID, open PR metadata, or worktree naming. Uncorroborated: may veto an unsafe start; never invents an owner |
| `docs/ideas/*.md` | expanded-grill-with-docs inputs | scanner returns up to five path-sorted inputs; recency is a router judgment |

Classification (`active | stale | closed`) is the router's judgment from content and recency — the scanner only detects. When classification is uncertain and it would change the route, that is Stop condition 1.

## Fallbacks when a target skill is not installed

Never emulate a missing lifecycle. Record `fallback:` and stop for the user:

- `expanded-grill-with-docs` missing → nearest: a grilling/interview skill if installed; otherwise ask the user to run shaping manually and return with a contract.
- `diagnosing-bugs` missing → nearest: human-directed-swarm-planner (Bug swarm) for parallelizable defects; otherwise the environment's debugging skill.
- `wayfinder` missing → nearest: expanded-grill-with-docs scoped to *decomposing* the direction (explicitly not shaping any one slice).
- `prototype` missing → nearest: a time-boxed experiment the user runs or authorizes explicitly, outside production code.
- `production-flywheel` / `codebase-integrity-audit-loop` / `human-directed-swarm-planner` missing → no safe substitute; stop.
- `repository-health-assessment` / `independent-verification` missing → no safe substitute; stop rather than grading or verifying inline.

## Customization point

If your loops persist state under names this registry and the scanner don't know, add the patterns to the constants at the top of `scripts/scan_state.py` and add a row to the glossary above. The same applies to branch-prefix corroborators: the scanner hints `flywheel/` and `audit/` by default — extend `BRANCH_OWNER_PREFIXES` if your loops use different conventions. Keep the two in sync — the glossary is the router's map, the scanner is its eyes. The scanner returns escaped JSON and fails closed; a router must stop whenever `scan_complete` is false.
