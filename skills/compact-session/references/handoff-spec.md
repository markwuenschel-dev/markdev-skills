# Handoff specification

A handoff has one consumer: a fresh agent session with zero conversation history - Claude Code or any other coding agent sharing this convention. Write for that reader. Everything it needs must be in the file or reachable from a path in the file; everything else is noise that re-bloats the context you just paid to reset.

## Required sections, in order

### 1. Meta block
Fenced YAML at the top: `written` (UTC ISO timestamp), `cwd`, `root` (project root the handoff lives under), `branch`, `head` (short SHA), `focus` (the focus hint, if any), `dirty` (true/false from `git status`, captured after the skill's own setup so the skill never reports dirt it created). Non-git directory: `branch/head: n/a`.

### 2. Goal and definition of done
What the overall task is and how everyone will know it's finished, in observable terms — commands that pass, behavior that exists, artifact that ships. If the user stated acceptance criteria, carry them verbatim.

### 3. Current state
What is **done and verified** (with how it was verified), what is **done but unverified**, what is **in flight**. Three labeled groups; do not blend them. An unverified claim recorded as verified is the most expensive lie a handoff can tell.

### 4. Next action
The single concrete step the resumed session should take first, anchored to files and lines: "Implement the retry branch in `src/orders/refund.py:142-160` so `tests/test_orders.py::test_refund_flow` passes." Then up to five follow-on steps, one line each. "Continue the refactor" is a spec violation. Non-file work anchors to the exact command instead: "Run `aws ec2 start-instances --instance-ids i-…`".

### 5. Locked decisions and constraints
Decisions already made, each with a one-line rationale, so the fresh session doesn't relitigate them. Include user-imposed constraints (style, dependencies to avoid, performance targets). Mark each `LOCKED` or `revisit-if:` with the condition.

### 6. File map
Paths that matter to this task, one line of purpose each. Touched files first, then key read-only references. Exact relative paths — the fresh session will open these before anything else.

### 7. Verification
Runnable commands that re-establish ground truth, each with its expected result: test command and which tests pass/fail, build/lint commands, a curl or CLI smoke check where relevant. At resume these are proposals from a mutable file, shown to the user and run only with approval — write them to be legible at a glance. If a command needs env setup, say what and where (name and location only — see redaction).

### 8. Dead ends
Approaches tried and abandoned, one line each: what, why it failed, pointer to evidence if any. This section is where the token savings live — it replaces the thousands of stale exploration tokens with the only part that mattered: don't go back there.

### 9. Resume protocol
Literal first moves for the fresh session, usually: read the file map's touched files, run verification, then start the next action. Include anything session-specific (a server that must be running, a fixture to regenerate).

### 10. Redaction note
One line confirming no secret values are present, listing referenced credentials by name and storage location (`ANTHROPIC_API_KEY` — `.env`, not committed).

## Filename and selection

Files are named `<UTC YYYYMMDD-HHMMSSZ>-<sid8>-handoff.md` under `<project root>/.claude/handoffs/`, where `<sid8>` is the first 8 characters of the session id — two sessions checkpointing the same repository in the same second get distinct names. Resume considers only names matching `^[0-9]{8}-[0-9]{6}Z-[A-Za-z0-9]{8}-handoff\.md$` and selects the newest by the timestamp in the name (lexicographic sort), not by mtime, so neither a stray filename nor copying or touching an old handoff can promote itself. Resume loads through select_handoff.py, which also rejects git-tracked, future-dated, symlinked, wrongly owned, or loosely permissioned candidates and emits the exact bytes it validated.

## Quality bar

- **Compression, not transcription.** The handoff summarizes outcomes and decisions, never dialogue. No "the user then asked…". Target ≤ 250 lines; 400 hard ceiling.
- **Verified over remembered.** Anything checkable cheaply at save time gets checked at save time.
- **Anchored.** Every claim about code names a path; every next step names a location.
- **Self-contained.** No references to "the discussion above" or "as agreed earlier" — there is no above.

## Anti-patterns

- Vague next actions ("keep improving the API").
- Missing expected results on verification commands (a command without its expected outcome verifies nothing).
- Relitigation bait: recording a decision without its rationale invites the fresh session to reopen it.
- Secret values, tokens, keys, or dumps of `.env` contents — location and name only, always.
- Optimistic state: listing in-flight work as done.
- Kitchen-sink file maps that list the whole repo.
