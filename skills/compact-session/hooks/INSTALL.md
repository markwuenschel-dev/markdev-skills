# compact-session hooks — install

Two optional hooks, macOS/Linux only. Neither is required for the skill
itself; both always exit 0 and never block a prompt.

**`context_nudge.py`** (UserPromptSubmit) — reads the transcript tail on each
prompt (256KB, widening up to 16MB if a single huge record hides the usage
data), estimates current context from the last main-chain assistant usage
record, and past ~120k tokens emits `additionalContext` JSON. Claude Code
injects that as a system reminder — no visible transcript entry — and Claude
follows the skill's offer gate: names the nudge as its signal, offers a
checkpoint, writes nothing without your yes. Debounced: once at threshold,
then only per +30k growth; silent for 15 minutes after a handoff is written;
per-session state is pruned after 14 days.

**`precompact_marker.py`** (PostCompact, matcher `auto`) — safety net for when
auto-compact wins the race. It runs after compaction *completes*, so it never
records an attempt that was blocked or failed; PreCompact could block
compaction, but blocking at the context ceiling risks wedging the session,
so this package records post-hoc instead. It writes a marker to `~/.claude/compact-session/markers/` —
outside any repository, so no `git add` can capture it — with timestamp,
project, and transcript path, and recommends `/compact-session save` while
the post-compact summary is fresh.

## Wiring

Merge `settings-snippet.json` into `~/.claude/settings.json` (create the
`hooks` key if absent; if you already have `UserPromptSubmit` or `PostCompact`
entries, append these hook objects to the existing arrays rather than
replacing them). Direct edits to hooks in settings files are normally picked
up by the file watcher — no restart needed. Confirm registration with
`/hooks`, which shows each hook's event, source file, and command.

## Configuration

Environment variables, e.g. in your shell profile:

- `COMPACT_SESSION_NUDGE_TOKENS` — nudge threshold (default `120000`, ~60% of
  a 200k window; raise substantially on a 1M-context model). Minimum 1000;
  invalid values fall back to the default.
- `COMPACT_SESSION_RENUDGE_TOKENS` — growth between re-nudges (default
  `30000`, minimum 1000).
- `COMPACT_SESSION_NUDGE_OFF=1` — disable the nudge without touching settings.
- `COMPACT_SESSION_NUDGE_DEBUG=1` — append diagnostics to
  `~/.claude/compact-session/nudge.log`, so a silent hook is distinguishable
  from a broken one.

## Verify

`COMPACT_SESSION_NUDGE_TOKENS=1000 claude`, submit two prompts: the second
should show Claude offering a checkpoint (the injected reminder itself is not
displayed). With `COMPACT_SESSION_NUDGE_DEBUG=1`, the log records the token
estimate and the nudge/suppress decision on every prompt.

## Scope and safety notes

- Hooks execute shell commands with your permissions — read these two scripts
  before wiring them, as you would any hook.
- Reads: transcript tail, locally. Writes: debounce state and optional log
  under `~/.claude/compact-session/` (directory `0700`, files `0600`) and
  markers under `~/.claude/compact-session/markers/`. Nothing leaves the
  machine.
- Token math is an estimate from the API usage fields of the last main-chain
  assistant message; treat the number as a meter, not an invoice.
