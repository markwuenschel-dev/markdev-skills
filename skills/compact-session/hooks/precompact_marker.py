#!/usr/bin/env python3
"""compact-session PostCompact marker (matcher: auto).

If native auto-compact completes, the checkpoint window was missed. This
hook leaves a durable breadcrumb under ~/.claude/compact-session/markers/
-- outside any repository, so it can never be swept up by git add --
recording when it happened, which project, and where the full transcript
lives.

Registered on PostCompact, which fires after compaction completes, so the
marker never records an event that was blocked or failed. (PreCompact can
block compaction, but blocking at the context ceiling risks wedging the
session, so this package records post-hoc instead of intervening.)
Always exits 0.
"""
import json
import os
import sys
import time


def marker_dir():
    d = os.path.expanduser("~/.claude/compact-session/markers")
    os.makedirs(d, exist_ok=True)
    os.chmod(os.path.dirname(d), 0o700)
    os.chmod(d, 0o700)
    return d


def exclusive_create(directory, base):
    for attempt in range(100):
        name = base if attempt == 0 else base.replace(
            "-autocompact.md", "-%d-autocompact.md" % attempt
        )
        path = os.path.join(directory, name)
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            return fd, path
        except FileExistsError:
            continue
    raise OSError("could not create unique marker file")


try:
    data = json.load(sys.stdin)
    if data.get("trigger") != "auto":
        sys.exit(0)
    cwd = data.get("cwd") or os.getcwd()
    session = data.get("session_id", "unknown")
    now = time.time()
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(now))
    micros = int((now % 1) * 1e6)
    base = "%s.%06dZ-%s-autocompact.md" % (stamp, micros, session[:8])
    fd, path = exclusive_create(marker_dir(), base)
    with os.fdopen(fd, "w") as f:
        f.write(
            "# Auto-compact completed before a checkpoint\n\n"
            "- when: %s\n"
            "- session: %s\n"
            "- project: %s\n"
            "- transcript: %s\n\n"
            "Native auto-compact replaced this conversation with a lossy "
            "summary before a /compact-session checkpoint was taken. The full "
            "transcript remains at the path above (subject to Claude Code's "
            "cleanupPeriodDays retention). Running /compact-session save soon "
            "after, while the post-compact summary is still fresh, captures a "
            "proper handoff.\n"
            % (
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                session,
                cwd,
                data.get("transcript_path", "unknown"),
            )
        )
    print("[compact-session] auto-compact marker written: %s" % path)
except Exception:
    pass
sys.exit(0)
