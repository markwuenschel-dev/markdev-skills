---
name: retro-mwdev
description: "Conduct a retrospective on a coding session: find what in the agent's environment (steering files, checks, skills, tooling, information access) made the run slower or wronger, and propose ranked fixes routed to the skill that applies them."
disable-model-invocation: true
---

The user has asked for a **retrospective**. You are improving the coding agent's **environment** so future runs go better. The session is the evidence; the environment is the patient. Retro is read-only: it proposes changes and names the owner that applies each one.

## Steps

1. Call the Skill tool with `writing-for-agents`. Its **context pointer**, **no-op**, **cache**, and **sprawl** tests are the yardstick for every steering-file finding below.

2. Find the session. Default to the current one. For an earlier session, list the project's logs and summarise the chosen one:

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/session-stats.js" --find <repo-root>
   node "${CLAUDE_SKILL_DIR}/scripts/session-stats.js" <session.jsonl> --top 10
   ```

   Logs live in `~/.claude/projects/<slug>/` (`%USERPROFILE%\.claude\projects\` on Windows), where the slug is the repo's absolute path with every non-alphanumeric character replaced by `-`. The summary gives tool-call counts, result sizes, errors, repeated reads, skills invoked, and `unverified_claims`: success statements with no successful test, check, build, or gate command since the last human turn. That last field is a heuristic, so check each hit against the log before calling it a finding. Open the raw `.jsonl` only at the turns a finding needs, with `Grep` on a tool-use id or file name.

   **Done when:** you can point to the turns where the run lost time, tokens, or correctness.

3. Look for candidates in each category. Every candidate cites the turn or tool call that shows it.

   - **Navigation**: the agent searched long for a file or missed a hidden dependency. Fix: a **navigation pointer** in `CLAUDE.md`/`AGENTS.md` or a doc.
   - **Automated checks**: the agent made a mistake a check could catch. Read the repo's own check surface first: `.agentic/command-policy` (`gate-runner`), `package.json`/build-tool `lint`/`check` scripts, pre-commit config, CI workflows. A check that exists but sits unwired, unlisted in the command policy, or silently broken is the finding. A repo with no **guardrail** (no pre-commit hook and no CI job running lint/typecheck/test) is itself a finding.
   - **Verification**: the agent claimed done, fixed, or passing without a fresh receipt. Start from `unverified_claims`. Fix: declare the gate in `.agentic/command-policy` so `gate-runner` can hold the claim.
   - **Coding standards**: the reviewer missed a mistake. Classify the violation. A **mechanical** one (fixed syntactic pattern, banned API, import shape, file location) gets a deterministic check: a custom linter rule, a pre-commit hook, or a CI job, whichever the repo makes cheapest. Reserve `CODING_STANDARDS.md` for **judgement calls** (cross-file consistency, matching surrounding style).
   - **Steering files**: `CLAUDE.md`/`AGENTS.md`, repo or global, carry instructions that belong in coding standards, a check, or a skill; or carry **no-ops** and **caches** of what the environment already says. Use when a steering file is large.
   - **Skills**: a skill fired when it should not have, failed to fire, was followed into the wrong branch, or loaded far more than the run used. Measure exposure with `shared/skill-context-profiler`; check ownership with `ask-matt`.
   - **Tool economy**: expensive or repeated calls (the largest results and repeated reads from step 2), or custom tooling (CLIs, MCPs) that is token-inefficient.
   - **Information access**: a crucial fact was unavailable to the agent. Fix examples: teeing dev-server logs to a file, read-only access to a third-party service, a `research` note in the repo.

4. Present candidates in order of severity, worst first, one block each:

   ```markdown
   ### <n>. <one-line finding>
   - **Category:** <from step 3>
   - **Status:** <confirmed | plausible | unverified>
   - **Evidence:** <turn / tool call / numbers from session-stats>
   - **Change:** <the concrete edit, check, or pointer>
   - **Next-run proof:** <the rerun, negative fixture, or before/after measurement that shows the change worked>
   - **Applies it:** <owner, see Routing>
   ```

   Lead with the top three; list the rest under **Also found**, one line each so nothing severe is dropped, still carrying the four fields: `- <finding> (<category>) — <status> · proof: <next-run proof> · owner: <owner>`. Record hypotheses the evidence contradicted under **Ruled out**, one line each.

   **Done when:** every category is either represented or recorded as `no finding`, and each candidate names its status, next-run proof, and owner.

5. When the user wants the findings acted on, write them as candidate-ledger entries so `production-flywheel` can take them as ledger work. Write a findings file (`{"session": "<log>", "findings": [...]}`; each finding has `title`, `category`, `status`, `evidence` [{`file`, `line`, `observation`}], `change`, `next_run_proof`, `owner`, the eight spine `scores` (1–5), and `effort` S/M/L), then convert it:

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/retro-to-ledger.js" findings.json --out retro-ledger.json
   ```

   Categories are kebab-case (`automated-checks`, `steering-files`, `tool-economy`, and so on). A `plausible` finding may score confidence at most 3, and an `unverified` one at most 2. The spine's own verifier checks the output; a finding with `human_decision_risk` ≥ 4 is held out of the eligible queue until a human decides. Retro writes only this file; applying the fixes stays with the owners.

   **Done when:** the converter exits 0, and the eligible queue it prints is reported to the user.

## Routing

| Change | Owner |
| --- | --- |
| Repo code, checks, CI, `CLAUDE.md`/`AGENTS.md`, `CODING_STANDARDS.md` | `production-flywheel` (or the user directly for a one-line edit) |
| Gate declarations in `.agentic/command-policy` | `gate-runner` policy, shipped through `production-flywheel` |
| A skill's wording, branches, or context policy | `skillwright-forge` |
| Findings the user wants queued as work | `retro-to-ledger.js` output, consumed by `production-flywheel` as ledger candidates |
| Many integrity-style candidates at once | `codebase-integrity-audit-loop` for a verified candidate ledger |

## Reference

### Implementation vs review

All work goes through implementation, then review. The implementation agent carries the most **context pressure**: it explores, writes code, and debugs. The review agent receives a diff and carries the least. So the review agent imposes coding standards, not the implementation agent.

### Where a fix lives

- `CLAUDE.md`/`AGENTS.md`: pushed into every agent's context in the repo. Use sparingly, mostly for **navigation pointers**.
- `CODING_STANDARDS.md`: read during review, not implementation. Add navigation pointers to docs once it passes about 1,000 lines.
- Docs: reference files reached through pointers. Look for an existing doc before writing a new one.
- Skills: for reference whose description should sit in context, or for user-invoked commands.
