## Stage 0 — Staged dependency & publish preflight

The full preflight still runs before any mutation, but it is staged. The first interactive question must not wait on capabilities needed only by later implementation, verification, or publication phases.

### Stage 0A — Fast admission (once per session, before the first report, selection, or design question)

Run one compact, read-only probe batch:

- Verify that an explicit authorization, selected candidate/contract, or immutable action-graph/action-set reference is present. An approved contract/action-set must carry `authorization_ref`, issuer, mission/scope, exact item/action IDs, lifecycle status plus expiry/fencing, permitted mutation, and publication policy. A current user selection is sufficient only when those facts are recorded; a report recommendation, design approval, stale pointer, or unfenced candidate is not. Missing provenance remains `MISSING_DELIVERY_AUTHORIZATION`.
- Resolve the active mode and load only its routing reference.
- If an approved contract or already-selected candidate/action is supplied, verify that the supplied identity can be read and treat it as the queue; skip report generation.
- If no item is selected in manual mode, check only the report source (`architecture-improvement-intelligence`) and the design-gate capability (`expanded-grill-with-docs`) needed to reach selection.
- If a design gate will be offered, confirm `expanded-grill-with-docs` is available or its named fallback can be read. Do not silently remove option A.

Do **not** read or probe future conditional skills, independent-verification tooling, GitHub auth, remotes, JUnit signals, or publish capability in Stage 0A. Those checks belong to deep readiness after a queue exists and the current lane/scoping choice is known.

Gate: the active authorization/mode is identifiable, the selected reference (when present) is readable, and the next required report/design capability is available or has an explicitly named fallback. Stop before the design question on failure.

### Stage 0B — Full active-route preflight (once per session, before the first mutation)

After a queue exists and the first item's lane/scoping choice is known, run the active-route checks below as one read-only probe batch where the runtime permits. The list is a routing inventory, not a checklist to load in full: defer a branch's capability until the user selects that branch, then gate it before entering the phase.

Required for the active route:

- `expanded-grill-with-docs` when option A/default is selected;
- `independent-verification` (Stage 11 — the completion gate; there is no fallback that preserves independence);
- `tdd` for new behavior, or the documented characterization/refactor path for behavior-preserving work;
- `architecture-improvement-intelligence` only when the invocation is report-first;
- `to-tickets` only when no valid Slice Contract fallback is available;
- `adaptive-causal-debugging` only when behavior is red, flaky, slow, or unexplained.

Conditional route capabilities:

- `codebase-design` (design-it-twice technique);
- `codebase-integrity-audit-loop` (source of `--parallel-report` ledger candidates; the family scoring spine is `shared/candidate-ledger-spine`);
- `remediation-graph-optimizer` (typical reconciled ledger source for legacy `--graph`);
- `human-directed-swarm-planner` (execution-topology provider for genuinely independent authorized work units; never a mutation owner);
- `shared/action-graph-execution` (required when `--action-graph` is set; see [ACTION-GRAPH-MODE.md](../ACTION-GRAPH-MODE.md));
- `decision-terrain-mapper`, `research`, and `domain-modeling` (only when the user elects the Decision Terrain branch);
- `prototype` or `triage` (only when the selected A sub-lane requires it);
- `writing-plans`, `executing-plans`, `production-campaign`, `agent-executor-pool`, `requesting-code-review`, and `receiving-code-review` (only when that implementation/review path is selected);
- `verification-before-completion` (producer-side smoke discipline during Stage 9, never a substitute for Stage 11);
- `land-pr` (post-authorization only; never Stage 13's helper).

Fallback rule: if an active required or conditional skill is not installed as a routed command but its `SKILL.md` can be read from `$HOME/.agents/skills/<skill-name>/SKILL.md`, read that file and follow it directly, and say so explicitly: "The routed command isn't installed here, but I found the shared skill file and will follow it directly."

Gate: every capability required by the active route is available as a routed command, its shared `SKILL.md` was read directly, or a named fallback is stated. If an active required capability is missing with none of those, stop. Do not silently improvise.

### Independent-verification tooling preflight

Stage 11 runs real tooling, not a prompt. Discovering it is missing at verification time is indistinguishable from a verification failure, so classify it now.

`$IV` throughout this skill is the `independent-verification` skill directory — `$HOME/.agents/skills/independent-verification`, the same convention the fallback rule above uses. Resolve it explicitly rather than relying on `${CLAUDE_SKILL_DIR}`: while the flywheel is the running skill, that variable points at *this* package, not IV's, so IV's own documented `$SD` commands do not transplant here unchanged.

Check:

- **`python` 3.8+ and `git` on `PATH`.** IV deliberately has no third-party dependencies; if `python` is missing, every round is `BLOCKED-UNVERIFIABLE`.
- **The scripts are readable:** `$IV/scripts/preflight.py`, `run_gate.py`, `snapshot.py`, `ratchet.py`, `verdict.py`, **and `_iv.py`** — the shared module every one of the others imports. Omitting it is how this preflight passes while the tooling is unusable, which is the exact failure it exists to prevent.
- **The packet/protocol resources are readable:** `$IV/assets/verification-packet.json` and `$IV/references/verifier-protocol.md`, both consumed when Stage 11 assembles and dispatches the independent packet.
- **The `independent-verifier` agent type is installed.** It lives at `$IV/assets/independent-verifier.agent.md` and is **not live where it sits** — it must be copied to `.claude/agents/independent-verifier.md` (project) or `~/.claude/agents/independent-verifier.md` (personal), dropping the `.agent`. If it is absent, dispatch falls back to `general-purpose`, which has full tool access including `Edit` — the verifier's inability to touch the code stops being mechanical and becomes an instruction it could ignore. Say so explicitly rather than proceeding silently; `compute` still catches post-gate repository changes, but that is a backstop, not the guarantee.
- **Receipt sealing.** If `IV_RECEIPT_KEY` is set from somewhere this agent cannot read or write, records are MAC-sealed and `tamper_evidence` reads `hmac`. Without it the tooling still runs and still catches edited records, but reports `chain-only`. Classify which one this session will produce and state it — do not imply a guarantee the setup cannot make.
- **The repo emits JUnit XML** from at least one gate (`pytest --junitxml`, `jest --reporters=jest-junit`, `vitest --reporter=junit`, `go-junit-report`, `dotnet test --logger junit`). Without a test signal the ratchet compares nothing, and a packet is `BLOCKED-UNVERIFIABLE` unless it deliberately sets `allow_no_test_signal`.

Optional but cheap once per machine, to confirm the tooling itself is sound:

```bash
python $IV/scripts/selftest.py -v
```

Gate: `python` and `git` are present, the IV scripts and packet/protocol resources are readable, the verifier agent type is either installed or its absence is reported with the consequence named, and the receipt mode (`hmac` / `chain-only`) is stated. If `python` is missing, say plainly that Stage 11 cannot produce a verdict on this machine, and let the user decide whether to continue with a queue that can only reach `BLOCKED-UNVERIFIABLE` — never quietly downgrade Stage 11 to a self-check.

### Baseline publish capability

Once the queue exists, classify baseline publish capability so the user knows the ceiling before any work begins:

- `publish-capable`: remote exists, push auth works or is expected, PR tooling/auth exists
- `push-only`: push appears possible, but PR creation tooling/auth is missing
- `local-only`: no remote or no push/auth path
- `unknown`: cannot determine safely yet

The authoritative ship check runs **per item** in the deep per-item preflight (below), because branch/auth/tree state can change between items. This session-level pass is an early warning, not a reason to delay the first design-lane question. If it shows `local-only` or missing `gh`, say so before mutation and preserve the exact blocker.

## Stage 1 — Report

### Approved or already-selected path

When the invocation already supplies a valid approved implementation contract, an explicitly recorded current user selection, or a selected action/action-set with the required authorization envelope, treat that supplied selection as the queue. Print the queue and proceed directly to the selected-candidate summary and the Stage 4 design-lane question; do **not** generate an architecture report or ask the recommendation-selection prompt again. A report recommendation, design approval, stale pointer, or unfenced candidate cannot substitute for that selection. If a supplied selection is present but invalid, stale, or unfenced, return `MISSING_DELIVERY_AUTHORIZATION`; do not generate a replacement report or scan for other work. A bare `--action-graph` envelope still uses its computed frontier prompt, but never runs the report-first path.

For the report-first manual path only (no valid authorized selection is supplied), run `/architecture-improvement-intelligence`.

Gate:
- A self-contained HTML architecture report exists and its absolute path is printed.
- The report contains **numbered** deepening candidates (`1..N`).
- Each candidate names the module, interface/seam friction, expected leverage, expected locality, and testability impact, scored per the family scoring spine in `shared/candidate-ledger-spine`.
- No production code has changed.
- The report's Mermaid diagrams render without syntax errors, and ugly candidate names do not break the page (the report uses the architecture owner's canonical Mermaid-safe helper).

Then ask which recommendations to run (Stage 2). Do not change production code yet. The approved/already-selected path does not run this report or prompt again.

## Stage 2 — Batch selection & queue

Ask, verbatim in intent:

```text
Which recommendations do you want to run?

You can answer with:
- one number: 3
- multiple numbers: 1, 4, 5
- ordered sequence: 4 then 1 then 3
- all
```

Parse the answer:

- **one number** → a one-item queue
- **multiple numbers** → a queue in the order given (comma order is the run order)
- **ordered sequence** (`4 then 1 then 3`) → a queue in exactly that order
- **all** → every candidate, in report order (confirm the order if the user didn't specify one)

Then print an explicit, visible queue:

```text
Selected queue:
1. [candidate name]
2. [candidate name]
3. [candidate name]
```

This queue **is** the authorization to proceed through every item automatically. Do not ask "shall I start?" or "shall I continue?" between items.

The queue is editable mid-run: the user can reorder, drop, or insert items at any time Apply the edit at the next item boundary, reprint the updated queue, and keep going — a queue edit is a steering input, not a stop.

### Ship granularity

One PR per item is the default. The user can elect **batched shipping** instead — the whole queue or named groups, each group sharing one branch and one PR — in the selection message or at any item boundary (a granularity change applies only to items not yet shipped). When the queue is long (≈5+ items) or several items look small, confirm granularity at the first natural stop (usually item 1's design-lane question, or the upfront exchange if the user decided all lanes ahead of time) rather than silently defaulting into a PR-per-item run. The model may recommend groupings by module or theme, but the election is the user's — never model-elect batching. Batching moves only *where Stage 13 runs*: every per-item stage and gate still runs per item, and a batched item's completion footer reads `PR: ships with group <name>` until the group PR opens.

### Graph mode queue

When `--graph` is set (*Operating modes*), this section's prompt and the "Selected queue" print above are both replaced. Read [GRAPH-MODE.md](../GRAPH-MODE.md) for the full mechanics; in outline:

1. Ingest the ledger and validate it through `shared/candidate-ledger-spine/ledger-verify.js` exactly as any other candidate source; refuse to proceed if it does not validate clean.
2. Refuse a `depends_on` cycle outright (see the Hard Rules bullet above).
3. Compute the eligible frontier per the spine's own eligibility gate and stable comparator (`REPORT-SCORING.md` `## Eligibility and stable ranking`) — this skill never invents a second ranking.
4. Print the frontier — eligible items ranked, blocked items listed with what blocks each — and let the user pick within it, or pre-authorize "top-ranked each time" for the rest of the run.
5. Persist run state to `.verification/graph/state.json`, which is **never authoritative**: every completion claim is re-derived from `verdict.json` on resume, never trusted from the state file alone.

Ordering is computed, not user-typed, which is a real reduction in control from manual mode's numbered-answer queue — say so plainly when offering `--graph`. Every item still passes its own Stage 4 A/B gate at its turn; nothing here shortcuts that. Batched shipping and `--graph` combine only across independent frontier nodes — a batched group stays internally sequential, one shared branch with per-item commits, exactly as *Ship granularity* above already requires.

### Action-graph mode queue

When `--action-graph` is set (*Operating modes*), this section's prompt and the "Selected queue" print above are both replaced, sibling to the `--graph` replacement above. Read [ACTION-GRAPH-MODE.md](../ACTION-GRAPH-MODE.md) for the full mechanics; in outline:

1. Ingest the envelope and validate it through `ActionGraphVerify.verifyExecutionGraph` exactly as any other candidate source; refuse to proceed if it does not validate clean.
2. Refuse a `hard_requires` cycle outright (see the Hard Rules bullet above) — never solved as a scheduling puzzle.
3. Compute the frontier per the three distinct edge-readiness rules — `hard_requires`, `decision_requires`, `verification_requires` — never one flattened `depends_on`.
4. Print the frontier: ready items ranked, blocked items listed (never dropped) using `explainGateBlockers`-shaped reasons for verification-blocked items and "waiting on human decision `<id>`" for decision-blocked items, and let the user pick within it, or pre-authorize "top-ranked each time" for the rest of the run.
5. Persist run state via `shared/action-graph-execution`'s `state-store.js` to `.verification/action-graph/state.json` — the sibling convention to `.verification/graph/state.json`, gitignored the same way. This is read-then-reverify on resume, never read-then-trust, exactly like the candidate-graph path above.

Ordering is computed here too, for the same reason `--graph` states above. Every action still passes its own Stage 4 A/B gate at its turn; nothing here shortcuts that. Batched shipping and `--action-graph` combine only across independent frontier actions — a batched group stays internally sequential, one shared branch with per-item commits, exactly as *Ship granularity* above already requires.

### Per-item status header

At the start of each item, print:

```text
Now running queue item 2/5: [candidate name]
```

### Per-item completion footer

At the end of each item, print:

```text
Completed queue item 2/5:
- Branch:
- PR:
- Verification: PASS | FAIL | BLOCKED-UNVERIFIABLE | ESCALATE (exit code) · round n of 3
                 | n/a — decision-terrain item, planning only, never reached Stage 11
- Evidence: <evidence_dir> · packet lock <sha> · tamper_evidence: hmac | chain-only
- Tests:
- Notes:
Moving to item 3/5.
```

Then move immediately to the next item. Do not ask whether to continue unless there is a real blocker.

### Selected-candidate summary (per item, at its turn)

When an item reaches its turn, summarize it before the design-lane gate:

```markdown
## Selected candidate

**Module/seam:**
**Current friction:**
**Expected leverage:**
**Expected locality:**
**Risk:**
**Staleness:** did earlier queue items ship changes to this candidate's modules? (untouched / touched — summarize)
**Lane recommendation:** full grill (A) / user-elected shortcut (B) / Decision Terrain Mapper (too big for one slice) — with reasoning
```

If earlier items materially changed this candidate's premise, say so and let the user re-confirm, re-scope, or drop it before the gate — do not grill a stale premise. (This is the same staleness rule Stage 14 applies to leftover candidates, applied inside the running queue.)

## The queue loop

For each item in the queue, in order:

1. **Fast item admission** (Stage 3A) and the selected-candidate summary — confirm the item is still authorized and prompt-ready without running network or toolchain probes.
2. **Scoping pre-check + design-lane gate** (Stage 4) — confirm the candidate is one slice (else recommend `/decision-terrain-mapper` to decompose it), then ask the A/B question immediately. Do not choose B on the user's behalf.
3. **Deep per-item preflight** (Stage 3B) — run the GitHub CLI, ship-capability, frontier, branch, and dirty-tree checks before any mutation.
4. **Design process** (Stage 5) — grill / design-it-twice / prototype / triage as selected, **or** `/decision-terrain-mapper` if the scoping pre-check routed here (planning only — the item exits Flywheel after the terrain handoff, Decision Terrain Mapper owns the multi-cycle map, and completed terrain returns to the invoking caller; it never reaches Implement/Ship here).
5. **Implement** (Stage 6–9) — slice, plan, deliver via TDD or the refactor path.
6. **Review, then verify independently** (Stage 10–11) — review feeds the round; a fresh verifier returns the verdict. The repository is frozen from dispatch until the verdict lands, so the next item cannot begin here.
7. **Capture & ship** (Stage 12–13) — capture durable knowledge, then commit, push, open the PR **only on a verified `PASS`**. Never merge.
8. **Advance** (Stage 14) — print the completion footer and move to the next item automatically.

Stop the loop only when the queue is empty or a blocker prevents safe delivery.

## Stage 3 — Per-item preflight

Stage 3 is split so the design-lane question is not held behind slow, no-write checks. Stage 3B remains mandatory before implementation for **each** selected item; nothing in Stage 3A authorizes mutation.

### Stage 3A — Fast item admission

Before the Stage 4 question, confirm the item's authorization identity and declared scope are still readable. Under `--graph` or `--action-graph`, recompute enough frontier state to ensure the item can be shown as prompt-ready; the authoritative frontier check is repeated in Stage 3B immediately before mutation. Print one compact admission receipt and move to the design-lane question. Do not run `gh`, network, IV, JUnit, or full repository probes here.

### Stage 3B — Deep per-item preflight

Run before implementation for **each** selected item. Its job: confirm the repo can actually ship a PR, and confirm the working tree is in a known state — before any code changes for this item. Issue independent read-only commands as one concurrent probe batch where the runtime permits, then report one compact receipt.

**Decision-Terrain-bound items:** if the selected-candidate summary (Stage 2) recommended `/decision-terrain-mapper` for this item — planning only, no PR this pass — the ship-capability checks below are **informational, not blocking**; terrain mapping opens no PR, so missing `gh`/auth/remote does not stop it. Still run the working-tree check so the map work starts from a known state.

Run these checks (support both `gh` and `gh.exe` on Windows — try `gh`, fall back to `gh.exe`):

```bash
git --version
gh --version          # or: gh.exe --version
gh auth status        # or: gh.exe auth status
git remote -v
git status --short
git branch --show-current
```

Interpret:

- **`git` missing** → hard stop; the workflow can't operate. Tell the user to install Git.
- **`gh` / `gh.exe` missing** → stop before implementing this item and tell the user exactly what to install (GitHub CLI). Do not start work you can't ship.
- **`gh auth status` unauthenticated** → stop and tell the user to run `gh auth login`. Name the exact command.
- **No remote (`git remote -v` empty)** → stop and report; there's nowhere to push a PR. (If the user explicitly wants local-only for this item, record that as a user-elected exception.)
- **Detached HEAD / unexpected branch** → note it; you'll create a fresh feature branch for the slice anyway.

### Working-tree check

Inspect `git status --short` before starting the item:

- **Clean** → proceed.
- **Dirty** → summarize the dirty files and decide whether they are **expected** from this workflow (e.g. an in-progress branch from the previous queue item that was already pushed) or a **blocker** (unrelated uncommitted changes that would contaminate this slice). If it's a blocker, stop and ask; if it's expected and explained, proceed and record why.

Do not defer any of this to ship time. The whole reason it lives in preflight is so the assistant never reaches the end of an item only to discover it cannot open a PR.

**Under `--graph`:** confirm this item is still in the computed eligible frontier — i.e. every `depends_on` candidate is `completed` — before proceeding. An item that was eligible when queued but whose dependency has since been reset to blocked (Stage 13's group-branch-reset case) is not ready; recompute the frontier (Stage 14) rather than starting it.

**Under `--action-graph`:** confirm the item's `action_id` is still in the recomputed frontier — recompute via `ActionGraphVerify.verifyExecutionGraph` (or `computeFrontier`), never trust a cached one — before proceeding.

Gate:
- `git` present; `gh`/`gh.exe` present and authenticated, or the exact blocker is reported and the queue is paused.
- A remote exists, or a user-elected local-only exception is recorded.
- The working tree state is known and either clean or explained.
- Under `--graph`: this item is currently in the eligible frontier.

## Stage 4 — Design-lane gate (per item, at its turn)

**Mandatory for every item. The default is the full grill. The assistant must not skip it or choose the shortcut on the user's behalf.**

**Scoping pre-check (before the A/B gate).** Confirm the candidate is actually one vertical slice. If it's too big for one slice/session — interdependent unknowns, multi-session architectural scope — it isn't gate-ready: recommend the Decision Terrain branch to decompose it first, and let the user elect it (see *The Decision Terrain branch*). If the user elects terrain mapping, this item leaves Flywheel rather than reaching the A/B gate. Decision Terrain Mapper owns the map and returns completed terrain to the invoking caller.

First classify the candidate as `mechanical` / `partly designed` / `unresolved`, then present the gate verbatim in this shape:

```text
This candidate looks [mechanical / partly designed / unresolved].

Default option:
A. Run full /expanded-grill-with-docs before code.

Optional shortcut:
B. Treat the existing design as sufficient and proceed with direct implementation.

My recommendation:
[explain briefly]

Choose A or B.
```

- **If the user chooses A** → run `/expanded-grill-with-docs`. If multiple interface shapes remain plausible, run the design-it-twice pass in `/codebase-design` (see its `DESIGN-IT-TWICE.md`).
- **If the user chooses B** → record explicitly: "User elected the direct-implementation shortcut for this item," and state the risk being accepted (what grilling would have de-risked). Then proceed to implementation.
- **If the user doesn't answer** → hold this item. Do not pick B. (Only auto-run A if the user pre-authorized "A for the whole batch.")

There is no third, model-elected path. Do not infer B from the design looking complete. After the user answers A or B, return to the queue loop's Stage 3B deep preflight; enter the selected design/implementation lane only after that preflight passes (or its planning-only exception is recorded).

## Stage 5 — Design process

Run the lane the gate selected. **A is the default lane; Prototype and Triage are sub-lanes of A**, entered by their triggers rather than a separate gate question — pick Prototype when state/model/UI must be *felt*, Triage when the work starts from an existing issue/PR, otherwise grill. Decision Terrain Mapper is entered only when the scoping pre-check routed here; B only when the user elected it at the gate.

- **A (default) — grill:** Run `/expanded-grill-with-docs`. See [branches/design.md](../branches/design.md). If 2+ interface shapes are plausible, run the design-it-twice pass in `/codebase-design` (see its `DESIGN-IT-TWICE.md`).
- **Prototype** (sub-lane of A, when state/model/UI must be felt): Run `/prototype`. See [branches/prototype.md](../branches/prototype.md).
- **Triage** (sub-lane of A, when work starts from an issue/PR): Run `/triage`. See [branches/triage.md](../branches/triage.md).
- **Decision Terrain Mapper (user-elected, pre-slice):** the scoping pre-check found the candidate too big for one slice. Run `/decision-terrain-mapper` to chart it into a map of tickets; planning only. **This item exits the Flywheel delivery loop here — do NOT proceed to Stage 6 (Slice) or Stage 13 (Ship).** Record the Decision Terrain map/handoff reference as planning-deferred. Do not append its decision tickets as delivery work. The mapper owns subsequent terrain cycles and returns completed terrain to the invoking caller. Other already-authorized independent Flywheel items may continue normally. See *The Decision Terrain branch*.
- **B — user-elected direct implementation:** proceed to Stage 6. Allowed **only** because the user chose B at the gate.

Gate:
- The chosen lane's procedure is complete, or the user's B election is recorded with its risk.
- Interface/seam direction, behavior change, acceptance criteria, out-of-scope boundaries, dependency strategy, and capture needs are explicit before implementation.
- **Decision Terrain Mapper items** end the loop iteration at map creation (no Stage 6+): the gate is that the map/handoff exists, its decision frontier is wired, and no Decision Terrain ticket has been misclassified as delivery work.
