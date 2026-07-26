#!/usr/bin/env python3
"""Static validator for Claude Code Agent Skill packages (SKILL.md).

Claude Code ships no built-in linter for skills, so this script is not a
duplicate of anything the platform already does. It checks structure,
frontmatter, links, and common security smells; it does not check activation
behavior — use the `skill-creator` plugin or `assets/evaluation-suite.json`
for that.

Exit codes:
  0: no errors; warnings accepted
  1: one or more errors
  2: warnings present under --strict
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
CODE_PATH_RE = re.compile(r"`((?:references|assets|scripts)/[^`\s]+)`")
SECRET_PATTERNS = {
    "OpenAI-style key": re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
}
RISK_PATTERNS = {
    "destructive shell command": re.compile(r"\brm\s+-rf\b|\bdel\s+/[sq]\b", re.IGNORECASE),
    "privilege escalation": re.compile(r"\bsudo\b|\bRunAs\b"),
    "implicit latest dependency": re.compile(r"\bnpx\s+\S+@latest\b|\bpip\s+install\b|\bnpm\s+install\b"),
    "network fetch": re.compile(r"\bcurl\b|\bwget\b|Invoke-WebRequest"),  # skillwright: allow-risk
    "dynamic evaluation": re.compile(r"\beval\s*\(|\bexec\s*\("),
}
FORBIDDEN_DOCS = {"README.md", "CHANGELOG.md", "INSTALLATION_GUIDE.md"}
STANDARD_DIRS = {"references", "assets", "scripts"}
IGNORED_TREE_NAMES = {"__pycache__", ".DS_Store"}
RISK_SUPPRESSION = "skillwright: allow-risk"


@dataclass(frozen=True)
class Finding:
    severity: str
    code: str
    message: str
    path: str
    line: int | None = None


def add(findings: list[Finding], severity: str, code: str, message: str, path: Path, line: int | None = None) -> None:
    findings.append(Finding(severity, code, message, path.as_posix(), line))


def parse_scalar(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    if value[0:1] in {"'", '"'}:
        try:
            parsed = ast.literal_eval(value)
            return str(parsed)
        except (SyntaxError, ValueError):
            return value.strip("'\"")
    return value


def parse_frontmatter(text: str, path: Path, findings: list[Finding]) -> tuple[dict[str, str], str, int]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        add(findings, "error", "frontmatter.missing", "SKILL.md must start with YAML frontmatter delimited by ---." , path, 1)
        return {}, text, 0

    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        add(findings, "error", "frontmatter.unclosed", "Frontmatter is missing its closing --- delimiter.", path, 1)
        return {}, text, 0

    data: dict[str, str] = {}
    i = 1
    while i < end:
        raw = lines[i]
        if not raw.strip() or raw.lstrip().startswith("#"):
            i += 1
            continue
        if raw.startswith((" ", "\t")):
            add(findings, "warning", "frontmatter.nested", "Nested frontmatter could not be fully validated by the portable parser.", path, i + 1)
            i += 1
            continue
        if ":" not in raw:
            add(findings, "error", "frontmatter.syntax", "Expected a top-level 'key: value' entry.", path, i + 1)
            i += 1
            continue
        key, value = raw.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value in {"|", ">", "|-", ">-", "|+", ">+"}:
            block: list[str] = []
            i += 1
            while i < end and (not lines[i].strip() or lines[i].startswith((" ", "\t"))):
                block.append(lines[i].lstrip())
                i += 1
            data[key] = ("\n" if value.startswith("|") else " ").join(block).strip()
            continue
        data[key] = parse_scalar(value)
        i += 1

    body = "\n".join(lines[end + 1 :])
    return data, body, end + 2


def internal_markdown_files(root: Path) -> Iterable[Path]:
    yield root / "SKILL.md"
    ref_dir = root / "references"
    if ref_dir.is_dir():
        yield from sorted(p for p in ref_dir.iterdir() if p.is_file() and p.suffix.lower() == ".md")


def validate_links(root: Path, path: Path, text: str, findings: list[Finding]) -> set[Path]:
    referenced: set[Path] = set()
    matches = [(match, match.group(1), "link") for match in LINK_RE.finditer(text)]
    if path.resolve() == (root / "SKILL.md").resolve():
        matches.extend((match, match.group(1), "path") for match in CODE_PATH_RE.finditer(text))

    for match, raw_target, source_kind in matches:
        target = unquote(raw_target.strip().split(" ", 1)[0].strip("<>"))
        if not target or target.startswith(("#", "http://", "https://", "mailto:", "data:")):
            continue
        clean = target.split("#", 1)[0].split("?", 1)[0]
        if not clean:
            continue
        line = text[: match.start()].count("\n") + 1
        if "\\" in clean:
            add(findings, "error", "path.backslash", "Use forward slashes in relative paths.", path, line)
        resolved = ((root if source_kind == "path" else path.parent) / clean).resolve()
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            add(findings, "error", "path.escape", f"Referenced path escapes the skill directory: {target}", path, line)
            continue
        referenced.add(resolved)
        if not resolved.exists():
            code = "link.broken" if source_kind == "link" else "path.broken"
            add(findings, "error", code, f"Referenced file does not exist: {target}", path, line)
    return referenced


def validate(root_arg: Path, max_lines: int) -> list[Finding]:
    findings: list[Finding] = []
    root = root_arg.parent if root_arg.is_file() else root_arg
    root = root.resolve()
    skill_path = root / "SKILL.md"

    if not root.exists():
        add(findings, "error", "package.missing", "Skill path does not exist.", root)
        return findings
    if not skill_path.is_file():
        add(findings, "error", "skill.missing", "Skill directory must contain SKILL.md.", skill_path)
        return findings

    try:
        text = skill_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        add(findings, "error", "encoding.utf8", "SKILL.md must be valid UTF-8.", skill_path)
        return findings

    frontmatter, body, body_start = parse_frontmatter(text, skill_path, findings)
    name = frontmatter.get("name", "").strip()
    description = frontmatter.get("description", "").strip()
    when_to_use = frontmatter.get("when_to_use", "").strip()

    # Claude Code does not require `name` (falls back to the directory name) or
    # `description` (falls back to the first markdown paragraph); mismatches
    # below are flagged as warnings because they cause real confusion, not
    # because the platform rejects them.
    if name:
        if not NAME_RE.fullmatch(name):
            add(findings, "warning", "name.format", "Name is not lowercase letters, numbers, and single hyphens — harmless to Claude Code, but inconsistent with skill naming convention.", skill_path)
        if name != root.name:
            add(findings, "warning", "name.directory", f"Name '{name}' differs from directory '{root.name}'. The command a user types comes from the directory, not this field, so a mismatch is confusing even though Claude Code allows it.", skill_path)
        if any(reserved in name.split("-") for reserved in ("anthropic", "claude")):
            add(findings, "warning", "name.reserved", "Name contains 'claude'/'anthropic' — not blocked by Claude Code, but risks confusion with bundled or official skills.", skill_path)
        if "<" in name or ">" in name:
            add(findings, "error", "name.xml", "Name must not contain XML tags.", skill_path)
    else:
        add(findings, "warning", "name.missing", "No name set; Claude Code will use the directory name for display. Set it explicitly for clarity.", skill_path)

    combined_desc_len = len(description) + len(when_to_use)
    if not description:
        add(findings, "warning", "description.missing", "No description set; Claude Code falls back to the first markdown paragraph, which is rarely written for routing. Add an explicit description.", skill_path)
    else:
        if combined_desc_len > 1536:
            add(findings, "error", "description.length", f"description + when_to_use is {combined_desc_len} characters; Claude Code truncates the combined text at 1,536 in the skill listing.", skill_path)
        if re.match(r"^(I|We|You)\b", description, re.IGNORECASE):
            add(findings, "warning", "description.person", "Write the description in third person.", skill_path)
        if not re.search(r"\bUse when\b", description, re.IGNORECASE):
            add(findings, "warning", "description.trigger", "Description should state when the skill is used.", skill_path)
        if not re.search(r"\b(?:Do not use|Don't use|Not for)\b", description, re.IGNORECASE):
            add(findings, "warning", "description.nongoal", "Consider naming the closest non-goal to sharpen routing.", skill_path)
        if "<" in description or ">" in description:
            add(findings, "error", "description.xml", "Description must not contain XML tags.", skill_path)

    for bool_field in ("disable-model-invocation", "user-invocable"):
        value = frontmatter.get(bool_field, "").strip().lower()
        if value and value not in {"true", "false"}:
            add(findings, "error", "frontmatter.bool", f"'{bool_field}' must be 'true' or 'false', got '{value}'.", skill_path)

    context_value = frontmatter.get("context", "").strip()
    if context_value and context_value != "fork":
        add(findings, "error", "frontmatter.context", f"'context' only accepts 'fork', got '{context_value}'.", skill_path)
    if frontmatter.get("agent", "").strip() and context_value != "fork":
        add(findings, "warning", "frontmatter.agent-without-fork", "'agent' has no effect unless 'context: fork' is also set.", skill_path)

    effort_value = frontmatter.get("effort", "").strip()
    if effort_value and effort_value not in {"low", "medium", "high", "xhigh", "max"}:
        add(findings, "error", "frontmatter.effort", f"'effort' must be one of low/medium/high/xhigh/max, got '{effort_value}'.", skill_path)

    line_count = len(text.splitlines())
    if line_count > max_lines:
        add(findings, "warning", "skill.lines", f"SKILL.md has {line_count} lines; {max_lines} is Anthropic's advisory limit, not an enforced one — every loaded line is a recurring token cost for the rest of the session.", skill_path)

    if "\\" in body:
        for lineno, line in enumerate(body.splitlines(), start=body_start):
            if "\\" in line and not re.search(r"\\[nrt'\"\\]", line):
                add(findings, "warning", "path.possible-backslash", "Possible Windows-style path; use forward slashes.", skill_path, lineno)

    for marker in ("TODO", "TBD", "FIXME", "XXX"):
        for lineno, line in enumerate(text.splitlines(), start=1):
            if re.search(rf"\b{marker}\b", line):
                add(findings, "warning", "placeholder.present", f"Unresolved placeholder '{marker}'.", skill_path, lineno)

    referenced: set[Path] = set()
    for md_path in internal_markdown_files(root):
        if not md_path.exists():
            continue
        md_text = md_path.read_text(encoding="utf-8")
        referenced |= validate_links(root, md_path, md_text, findings)
        for label, pattern in SECRET_PATTERNS.items():
            for match in pattern.finditer(md_text):
                line = md_text[: match.start()].count("\n") + 1
                add(findings, "error", "secret.detected", f"Possible {label} embedded in text.", md_path, line)

    for dirname in STANDARD_DIRS:
        directory = root / dirname
        if not directory.exists():
            continue
        if not directory.is_dir():
            add(findings, "error", "structure.type", f"{dirname} must be a directory.", directory)
            continue
        for item in directory.rglob("*"):
            if any(part in IGNORED_TREE_NAMES for part in item.relative_to(directory).parts):
                continue
            if item.is_file():
                depth = len(item.relative_to(directory).parts)
                if depth > 1:
                    add(findings, "error", "structure.nested", f"Keep {dirname}/ files one level deep: {item.relative_to(root).as_posix()}", item)
            if item.is_symlink():
                resolved = item.resolve()
                try:
                    resolved.relative_to(root)
                except ValueError:
                    add(findings, "error", "structure.symlink", "Symlink escapes the skill directory.", item)

    for forbidden in FORBIDDEN_DOCS:
        candidate = root / forbidden
        if candidate.exists():
            add(findings, "warning", "structure.extra-doc", f"Remove {forbidden}; agent skills should keep operational content in SKILL.md and disclosed resources.", candidate)

    support_files = {
        p.resolve()
        for dirname in STANDARD_DIRS
        for p in ((root / dirname).iterdir() if (root / dirname).is_dir() else [])
        if p.is_file()
    }
    for support in sorted(support_files):
        if support.name.startswith("."):
            continue
        if support not in referenced and support.parent.name == "references":
            add(findings, "warning", "reference.unused", "Reference is not linked from SKILL.md or another reference.", support)

    script_dir = root / "scripts"
    if script_dir.is_dir():
        for script in sorted(p for p in script_dir.iterdir() if p.is_file()):
            try:
                script_text = script.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for label, pattern in SECRET_PATTERNS.items():
                for match in pattern.finditer(script_text):
                    line = script_text[: match.start()].count("\n") + 1
                    add(findings, "error", "secret.detected", f"Possible {label} embedded in script.", script, line)
            script_lines = script_text.splitlines()
            for label, pattern in RISK_PATTERNS.items():
                for match in pattern.finditer(script_text):
                    line = script_text[: match.start()].count("\n") + 1
                    if RISK_SUPPRESSION in script_lines[line - 1]:
                        continue
                    add(findings, "warning", "script.risk-review", f"Review {label} for approval, pinning, and sandbox requirements.", script, line)

    return sorted(findings, key=lambda f: ({"error": 0, "warning": 1}.get(f.severity, 2), f.path, f.line or 0, f.code))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="Skill directory or SKILL.md path")
    parser.add_argument("--strict", action="store_true", help="Return exit code 2 when warnings remain")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Emit JSON")
    parser.add_argument("--max-lines", type=int, default=500, help="Maximum SKILL.md line count (default: 500)")
    args = parser.parse_args()

    findings = validate(args.path, args.max_lines)
    errors = sum(f.severity == "error" for f in findings)
    warnings = sum(f.severity == "warning" for f in findings)

    if args.as_json:
        print(json.dumps({"errors": errors, "warnings": warnings, "findings": [asdict(f) for f in findings]}, indent=2))
    else:
        for finding in findings:
            location = f"{finding.path}:{finding.line}" if finding.line else finding.path
            print(f"{finding.severity.upper():7} {finding.code:28} {location} — {finding.message}")
        print(f"\nSummary: {errors} error(s), {warnings} warning(s)")

    if errors:
        return 1
    if warnings and args.strict:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
