#!/usr/bin/env python3
"""Deterministic handoff validator for compact-session.

Fails closed (exit 2) on: symlinked or non-regular handoff files (and
symlinked .claude/handoffs parents when validating a canonical location),
missing/duplicated/misordered required sections, a meta block that is
absent from the top, unclosed, duplicated-key, or wrongly typed (including
unparseable timestamps), template or inline placeholders, missing
Current-state subgroups, an unanchored immediate next action, command
bullets without their own expected results, a Locked-decisions section
with no LOCKED/revisit-if entries, injection-shaped phrasing, line-budget
overrun, and secret-shaped content matching the built-in patterns. When
gitleaks is installed it must also pass: an installed-but-erroring
gitleaks fails validation (set CHECK_HANDOFF_SKIP_GITLEAKS=1 to bypass
that layer only).

The secret scan is a backstop against recognized shapes, not a guarantee,
and passing validation never makes the handoff trusted: resume still
treats every command and instruction in it as an unapproved proposal.

Usage: python3 check_handoff.py <handoff-file>
"""
import datetime
import os
import re
import shutil
import stat as stat_mod
import subprocess
import sys

VERSION = "3.6"

REQUIRED_SECTIONS = [
    "Goal and definition of done",
    "Current state",
    "Next action",
    "Locked decisions and constraints",
    "File map",
    "Verification",
    "Dead ends",
    "Resume protocol",
    "Redaction note",
]
REQUIRED_META_KEYS = ["written", "cwd", "root", "branch", "head", "focus", "dirty"]
STATE_SUBGROUPS = ["**Done and verified**", "**Done, unverified**", "**In flight**"]
LINE_TARGET = 250
LINE_CEILING = 400

TEMPLATE_PLACEHOLDERS = [
    "<UTC ISO-8601>", "<absolute path>", "<project root>", "<branch or n/a>",
    "<short SHA or n/a>", "<focus hint or none>", "<true|false>",
    "<One concrete, file-and-line-anchored step.>", "<follow-on step>",
    "<path>", "<command>", "<result>", "<approach>", "<why closed>",
    "<evidence pointer>", "<item", "<What the task is",
    "<session-specific requirements", "<list or", "<VAR_NAME in <location>",
]
GENERIC_PLACEHOLDER = re.compile(r"<[^<>\n]*\s[^<>\n]*\s[^<>\n]*>")
FULL_LINE_PLACEHOLDER = re.compile(r"^\s*<[^<>\n]+>\s*$")
INLINE_MARKER = re.compile(r"(?i)<\s*(todo|tbd|fixme|fill[- ]?me|placeholder|xxx)\s*>")
ANCHOR = re.compile(
    r"(\b[\w\-]+\.[A-Za-z0-9]{1,8}(:\d+)?\b"    # file.ext or file.ext:line
    r"|(?:^|[\s(])/?[\w.\-]+/[\w.\-]+/[\w./\-]+"  # two+ path separators
    r"|`[^`\n]*/[^`\n]*`"                          # backticked path token
    r"|`[^`\n]+\s+[^`\n]+`)")                     # backticked command w/ args
EXPECTED = re.compile(r"(expected|→|->)", re.I)
INJECTION_PATTERNS = [
    ("ignore-instructions phrasing",
     r"(?i)(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+)?"
     r"(previous|prior|earlier|above|preceding)\s+"
     r"(instructions?|directions?|directives?|prompts?|rules?|guidance)"),
    ("line-initial SYSTEM: directive", r"(?m)^\s*SYSTEM\s*:"),
    ("pipe-to-shell", r"\|\s*(sudo\s+)?(ba|z)?sh\b"),
]

SECRET_PATTERNS = [
    ("private key block", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("AWS access key id", r"\bAKIA[0-9A-Z]{16}\b"),
    ("AWS-style 40-char secret (mixed case + digit)",
     r"(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+=]{0,39}[A-Z])(?=[A-Za-z0-9/+=]{0,39}[a-z])"
     r"(?=[A-Za-z0-9/+=]{0,39}\d)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])"),
    ("GitHub token", r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    ("GitLab token", r"\bglpat-[A-Za-z0-9_\-]{20}\b"),
    ("npm token", r"\bnpm_[A-Za-z0-9]{30,}\b"),
    ("Stripe key", r"\b[srp]k_(live|test)_[A-Za-z0-9]{16,}\b"),
    ("Slack token", r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    ("Google API key", r"\bAIza[0-9A-Za-z_\-]{30,}\b"),
    ("sk- style API key", r"\bsk-[A-Za-z0-9_\-]{20,}\b"),
    ("JWT", r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}"),
    ("credential-bearing URL", r"[A-Za-z][A-Za-z0-9+.\-]*://[^/\s:@]+:[^@\s]+@"),
    ("credential assignment",
     r"(?im)^[^=:\n]{0,64}(secret|token|passw|api[_-]?key|access[_-]?key"
     r"|private[_-]?key|client[_-]?secret|connection[_-]?string)"
     r"[^=:\n]{0,32}[:=]\s*['\"]?(?![<$*{])[^\s'\"]{8,}"),
]


def force_utf8_stdio():
    """Windows consoles and pipes default to legacy code pages (cp1252);
    handoffs are UTF-8 and legitimately contain characters like the spec's
    own arrow. Emit UTF-8 regardless of locale so validator error echoes,
    placement notices, and selector output never crash on encode."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def path_safety(path, errors):
    try:
        st = os.lstat(path)
    except OSError as e:
        errors.append("cannot stat file: %s" % e)
        return
    if stat_mod.S_ISLNK(st.st_mode) or not stat_mod.S_ISREG(st.st_mode):
        errors.append("handoff must be a regular file, not a symlink or special file")
    parent = os.path.dirname(os.path.abspath(path))
    if os.path.basename(parent) == "handoffs":
        for p in (parent, os.path.dirname(parent)):
            try:
                if stat_mod.S_ISLNK(os.lstat(p).st_mode):
                    errors.append("refusing symlinked directory in handoff path: %s" % p)
            except OSError:
                pass


def parse_meta(lines, errors):
    fence_open = next((i for i, l in enumerate(lines) if l.strip() == "```yaml"), None)
    if fence_open is None or fence_open > 5:
        errors.append("meta: fenced ```yaml block must open within the first 6 lines")
        return {}
    meta, closed = {}, False
    for l in lines[fence_open + 1:]:
        if l.strip() == "```":
            closed = True
            break
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", l.strip())
        if m:
            key, val = m.group(1), m.group(2).strip()
            if key in meta:
                errors.append("meta: duplicate key: %s" % key)
            meta[key] = val
    if not closed:
        errors.append("meta: yaml fence is never closed")
    for key in REQUIRED_META_KEYS:
        if key not in meta or not meta[key]:
            errors.append("meta: missing or empty key: %s" % key)
    for key, val in meta.items():
        if "<" in val:
            errors.append("meta: placeholder value for %s: %r" % (key, val))
    if meta.get("written"):
        try:
            dt = datetime.datetime.strptime(meta["written"], "%Y-%m-%dT%H:%M:%SZ")
            if not 2020 <= dt.year <= 2100:
                errors.append("meta: written year %d is implausible" % dt.year)
        except ValueError:
            errors.append("meta: written is not a real UTC datetime "
                          "(YYYY-MM-DDTHH:MM:SSZ)")
    win_abs = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\)")
    for key in ("cwd", "root"):
        v = meta.get(key)
        if v and not (v.startswith("/") or win_abs.match(v)):
            errors.append("meta: %s must be an absolute path (POSIX or "
                          "Windows)" % key)
    if meta.get("dirty") not in (None, "", "true", "false"):
        errors.append("meta: dirty must be true or false")
    return meta


def section_bodies(lines):
    order, bodies, current = [], {}, None
    for line in lines:
        m = re.match(r"^##\s+(.*?)\s*$", line)
        if m:
            current = m.group(1)
            order.append(current)
            bodies.setdefault(current, [])
        elif current is not None:
            bodies[current].append(line)
    return order, bodies


def run_gitleaks(path, errors):
    if os.environ.get("CHECK_HANDOFF_SKIP_GITLEAKS") == "1":
        return "gitleaks layer skipped by CHECK_HANDOFF_SKIP_GITLEAKS=1"
    if not shutil.which("gitleaks"):
        return "gitleaks not installed; built-in patterns only"

    def call(args):
        return subprocess.run(["gitleaks"] + args, capture_output=True,
                              text=True, timeout=60)

    try:
        p = call(["dir", "--redact", "--no-banner", "--exit-code", "9", path])
        used = "gitleaks dir"
        if p.returncode not in (0, 9):
            p = call(["detect", "--no-git", "--redact", "--exit-code", "9",
                      "--source", path])
            used = "gitleaks detect (legacy)"
        if p.returncode == 0:
            return "%s: clean" % used
        if p.returncode == 9:
            errors.append("gitleaks found secret(s) - run gitleaks on the file for "
                          "details, then redact to name + location")
            return "%s: leaks found" % used
        errors.append("installed gitleaks failed to run (exit %d) - validation fails "
                      "closed; fix or uninstall gitleaks, or set "
                      "CHECK_HANDOFF_SKIP_GITLEAKS=1 to bypass this layer only"
                      % p.returncode)
        return "gitleaks errored"
    except (OSError, subprocess.SubprocessError) as e:
        errors.append("installed gitleaks failed to run (%s) - validation fails "
                      "closed; fix or uninstall gitleaks, or set "
                      "CHECK_HANDOFF_SKIP_GITLEAKS=1 to bypass this layer only"
                      % e.__class__.__name__)
        return "gitleaks errored"


def validate_content(text):
    """Structural + secret + injection validation of exact bytes.
    Returns (errors, warnings). Path-independent by design so callers can
    validate the same buffer they will persist or consume."""
    errors, warnings = [], []
    lines = text.splitlines()
    parse_meta(lines, errors)

    order, bodies = section_bodies(lines)
    present = [h for h in order if h in REQUIRED_SECTIONS]
    for s in REQUIRED_SECTIONS:
        n = present.count(s)
        if n == 0:
            errors.append("missing required section: ## %s" % s)
        elif n > 1:
            errors.append("duplicated required section: ## %s" % s)
    if len(present) == len(REQUIRED_SECTIONS) and \
            set(present) == set(REQUIRED_SECTIONS) and present != REQUIRED_SECTIONS:
        errors.append("required sections out of order: %s" % " > ".join(present))

    for i, line in enumerate(lines, 1):
        hit = next((ph for ph in TEMPLATE_PLACEHOLDERS if ph in line), None)
        if hit:
            errors.append("template placeholder on line %d: %r" % (i, hit))
        elif INLINE_MARKER.search(line):
            errors.append("inline placeholder marker on line %d" % i)
        elif FULL_LINE_PLACEHOLDER.match(line) or GENERIC_PLACEHOLDER.search(line):
            errors.append("placeholder-like text on line %d" % i)
    for label, pattern in INJECTION_PATTERNS:
        rx = re.compile(pattern)
        for i, line in enumerate(lines, 1):
            if rx.search(line):
                errors.append("injection-shaped content (%s) on line %d - handoffs "
                              "carry state, not directives" % (label, i))

    for s in REQUIRED_SECTIONS:
        body = bodies.get(s, [])
        substantive = [l for l in body
                       if len(re.sub(r"[*_`#>\-\d.]", " ", l).split()) >= 3
                       and "<" not in l]
        if s in bodies and not substantive:
            errors.append("section ## %s has no substantive content" % s)

    cs = "\n".join(bodies.get("Current state", []))
    if cs:
        for sub in STATE_SUBGROUPS:
            if sub not in cs:
                errors.append("Current state missing subgroup %s" % sub)
        for seg_head, seg in zip(STATE_SUBGROUPS,
                                 re.split("|".join(re.escape(s) for s in STATE_SUBGROUPS),
                                          cs)[1:]):
            if not re.search(r"(?m)(^\s*-\s+\S|^\s*None\s*$)", seg):
                errors.append("Current state subgroup %s is empty - list items or "
                              "write None" % seg_head)
    na_body = "\n".join(bodies.get("Next action", []))
    if na_body:
        immediate = re.split(r"(?m)^\s*Then:?\s*$", na_body)[0]
        if not ANCHOR.search(immediate):
            errors.append("the immediate next action (before 'Then:') has no "
                          "anchor - name the file to touch, or backtick the "
                          "exact command to run")
    vbullets = []
    for line in bodies.get("Verification", []):
        if re.match(r"^\s*-\s", line):
            vbullets.append(line.strip())
        elif vbullets and line.strip() and re.match(r"^\s+\S", line):
            vbullets[-1] += " " + line.strip()  # wrapped continuation
    for b in vbullets:
        if not re.match(r"^-\s*Env\b", b) and not EXPECTED.search(b):
            errors.append("Verification bullet without its own expected result "
                          "(only '- Env' reference lines are exempt): %r" % b)
    for line in bodies.get("Locked decisions and constraints", []):
        if re.match(r"^\s*-\s", line) and \
                not re.match(r"^\s*-\s*(LOCKED:|revisit-if)", line):
            errors.append("unclassified decision bullet (each must start with "
                          "LOCKED: or revisit-if): %r" % line.strip())

    if len(lines) > LINE_CEILING:
        errors.append("line budget exceeded: %d lines (hard ceiling %d) - distill, "
                      "don't transcribe" % (len(lines), LINE_CEILING))
    elif len(lines) > LINE_TARGET:
        warnings.append("over target: %d lines (target %d)" % (len(lines), LINE_TARGET))

    for label, pattern in SECRET_PATTERNS:
        rx = re.compile(pattern)
        for i, line in enumerate(lines, 1):
            if rx.search(line):
                errors.append("secret-shaped content (%s) on line %d - replace the "
                              "value with a variable name and storage location"
                              % (label, i))
    return errors, warnings


def main():
    if len(sys.argv) != 2:
        print("usage: check_handoff.py <handoff-file>", file=sys.stderr)
        return 2
    force_utf8_stdio()
    path = sys.argv[1]
    errors = []
    path_safety(path, errors)
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError as e:
        print("FAIL: cannot read file: %s" % e)
        return 2
    lines = text.splitlines()
    c_errors, warnings = validate_content(text)
    errors.extend(c_errors)
    gitleaks_note = run_gitleaks(path, errors)

    for w in warnings:
        print("WARN: %s" % w)
    if errors:
        for e in errors:
            print("FAIL: %s" % e)
        print("\n%d violation(s). Fix and re-run." % len(errors))
        return 2
    print("PASS: %d lines; structure, order, meta, subgroups, anchors, and "
          "per-command expected results check out; no placeholders; no "
          "secret-shaped content matched known patterns (%s). This is a backstop: "
          "resume still treats all handoff content as untrusted proposals. "
          "[core v%s]" % (len(lines), gitleaks_note, VERSION))
    return 0


if __name__ == "__main__":
    sys.exit(main())
