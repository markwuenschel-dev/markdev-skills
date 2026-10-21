#!/usr/bin/env python3
"""Emit a complete, deterministic JSON lifecycle-state scan for loop-router."""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

# Keep these patterns in sync with references/loop-registry.md.
KNOWN_STATE_FILES = {"STATE.md"}
KNOWN_CONTRACT_TOKEN = "contract"
KNOWN_LEDGER_TOKEN = "ledger"
KNOWN_IDEAS_DIR = Path("docs") / "ideas"
SWARM_PLAN_HEADER = "# Swarm Plan:"
BRANCH_OWNER_PREFIXES = ("flywheel/", "audit/")
EXCLUDED_DIRS = {
    ".git", "node_modules", "dist", "build", "target", ".venv", "venv",
    "vendor", ".next", "__pycache__",
}
MAX_DEPTH = 8


class ScanFailure(Exception):
    def __init__(self, operation: str, path: Path | str, message: str):
        self.operation = operation
        self.path = str(path)
        self.message = message
        super().__init__(f"{operation}: {path}: {message}")


def display_path(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def error_item(exc: BaseException) -> dict[str, str]:
    if isinstance(exc, ScanFailure):
        return {"operation": exc.operation, "path": exc.path, "message": exc.message}
    return {"operation": "scan", "path": "", "message": str(exc)}


def require_directory(path: Path, operation: str) -> None:
    try:
        info = path.stat()
    except OSError as exc:
        raise ScanFailure(operation, path, exc.strerror or str(exc)) from exc
    if not stat.S_ISDIR(info.st_mode):
        raise ScanFailure(operation, path, "not a directory")
    # Root can bypass chmod(000); treat its permission bits as an unreadable
    # lifecycle boundary rather than silently producing a privileged partial scan.
    if not os.access(path, os.R_OK | os.X_OK) or info.st_mode & 0o555 == 0:
        raise ScanFailure(operation, path, "directory is not readable and searchable")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        message = getattr(exc, "strerror", None) or str(exc)
        raise ScanFailure("read", path, message) from exc


def discover(root: Path) -> list[Path]:
    files: list[Path] = []
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack:
        directory, depth = stack.pop()
        require_directory(directory, "traverse")
        try:
            entries = sorted(directory.iterdir(), key=lambda item: item.name)
        except OSError as exc:
            raise ScanFailure("traverse", directory, exc.strerror or str(exc)) from exc
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir():
                    if entry.name not in EXCLUDED_DIRS and depth < MAX_DEPTH:
                        stack.append((entry, depth + 1))
                elif entry.is_file():
                    files.append(entry)
            except OSError as exc:
                raise ScanFailure("traverse", entry, exc.strerror or str(exc)) from exc
    return sorted(files, key=lambda item: display_path(root, item))


def add_file_findings(root: Path, files: list[Path], findings: list[dict]) -> None:
    for path in files:
        relative = display_path(root, path)
        lower = path.name.lower()
        if path.name in KNOWN_STATE_FILES:
            findings.append({"type": "state_file", "path": relative})
        if path.suffix.lower() == ".md" and KNOWN_CONTRACT_TOKEN in lower:
            findings.append({"type": "contract_file", "path": relative})
        if path.suffix.lower() == ".md" and KNOWN_LEDGER_TOKEN in lower:
            findings.append({"type": "audit_ledger", "path": relative})
        if path.suffix.lower() == ".md" and any(
            line.startswith(SWARM_PLAN_HEADER) for line in read_text(path).splitlines()
        ):
            findings.append({"type": "swarm_plan", "path": relative})

    ideas_root = root / KNOWN_IDEAS_DIR
    ideas = [path for path in files if path.parent == ideas_root and path.suffix.lower() == ".md"]
    for path in ideas[:5]:
        findings.append({"type": "idea_input", "path": display_path(root, path)})


def run_git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", "-C", str(root), *args], text=True, encoding="utf-8", errors="strict",
            capture_output=True, check=False,
        )
    except (OSError, UnicodeError) as exc:
        message = getattr(exc, "strerror", None) or str(exc)
        raise ScanFailure("git", root, message) from exc


def inspect_git(root: Path, findings: list[dict], warnings: list[dict]) -> None:
    if shutil.which("git") is None:
        warnings.append({"operation": "git", "path": ".", "message": "Git is unavailable; Git signals skipped"})
        return
    context = run_git(root, "rev-parse", "--is-inside-work-tree")
    inside = context.returncode == 0 and context.stdout.strip() == "true"
    if not inside:
        if (root / ".git").exists():
            detail = context.stderr.strip() or context.stdout.strip() or "Git metadata is malformed or inaccessible"
            raise ScanFailure("git", root / ".git", detail)
        if context.returncode in (1, 128):
            warnings.append({"operation": "git", "path": ".", "message": "not a Git repository; Git signals skipped"})
            return
        raise ScanFailure("git", root, context.stderr.strip() or "unable to determine Git context")

    def required(*args: str) -> str:
        result = run_git(root, *args)
        if result.returncode != 0:
            raise ScanFailure("git", root, result.stderr.strip() or f"git {' '.join(args)} failed")
        return result.stdout

    branch = required("branch", "--show-current").strip() or "(detached-or-unborn)"
    status = required("status", "--porcelain=v1", "-z")
    worktrees = required("worktree", "list", "--porcelain")
    default = run_git(root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    if default.returncode == 0:
        default_branch = default.stdout.strip().removeprefix("origin/")
    elif default.returncode == 1:
        default_branch = None
        warnings.append({"operation": "git", "path": ".", "message": "origin/HEAD is unavailable"})
    else:
        raise ScanFailure("git", root, default.stderr.strip() or "unable to inspect origin/HEAD")

    owner = next((prefix[:-1] for prefix in BRANCH_OWNER_PREFIXES if branch.startswith(prefix)), "unknown")
    annotation = {"branch": branch, "owner_hint": owner}
    if default_branch and branch not in {default_branch, "(detached-or-unborn)"}:
        findings.append({"type": "git_non_default_branch", **annotation})
    elif not default_branch and branch not in {"main", "master", "(detached-or-unborn)"}:
        findings.append({"type": "git_non_default_branch", **annotation})

    dirty_paths = status.count("\0")
    if dirty_paths:
        findings.append({"type": "git_dirty_paths", "count": dirty_paths, **annotation})
    worktree_count = sum(1 for line in worktrees.splitlines() if line.startswith("worktree "))
    if worktree_count > 1:
        findings.append({"type": "git_extra_worktrees", "count": worktree_count - 1, **annotation})


def scan(root_arg: str) -> tuple[dict, int]:
    findings: list[dict] = []
    warnings: list[dict] = []
    try:
        root = Path(root_arg).expanduser().resolve()
        require_directory(root, "traverse")
        files = discover(root)
        add_file_findings(root, files, findings)
        inspect_git(root, findings, warnings)
    except Exception as exc:  # Convert all scanner failures into data.
        return {
            "scan_complete": False,
            "findings": [],
            "warnings": warnings,
            "errors": [error_item(exc)],
        }, 1
    findings.sort(key=lambda item: (item["type"], item.get("path", ""), item.get("branch", "")))
    return {"scan_complete": True, "findings": findings, "warnings": warnings, "errors": []}, (2 if findings else 0)


def main() -> int:
    if len(sys.argv) > 2:
        result = {"scan_complete": False, "findings": [], "warnings": [], "errors": [{
            "operation": "usage", "path": "", "message": "usage: scan_state.sh [repo_root]",
        }]}
        print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
        return 1
    result, code = scan(sys.argv[1] if len(sys.argv) == 2 else ".")
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return code


if __name__ == "__main__":
    sys.exit(main())
