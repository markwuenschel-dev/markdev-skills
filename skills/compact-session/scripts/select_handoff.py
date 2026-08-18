#!/usr/bin/env python3
"""Provenance-checked handoff selection for compact-session resume.

Usage: select_handoff.py <project-root> [explicit-filename]

Agent-agnostic core: works for any coding agent sharing the handoff
convention. Opens <root>/<HANDOFF_DIR> (default .claude/handoffs; same
relative-path rules as place_handoff.py) through retained directory fds (refusing
symlinked components), considers only canonically named candidates, and for
each: opens once with O_NOFOLLOW, requires a regular file owned by the
current user with no group/world write bits, requires the file NOT to be
git-tracked (a cloned repository can commit a poisoned handoff that local
exclusion does not hide), parses the filename timestamp as real UTC within
a 15-minute clock-skew allowance, validates the exact bytes it read, and
requires the internal `written` timestamp to agree with the filename within
1 hour. The newest valid candidate wins (or the explicit filename, which
must still pass everything except "newest").

Exactly one handoff is live at a time and this decides which: the header
states it outright — the live file on SELECTED, the retired ones on
SUPERSEDED, the refused ones on REJECTED — so a reader facing a directory
of checkpoints never has to guess currency from dates or file counts.

On success prints that provenance header, a delimiter line, then the
validated bytes — resume consumes THIS output, not a re-read of the path.
Exit 0 on success, 2 otherwise. Passing validation never makes the content
trusted: it remains proposed data behind the skill's approval gates.
"""
import datetime
import os
import re
import stat
import subprocess
import sys

POSIX = (os.name == "posix" and hasattr(os, "O_NOFOLLOW")
         and not os.environ.get("HANDOFF_FORCE_DEGRADED"))

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_handoff  # noqa: E402

CANONICAL = re.compile(r"^(\d{8}-\d{6})Z-[A-Za-z0-9]{8}-handoff\.md$")
SKEW = 900          # filename may lead the clock by at most 15 minutes
WRITTEN_TOLERANCE = 3600  # filename vs internal `written`, seconds
DELIM = "-----8<----- validated handoff content -----8<-----"


def fail(msg):
    print("FAIL: %s" % msg, file=sys.stderr)
    sys.exit(2)


def handoff_components():
    raw = os.environ.get("HANDOFF_DIR", ".claude/handoffs").strip().strip("/")
    parts = [p for p in raw.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        fail("HANDOFF_DIR must be a relative path with no . or .. components")
    return parts


def open_dir_no_follow(name, dir_fd=None):
    try:
        return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                       dir_fd=dir_fd)
    except OSError as e:
        return e


def git_tracked(root, relpath):
    try:
        p = subprocess.run(["git", "-C", root, "ls-files", "--error-unmatch",
                            "--", relpath],
                           capture_output=True, text=True, timeout=10)
        return p.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False  # no git / git broken -> provenance check unavailable


def main():
    check_handoff.force_utf8_stdio()
    if len(sys.argv) not in (2, 3):
        fail("usage: select_handoff.py <project-root> [explicit-filename]")
    root = sys.argv[1]
    explicit = os.path.basename(sys.argv[2]) if len(sys.argv) == 3 else None

    parts = handoff_components()
    hrel = "/".join(parts)
    hdir = os.path.join(root, *parts)
    if POSIX:
        fd = open_dir_no_follow(root)
        if isinstance(fd, OSError):
            fail("cannot open project root: %s" % fd)
        for i, part in enumerate(parts):
            nxt = open_dir_no_follow(part, dir_fd=fd)
            if isinstance(nxt, OSError):
                fail("no %s directory (or a symlinked component) under %s"
                     % ("/".join(parts[:i + 1]), root))
            fd = nxt
        hfd = fd
    else:
        hfd = None
        cur = root
        for i, part in enumerate(parts):
            cur = os.path.join(cur, part)
            if not os.path.lexists(cur):
                fail("no %s directory under %s" % ("/".join(parts[:i + 1]), root))
            st = os.lstat(cur)
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
                fail("refusing symlinked or non-directory component: %s" % cur)

    names = sorted(os.listdir(hfd if hfd is not None else hdir), reverse=True)
    ignored = [n for n in names if not CANONICAL.match(n)]
    candidates = [n for n in names if CANONICAL.match(n)]
    # Keep the full newest-first list: the supersession report describes the
    # whole directory, not the subset left after an explicit-filename request.
    all_canonical = list(candidates)
    if explicit:
        if explicit not in candidates:
            fail("explicit file %r is missing or not canonically named" % explicit)
        candidates = [explicit]
    if not candidates:
        fail("no canonically named handoffs in %s/%s (%d other file(s) "
             "ignored)" % (root, hrel, len(ignored)))

    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    rejections = []
    for name in candidates:
        reasons = []
        try:
            ts = datetime.datetime.strptime(CANONICAL.match(name).group(1),
                                            "%Y%m%d-%H%M%S")
        except ValueError:
            rejections.append((name, ["filename timestamp is not a real UTC time"]))
            continue
        if (ts - now).total_seconds() > SKEW:
            reasons.append("filename timestamp is in the future beyond clock skew")
        if git_tracked(root, hrel + "/" + name):
            reasons.append("file is git-tracked: a committed handoff is repository "
                           "content, not a local checkpoint - refusing")
        if POSIX:
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=hfd)
            except OSError as e:
                rejections.append((name, reasons + ["cannot open without "
                                                    "following symlinks: %s" % e]))
                continue
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode):
                    reasons.append("not a regular file")
                if st.st_uid != os.geteuid():
                    reasons.append("not owned by the current user")
                if stat.S_IMODE(st.st_mode) & 0o022:
                    reasons.append("group/world-writable permissions")
                text = os.fdopen(os.dup(fd), encoding="utf-8",
                                 errors="replace").read()
            finally:
                os.close(fd)
        else:
            fpath = os.path.join(hdir, name)
            st = os.lstat(fpath)
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
                rejections.append((name, reasons + ["symlink or not a regular "
                                                    "file"]))
                continue
            with open(fpath, encoding="utf-8", errors="replace") as f:
                text = f.read()
        errors, _ = check_handoff.validate_content(text)
        reasons.extend(errors)
        m = re.search(r"(?m)^written:\s*(\S+)", text)
        if m:
            try:
                w = datetime.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%SZ")
                if abs((w - ts).total_seconds()) > WRITTEN_TOLERANCE:
                    reasons.append("internal written timestamp disagrees with the "
                                   "filename by more than 1 hour")
            except ValueError:
                pass  # validate_content already flagged it
        if reasons:
            rejections.append((name, reasons))
            continue

        idx = all_canonical.index(name)
        newer, older = all_canonical[:idx], all_canonical[idx + 1:]
        print("SELECTED: %s" % os.path.join(root, hrel, name))
        if explicit and newer:
            print("AUTHORITATIVE: no - a filename was requested explicitly, so "
                  "this is a user-directed override rather than the live "
                  "checkpoint; the live one is the newest valid handoff, listed "
                  "under OVERRIDDEN below. Say so before resuming.")
        else:
            print("AUTHORITATIVE: this is the live checkpoint - the newest valid "
                  "handoff wins by construction. Resume from this file alone; do "
                  "not read, merge, or reconcile it against the others. Neither "
                  "its age nor the number of files beside it makes it stale - "
                  "only re-verified repository state can contradict it.")
        print("HELPERS: session-handoff core v%s" % check_handoff.VERSION)
        if not POSIX:
            print("MODE: degraded (POSIX symlink-fd/ownership/permission "
                  "hardening unavailable; content validation full)")
        print("CANDIDATES: %d canonical here (%d rejected while choosing), "
              "%d non-canonical ignored%s"
              % (len(all_canonical), len(rejections), len(ignored),
                 (": " + ", ".join(ignored[:5])) if ignored else ""))
        if older:
            print("SUPERSEDED: %d older canonical handoff(s) - retired history, "
                  "not competing candidates: %s%s"
                  % (len(older), ", ".join(older[:5]),
                     " (+%d more)" % (len(older) - 5) if len(older) > 5 else ""))
        else:
            print("SUPERSEDED: none - no older canonical handoff in this "
                  "directory")
        if explicit and newer:
            print("OVERRIDDEN: %d newer canonical handoff(s) skipped because a "
                  "filename was requested explicitly - tell the user: %s"
                  % (len(newer), ", ".join(newer[:5])))
        for rname, rr in rejections:
            print("REJECTED %s: %s" % (rname, "; ".join(rr[:3])))
        print(DELIM)
        sys.stdout.write(text)
        return 0

    print("FAIL: no valid handoff among %d canonical candidate(s):"
          % len(candidates), file=sys.stderr)
    for rname, rr in rejections:
        print("  %s: %s" % (rname, "; ".join(rr[:4])), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
