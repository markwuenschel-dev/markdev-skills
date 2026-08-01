#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from validate_skill import validate


VALID_SKILL = """---
name: sample-skill
description: Creates sample outputs. Use when a sample package is requested. Do not use for unrelated documentation.
---

# Sample Skill

1. Create the requested artifact.

**Completion criterion:** the artifact exists and validates.
"""


class ValidateSkillTests(unittest.TestCase):
    def test_valid_minimal_skill(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample-skill"
            root.mkdir()
            (root / "SKILL.md").write_text(VALID_SKILL, encoding="utf-8")
            findings = validate(root, 500)
            self.assertFalse([f for f in findings if f.severity == "error"])

    def test_detects_name_mismatch_and_broken_link(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "wrong-directory"
            root.mkdir()
            text = VALID_SKILL + "\nRead [missing](references/missing.md).\n"
            (root / "SKILL.md").write_text(text, encoding="utf-8")
            codes = {f.code for f in validate(root, 500)}
            self.assertIn("name.directory", codes)
            self.assertIn("link.broken", codes)

    def test_detects_nested_reference(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample-skill"
            nested = root / "references" / "nested"
            nested.mkdir(parents=True)
            (root / "SKILL.md").write_text(VALID_SKILL, encoding="utf-8")
            (nested / "rules.md").write_text("# Rules\n", encoding="utf-8")
            codes = {f.code for f in validate(root, 500)}
            self.assertIn("structure.nested", codes)

    def test_validates_root_relative_code_paths_in_skill(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample-skill"
            (root / "assets").mkdir(parents=True)
            (root / "assets" / "template.json").write_text("{}\n", encoding="utf-8")
            text = VALID_SKILL + "\nUse `assets/template.json`.\n"
            (root / "SKILL.md").write_text(text, encoding="utf-8")
            self.assertNotIn("path.broken", {f.code for f in validate(root, 500)})

            (root / "SKILL.md").write_text(text.replace("template.json", "missing.json"), encoding="utf-8")
            self.assertIn("path.broken", {f.code for f in validate(root, 500)})

    def test_ignores_python_cache_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample-skill"
            cache = root / "scripts" / "__pycache__"
            cache.mkdir(parents=True)
            (root / "SKILL.md").write_text(VALID_SKILL, encoding="utf-8")
            (cache / "tool.cpython-313.pyc").write_bytes(b"cache")
            self.assertNotIn("structure.nested", {f.code for f in validate(root, 500)})

    def test_risk_suppression_is_line_scoped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample-skill"
            scripts = root / "scripts"
            scripts.mkdir(parents=True)
            (root / "SKILL.md").write_text(VALID_SKILL, encoding="utf-8")
            (scripts / "tool.py").write_text(
                '# reviewed signature: curl  # skillwright: allow-risk\nprint("curl")\n',
                encoding="utf-8",
            )
            risk_lines = [f.line for f in validate(root, 500) if f.code == "script.risk-review"]
            self.assertEqual(risk_lines, [2])

    def test_missing_name_and_description_are_warnings_not_errors(self) -> None:
        # Claude Code falls back to the directory name and the first markdown
        # paragraph, so omitting these fields does not break the skill.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample-skill"
            root.mkdir()
            (root / "SKILL.md").write_text("---\n---\n\n# Sample Skill\n\nDo the thing.\n", encoding="utf-8")
            findings = validate(root, 500)
            codes_by_severity = {f.code: f.severity for f in findings}
            self.assertEqual(codes_by_severity.get("name.missing"), "warning")
            self.assertEqual(codes_by_severity.get("description.missing"), "warning")
            self.assertFalse([f for f in findings if f.severity == "error"])

    def test_description_length_cap_includes_when_to_use(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample-skill"
            root.mkdir()
            text = (
                "---\nname: sample-skill\ndescription: "
                + ("a" * 1500)
                + "\nwhen_to_use: "
                + ("b" * 100)
                + "\n---\n\nBody.\n"
            )
            (root / "SKILL.md").write_text(text, encoding="utf-8")
            codes = {f.code for f in validate(root, 500)}
            self.assertIn("description.length", codes)

    def test_flags_invalid_context_effort_and_bool_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample-skill"
            root.mkdir()
            text = VALID_SKILL.replace(
                "---\nname: sample-skill",
                "---\ncontext: subagent\neffort: extreme\ndisable-model-invocation: yes\nname: sample-skill",
            )
            (root / "SKILL.md").write_text(text, encoding="utf-8")
            codes = {f.code for f in validate(root, 500)}
            self.assertIn("frontmatter.context", codes)
            self.assertIn("frontmatter.effort", codes)
            self.assertIn("frontmatter.bool", codes)

    def test_line_limit_is_a_warning_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample-skill"
            root.mkdir()
            long_body = VALID_SKILL + ("\nMore detail.\n" * 500)
            (root / "SKILL.md").write_text(long_body, encoding="utf-8")
            findings = validate(root, 500)
            codes_by_severity = {f.code: f.severity for f in findings}
            self.assertEqual(codes_by_severity.get("skill.lines"), "warning")


if __name__ == "__main__":
    unittest.main()
