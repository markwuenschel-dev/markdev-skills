#!/usr/bin/env python3
"""Deterministic reliability checks for loop-router's scanner and validator."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCANNER = ROOT / "scripts" / "scan_state.sh"
VALIDATOR_PATH = ROOT / "scripts" / "validate_route_record.py"
VALIDATOR_SPEC = importlib.util.spec_from_file_location("route_validator", VALIDATOR_PATH)
assert VALIDATOR_SPEC and VALIDATOR_SPEC.loader
route_validator = importlib.util.module_from_spec(VALIDATOR_SPEC)
VALIDATOR_SPEC.loader.exec_module(route_validator)
SCANNER_SPEC = importlib.util.spec_from_file_location("state_scanner", ROOT / "scripts" / "scan_state.py")
assert SCANNER_SPEC and SCANNER_SPEC.loader
state_scanner = importlib.util.module_from_spec(SCANNER_SPEC)
SCANNER_SPEC.loader.exec_module(state_scanner)
BASH = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else shutil.which("bash")


def route(loop: str, mode: str | None = None) -> dict:
    mode = mode or next(iter(route_validator.LOOP_RULES[loop]["mutation_modes"]))
    record = {
        "selected_loop": loop,
        "route_status": "handoff_ready",
        "reason": ["deterministic test route"],
        "input_artifacts": [],
        "mutation_mode": mode,
        "return_condition": ["test condition is met"],
        "from_loop": None,
        "detour_of": None,
        "fallback": None,
        "deferred_work": [],
    }
    if loop == "prototype":
        record["detour_of"] = {"name": "expanded-grill-with-docs", "blocked_question": "Does it work?"}
    return record


def bash_path(path: Path) -> str:
    """Use forward-slash paths with Git Bash while preserving POSIX paths."""
    return str(path).replace("\\", "/")


@unittest.skipUnless(BASH, "bash is required to execute scan_state.sh")
class ScannerTests(unittest.TestCase):
    def scan(self, root: Path) -> tuple[subprocess.CompletedProcess[str], dict]:
        result = subprocess.run(
            [str(BASH), bash_path(SCANNER), bash_path(root)], text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.stderr, "", result.stderr)
        return result, json.loads(result.stdout)

    def test_empty_directory_is_complete_with_no_findings(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            result, payload = self.scan(Path(temp))
        self.assertEqual(result.returncode, 0)
        self.assertTrue(payload["scan_complete"])
        self.assertEqual(payload["findings"], [])
        self.assertEqual(payload["errors"], [])

    @unittest.skipUnless(shutil.which("git"), "git is required for repository scan coverage")
    def test_repository_without_state_is_complete_with_no_findings(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            result, payload = self.scan(root)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(payload["scan_complete"])
        self.assertEqual(payload["findings"], [])

    def test_valid_state_artifact_is_discovered(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "STATE.md").write_text("open session\n", encoding="utf-8")
            result, payload = self.scan(root)
        self.assertEqual(result.returncode, 2)
        self.assertTrue(payload["scan_complete"])
        self.assertIn({"type": "state_file", "path": "STATE.md"}, payload["findings"])

    def test_existing_lifecycle_artifact_types_are_discovered(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "STATE.md").write_text("open\n", encoding="utf-8")
            (root / "delivery.contract.md").write_text("status: approved\n", encoding="utf-8")
            (root / "plan.md").write_text("preamble\n# Swarm Plan: repair\n", encoding="utf-8")
            (root / "audit-ledger.md").write_text("candidate C-01\n", encoding="utf-8")
            ideas = root / "docs" / "ideas"
            ideas.mkdir(parents=True)
            (ideas / "route.md").write_text("idea\n", encoding="utf-8")
            result, payload = self.scan(root)
        self.assertEqual(result.returncode, 2)
        found = {(item["type"], item.get("path")) for item in payload["findings"]}
        self.assertTrue({
            ("state_file", "STATE.md"),
            ("contract_file", "delivery.contract.md"),
            ("swarm_plan", "plan.md"),
            ("audit_ledger", "audit-ledger.md"),
            ("idea_input", "docs/ideas/route.md"),
        }.issubset(found))

    def test_filename_with_spaces_is_discovered_as_one_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state_dir = root / "space dir"
            state_dir.mkdir()
            (state_dir / "STATE.md").write_text("open\n", encoding="utf-8")
            result, payload = self.scan(root)
        self.assertEqual(result.returncode, 2)
        self.assertIn({"type": "state_file", "path": "space dir/STATE.md"}, payload["findings"])

    def test_unreadable_child_fails_closed(self) -> None:
        if os.name == "nt":
            # NTFS does not represent an unreadable directory with chmod(000).
            # Force the same traversal failure at the filesystem boundary.
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                blocked = root / "restricted"
                blocked.mkdir()
                original_iterdir = Path.iterdir

                def denied(path: Path):
                    if path == blocked:
                        raise PermissionError("permission denied")
                    return original_iterdir(path)

                with patch.object(Path, "iterdir", denied):
                    payload, code = state_scanner.scan(str(root))
            self.assertEqual(code, 1)
            self.assertFalse(payload["scan_complete"])
            self.assertEqual(payload["findings"], [])
            self.assertEqual(payload["errors"][0]["operation"], "traverse")
            return
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            blocked = root / "restricted"
            blocked.mkdir()
            blocked.chmod(0)
            try:
                result, payload = self.scan(root)
            finally:
                blocked.chmod(0o700)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(payload["scan_complete"])
        self.assertEqual(payload["findings"], [])
        self.assertEqual(payload["errors"][0]["operation"], "traverse")

    @unittest.skipUnless(shutil.which("git"), "git is required for malformed metadata coverage")
    def test_malformed_git_metadata_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / ".git").write_text("not a gitdir\n", encoding="utf-8")
            result, payload = self.scan(root)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(payload["scan_complete"])
        self.assertEqual(payload["errors"][0]["operation"], "git")

    def test_non_git_directory_is_complete_and_warns(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            result, payload = self.scan(Path(temp))
        self.assertEqual(result.returncode, 0)
        self.assertTrue(payload["scan_complete"])
        self.assertTrue(any(item["operation"] == "git" for item in payload["warnings"]))

    @unittest.skipIf(os.name == "nt", "NTFS rejects newline filenames; this portable POSIX case runs in CI")
    def test_paths_with_newlines_and_controls_are_escaped_json_values(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for dirname in ("line\nbreak", "control\x1bdir"):
                path = root / dirname
                path.mkdir()
                (path / "STATE.md").write_text("open\n", encoding="utf-8")
            result, payload = self.scan(root)
        self.assertEqual(result.returncode, 2)
        paths = {finding["path"] for finding in payload["findings"] if finding["type"] == "state_file"}
        self.assertEqual(paths, {"line\nbreak/STATE.md", "control\x1bdir/STATE.md"})
        self.assertIn("line\\nbreak", result.stdout)
        self.assertIn("control\\u001bdir", result.stdout)
        self.assertNotIn("\x1b", result.stdout)


class RouteValidatorTests(unittest.TestCase):
    def assert_invalid(self, record: dict, fragment: str) -> None:
        self.assertTrue(any(fragment in error for error in route_validator.validate(record)), route_validator.validate(record))

    def test_valid_record_for_every_lifecycle(self) -> None:
        modes = {
            "expanded-grill-with-docs": "read_only",
            "repository-health-assessment": "read_only",
            "codebase-integrity-audit-loop": "write",
            "human-directed-swarm-planner": "write",
            "production-flywheel": "write",
            "diagnosing-bugs": "read_only",
            "wayfinder": "read_only",
            "prototype": "read_only",
            "independent-verification": "read_only",
            "none": "read_only",
        }
        for loop, mode in modes.items():
            with self.subTest(loop=loop):
                self.assertEqual(route_validator.validate(route(loop, mode)), [])

    def test_read_only_lifecycles_reject_write(self) -> None:
        for loop in ("expanded-grill-with-docs", "repository-health-assessment", "diagnosing-bugs", "wayfinder", "prototype", "independent-verification"):
            with self.subTest(loop=loop):
                self.assert_invalid(route(loop, "write"), "does not allow mutation_mode")

    def test_none_cannot_require_authorization_or_fallback(self) -> None:
        auth = route("none")
        auth["route_status"] = "authorization_required"
        self.assert_invalid(auth, "must use route_status")
        fallback = route("none")
        fallback["route_status"] = "fallback_required"
        fallback["fallback"] = {"name": "ordinary-session"}
        self.assert_invalid(fallback, "must use route_status")

    def test_prototype_requires_valid_parent(self) -> None:
        missing = route("prototype")
        missing["detour_of"] = None
        self.assert_invalid(missing, "detour_of is required")
        invalid = route("prototype")
        invalid["detour_of"]["name"] = "prototype"
        self.assert_invalid(invalid, "detour_of.name invalid")

    def test_detour_only_belongs_to_prototype(self) -> None:
        record = route("production-flywheel", "write")
        record["detour_of"] = {"name": "expanded-grill-with-docs", "blocked_question": "Does it work?"}
        self.assert_invalid(record, "cannot carry detour_of")

    def test_source_and_destination_cannot_match(self) -> None:
        record = route("diagnosing-bugs")
        record["from_loop"] = {"name": "diagnosing-bugs", "disposition": "closed"}
        self.assert_invalid(record, "cannot equal selected_loop")

    def test_unknown_lifecycle_invalid_mode_and_malformed_fallback_rejected(self) -> None:
        unknown = route("none")
        unknown["selected_loop"] = "invented-loop"
        self.assert_invalid(unknown, "selected_loop invalid")
        mode = route("none")
        mode["mutation_mode"] = "maybe"
        self.assert_invalid(mode, "mutation_mode invalid")
        fallback = route("wayfinder")
        fallback["route_status"] = "fallback_required"
        fallback["fallback"] = {"name": ["not-a-target"]}
        self.assert_invalid(fallback, "fallback.name must be")

    def test_valid_production_and_audit_write_routes_remain_valid(self) -> None:
        self.assertEqual(route_validator.validate(route("production-flywheel", "write")), [])
        self.assertEqual(route_validator.validate(route("codebase-integrity-audit-loop", "write")), [])

    def test_validator_cli_reports_semantic_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "route.json"
            invalid = route("diagnosing-bugs", "write")
            path.write_text(json.dumps(invalid), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(VALIDATOR_PATH), str(path)], text=True, capture_output=True, check=False,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not allow mutation_mode", result.stdout)

    def test_documented_lifecycles_match_the_declarative_rules(self) -> None:
        registry = (ROOT / "references" / "loop-registry.md").read_text(encoding="utf-8")
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        for loop in set(route_validator.LOOP_RULES) - {"none"}:
            self.assertIn(f"### {loop}", registry)
            self.assertIn(loop, skill)
        self.assertNotIn("(P6)", registry)


if __name__ == "__main__":
    unittest.main(verbosity=2)
