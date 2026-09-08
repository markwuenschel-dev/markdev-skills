# Project Intelligence Workspace

`shared/project-intelligence-workspace@1` is the canonical repository-local storage primitive for durable analysis, decision, verification, report, cache, and execution state.

## Rule

Durable state belongs to `<repository>/.project-intelligence/`. The primitive adds `/.project-intelligence/` to Git's local `info/exclude`; it does not edit the tracked `.gitignore` unless a human chooses to establish that repository convention separately.

Normal analysis must not scatter durable artifacts into `C:\`, `$HOME`, `Documents`, or generic OS temporary directories.

## Layout

```text
.project-intelligence/
  workspace.json
  lineage/
  evidence/
  verification/
  assessments/
  decisions/
    terrain/
    grill/
  execution/
  reports/
  artifacts/
  cache/
  scratch/
  logs/
  snapshots/              # SEI canonical snapshots
  predictive/             # SEI predictive state
  execution-evidence/     # revision-bound local execution receipts
  static-analysis-cache/  # reclaimable SEI analyzer cache
```

### Lifetimes

- **durable:** lineage, evidence, verification, assessments, decisions, execution, reports, artifacts, logs, snapshots, predictive state, and execution evidence.
- **reclaimable:** cache and static-analysis-cache. Recompute is allowed when the cache is absent.
- **ephemeral:** scratch. It is safe to delete after the owning operation completes.

## Short-path exception

Some Windows tools genuinely require a short staging path. `createScratchSession(..., {shortPathRequired:true})` may use `C:\pi-tmp\<repo-key>\...` (or `/tmp/pi-tmp/...` off Windows). That location is **ephemeral only** and must be cleaned. Final artifacts always return to `.project-intelligence/`.

## Legacy state

Consumers may read old state such as `.autonomous-loop/`, `.decision-terrain/`, `.wayfinder/`, or `.verification/` when their own compatibility contract requires it. New durable writes go to `.project-intelligence/`. Content-addressed immutable legacy artifacts may be copied into the canonical workspace after their bytes and bindings are verified; do not silently rewrite semantic state.

## Worktrees

The workspace is worktree-local. Repository identity and revision remain explicit in artifacts, so an identical immutable artifact from another worktree may be reused only when the consumer's content-addressed reuse rules prove compatibility. Git's `info/exclude` is resolved with `git rev-parse --git-path info/exclude`, which works with ordinary repositories and worktrees.

## Ownership boundary

Creating or updating `.project-intelligence/` and Git's local exclude metadata is runtime-state maintenance, not a source-code mutation. Skills that promise read-only source analysis may write there while leaving tracked worktree files unchanged.

## Cleanup and retention

`scratch/` is disposable and may be removed wholesale with `workspace-cli.js cleanup-scratch`. `cache/` and `static-analysis-cache/` are reclaimable, not authoritative; `workspace-cli.js prune-cache <repo> [days]` previews stale cache files and `--apply` removes only those reclaimable files. Durable lineage, evidence, assessments, decisions, reports, verification receipts, and content-addressed artifacts are never pruned by this command.

## Evidence-boundary invariant

`.project-intelligence/` is analysis/runtime state, never repository evidence. Repository inventories, source scans, candidate searches, duplication analysis, line counts, and file-count denominators must exclude this directory even when a tool enumerates ignored/untracked files. Git-tree-bound analyzers naturally exclude it because the workspace is untracked; filesystem walkers must explicitly prune it. This prevents analysis self-ingestion and feedback loops.

## Worktrees

The workspace records both a `worktree_key` (the concrete checkout path) and `repository_family_key`/`git_common_dir` (the shared Git repository behind linked worktrees). Durable state remains local to the current worktree by default; the family identity is preserved so future deduplication or explicit cross-worktree reuse can prove that two workspaces belong to the same repository rather than guessing from directory names.
