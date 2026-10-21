## Stage 6 — Slice

Run `/to-tickets` unless the work is already one clear vertical slice. Otherwise write a Slice Contract.

**The Slice Contract is the verification packet in prose.** Stage 11 locks it and a stranger grades against it, so it is authored here in a shape that survives that: every acceptance criterion carries a stable id, an `expected` someone could check by *running something*, and the id of the gate that will prove it.

```markdown
## Slice Contract

**Behavior to change:**
**Public interface / user-visible surface:**
**Out of scope (non-goals):**
**Declared paths:**            <!-- globs this slice may touch -->
**Forbidden paths:**           <!-- e.g. .github/workflows/**, infra/** -->
**Public contracts touched:**  <!-- schema, DTO, API route, CLI flag, event payload, config key -->
**Capture needs:**

### Acceptance criteria

| id | statement | expected (observable) | proving gate |
| --- | --- | --- | --- |
| REQ-1 | | | `unit` |

### Gates

| id | argv | cwd | expect exit | produces / junit |
| --- | --- | --- | --- | --- |
| `unit` | `["python","-m","pytest","tests/unit","-q","--junitxml=reports/junit-unit.xml"]` | `.` | 0 | `reports/junit-unit.xml` |
| `full-suite` | | `.` | 0 | |

**Final gate:** `full-suite`   <!-- the strongest command; runs last and covers everything before it -->
```

Three rules decide most later arguments, and getting them wrong here is what makes Stage 11 return `BLOCKED-UNVERIFIABLE` instead of a verdict:

- **`expected` must be checkable by a stranger running something.** "Handles duplicates correctly" is not verifiable. "The second POST with the same idempotency key returns 200 and the id created by the first call" is. The verifier grades against this text as locked and cannot substitute a softer one — which also means a vague `expected` cannot be rescued later.
- **Every criterion names its own proving gate, and the packet names one `final_gate`.** A criterion may only pass on its planned gate; otherwise any green gate can be cited for any criterion, and a suite that exits zero becomes "proof" of behavior it never exercised.
- **Each gate declares what it `produces`, and means it.** A gate that exits zero without writing an output it declared is `BLOCKED-UNVERIFIABLE`, not a pass — exiting zero is not the same as having run.

**Verification escape hatch.** If the standard runner cannot exercise the slice (DB, external APIs, queues, migrations, deploy-only, CLI bridges), build the smallest red-capable harness that reaches the changed behavior — and **declare it here as a gate**, because a harness the packet doesn't declare cannot produce evidence. It must reach the changed path, fail before the fix and pass after, and document its setup. Deleting it after use is only an option if it was never the sole proof of a criterion; if a criterion cites it, it is promoted to a real test and stays. Record why the standard runner was insufficient.

Gate: one tracer-bullet vertical slice, independently verifiable, adjacent work explicitly out of scope; every acceptance criterion has a stable id, an observable `expected`, and a named proving gate; every gate has an `argv`, an expected exit code, and its declared outputs; a `final_gate` is named; declared and forbidden paths are set; at least one gate emits JUnit XML (or `allow_no_test_signal` is a deliberate, stated election).

## Stage 7 — Worktree

Run `using-git-worktrees` for isolated delivery when available.

Branch base: cut each item's branch from the repo's default branch. If this item depends on an earlier queue item whose PR is still unmerged, branch from that item's branch instead, say so in the status header, and note in the PR body that it is stacked and merges after its parent. In batched mode the group shares one branch cut from the default branch: record the branch SHA at each item's start as that item's **baseline**, keep commits per-item so item boundaries stay legible and bisectable, and note that intra-group dependencies need no stacking — later items simply land on the same branch.

**Under `--graph`:** a `depends_on` edge is a real branch-base constraint, not just an ordering hint — branch from a dependency's branch only after that dependency's verdict reached `PASS`, never while it is still in flight. See GRAPH-MODE.md's *Worktree and branch boundaries* for the hazard this avoids.

**Under `--action-graph`:** a `hard_requires` edge is a real branch-base constraint exactly like `depends_on` is for candidate-graph mode — branch from a predecessor action's branch only after ITS status durably reaches `complete` (never while `active`/`verifying`). See ACTION-GRAPH-MODE.md's *Worktree and branch boundaries* for the hazard this avoids.

### Capture the verification baseline — before any code changes

Stage 11's ratchet is baseline-relative: without a floor, a new failure cannot be told apart from an old one, and the round is `BLOCKED-UNVERIFIABLE` rather than a verdict. **This is the only pre-change moment in the item**, so the baseline is captured here or not at all.

Run the Stage 6 gates on the pre-change revision, then snapshot it:

```bash
python $IV/scripts/snapshot.py --repo-root . --label baseline --junit reports/junit-unit.xml --junit reports/junit-api.xml --out .verification/<item-id>/baseline/snapshot.json
```

`--junit` takes **one path per flag** and is repeatable — repeat it once per report. Do not pass a shell glob (`reports/junit-*.xml`): the shell expands it to several words, argparse sees the extras as positional arguments, and the command dies with "unrecognized arguments" the moment the repo has more than one report.

Two things that bite:

- **The evidence directory must not be inside the diff.** Put `.verification/` in `.gitignore` (or place it outside the repo entirely). Evidence committed alongside the change contaminates the thing being verified, and IV's preflight blocks the round when it detects this.
- **If implementation already happened and no baseline exists**, reconstruct one from a clean worktree rather than skipping it. Reconstruction is the only escape hatch:

```bash
git worktree add ../baseline-<item-id> <baseline-ref>
# run the same Stage 6 gates there, then snapshot with --repo-root ../baseline-<item-id>
git worktree remove ../baseline-<item-id>
```

In batched mode the group shares one branch, so each item's recorded start SHA (above) is that item's `baseline_ref`, and each item gets its own baseline snapshot — the group does not share one.

Gate: an isolated branch/worktree exists (or the reason not to is documented); the working tree starts clean; `baseline/snapshot.json` exists and its `head_sha` is the pre-change revision; the evidence directory is gitignored or outside the repo. A missing baseline with no reconstruction path is a real blocker — say so now rather than reaching Stage 11 with nothing to compare against.

Worktree/plan ordering: creating a branch/worktree is a repo mutation. If the user hasn't approved that mutation, preview the plan first (`plan preview → approval → worktree → finalized plan → execute`); otherwise `worktree → plan → execute`.

## Stage 8 — Plan + execution topology

Run `writing-plans`. The ordered plan remains the task-level implementation intent; it does not decide delivery ownership.

Then choose the smallest execution topology that fits the already-authorized slice:

- **Sequential:** if tasks are dependent or a swarm would not reduce critical-path time/risk, skip swarm planning. `executing-plans` is a subordinate execution mechanic inside Flywheel.
- **Parallelizable:** invoke `human-directed-swarm-planner` in **execution-topology handoff mode** with the Slice Contract, execution revision, authorization/item ref, declared paths/resources, and acceptance gates. The planner returns topology only; it must name `production-flywheel` as execution owner and may not mutate.

The topology may decompose the selected slice into many logical lanes, but it cannot create new queue items, alter acceptance criteria, expand declared paths, or override action-graph/runtime state. Flywheel validates the topology before dispatch.

Gate: the plan maps every task to the slice and verification step; topology is sequential or explicitly resource/conflict-aware; all mutating work remains Flywheel-owned; no adjacent cleanup is admitted.

## Stage 9 — Execute & delivery loop

Flywheel executes the selected topology. Use `executing-plans` for sequential mechanics. For a closed multi-action set, compile it through `production-campaign/plan-compiler.js` and delegate bounded scheduling to `production-campaign`; ad hoc subagent topology is not a production delivery path.

**New behavior path** — the slice adds/changes observable behavior. Run `/tdd`:

```text
one behavior test → red → minimal implementation → green → refactor while green → task verification
```

Gate per task: behavior tested through the public interface; internal modules not mocked; test went red before green unless impossible (documented); refactor only while green; task verification passes.

**Refactor path** — the slice preserves behavior while changing structure:

```text
characterize existing behavior → green baseline → refactor → stay green → task verification
```

Gate: behavior characterized before change; green before refactor; green after; any divergence treated as a failure interrupt; no new behavior added unless it becomes an explicit acceptance criterion.

**Failure interrupt:** if work is broken, red, flaky, slow, or unexplained, pause the affected Flywheel work unit and run `adaptive-causal-debugging` under the same delivery authorization. The debugging specialist owns causal diagnosis; Flywheel retains mutation/delivery ownership and resumes only after the bounded repair/regression evidence is returned.

## Stage 10 — Review

Run `requesting-code-review`, then `receiving-code-review` on the output.

Integration and specialist review happen **here**, before verification — review is a producer-side activity that improves the change. It never grades it, never substitutes for Stage 11, and its findings must not be forwarded to the verifier.

Gate: critical/high-confidence issues fixed; false positives documented briefly; deferred issues captured as follow-ups; tests rerun after review fixes. Finish review before dispatching, because every post-dispatch edit invalidates the round.

## Stage 11 — Independent verification round

Run `/independent-verification` as the **orchestrator**. This stage is not optional, not shortenable, and not something the assistant can satisfy by checking its own work. See *Stage 11 is not the model's to self-certify*.

**Ordering is load-bearing here, and it is the opposite of the old Verify stage's.** IV ties every piece of evidence to a stable revision identity, so the slice must be *committed before it is verified*, and nothing may touch the repository between the verdict and the ship gate:

```text
capture + commit  →  verify  →  (repo frozen)  →  push + PR
```

Getting this backwards is not a style question. `preflight.py` blocks `WORKTREE_DIRTY` on any uncommitted change unless the packet opts in, and `verdict.py` blocks `REPO_CHANGED` / `REPO_MOVED` if the tree or HEAD moves after the gates ran. A flow that commits or writes files after verification cannot produce a verdict at all.

### 1. Capture, tidy, then commit the slice

Do everything that writes to the repository **now**, before the packet is locked:

- Tidy the producer side: no debug logs, no stale prototypes, no accidental artifacts, no temp harness left behind unless it was promoted to a real test **and declared as a gate**.
- Write the durable knowledge that belongs in the repo — `CONTEXT.md`, `docs/adr/`, `.out-of-scope/` (see Stage 12's table). These are part of the slice and must be inside the commit and inside `scope.declared_paths`, not added afterwards.
- Commit:

```bash
git status --short
git add <paths for this slice, including capture>
git commit -m "<concise, scoped message>"
```

Do **not** push yet; pushing is Stage 13's job and nothing is authorized to leave the machine until a verdict exists.

Gate: `git status --short` is empty (or every remaining entry is gitignored evidence), and `HEAD` is the revision the packet will name as `verify_ref`.

If the working tree genuinely cannot be committed — a deliberate, stated exception — the packet must set `allow_dirty_worktree: true`, and you must say why. This weakens the tie between evidence and revision, so it is an exception to justify, not a default to reach for.

### 2. Assemble the packet

Copy `$IV/assets/verification-packet.json` and fill it from the Stage 6 Slice Contract, which was authored in this shape. The packet is the entire contract — the verifier gets nothing else.

Carry across: `task` (id, title, source, `non_goals`), `producer.identity` (this session) and `verifier.identity` (the round's verifier — they must differ), `revision` (`repo_root`, `baseline_ref`, `verify_ref`, `diff_range`), `scope.declared_paths` / `forbidden_paths` / `public_contracts`, one `criteria[]` entry per acceptance criterion with its locked `expected` and `evidence_plan.gate`, the `gates[]` table with `argv` as an **array** (not a shell string), `final_gate`, `baseline.snapshot` pointing at the Stage 7 artifact, `evidence_dir`, and `specialist_lanes`.

Lanes are selected from the surfaces this slice actually touched. `correctness` and `test quality` are required on every round and are auto-appended if omitted; exempting one needs a non-empty reason in `lane_exemptions`, keyed by the lane name.

**What the packet must not carry:** your reasoning, the conversation, the design rationale, a summary of why the change is correct, or any field arguing the work's case. Preflight scans for these and blocks the round. This is not ceremony — a persuasive summary is the single most reliable way to turn a verifier into a rubber stamp, and every preceding stage has been building exactly the confidence that would write one.

The human gate is not a packet setting. A packet that tries to disable it is blocked.

Then lock it:

```bash
python $IV/scripts/preflight.py check --packet <packet> --verifier-id <id>
```

Exit 2 means the round cannot proceed. Fix the findings; **do not work around them** — every one of them is a way a round reaches `PASS` without evidence.

### 3. Dispatch a fresh verifier

Render the launch prompt rather than writing one:

```bash
python $IV/scripts/preflight.py dispatch-prompt --packet <packet> --protocol $IV/references/verifier-protocol.md
```

Launch a subagent with **exactly that text** as its prompt, using the `independent-verifier` agent type (or `general-purpose` if Stage 0 reported it uninstalled, noting the lost tool restriction).

Add nothing to the rendered prompt. Not a note about what you already checked, not a heads-up about a flaky test, not an apology for the diff. Every addition is producer reasoning reaching the verifier, and it costs the round the only property that makes it worth running. If the verifier asks for your reasoning, decline.

If a subagent is unavailable, the fallback is a **new session started by the user** with the rendered prompt and no other history. Continuing in this session is not a fallback; it is the failure mode.

### 4. Freeze, then consume the verdict

From dispatch until the verdict returns: no edits, no commits, no branch changes, and **no starting the next queue item**. `compute` recomputes the repository's identity and refuses a verdict if anything moved after the gates ran. Waiting is part of the stage.

Read the artifact at `<evidence_dir>/verdict.json`, not the verifier's prose:

| Exit | Verdict | Flywheel response |
| --- | --- | --- |
| 0 | `PASS` | Proceed to Stage 12–13. Check `tamper_evidence` first: `hmac` if sealed, `chain-only` if not. |
| 1 | `FAIL` | Repair round (below). Item blocked, queue continues after repair. |
| 2 | `BLOCKED-UNVERIFIABLE` | Nothing was established. Repair the *infrastructure*, re-run. Never reinterpret as a pass. |
| 3 | `ESCALATE` | Three consecutive non-PASS rounds — **pause the queue** and escalate. |
| 64 | usage error | Treat as `BLOCKED-UNVERIFIABLE`. |

Exit code and verdict string are **not** a bijection: on exit 3 the payload still carries `"verdict": "FAIL"` or `"BLOCKED-UNVERIFIABLE"` alongside `"escalated": true`. **The exit code is authoritative.**

Never re-derive the verdict, never soften it in the completion footer, and never report `PASS` next to caveats that would have been failures. If your account of the round and the exit code disagree, the exit code is right and your account is the bug.

### 5. Repair rounds

On `FAIL` or `BLOCKED-UNVERIFIABLE`:

0. **Commit the repair before re-verifying.** The same rule as step 1 — a repair sitting uncommitted blocks the next round on `WORKTREE_DIRTY`. Amend the slice commit or add a follow-up commit, then update `verify_ref` if it moved.
1. The producer — or a fresh repair agent — fixes **only the reported gap**. New scope invalidates the packet.
2. If the fix needs a criterion or scope change, that is a **contract change**: amend the packet, increment `round`, and say so explicitly in the completion footer. A quietly amended contract is how a failing change becomes a passing one without improving.
3. Increment `round`, point `evidence_dir` at a new round directory so prior rounds survive, and start a **new verifier context**. Reusing the previous verifier gives it a memory of arguing with this diff.

Everything else in the packet is locked between rounds — including `baseline`, `final_gate`, `authorized_removals`, `allow_no_test_signal`, `specialist_lanes`, and `lane_exemptions`. Only `evidence_dir`, `round`, and `verifier` may change.

Never lower a criterion so the round will pass. That is a stop condition, not a fix.

### 6. Circuit breaker

Keep every round's `evidence_dir` as a **sibling directory under one parent** — `.verification/<item-id>/round-1`, `round-2`, … `compute` finds prior rounds by globbing `<evidence_dir>/../*/verdict.json`, so a flat or scattered layout means it sees no history and the breaker below silently never fires.

After three consecutive non-PASS rounds, `compute` exits 3 and stops the loop. **Do not start round four.** Preserve every round's verdicts, classify the likely cause, and pause the queue with that classification:

`implementation defect` · `incorrect task decomposition` · `incorrect requirement` · `missing environment` · `unstable test` · `unresolved architecture decision` · `unverifiable acceptance criterion`

Three rounds of the same failure usually means one of the last four, not the first. A loop that keeps failing on the same criterion is evidence about the criterion — which usually means the item goes back to its design gate, or to `/decision-terrain-mapper` if the premise turned out to be bigger than one slice.

Gate: a `verdict.json` exists for this item at a known path; its exit code is `0` with `"verdict": "PASS"`; its `packet_lock_sha256` matches the packet for the revision being shipped; `tamper_evidence` is recorded. Anything else is not a pass, and Stage 13 does not run.

## Stage 12 — Record completion (writes nothing to the repository)

**The verified revision is frozen from verifier dispatch until the verdict is consumed. This stage records; it does not edit.** Durable knowledge was written and committed at Stage 11 step 1, precisely so that it lands inside the verified revision instead of contaminating it afterwards. Adding a file here changes the revision identity and makes any later policy-gated publish check block on `REPO_CHANGED`. If something genuinely must be written now, it belongs to the next item or a follow-up.

Record a provisional delivery status: `complete-local`, `complete-published`, `blocked-after-delivery`, or `stopped-before-delivery`. This is coarse and temporary — Stage 13 assigns the final, authoritative **publish status** from its enum, and that value supersedes this one. List every changed file and why.

**Do not re-adjudicate the acceptance criteria here.** Stage 11 already graded them, and a second pass by the producer is exactly the self-grading this workflow removed. Cite the verdict instead: the evidence directory, the round number, the per-criterion results as `verdict.json` recorded them, and `tamper_evidence`.

Durable knowledge belongs in one authoritative place — **committed at Stage 11 step 1**, listed here so the homes stay in one table:

| Knowledge | Home |
| --- | --- |
| Domain language | `CONTEXT.md` |
| Hard-to-reverse trade-off decision | `docs/adr/` |
| Rejected enhancement concept | `.out-of-scope/` |
| Implementation contract | issue or agent brief |
| Verification evidence | `<evidence_dir>/` — `verdict.json`, `verdict.md`, gate logs, receipts |
| Verification summary for humans | PR body (rendered from `verdict.md`) |

If this item came from a candidate ledger (`REPORT-SCORING.md` schema), the verdict is what lets it advance: `lifecycle_status` moves to `verifying` at Stage 11 and reaches `completed` only on a `PASS`, with `completion.verification_refs` pointing at the `verdict.json` path. A ledger candidate with no verification reference is not complete, whatever the branch looks like.

## Stage 13 — Publish (explicit policy only; never merge)

Stage 13 is skipped unless the lifecycle caller or user supplies one explicit publish policy for this completed action. A verified `PASS` is necessary evidence, not publication authority.

- `local_only`: record `complete-local-user-deferred`; do not invoke `git push` or `gh pr create`.
- `push_allowed`: after an explicit request to publish this named branch, push the verified branch and record `pushed-pr-pending`; do not create a PR.
- `pr_allowed`: after an explicit request to publish this named branch, push if necessary and create one evidence-carrying PR. Record `complete-published` only when the PR exists and remains open.

No default, inferred, queued, or model-selected policy authorizes network publication. `pr_allowed` does not authorize merge.

**Ship gate — check before touching git.** Two mechanical conditions, and nothing else counts:

1. `compute` exits `0` — re-derived, **without touching the verifier's artifact**:

```bash
python $IV/scripts/verdict.py compute --packet <packet> --out <scratch>/recheck.json
```

`--out` is mandatory here. Without it, `compute` rewrites `<evidence_dir>/verdict.json` and appends a fresh sealed record to the verifier's receipt chain — the producer overwriting the very artifact it is being gated on. Write the re-check somewhere outside the evidence directory and compare.

2. `<evidence_dir>/verdict.json` carries `"verdict": "PASS"` **and** a `packet_lock_sha256` matching the packet for the revision being shipped.

A stale or mismatched lock means the artifact describes different work — that is `blocked-verification`, not a pass. There is no path from `FAIL`, `BLOCKED-UNVERIFIABLE`, or `ESCALATE` to this stage.

The slice was already committed at Stage 11 step 1, so this stage only publishes when explicitly permitted. **Do not commit here** — a new commit moves `HEAD` off `verify_ref` and the verdict stops describing what you are shipping. Run only the command allowed by the chosen policy:

```bash
git status --short          # expect clean; anything here was never verified
git push -u origin <branch>       # push_allowed or pr_allowed only
gh pr create --title "<outcome>" --body-file <body.md>   # pr_allowed only; body from the pr-mwdev skill
```

**Do not use `/land-pr` as the ship path.** It merges — `gh pr merge --merge --delete-branch` — which is exactly what this stage and the human gate forbid. Its preflight ideas are worth borrowing by hand; its merge step is out of scope. `/land-pr` is for *after* a human has authorized the merge, never as this stage's helper.

Rules:

- **Never create a PR automatically.** `gh pr create` requires `pr_allowed` plus an explicit request for this branch. Merging requires an explicit "merge" from the user. `gh pr merge` is out of scope here.
- Write the PR body with the `pr-mwdev` skill (its `production-flywheel` caller contract adds architecture and agent-readability impact and the human-gate line). Never use `--fill`: it builds the body from commit messages and drops the verification block. Before `gh pr create`, run `node "${CLAUDE_SKILL_DIR}/../pr-mwdev/scripts/check-pr-body.js" --caller flywheel --repo . <body.md>`; a nonzero exit means the PR is not created and the item stays `pushed-pr-pending`.
- **The PR carries its evidence.** Include a verification block: the verdict and exit code, the round number (and that earlier rounds exist, if they do), the evidence directory path, the `packet_lock_sha256`, `tamper_evidence` (`hmac` or `chain-only`), the gates that ran, and any pre-existing failures the ratchet excluded. Render it from `<evidence_dir>/verdict.md` rather than retelling it. Do not summarize the round more favorably than the artifact — a reviewer must be able to reach the same verdict without trusting this session.
- **State the human gate explicitly in the PR body:** the machine verdict authorizes review, not merge.
- **If `gh pr create` fails**, report the failure clearly and **leave the branch pushed** if the push succeeded. Give the user the exact remote branch URL and the manual PR-creation step. Classify as `pushed-pr-pending`.

Batched groups (user-elected, Stage 2): commit per item onto the group branch, but run push + PR creation **once per group**, after the group's final item completes Stage 12 — PR titled for the group, body summarizing each item. **Batching does not batch verification:** every item still runs its own Stage 11 round against its own baseline, and the group PR carries one verification block per item. An item that has not reached `PASS` does not ride along in the group PR — reset the group branch to that item's baseline SHA as below.

**Evaluate each item's ship gate at that item's own Stage 11, not at group-PR time.** Once item *i+1* commits onto the shared branch, `HEAD` has moved off item *i*'s `verify_ref`, and re-running `compute` for item *i* then returns `REPO_MOVED` — not because anything is wrong, but because the group branch legitimately advanced. So record each item's gate result (exit code, `PASS`, packet lock) while its revision is still `HEAD`, and let the group PR *cite* those recorded results rather than recomputing them. Recomputing an earlier item's verdict at group-PR time will always block, and blocking there would be a false negative. A completed-but-unshipped item carries `pushed-pr-pending` until the group PR opens, then its status becomes `complete-published`. If an item blocks or is abandoned mid-implementation, reset the group branch to that item's baseline SHA (Stage 7) so half-done work never rides along, record that item's blocked status, and continue — the group PR ships the completed subset.

Publish status must be one of: `complete-published`, `pushed-pr-pending`, `complete-local-user-deferred`, `blocked-no-remote`, `blocked-no-auth`, `blocked-no-gh`, `blocked-verification`, `blocked-unverifiable`, `blocked-verification-escalated`, `stopped-before-delivery`.

The three verification statuses are distinct and must not be collapsed: `blocked-verification` is a `FAIL` (the change was graded and did not meet the contract), `blocked-unverifiable` is a `BLOCKED-UNVERIFIABLE` (nothing was established — infrastructure, not the change), and `blocked-verification-escalated` is exit 3 after three rounds. Reporting an unverifiable round as a failure, or a failure as merely unverifiable, misdescribes what is known.

Gate if publishing succeeds: branch committed, pushed, PR exists (open, not merged), PR body passed `check-pr-body.js --caller flywheel`, stale refs/branches cleaned up.
Gate if PR creation is blocked after push: branch pushed, remote URL provided, exact blocker named, manual PR step given, status `pushed-pr-pending`.

Note: the deep per-item preflight (Stage 3B) should have already caught missing `gh`/auth/remote. If ship fails anyway, it's a genuine blocker — report it and decide whether the queue can safely continue to the next item (usually it can; a per-item ship failure doesn't have to abort the whole queue).
