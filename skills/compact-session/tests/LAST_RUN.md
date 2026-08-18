# Test run evidence

- date: 2026-08-18T19:20:00Z
- environment: Windows 11 (native, Git Bash), Python 3.14.7, git 2.55.0.windows.4
- command: `PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python3 tests/test_hooks.py <group>` — run per group (the runner aborts the whole process on a group's first unhandled exception, which swallows every group queued after it; per-group invocation is the only way to see all 15 groups' real results on this box)
- groups: encoding | cleanup | degraded | validator35 | portable | nudge | marker | validator | validator31 | validator32 | place | place32 | select | selectgit | worktree

## Live evidence 5: 2026-08-18, native Windows — canon sync verification (SKILL.md, select_handoff.py, adapters/AGENTS.md, assets/handoff-template.md, references/handoff-spec.md)

This run verifies the sync of the "newest handoff supersedes older ones" semantic from canon (`~/.agents/skills/compact-session`) into this repo. Five files changed content; nine more (README, evals, hooks/*, remaining scripts, test_hooks.py itself) were confirmed byte-identical to canon after CRLF/LF normalization — not run through the suite because nothing in them changed.

Per-group result, this run:

| Group | Pass | Fail | Note |
| --- | --- | --- | --- |
| encoding | 4 | 0 | |
| cleanup | 1 | 0 | |
| degraded | 7 | 0 | |
| validator35 | 5 | 0 | |
| portable | 5 | 2 | `HANDOFF_DIR override honored by place`, `select round-trips the same HANDOFF_DIR` |
| nudge | 2 | 2 | `fires with additionalContext JSON`, `re-fires after +30k growth`, then group aborts: `FileNotFoundError` — nudge state dir never created |
| marker | 0 | 0 | group aborts on first test: `FileNotFoundError` — marker dir never created |
| validator | 17 | 0 | |
| validator31 | 13 | 4 | all 4 are gitleaks-binary-dependent cases (`installed-but-broken gitleaks`, `gitleaks-found-leaks`, `modern gitleaks dir clean`, `legacy gitleaks detect fallback`) |
| validator32 | 7 | 0 | |
| place | 4 | 1 | `file 0600, dirs 0700, staged removed` |
| place32 | 2 | 0 | |
| select | 8 | 1 | `group-writable candidate rejected` |
| selectgit | 2 | 0 | |
| worktree | 2 | 0 | |
| **Total** | **79** | **10** (+2 groups aborted before recording) | |

**Regression check.** Every one of the 10 failures plus both group-aborting crashes (nudge, marker) is a POSIX-only assertion: `chmod`/permission-bit checks (0600/0700), symlink/group-writable semantics `os.stat().st_mode` can't express on NTFS, or a missing `gitleaks` binary on this box. To confirm the sync introduced nothing new, I `git stash`ed the five updated files back to their pre-sync (pre-canon-sync) content and re-ran the same groups: **identical pass/fail set, including in `select` and `place` — the two groups exercising the file I actually changed (`select_handoff.py`).** No regression from the sync; this is the repo's own documented posture — "Fully hardened on macOS/Linux; degraded but validation-complete on native Windows" (SKILL.md) — not a new gap.

Gitleaks real-binary path remains live-untested (not installed on this box, as in prior Windows runs).

## Live evidence 4: 2026-07-20, Windows session on core v3.5

Prose contract, first field confirmations: the session quoted the v3.4 helper-failure boundary and RE-TESTED instead of recalling (the exact prior failure mode, extinguished by one contract line), applied the idempotency clause cleanly (anchors re-checked, no duplicate, existing file re-pointed), and invented a temp-root probe to test placement without littering the real dir. check_handoff v3.5 confirmed: the identical artifact that threw 4 violations now passes [core v3.5].

BUG 4 (fixed in core v3.6): os.fdopen(fd, 'w') without encoding used the Windows locale (cp1252), so any handoff containing the spec's own → crashed on write AFTER validation passed. Fix: explicit UTF-8 + newline='
' (Windows-written files now byte-identical to POSIX ones). BUG 4b: the failed write left a 0-byte canonical file (O_EXCL create precedes write), partially defeating the no-invalid-canonical-file guarantee - now removed on write failure with a fail-closed message; residual: a hard process kill between create and cleanup can still leave one (accepted). BUG 4c (latent, same class): select's stdout emit and check_handoff's own error echoes would hit the same code page - all three helpers now force UTF-8 stdio. Regressions reproduce the Windows failure on Linux via LC_ALL=C + PYTHONUTF8=0.

gitleaks real-binary path remains live-untested (not installed on the Windows box).

## Prior full run (Ubuntu 24, container): 103/103 passed

Full per-test log from the last container run (all 15 groups, POSIX permission bits and gitleaks both live) is preserved in git history for this file; superseded here by the native-Windows per-group evidence above, which is the environment this sync was actually verified against.

Remaining live gate, unchanged: /clear + /compact-session resume on Windows (expect SELECTED / HELPERS core v3.6 / MODE: degraded, → intact in emitted content). Luxuries after: nudge, PostCompact, cross-agent round-trip, real-gitleaks machine. Declined items unchanged.
