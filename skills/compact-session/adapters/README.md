# Portability map

The package is a portable core plus per-tool adapters. Nothing portable is
trapped in tool-specific packaging, and nothing tool-specific is degraded to
a lowest common denominator.

**Portable core** (plain python3 + git; POSIX fully hardened, native
Windows runs a degraded mode that keeps full validation, secret scanning,
and exclusive creation while announcing the skipped POSIX hardening):
- `scripts/check_handoff.py` — structural/secret/injection validation (lib + CLI)
- `scripts/place_handoff.py` — validate-then-place; session id optional
  (random collision-safe suffix when the tool has none)
- `scripts/select_handoff.py` — provenance-checked selection, emits validated bytes
- `references/handoff-spec.md`, `assets/handoff-template.md` — the format
- The handoff artifact itself: `<root>/.claude/handoffs/<ts>Z-<sid8>-handoff.md`

**Adapters:**
- Claude Code: `SKILL.md` (full-featured — pre-approved read-only tools,
  `$ARGUMENTS` mode selection, session-id provenance in filenames,
  slash-command invocation, progressive disclosure)
- Everything else: `adapters/AGENTS.md` — a self-contained block for
  AGENTS.md-style always-loaded instruction files. Deliberately terse:
  those files pay context cost in every session, so detail lives in the
  spec the agent reads at save time.

**Interoperability, the actual point:** all agents on a repository share one
handoff directory (default `.claude/handoffs`; override with `HANDOFF_DIR`,
a relative path every agent must agree on). Checkpoint in Claude Code,
reset, resume in another tool — or the reverse. Filenames sort identically;
`select_handoff.py` applies the same provenance rules regardless of which
agent wrote the file.

**Claude Code-only, by nature (not by packaging):**
- `hooks/context_nudge.py` — parses Claude Code's transcript format and
  injects via a Claude Code hook event; no cross-tool analog exists. The
  generic substitute is behavioral (the adapter's "offer a checkpoint when
  you notice degradation" clause) and is honestly weaker.
- `hooks/precompact_marker.py` — PostCompact is a Claude Code event.
- `evals/` — written for Claude Code's eval tooling.
- Tests: groups `nudge` and `marker` need nothing but python3 to run, but
  test Claude Code-shaped inputs; all other groups exercise the core.
