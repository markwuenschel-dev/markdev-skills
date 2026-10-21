---
name: pr-mwdev
description: "Write or rewrite a GitHub PR body a reviewer can judge in a minute: a visual summary, before/after evidence, and merge danger (door and blast radius). Use when drafting or improving a PR description, and whenever land-pr or production-flywheel reaches PR creation. Produces the body text only; never pushes, opens, or merges a PR."
metadata:
  credits:
    skill: show-me
    author: Dex Horthy
    organisation: Humanlayer
    url: "https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md"
---

# PR body

Single source of truth for PR-body shape. `land-pr` and `production-flywheel` decide *whether* a PR exists; this skill decides *what its body says*. Callers own their evidence and hand it in; place it verbatim.

## 1. Gather the inputs

Read, do not ask:

- The change: `git diff <base>...HEAD --stat`, then the hunks that matter, and `git log <base>..HEAD --oneline`. `<base>` is the PR base (default branch unless stacked).
- Vocabulary: the repo's `CONTEXT.md` (or `CONTEXT-MAP.md` in a multi-context repo). Use its terms for domain concepts; skip when absent.
- Evidence the session already produced: validation commands and their results, `gate-runner` receipts, a `production-flywheel` `verdict.md`, screenshots the user captured.
- Impact the session already produced: a `connected-impact-sweep` report, if one ran for this change.
- An existing body: `gh pr view <n> --json body,title` when rewriting.

**Done when:** you can state the outcome in one sentence and every evidence item has a source you can name (a command and its exit code, a receipt path, a file).

## 2. Fill the template

```markdown
## Summary

<one sentence: the outcome, in domain language>

<one visual: pseudocode, call tree, component tree, file tree, Mermaid, or diff-sketch>

## Evidence

- **Before:** <failing test / output / screenshot>
  **After:** <passing test / output / screenshot>

| Check | Source | Status |
| --- | --- | --- |
| <command or check> | local / CI / user / receipt path | PASS / FAIL / BLOCKED-UNVERIFIABLE / SKIPPED / NOT RUN |

<caller evidence block, pasted verbatim>

## Merge Danger

**Door:** <one-way | two-way | unknown> — <the reason, one line>

**Blast Radius:** <one word>

<consumers or surfaces that could break; how to roll back>

## Out of scope

<deliberately excluded work, one bullet each>
```

Section rules:

- **Summary.** Read [visuals.md](references/visuals.md) to pick the view.
- **Evidence.** A screenshot beats execution output for a visual change; execution output (the exact test that failed and now passes, with the command) beats prose. Every line traces to an input from step 1. Each check gets exactly one status: PASS, FAIL, BLOCKED-UNVERIFIABLE (the gate-runner or independent-verification outcome when a check could not be judged), SKIPPED (deliberately not run, with the reason), or NOT RUN (not attempted). When a check ran through `gate-runner`, put its receipt path (`.agentic/gate-evidence/<gate>/<run-id>/receipt.json`) in the Source cell and copy the receipt's `outcome` as the status. When no before/after exists, write `No before/after captured`.
- **Merge Danger.** A one-way door is anything a revert cannot undo: a data migration or delete, a published API, schema, or contract change with outside consumers, a secret rotation, an external side effect such as sent mail or a charged card, or a deploy with no rollback path. Everything else is two-way. Use `unknown` when the diff cannot settle it (for example, an external consumer you cannot inspect), and say what would settle it. Take blast radius from the `connected-impact-sweep` report when one exists; otherwise derive it from the diff's touched consumers (layout shift, consumer breakage, CI, data, mobile). Name the rollback: revert the merge commit, a feature flag, a down-migration, or `none`.
- **Out of scope.** Omit the heading when nothing was excluded.
- No preamble, no restated title.

**Done when:** every heading is filled or deliberately omitted, every claim traces to step 1, the body reads in about a minute, and the checker exits 0:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-pr-body.js" [--caller land-pr|flywheel] --repo <repo-root> <body.md>
```

Pass `--caller` when a caller invoked this skill. `--repo` resolves every cited receipt and fails when the status contradicts the receipt's outcome, or a PASS rests on a stale receipt. The checker proves structure and receipt consistency, never that an uncited claim is true.

## 3. Hand off

Write the body to a temporary file outside the repository and return its path. The caller passes it with `--body-file`.

When the user asked only for a body, show it and stop. When the user asked to update an existing PR's description, run `gh pr edit <n> --body-file <path>` and confirm with `gh pr view <n> --json body`. Pushing, creating, and merging belong to `land-pr` or `production-flywheel`.

## Caller contracts

| Caller | Evidence block it supplies | Extra lines it requires |
| --- | --- | --- |
| `land-pr` (local-change mode) | Validation commands with results (at least one status-table row), shipment SHA | Deployment impact under Merge Danger when `-ec2` is set |
| `production-flywheel` (Stage 13, `pr_allowed`) | Verification block rendered from `<evidence_dir>/verdict.md`, including `packet_lock_sha256` and `tamper_evidence` | Architecture and agent-readability impact (one line each, under Summary); the human-gate line: *the machine verdict authorizes review, not merge* |
| Batched flywheel group | One verification block per item | One Summary line per item |

`--caller land-pr` and `--caller flywheel` enforce the rows above that a machine can check: the status table for `land-pr`; the human-gate line, `packet_lock_sha256`, and `tamper_evidence` for the flywheel.
