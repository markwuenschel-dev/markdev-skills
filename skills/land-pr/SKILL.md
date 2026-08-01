---
name: land-pr
description: "Ship one local repository change or an explicit queue of existing GitHub pull requests. For local changes, inspect, validate, commit, push, write a staff-level PR, preflight, and merge with a merge commit. For explicit PR numbers such as `$land-pr 45, 47, 48`, order and land that queue serially. Add `-ec2` to either form to deploy the final merged revision of each affected mapped service to its configured EC2 target. Use for land, ship, submit, merge, or deploy work; never merge or deploy without the user's request."
---

# Land PRs

Use proof as the gate. This is the sole landing skill.

## Invocation and mode selection

- **Local-change mode:** `$land-pr`, `land this`, or `ship this`. Inspect the current worktree, create or reuse one focused shipment branch, validate, commit, push, write a ready PR, preflight it, and merge it.
- **Queue mode:** `$land-pr 45, 47, 48`, `land PRs 45 47 48`, or `land all my PRs`. These are **existing PRs**. Do not create a duplicate PR, commit, stage, or alter unrelated local changes. With no list, discover the authenticated user's open, ready PRs against the default branch.
- **EC2 overlay:** append `-ec2`, e.g. `$land-pr 45, 47, 48 -ec2`. It authorizes the post-merge release phase as well as landing. Read [EC2 release](references/ec2-release.md) before any target mutation.
- An explicit PR order is the queue confirmation. Otherwise print the proposed order and wait for confirmation. A request to land a single local change authorizes its one PR; it does not authorize unrelated open PRs.

The landing strategy is always a **merge commit**. Do not substitute squash or rebase merely because they are defaults. If repository policy cannot accept a merge commit, stop and report that incompatibility; do not choose a different history shape.

## Required preflight and safety rules

Before state change, read applicable `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and deployment instructions. Run and retain:

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

Require authenticated `gh`, reachable `origin`, and `git merge-tree -h` support for `--write-tree`. Capability or authentication failure stops with exact output. Never reset, stash, discard, overwrite, force-push, rebase, use `--admin`, or use conflict-strategy shortcuts. Never expose secrets. A dirty worktree is a blocker only for **local-change mode**; queue mode leaves it untouched and reports it.

## A. Local-change mode

### 1. Inspect and isolate

```bash
git status --short --branch
git diff --stat
git diff --check
git diff
git diff --cached
git ls-files --others --exclude-standard
```

Classify every tracked, staged, and untracked item as intended, excluded, or blocker. Surface `.env` files, private keys, tokens, generated artifacts, caches, build products, and nested repositories. Continue only with one coherent intended change and a clean `git diff --check`.

Resolve the default branch and shipment branch:

```bash
default_branch="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')"
current_branch="$(git branch --show-current)"
git ls-remote --exit-code origin "refs/heads/$default_branch"
```

Create `land/<short-description>` only from the default branch; otherwise reuse the current branch only when it is focused and non-detached. Fetch and merge the current default branch if the shipment branch is behind; on conflict, stop and report paths.

### 2. Validate, commit, and push

Run the smallest authoritative repository validation set. Stage only intended paths, then prove the staged contents:

```bash
git status --short
git diff --cached --stat
git diff --cached --check
git diff --cached
git commit -m "<type(scope): concise description>"
git rev-parse HEAD
git push -u origin "$(git branch --show-current)"
git ls-remote --exit-code --heads origin "$(git branch --show-current)"
```

Do not make an empty commit. When nothing is staged, continue only if the focused shipment branch already contains intended commits beyond `origin/$default_branch`. Record validation results and the shipment SHA.

### 3. Write or update a staff-level PR

Find an open PR for the shipment branch. If none exists, create a ready PR with a precise title and a Markdown body that includes: **Problem / outcome**, **Design and affected contracts**, **Risk and invariants**, **Validation with commands/results**, **Deployment or rollback impact**, and **Scope deliberately excluded**. State uncertainty plainly; do not invent reviewers, benchmarks, or production proof.

```bash
gh pr list --head "<shipment-branch>" --base "$default_branch" --state open --limit 2 --json number,url,isDraft,headRefName,headRefOid,baseRefName
gh pr create --base "$default_branch" --head "<shipment-branch>" --title "<concise outcome>" --body-file "<temporary-markdown-file>"
gh pr view "<pr-number>" --json number,url,isDraft,baseRefName,headRefName,headRefOid
```

Use the resulting PR as a one-entry queue, then continue at **B. Queue landing**. If `-ec2` is present, defer cleanup until **C. EC2 overlay**.

## B. Queue landing

### 1. Discover and confirm

For no-list queue mode, discover candidates and exclusions:

```bash
gh pr list --state open --base "$default_branch" --author "@me" --json number,title,isDraft,headRefName,headRefOid,baseRefName,url --limit 200
gh pr list --state open --json number,title,author,isDraft,baseRefName --limit 200
```

Default candidates are the authenticated user's non-draft PRs targeting the default branch. Explicit IDs may include foreign-author PRs; drafts additionally require explicit ready-to-land authorization. Order explicit IDs as supplied; otherwise put stack parents before children and sort independent PRs by ascending number. Print position, number, title, base, short head SHA, stack relation, and exclusions. Zero candidates stops cleanly.

### 2. Land one PR at a time

For each current entry only, inspect its live state:

```bash
gh pr view "<n>" --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,headRefOid,url
```

Already merged or closed is terminal and advances. If a merged stack parent leaves a child still targeting its deleted branch, retarget the child to `$default_branch`, then re-verify. Record the head SHA.

Preflight the exact head against the moving default tip:

```bash
git fetch origin "$default_branch"
base_sha="$(git rev-parse "origin/$default_branch")"
git merge-tree --write-tree --name-only --messages "$base_sha" "<head-sha>"
```

Exit `0` is clean; `1` is conflict; any other result is `blocked-error` with output. On conflicts, `CONFLICTING`, or a protection-required `BEHIND` state, update server-side only:

```bash
gh pr update-branch "<n>"
```

Re-read the PR and repeat preflight after a successful update. A conflict-resolution failure is `blocked-conflict`; mark its stack children `blocked-parent`. Never resolve or rewrite the author's branch locally.

Require reviews and required checks:

```bash
gh pr checks "<n>" --required --watch --fail-fast=false
gh pr view "<n>" --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup
```

Missing review is `blocked-review`; failed checks are `blocked-checks`; checks still pending beyond this session are `left-open-pending-checks`. If the default tip advanced, repeat the preflight. Merge only the recorded head with a merge commit:

```bash
gh pr merge "<n>" --merge --delete-branch --match-head-commit "<head-sha>"
gh pr view "<n>" --json state,mergedAt,mergeCommit,headRefName,url
```

Merge-queue / auto-merge behavior is `queued` only when it preserves the required merge-commit strategy; otherwise block and report the policy conflict. For a completed merge, fetch the default branch and prove the returned merge SHA has two parents:

```bash
git fetch origin "$default_branch"
git rev-list --parents -n 1 "<merge-sha>"
```

Record `merged-<sha>` only when GitHub says `MERGED` and the parent list contains the commit plus two parents. A blocker records its terminal state and the loop continues; unexpected mutating-command failure stops with exact output.

### 3. Synchronize

In the primary default-branch worktree:

```bash
git -C "<main-worktree>" fetch --prune origin
git -C "<main-worktree>" switch "$default_branch"
git -C "<main-worktree>" pull --ff-only origin "$default_branch"
```

Record the synchronized `origin/$default_branch` SHA. For a queue, this is the sole `release_sha` used by the EC2 overlay; never deploy a mutable branch or one release per PR.

## C. EC2 overlay (`-ec2` only)

Run this section only after B.3. Consider only entries that actually merged. Map their changed repositories to exactly one service each, deduplicate services, and deploy each service once at `release_sha`. A blocked or queued PR contributes no changes; say so if another merged PR releases the same service at a revision that excludes it.

Read [EC2 release](references/ec2-release.md), resolve and print each service contract, and run all read-only target reconciliation before mutating any target. Release services serially in documented dependency order (otherwise stable name order). A failed activation rolls back that service and halts later releases; they become `not-released-halted`. A target with identity, cleanliness, migration/backup, health, or kill-switch failure is `not-released-blocked` and remains untouched.

## D. Cleanup and final report

After the merge outcome (and, if requested, every EC2 outcome), synchronize and audit all worktrees, local branches, remote refs, and open PRs. Remove only a branch/worktree/ref with merge proof and its removal predicate: linked worktree clean, branch not checked out, and no open PR uses its remote branch. In a single-maintainer repository, perform this sweep repo-wide; otherwise ask before removing a branch or worktree outside this land.

```bash
git -C "<main-worktree>" worktree list --porcelain
git -C "<main-worktree>" branch --format="%(refname:short)"
git -C "<main-worktree>" for-each-ref refs/remotes/origin --format="%(refname:short)"
gh pr list --state open --limit 1000 --json headRefName,baseRefName,url
```

Use non-forcing deletion where ancestry proves reachability. A squash-like branch must never be force-deleted in this unified merge-commit workflow. Preserve and name dirty, unique, or open-PR branches. Only after every candidate is accounted for may the primary worktree run `worktree prune`, reflog expiry, and `gc --prune=now`.

Finish with a table: queue position, PR number, title, terminal landing state, merge SHA or decisive blocker, plus (for `-ec2`) service, target, prior release, `release_sha`, probe results, and release state. Report validation results, PR URLs, cleanup proof, and exactly what still needs human action. Never claim main-only cleanup, a merge, or a deployment without its recorded proof.
