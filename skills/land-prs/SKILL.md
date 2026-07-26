---
name: land-prs
description: "Lands multiple open GitHub pull requests serially with per-merge proof: discovers and orders the landing queue (user-given order, then stacked parents first, then ascending PR number), confirms the queue once, then for each PR preflights against the moving default-branch tip with merge-tree, updates the branch server-side when needed, requires green required checks, merges with --match-head-commit, and finishes with one land-pr-style main-only restoration and a landing report. Use when several open PRs need landing — 'land all my PRs', an enumerated PR list, stacked PRs that must merge in order, or the open PRs left by a production-flywheel queue run. For a single working-tree change or a single PR, use land-pr instead; this skill opens no PRs and deploys nothing. It never merges without the user's request and a confirmed landing queue."
allowed-tools: "Bash(git *), Bash(gh *)"
---

# Land multiple open PRs

Land a set of open pull requests **serially, one terminal state per PR**, using proof as the gate exactly as `land-pr` does for a single landing. The unit of work here is the **landing queue**: an ordered list of PR numbers the user has confirmed. Everything before the queue confirmation is read-only discovery; everything after it auto-advances without per-PR pauses, in the production-flywheel style — confirmation authorizes the whole queue, blockers get recorded rather than re-asked.

Boundary with `land-pr`: that skill takes a working-tree change from inspection through commit, PR creation, one merge, and main-only cleanup. This skill starts where the PRs already exist and only orchestrates their landing; it never creates commits or PRs. Policy here deliberately mirrors `land-pr`'s Safety rules and Merge policy boundaries — **if `land-pr`'s policy changes, update the mirrored rules here in lockstep** (this is a hand-maintained mirror in the connected-impact sense).

## Interface

- **Inputs:** an optional explicit PR list and/or order from the user's request. Nothing else is required.
- **Default scope when no list is given:** open, non-draft PRs targeting the default branch, authored by the authenticated user (`--author "@me"`). A draft or foreign-author PR enters the queue only when the user names its number — and a draft additionally needs explicit authorization to land as a draft-turned-ready.
- **Outputs:** a landing report (one terminal state per queue entry, with proof), and a repository restored to `land-pr`'s main-only definition when nothing remains open — otherwise an honestly reported partial end-state.
- **Side effects:** merges into the default branch, remote and local branch deletions, worktree removal, reflog expiry and `gc`. Nothing is deployed.
- **Dependencies:** `git` whose `merge-tree -h` lists `--write-tree`, authenticated `gh`, an accessible `origin`. The `land-pr` skill itself is not invoked at runtime; only its policy is mirrored.

## Required tools

Before any state-changing command, run and keep the outputs:

```bash
git --version
git merge-tree -h
git rev-parse --show-toplevel
git status --short --branch
git remote get-url origin
git worktree list --porcelain
gh --version
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef
```

A missing capability, failed authentication, missing origin, or `merge-tree` without `--write-tree` stops the run with the exact output. A help-only exit status from `merge-tree -h` is not a failure. A dirty working tree does **not** stop the run — merges happen on GitHub's side — but it blocks the final main-only claim, and the report must say so rather than cleaning anything by reset, stash, discard, or overwrite.

**Proof:** capability outputs recorded; `default_branch` resolved via `gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'`.

## Standing rules (hold for the whole run)

- Merge only PRs in the confirmed landing queue. Never merge, close, or convert a PR outside it.
- Exactly one PR is in flight at a time. Do not update, re-check, or pre-warm later PRs early: each merge moves the tip, so early work is wasted CI and stale proof.
- No force-push, no local rebase of PR branches, no `--admin` or other bypass, no merge-strategy shortcuts (`-X ours`/`theirs`, whitespace suppression, custom bases). Respect branch protection, required reviews, merge queues, and repository merge policy — squash only where policy permits, merge commit where the integration boundary is intentional, rebase-merge only where the repository expects it. *(Mirror of `land-pr` — keep in lockstep.)*
- A blocked PR records its state and the run continues to the next queue entry; it never silently aborts the run and is never "fixed" by loosening a rule. Stack children of a blocked parent are recorded `blocked-parent` and skipped.
- Any state-mutating command failing in a way this skill does not anticipate stops the loop, reports the exact output, and leaves the repository as it stands.

## 1. Discover and order the landing queue

```bash
gh pr list --state open --base "$default_branch" --author "@me" --json number,title,isDraft,headRefName,headRefOid,baseRefName,url --limit 200
gh pr list --state open --json number,title,author,isDraft,baseRefName --limit 200
```

The first query builds the default scope; the second exists to *report* what was excluded (drafts, foreign authors, PRs with a non-default base) so exclusions are visible, not silent. A PR whose base is another open PR's head branch is a **stack child** of that PR.

Order the queue: the user's explicit order wins; otherwise topological order (stack parents before children); ties and independent PRs by ascending PR number. Print the queue as a table — position, PR number, title, base, short head SHA, stack relation — plus the excluded list with reasons.

**Gate — human approval:** proceed only when the user confirms the printed queue. A request that already enumerated the PRs or their order **is** that confirmation — restate the queue and continue without asking again. Zero candidates: report that and stop. After confirmation, advance through the queue automatically; do not ask "continue?" between PRs.

## 2. Land each PR at its turn

Run this sequence for the current queue entry only.

**a. Verify the PR live.**

```bash
gh pr view "<n>" --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,headRefOid,url
```

Already merged or closed → terminal state `already-merged` / `already-closed`, next entry. A stack child whose parent just merged with branch deletion should now show `baseRefName == default_branch` (GitHub retargets on base-branch deletion); if it still points at the deleted branch, retarget explicitly with `gh pr edit "<n>" --base "$default_branch"` and re-verify. Record the head SHA — it is the only SHA later steps may trust.

**b. Preflight against the moving tip.**

```bash
git fetch origin "$default_branch"
base_sha="$(git rev-parse "origin/$default_branch")"
git merge-tree --write-tree --name-only --messages "$base_sha" "<head-sha>"
```

Exit `0` is a clean simulated merge; `1` is conflicts; any other status is an execution error → terminal state `blocked-error` with the captured output, next entry. Never infer cleanliness from output shape. The preflight complements CI, review, and GitHub mergeability — it replaces none of them. *(Same tool and reading as `land-pr` §7.)*

**c. Update the branch when the merge is not clean.** On preflight conflicts, or when GitHub reports `CONFLICTING`, or when protection requires the branch to be up to date and it is `BEHIND`:

```bash
gh pr update-branch "<n>"
```

This merges the base into the head server-side — no force-push, no local rebase. On success the head SHA changed: re-run step a to record the new head, then step b. On failure with conflicts → terminal state `blocked-conflict` with the output; mark its stack children `blocked-parent`; next entry. Conflict *resolution* is the user's decision, reported, never improvised mid-queue.

**d. Require a green merge state.**

```bash
gh pr checks "<n>" --required --watch --fail-fast=false
gh pr view "<n>" --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid
```

Required review missing → `blocked-review`, next entry. Required checks still pending beyond the active session → `left-open-pending-checks`, next entry. Failed required checks → `blocked-checks` with the failing check names, next entry.

**e. Merge with an exact head match.** If `origin/$default_branch` advanced since this entry's recorded `base_sha`, redo step b first. Then:

```bash
gh pr merge "<n>" --squash --delete-branch --match-head-commit "<head-sha>"
```

`--squash` only where repository policy permits it; otherwise the policy-supported strategy. Merge queue or auto-merge configured → let GitHub queue it, terminal state `queued` (its cleanup belongs to a later run that verifies the actual merge), next entry.

**f. Prove the merge.**

```bash
gh pr view "<n>" --json state,mergedAt,mergeCommit,headRefName,url
```

**Proof:** GitHub reports `MERGED` with a merge commit and timestamp → terminal state `merged-<merge-sha>`.

**Per-entry completion criterion:** exactly one terminal state recorded — `merged-<sha>`, `queued`, `left-open-pending-checks`, `blocked-conflict`, `blocked-checks`, `blocked-review`, `blocked-error`, `blocked-parent`, `already-merged`, or `already-closed` — with its command-output proof.

## 3. Synchronize the default branch

After the last queue entry, in the primary default-branch worktree:

```bash
git -C "<main-worktree>" fetch --prune origin
git -C "<main-worktree>" switch "$default_branch"
git -C "<main-worktree>" pull --ff-only origin "$default_branch"
```

**Proof:** `<main-worktree>` is clean, on the default branch, and at the current `origin/$default_branch` tip.

## 4. Restore main-only state — once

Run `land-pr`'s main-only restoration exactly — audit every worktree, local branch, and origin ref; one merge proof plus its removal predicate per candidate; branches serving open, queued, or blocked PRs stay live and are reported; `worktree prune`, then `reflog expire --expire=now --expire-unreachable=now --all` and `gc --prune=now` only once every non-default candidate is accounted for. *(Mirror of `land-pr` §10–§12 — keep in lockstep.)* A dirty worktree, unique branch, or open-PR branch blocks the main-only claim; report it by name instead of deleting it.

**Proof:** `land-pr` §12's final checks pass, or the partial end-state is stated with the blocking names.

## 5. Landing report — termination

Print one table: position, PR number, title, terminal state, proof (merge SHA, or the blocker's decisive output line), followed by the final repository state and a short list of exactly what needs the user (conflicts to resolve, reviews to obtain, queued merges to re-verify later). The run is complete when every queue entry has a terminal state and this report is printed — never before, and never with a summary that claims more than the proofs show.
