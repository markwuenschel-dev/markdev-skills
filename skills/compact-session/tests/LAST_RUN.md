# Test run evidence

- date: 2026-07-07/20/26T19:34:09Z
- environment: Ubuntu 24, Python 3.12.3, git version 2.43.0, container
- command: python3 tests/test_hooks.py   (groups: encoding | cleanup | degraded | validator35 | portable | nudge | marker | validator | validator31 | validator32 | place | place32 | select | selectgit | worktree)

## Live evidence 4: 2026-07-20, Windows session on core v3.5

Prose contract, first field confirmations: the session quoted the v3.4 helper-failure boundary and RE-TESTED instead of recalling (the exact prior failure mode, extinguished by one contract line), applied the idempotency clause cleanly (anchors re-checked, no duplicate, existing file re-pointed), and invented a temp-root probe to test placement without littering the real dir. check_handoff v3.5 confirmed: the identical artifact that threw 4 violations now passes [core v3.5].

BUG 4 (fixed in core v3.6): os.fdopen(fd, 'w') without encoding used the Windows locale (cp1252), so any handoff containing the spec's own → crashed on write AFTER validation passed. Fix: explicit UTF-8 + newline='
' (Windows-written files now byte-identical to POSIX ones). BUG 4b: the failed write left a 0-byte canonical file (O_EXCL create precedes write), partially defeating the no-invalid-canonical-file guarantee - now removed on write failure with a fail-closed message; residual: a hard process kill between create and cleanup can still leave one (accepted). BUG 4c (latent, same class): select's stdout emit and check_handoff's own error echoes would hit the same code page - all three helpers now force UTF-8 stdio. Regressions reproduce the Windows failure on Linux via LC_ALL=C + PYTHONUTF8=0.

gitleaks real-binary path remains live-untested (not installed on the Windows box).

## This run
```
PASS encoding: → handoff written under C locale (BUG 4 regression)
PASS encoding: written bytes are LF-only UTF-8 (platform-identical)
PASS encoding: select emits → under C locale (latent sibling fixed)
PASS encoding: validator error echo survives C locale
PASS cleanup: failed write exits 2 and removes the partial file - []
PASS degraded: place succeeds, announces mode on stderr, stdout stays a pure path
PASS degraded: placed file passes the validator
PASS degraded: select round-trips and announces MODE in header
PASS degraded: secret draft still creates NO canonical file (regression)
PASS degraded: symlinked .claude still refused, victim untouched
PASS degraded: future-dated candidate still rejected
PASS versioned: select header and place notice identify core version
PASS validator: Windows drive-letter cwd/root accepted (regression) - PASS: 56 lines; structure, order, meta, subgroups, anchors, and per-command expected results check out; no placeholders; no secret-shaped content matched known patterns (gitleaks not installed; built-in patterns only). This is a backstop: resume still treats all handoff content as untrusted proposals. [core v3.6]
PASS validator: UNC root accepted
PASS validator: relative root still rejected on any platform
PASS validator: wrapped expected-result bullet passes (regression)
PASS validator: backticked ops command satisfies the anchor (regression)
PASS portable: place without session id succeeds (0)
PASS portable: place without session id succeeds (1)
PASS portable: two same-second no-sid saves get distinct names
PASS portable: HANDOFF_DIR override honored by place
PASS portable: select round-trips the same HANDOFF_DIR
PASS portable: mismatched HANDOFF_DIR fails loudly (agreement required)
PASS portable: dot-dot HANDOFF_DIR rejected by place and select
PASS nudge: below threshold silent
PASS nudge: fires with additionalContext JSON
PASS nudge: debounce on repeat
PASS nudge: re-fires after +30k growth
PASS nudge: state dir 0700 / file 0600 - dir 700 file 600
PASS nudge: >256KB record detected (regression)
PASS nudge: invalid env falls back to default
PASS nudge: step=0 clamped, no re-fire at same tokens
PASS nudge: fresh handoff at .git-dir root suppresses (from subdir)
PASS nudge: worktree root found via git, suppresses (regression)
PASS nudge: .git-file root found by fallback walk without git
PASS nudge: debug log created 0600 (regression) - 600
PASS nudge: stale session state pruned
PASS nudge: garbage stdin exits 0
PASS marker: two rapid fires -> two distinct files (collision-safe) - ['20260720-193342.653569Z-abcdef12-autocompact.md', '20260720-193342.676899Z-abcdef12-autocompact.md']
PASS marker: dir 0700 / file 0600
PASS marker: records project + transcript, file under $HOME not the repo
PASS marker: manual compaction ignored
PASS validator: filled handoff passes - PASS: 56 lines; structure, order, meta, subgroups, anchors, and per-command expected results check out; no placeholders; no secret-shaped content matched known patterns (gitleaks not installed; built-in patterns only). This is a backstop: resume still treats all handoff content as untrusted proposals. [core v3.6]
PASS validator: untouched template fails (regression)
PASS validator: missing focus meta fails (regression)
PASS validator: section reorder fails (regression)
PASS validator: duplicated section fails
PASS validator: empty required section fails
PASS validator: meta fence not at top fails
PASS validator: unanchored next action fails
PASS validator: verification without expected results fails
PASS validator: over 400 lines fails
PASS validator: AWS_SECRET_ACCESS_KEY assignment fails (regression)
PASS validator: NPM_TOKEN assignment fails (regression)
PASS validator: GitLab token value fails (regression)
PASS validator: Stripe live key value fails (regression)
PASS validator: bare AWS-style 40-char secret fails (regression)
PASS validator: 40-char lowercase git sha is not a false positive
PASS validator: name-and-location credential reference passes
PASS validator: unclosed yaml fence fails (regression)
PASS validator: impossible timestamp fails (regression)
PASS validator: duplicate meta key fails (regression)
PASS validator: missing Current-state subgroup fails (regression)
PASS validator: anchor only in follow-on steps fails (regression)
PASS validator: command bullet without expected result fails (regression)
PASS validator: inline <TODO> marker fails (regression)
PASS validator: constraints without LOCKED/revisit-if fail
PASS validator: SYSTEM/ignore-instructions injection fails (regression)
PASS validator: pipe-to-shell injection fails (regression)
PASS validator: symlinked handoff file fails (regression)
PASS validator: symlinked handoffs directory fails (regression)
PASS validator: installed-but-broken gitleaks fails closed (regression)
PASS validator: explicit skip env bypasses broken gitleaks
PASS validator: gitleaks-found-leaks fails
PASS validator: modern gitleaks dir clean passes
PASS validator: legacy gitleaks detect fallback passes
PASS validator: prose and/or slash does not satisfy anchor (regression)
PASS validator: non-backticked command bullet without expected fails (regression)
PASS validator: '- Env' reference line stays exempt
PASS validator: empty Current-state subgroup fails (regression)
PASS validator: explicit None subgroup passes
PASS validator: unclassified sibling decision fails (regression)
PASS validator: 'disregard prior directions' variant fails (regression)
PASS place: canonical name printed and file created - /tmp/tmp9433qy61/proj/.claude/handoffs/20260720-193344Z-abcdef12-handoff.md
PASS place: file 0600, dirs 0700, staged removed
PASS place: placed file passes the validator
PASS place: symlinked .claude refused, victim untouched (regression)
PASS place: symlinked handoffs refused, victim untouched (regression)
PASS place: secret-shaped draft creates NO canonical file (regression)
PASS place: failed validation preserves the staged draft for fixing
PASS select: newest valid canonical wins; junk ignored
PASS select: emitted bytes equal the validated file's bytes
PASS select: future-dated filename rejected (regression)
PASS select: impossible filename timestamp rejected (regression)
PASS select: filename/written disagreement rejected (regression)
PASS select: group-writable candidate rejected
PASS select: symlinked handoffs directory refused
PASS select: explicit filename still fully checked
PASS select: injection-bearing sole candidate stops resume
PASS select: git-tracked sole candidate rejected (regression)
PASS select: local untracked candidate wins over newer tracked one
PASS worktree: --git-path info/exclude resolves to common exclude - /tmp/tmpg32g_bcm/main/.git/info/exclude
PASS worktree: --git-dir points at per-worktree dir (why old path was wrong)

103/103 passed
```

Remaining live gate, now genuinely just: /clear + /compact-session resume on Windows (expect SELECTED / HELPERS core v3.6 / MODE: degraded, → intact in emitted content). Luxuries after: nudge, PostCompact, cross-agent round-trip, real-gitleaks machine. Declined items unchanged.
