#!/usr/bin/env python3
"""compact-session context nudge (UserPromptSubmit hook).

Estimates current context size from the session transcript's most recent
main-chain assistant usage record. Past a threshold, emits JSON with
hookSpecificOutput.additionalContext, which Claude Code injects as a
system reminder (no visible transcript entry). The text is factual, not
imperative, and composes with the skill's offer gate: Claude treats it
as an observed signal, offers a checkpoint, and writes nothing without
user agreement.

Never blocks the prompt: every path exits 0.

Config (environment):
  COMPACT_SESSION_NUDGE_TOKENS    threshold in tokens (default 120000, min 1000)
  COMPACT_SESSION_RENUDGE_TOKENS  growth before re-nudging (default 30000, min 1000)
  COMPACT_SESSION_NUDGE_OFF=1     disable entirely
  COMPACT_SESSION_NUDGE_DEBUG=1   append diagnostics to ~/.claude/compact-session/nudge.log
"""
import json
import os
import subprocess
import sys
import time

TAIL_STEPS = (262144, 1048576, 4194304, 16777216)  # grow if a huge record hides usage
STATE_MAX_AGE = 14 * 86400
DEBUG = os.environ.get("COMPACT_SESSION_NUDGE_DEBUG") == "1"


def log(msg):
    if not DEBUG:
        return
    try:
        d = os.path.expanduser("~/.claude/compact-session")
        os.makedirs(d, exist_ok=True)
        os.chmod(d, 0o700)
        path = os.path.join(d, "nudge.log")
        fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            os.chmod(path, 0o600)  # also corrects files created before this fix
        except OSError:
            pass
        with os.fdopen(fd, "a") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg))
    except OSError:
        pass


def env_int(name, default, minimum):
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        val = int(raw)
    except ValueError:
        log("invalid %s=%r, using default %d" % (name, raw, default))
        return default
    if val < minimum:
        log("%s=%d below minimum, clamped to %d" % (name, val, minimum))
        return minimum
    return val


def context_tokens(transcript_path):
    """Current context ~= input + cache_read + cache_creation of the last
    non-sidechain assistant message. Widens the tail window if no usage
    record fits (single records can exceed 256KB). Returns None if
    undeterminable."""
    try:
        size = os.path.getsize(transcript_path)
        for tail_bytes in TAIL_STEPS:
            with open(transcript_path, "rb") as f:
                f.seek(max(0, size - tail_bytes))
                tail = f.read().decode("utf-8", "replace")
            lines = tail.splitlines()
            if size > tail_bytes and lines:
                lines = lines[1:]  # drop the partial first line of the tail
            for line in reversed(lines):
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("isSidechain") or entry.get("type") != "assistant":
                    continue
                usage = (entry.get("message") or {}).get("usage") or {}
                if "input_tokens" in usage:
                    return (
                        usage.get("input_tokens", 0)
                        + usage.get("cache_read_input_tokens", 0)
                        + usage.get("cache_creation_input_tokens", 0)
                    )
            if size <= tail_bytes:
                break
            log("no usage in %dB tail, widening" % tail_bytes)
        return None
    except OSError as e:
        log("transcript read failed: %s" % e)
        return None


def project_root(cwd):
    """Prefer git itself, which is correct for linked worktrees and
    submodules; fall back to a filesystem walk that accepts both .git
    directories (standard checkouts) and .git files (linked worktrees)."""
    try:
        p = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5,
        )
        if p.returncode == 0 and p.stdout.strip():
            return p.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    d = os.path.abspath(cwd)
    for _ in range(20):
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return os.path.abspath(cwd)


def main():
    if os.environ.get("COMPACT_SESSION_NUDGE_OFF") == "1":
        return
    data = json.load(sys.stdin)
    transcript_path = data.get("transcript_path") or ""
    session_id = data.get("session_id") or "unknown"
    cwd = data.get("cwd") or os.getcwd()
    if not os.path.isfile(transcript_path):
        return

    tokens = context_tokens(transcript_path)
    if tokens is None:
        return
    threshold = env_int("COMPACT_SESSION_NUDGE_TOKENS", 120000, 1000)
    step = env_int("COMPACT_SESSION_RENUDGE_TOKENS", 30000, 1000)
    log("tokens=%d threshold=%d" % (tokens, threshold))
    if tokens < threshold:
        return

    # A handoff written in the last 15 minutes means the user is mid-reset;
    # stay silent instead of nagging between save and /clear.
    rel = [p for p in os.environ.get("HANDOFF_DIR", ".claude/handoffs")
           .strip("/").split("/") if p and p not in (".", "..")] or \
          [".claude", "handoffs"]
    handoff_dir = os.path.join(project_root(cwd), *rel)
    try:
        newest = max(
            (
                os.path.getmtime(os.path.join(handoff_dir, f))
                for f in os.listdir(handoff_dir)
                if f.endswith("-handoff.md")
            ),
            default=0,
        )
        if time.time() - newest < 900:
            log("suppressed: fresh handoff")
            return
    except OSError:
        pass

    # Per-session debounce with atomic writes; prune stale session state.
    state_dir = os.path.expanduser("~/.claude/compact-session")
    os.makedirs(state_dir, exist_ok=True)
    os.chmod(state_dir, 0o700)
    now = time.time()
    for f in os.listdir(state_dir):
        if f.startswith("nudge-") and f.endswith(".json"):
            p = os.path.join(state_dir, f)
            try:
                if now - os.path.getmtime(p) > STATE_MAX_AGE:
                    os.unlink(p)
            except OSError:
                pass
    state_path = os.path.join(state_dir, "nudge-%s.json" % session_id)
    last = 0
    try:
        with open(state_path) as f:
            last = int(json.load(f).get("tokens", 0))
    except (OSError, ValueError):
        pass
    if last and tokens < last + step:
        log("debounced: last=%d" % last)
        return
    tmp = state_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"tokens": tokens, "at": now}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, state_path)

    context = (
        "[compact-session] Estimated context size is ~%dk tokens, past the %dk "
        "checkpoint threshold. Much of the older history may be stale. Under the "
        "compact-session skill's offer gate, this line counts as an observed "
        "signal for offering the user a checkpoint; the offer is skipped if the "
        "user already declined one this session, and any in-flight edit finishes "
        "first." % (tokens // 1000, threshold // 1000)
    )
    print(json.dumps({
        "suppressOutput": True,
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        },
    }))
    log("nudged at %d" % tokens)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # a broken meter must never break prompting
        log("unexpected: %r" % e)
    sys.exit(0)
