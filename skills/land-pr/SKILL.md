---
name: land-pr
description: "Land a repository change through a GitHub pull request: prove scope, validate, commit, merge safely, and restore a main-only repository by pruning every merged or stale branch, worktree, and ref repo-wide — including ones left behind by parallel subagents. Built for single-maintainer repos where no other collaborator's branch could be at risk. Use when the user asks to land, ship, merge, or submit a PR/branch to main, or asks to clean up, sweep, or tidy stale branches/worktrees even when no PR is being landed right now."
---

# Land a PR

Use **proof** as the gate: complete a phase only when command output proves it. A successful land leaves the GitHub default branch (`main` in this workflow) as the only local branch, the only origin branch apart from `origin/HEAD`, and the only worktree, with stale refs and unreachable commits pruned.

Cleanup begins only after GitHub proves the merge. An open pull request keeps its branch and worktree live; report that state rather than claiming a main-only finish.

## Required tools

Require `git`, `gh`, authenticated GitHub access, an accessible `origin`, and a Git version whose `git merge-tree -h` lists `--write-tree`. Use the active shell; translate shell variables, redirection, and conditionals without changing the Git or GitHub CLI operation.

Before changing repository state, run:

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

Confirm that the merge-tree help output includes `--write-tree`; a help-only exit status is not a capability failure. Authentication, repository, origin, or merge-tree capability failures stop the land with their exact output.

## Safety rules

- Inspect tracked, staged, and untracked changes before staging.
- Treat "commit everything" as permission only after checking for secrets, credentials, generated artifacts, caches, build products, and nested repositories.
- Surface `.env` files, private keys, access tokens, and credential files as blockers.
- Follow applicable `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and scoped repository instructions.
- Preserve user changes while resolving a shipment; a clean tree is never obtained by reset, stash, discard, or overwrite.
- Respect required checks, branch protection, review requirements, merge queues, and repository merge policy.
- Preserve draft pull requests unless the user explicitly authorizes landing them.
- Treat main-only cleanup as explicit post-merge policy: remove a non-default branch, ref, or worktree only after merge proof and a clean-status check. A dirty, unique, or open-PR branch blocks the final main-only claim.
- In a single-maintainer repo (no other human collaborators), apply Section 11's repo-wide sweep by default and without pausing for confirmation — this includes branches and worktrees left behind by subagents that were never part of the current landing. Merge proof remains the only gate; do not add an extra confirmation step on top of it. If the repo has other collaborators, ask before deleting a branch or worktree that isn't the one just landed, since it may not be the user's to remove.

## 1. Inspect the complete change set

Read applicable repository instructions, then run:

```bash
git status --short --branch
git diff --stat
git diff --check
git diff
git diff --cached
git ls-files --others --exclude-standard
```

Inspect every untracked file and classify every changed or untracked item as intended, excluded, or a blocker. Continue only when the intended changes form one coherent landing.

**Proof:** `git diff --check` succeeds and every item is classified.

## 2. Determine the temporary shipment branch

Resolve the GitHub default branch and record the current branch:

```bash
default_branch="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')"
current_branch="$(git branch --show-current)"
git ls-remote --exit-code origin "refs/heads/$default_branch"
```

When on the default branch, create exactly one temporary branch:

```bash
git switch -c "land/<short-description>"
```

When already on another branch, reuse it only when it is focused on this landing. A detached `HEAD` or ambiguous branch purpose stops the land.

**Proof:** record `default_branch`, `current_branch`, and the shipment worktree path.

### Keep a long-lived shipment branch fresh

When the shipment branch (or its worktree) has existed for a while — common when a subagent has been working in its own worktree while other work landed on `default_branch` in the meantime — check how far it has drifted before doing anything else:

```bash
git fetch origin "$default_branch"
git rev-list --left-right --count "origin/$default_branch...HEAD"
```

If the branch is behind, merge the latest default branch into it (do not rebase — rebasing here would rewrite commits a subagent or the user is still relying on, and Section "Merge policy boundaries" already rules out rebase as a landing shortcut):

```bash
git merge "origin/$default_branch"
```

Resolve any conflicts surfaced by this merge now, while the change is small and the author (or subagent) has full context — this is the cheapest point to catch the conflict that would otherwise surface as a failed Section 7 preflight or a failed Section 9 merge after everything else is already done. If the merge conflicts, stop and report the conflicting paths rather than guessing at resolution.

## 3. Validate before committing

Run the smallest authoritative validation set for the intended change, preferring repository-documented commands. Repair failures caused by the landing and rerun the relevant command; report failures that cannot be safely resolved.

**Proof:** every required validation has a successful result.

## 4. Stage and commit

Stage only intended paths. Use `git add -A` only when the entire worktree is intended; otherwise stage approved paths explicitly. Review the staged proof:

```bash
git status --short
git diff --cached --stat
git diff --cached --check
git diff --cached
```

Commit the complete staged diff:

```bash
git commit -m "<type(scope): concise description>"
git rev-parse HEAD
```

When nothing is staged, create no empty commit. Continue only when the shipment branch already contains intended commits beyond the default branch.

**Proof:** record the shipment head SHA.

## 5. Push

Push the shipment branch and prove the remote head:

```bash
git push -u origin "$(git branch --show-current)"
git ls-remote --exit-code --heads origin "$(git branch --show-current)"
```

**Proof:** the remote branch resolves to the recorded shipment head SHA.

## 6. Create or update the pull request

Find an open pull request for the shipment branch:

```bash
gh pr list --head "<shipment-branch>" --base "$default_branch" --state open --limit 2 --json number,url,isDraft,headRefName,headRefOid,baseRefName
```

When none exists, write a temporary Markdown body covering the change, reason, validation, and remaining caveats, then create a ready pull request:

```bash
gh pr create --base "$default_branch" --head "<shipment-branch>" --title "<title>" --body-file "<temporary-markdown-file>"
```

Query the pull request and verify its base, head branch, and head SHA match the shipment.

**Proof:** record the PR number, URL, base SHA, and shipment head SHA.

## 7. Preflight the merge without touching the worktree

Immediately before relying on GitHub mergeability, fetch the current target tip and simulate the ordinary two-branch merge:

```bash
git fetch origin "$default_branch"
base_sha="$(git rev-parse "origin/$default_branch")"
git merge-tree --write-tree --name-only --messages "$base_sha" "<shipment-head-sha>"
```

Treat exit status `0` as a clean simulated merge, `1` as conflicts, and any other nonzero status as an execution error. Capture and report the output on a nonzero exit; do not infer cleanliness from output shape. The fetch updates remote-tracking refs; `merge-tree --write-tree` does not modify the index or working tree. If the target tip advances, fetch and rerun it against the new tip before merging.

Avoid strategy options such as `-X ours`, `-X theirs`, whitespace suppression, rename thresholds, or custom merge bases unless repository policy or the user explicitly requires them. The preflight complements, but never replaces, CI, reviews, branch protection, or GitHub mergeability.

## Merge policy boundaries

Use the repository's configured two-branch merge behavior unless an explicit policy says otherwise. Choose history shape from repository policy, protection, or user direction:

- squash when the repository favors one logical commit per pull request;
- merge commit when preserving the integration boundary is intentional;
- rebase merge only when the repository expects linearized individual commits.

Avoid `--no-ff`, local rebases, force-pushes, octopus merges, subtree merges, and the `ours` strategy as landing shortcuts. Detect and respect existing `rerere`, merge-driver, LFS, generated-file, and conflict-style configuration; leave global Git configuration unchanged.

## 8. Require a green merge state

Watch required checks and inspect the pull request:

```bash
gh pr checks "<pr-number>" --required --watch --fail-fast=false
gh pr view "<pr-number>" --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefOid,headRefOid,statusCheckRollup,url
```

Merge only when the pull request is open, ready, mergeable, approved where required, green on required checks, and still points at the recorded shipment head SHA. If checks remain pending beyond the active session, report the exact state and leave the PR open.

## 9. Merge

Rerun Section 7 if `origin/$default_branch` has advanced since its recorded `base_sha`. Use the repository-supported strategy; prefer squash only when repository policy permits it:

```bash
gh pr merge "<pr-number>" --squash --delete-branch --match-head-commit "<shipment-head-sha>"
```

When branch protection requires a merge queue or auto-merge, let GitHub queue the PR and report that state; cleanup waits for a later run that verifies an actual merge. Do not use administrator bypasses.

Verify the merge:

```bash
gh pr view "<pr-number>" --json state,mergedAt,mergeCommit,headRefName,url
```

**Proof:** GitHub reports `MERGED`, with a merge commit and timestamp.

## 10. Synchronize the default branch

Choose the primary worktree that will keep the default branch. If the shipment ran in a linked worktree while the default branch is already checked out elsewhere, run the remaining commands from that existing default-branch worktree.

```bash
git -C "<main-worktree>" fetch --prune origin
git -C "<main-worktree>" switch "$default_branch"
git -C "<main-worktree>" pull --ff-only origin "$default_branch"
```

**Proof:** `<main-worktree>` is clean, on the default branch, and at the current `origin/$default_branch` tip.

## 11. Restore main-only state

Audit every worktree, local branch, origin remote-tracking ref, and open pull request:

```bash
git -C "<main-worktree>" worktree list --porcelain
git -C "<main-worktree>" branch --format="%(refname:short)"
git -C "<main-worktree>" for-each-ref refs/remotes/origin --format="%(refname:short)"
gh pr list --state open --limit 1000 --json headRefName,baseRefName,url
```

For each non-default candidate, record one merge proof: the just-merged PR, a GitHub merged PR for that branch, or ancestry in the default branch. Then apply its removal predicate: a linked worktree is clean, a local branch is no longer checked out, and an origin branch has no open pull request. Only a candidate with both proof and its predicate may be removed. Remove a qualifying linked worktree from `<main-worktree>`:

```bash
git -C "<main-worktree>" worktree remove "<stale-worktree>"
```

Delete each proven local branch after it is no longer checked out. Use `git branch -d` when it is reachable from the default branch. A squash-merged branch may use `git branch -D` only with its GitHub merged-PR proof.

Retain only `origin/$default_branch`, `origin/HEAD`, and origin branches serving open pull requests. Delete every other origin branch with merge proof, then prune tracking refs:

```bash
git push origin --delete "<stale-branch>"
git -C "<main-worktree>" fetch --prune origin
git -C "<main-worktree>" worktree prune
```

After every non-default branch and worktree is accounted for, expire reflogs and prune unreachable commits:

```bash
git -C "<main-worktree>" reflog expire --expire=now --expire-unreachable=now --all
git -C "<main-worktree>" gc --prune=now
```

A dirty worktree, unique branch, or open-PR branch blocks the main-only finish. Report its path or branch name instead of deleting it.

## 12. Final proof

Run:

```bash
git -C "<main-worktree>" status --short --branch
git -C "<main-worktree>" worktree list --porcelain
git -C "<main-worktree>" branch --format="%(refname:short)"
git -C "<main-worktree>" for-each-ref refs/remotes/origin --format="%(refname:short)"
git -C "<main-worktree>" fsck --no-reflogs --unreachable
gh pr view "<pr-number>" --json state,mergedAt,mergeCommit,url
```

**Proof:** the default branch is the only local branch; `origin/$default_branch` is the only origin branch apart from `origin/HEAD`; its worktree is the only worktree; the working tree is clean; no unreachable objects remain; and the PR is merged. Report the PR URL, merge commit, validation results, and every branch, ref, worktree, or commit class removed.

## Standalone cleanup (no active PR)

Use this entry point when the user asks to tidy up, sweep, or restore a clean `main` but isn't landing a PR in this session — for example, several subagent worktrees finished and merged (via GitHub directly, via a merge queue, or in an earlier session) and never got swept afterward.

Run Sections 10 and 11 exactly as written, with one difference: since there is no PR number from the current session, gather merge proof for each branch independently:

```bash
gh pr list --state merged --limit 1000 --json number,headRefName,mergedAt,mergeCommit
git -C "<main-worktree>" log --oneline "$default_branch" --grep="Merge pull request" -20
```

A branch qualifies for the same removal predicate as Section 11 (clean worktree, not checked out, no open PR) once one of these independently confirms it merged. Everything else in Sections 10–12 — worktree removal, branch deletion, origin ref deletion, reflog expiry, `gc --prune=now`, and the final proof — is unchanged. Do not skip the merge-proof check just because there's no PR number in hand; a branch with no proof at all is reported, not deleted.
