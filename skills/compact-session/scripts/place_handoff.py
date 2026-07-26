#!/usr/bin/env python3
"""Validated, symlink-safe handoff placement for compact-session.

Usage: place_handoff.py <staged-draft> <project-root> [session-id]

Agent-agnostic core: nothing here depends on any particular coding agent.
When no session id is supplied (tools without one), a random 8-char suffix
preserves same-second collision safety. HANDOFF_DIR (a relative path,
default ".claude/handoffs") overrides the destination; every agent sharing
a repository must agree on it for cross-agent resume to work.

Reads the staged draft exactly once (O_NOFOLLOW, regular-file fstat),
validates those bytes in-process with check_handoff.validate_content plus
the gitleaks layer, and only then creates the canonical file - so no
canonical handoff ever exists that has not already passed validation.
Directories are created and opened through retained directory fds
(O_DIRECTORY | O_NOFOLLOW at each level) at mode 0700, the file is created
relative to the retained handoffs fd with O_CREAT | O_EXCL | O_NOFOLLOW at
0600, named <UTC %Y%m%d-%H%M%SZ>-<sid8>-handoff.md, and fsynced along with
its directory. Prints the final absolute path on success and removes the
staged draft. Exit 0 on success, 2 on refusal, validation failure, or error.
"""
import os
import re
import stat
import sys
import time

# Full POSIX hardening when available; on native Windows (or when forced for
# testing) run degraded: content validation and exclusive creation in full,
# lstat-based symlink refusal, but no fd-chains, no permission semantics,
# no directory fsync - and say so on stderr.
POSIX = (os.name == "posix" and hasattr(os, "O_NOFOLLOW")
         and not os.environ.get("HANDOFF_FORCE_DEGRADED"))

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_handoff  # noqa: E402


def fail(msg):
    print("FAIL: %s" % msg, file=sys.stderr)
    sys.exit(2)


def handoff_components():
    raw = os.environ.get("HANDOFF_DIR", ".claude/handoffs").strip().strip("/")
    parts = [p for p in raw.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        fail("HANDOFF_DIR must be a relative path with no . or .. components")
    return parts


def _remove_partial(name, dfd, handoffs):
    """Best-effort removal of a created-but-unwritten canonical file, so a
    failed write cannot leave a 0-byte handoff behind."""
    try:
        if dfd is not None:
            os.unlink(name, dir_fd=dfd)
        else:
            os.unlink(os.path.join(handoffs, name))
    except OSError:
        pass


def ensure_dir_plain(path, label):
    if os.path.lexists(path):
        st = os.lstat(path)
        if stat.S_ISLNK(st.st_mode):
            fail("refusing symlink at %s - it could redirect writes outside "
                 "the project; remove it and retry" % label)
        if not stat.S_ISDIR(st.st_mode):
            fail("%s exists and is not a directory" % label)
    else:
        os.mkdir(path)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def ensure_dir_fd(name, parent_fd, label):
    """Create-if-needed and open `name` relative to parent_fd, never
    following symlinks, returning a retained directory fd."""
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
    except FileExistsError:
        pass
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                     dir_fd=parent_fd)
    except OSError as e:
        fail("refusing %s - it is a symlink or not a directory (%s); a tracked "
             "symlink here could redirect writes outside the project"
             % (label, e.__class__.__name__))
    os.chmod(fd, 0o700)
    return fd


def main():
    check_handoff.force_utf8_stdio()
    if len(sys.argv) not in (3, 4):
        fail("usage: place_handoff.py <staged-draft> <project-root> [session-id]")
    staged, root = sys.argv[1], sys.argv[2]
    sid = sys.argv[3] if len(sys.argv) == 4 else os.urandom(4).hex()

    if POSIX:
        try:
            sfd = os.open(staged, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as e:
            fail("cannot open staged draft without following symlinks: %s" % e)
        if not stat.S_ISREG(os.fstat(sfd).st_mode):
            fail("staged draft must be a regular file")
        with os.fdopen(sfd, encoding="utf-8", errors="replace") as f:
            content = f.read()
    else:
        print("NOTICE: degraded placement mode (POSIX hardening unavailable); "
              "content validation fully applied [core v%s]"
              % check_handoff.VERSION, file=sys.stderr)
        try:
            st = os.lstat(staged)
        except OSError as e:
            fail("staged draft missing: %s" % e)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            fail("staged draft must be a regular file, not a symlink")
        with open(staged, encoding="utf-8", errors="replace") as f:
            content = f.read()

    # Validate the exact bytes BEFORE any canonical persistence.
    errors, _ = check_handoff.validate_content(content)
    check_handoff.run_gitleaks(staged, errors)
    if errors:
        for e in errors:
            print("FAIL: %s" % e, file=sys.stderr)
        fail("staged draft failed validation (%d violation(s)); no canonical "
             "file was created - fix the draft and re-run" % len(errors))

    parts = handoff_components()
    handoffs = os.path.join(root, *parts)
    if POSIX:
        try:
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        except OSError as e:
            fail("project root is not an openable directory: %s" % e)
        chain = [root_fd]
        for i, part in enumerate(parts):
            chain.append(ensure_dir_fd(part, chain[-1],
                                       "<root>/" + "/".join(parts[:i + 1])))
        dfd = chain[-1]
    else:
        if not os.path.isdir(root):
            fail("project root is not a directory: %s" % root)
        chain, dfd, cur = [], None, root
        for i, part in enumerate(parts):
            cur = os.path.join(cur, part)
            ensure_dir_plain(cur, "<root>/" + "/".join(parts[:i + 1]))

    sid8 = (re.sub(r"[^A-Za-z0-9]", "", sid)[:8] or "session0").ljust(8, "0")
    try:
        for attempt in range(2):
            name = "%s-%s-handoff.md" % (
                time.strftime("%Y%m%d-%H%M%SZ", time.gmtime()), sid8)
            try:
                if POSIX:
                    fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY
                                 | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
                else:
                    fd = os.open(os.path.join(handoffs, name),
                                 os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                break
            except FileExistsError:
                if attempt:
                    fail("could not create a unique handoff name")
                time.sleep(1.1)
        try:
            f = os.fdopen(fd, "w", encoding="utf-8", newline="\n")
        except Exception:
            os.close(fd)
            _remove_partial(name, dfd, handoffs)
            raise
        try:
            with f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            if dfd is not None:
                os.fsync(dfd)
        except Exception as e:
            _remove_partial(name, dfd, handoffs)
            fail("could not write the handoff (%s: %s); the partial file was "
                 "removed, so nothing invalid remains at the canonical location"
                 % (e.__class__.__name__, e))
    finally:
        for f_ in chain:
            os.close(f_)
    try:
        os.unlink(staged)
    except OSError:
        pass
    print(os.path.join(handoffs, name))


if __name__ == "__main__":
    main()
