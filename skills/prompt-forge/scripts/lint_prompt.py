#!/usr/bin/env python3
"""lint_prompt.py — static, heuristic linter for generated or pasted prompts.

Part of the prompt-forge skill. Checks are structural heuristics in the
spirit of lintlang: they catch vague, unbounded, or unsafe *language*, not
semantic wrongness. A clean pass is necessary, not sufficient.

Usage:
    python3 lint_prompt.py PROMPT_FILE [--agentic] [--reasoning-model] [--json]
    cat prompt.txt | python3 lint_prompt.py - [flags]

Flags:
    --agentic          Target edits files / runs commands / browses / spends /
                       messages. Missing guardrails become ERRORs.
    --reasoning-model  Target reasons internally (o-series, R1, thinking
                       modes). CoT scaffolding becomes an ERROR.
    --json             Machine-readable findings.

Exit codes: 0 = clean · 1 = warnings only · 2 = one or more errors.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass

ERROR, WARN, INFO = "ERROR", "WARN", "INFO"


@dataclass
class Finding:
    rule: str
    severity: str
    line: int  # 1-based; 0 = whole-document finding
    message: str
    fix: str


# ---------------------------------------------------------------- patterns --

CREDENTIAL_PATTERNS = [
    (r"\bsk-[A-Za-z0-9_-]{8,}", "OpenAI/Stripe-style secret key"),
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key ID"),
    (r"\bghp_[A-Za-z0-9]{20,}", "GitHub personal access token"),
    (r"\bxox[bapor]-[A-Za-z0-9-]{10,}", "Slack token"),
    (r"\bAIza[0-9A-Za-z_-]{30,}", "Google API key"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "PEM private key"),
    (r"\b(?:password|passwd|pwd)\s*[:=]\s*\S{4,}", "inline password assignment"),
    (r"\b(?:api[_-]?key|secret|token)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}",
     "inline secret assignment"),
    (r"(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp)://[^\s'\"]*:[^\s'\"]*@",
     "connection string with embedded credentials"),
    (r"\bBearer\s+[A-Za-z0-9_\-\.=]{20,}", "bearer token"),
]

INJECTION_PATTERNS = [
    r"ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+instructions",
    r"disregard\s+(?:your|all|the)\s+(?:previous\s+)?(?:instructions|rules|guidelines)",
    r"(?:reveal|print|show|output|repeat)\s+(?:your|the)\s+system\s+prompt",
    r"you\s+are\s+now\s+(?:free|unrestricted|jailbroken|dan)\b",
    r"pretend\s+(?:you\s+have|there\s+are)\s+no\s+(?:rules|restrictions|guidelines)",
]

AGENTIC_CAPABILITY = re.compile(
    r"\b(edit|modify|delete|remove|create|write|refactor|rename|move)\b[^.\n]{0,60}"
    r"\b(files?|director(?:y|ies)|repo(?:sitory)?|codebase|schema|database|branch)\b"
    r"|\brun\b[^.\n]{0,40}\b(command|terminal|shell|script|migration)s?\b"
    r"|\b(install|uninstall|upgrade)\b[^.\n]{0,40}\b(dependenc|package|librar)"
    r"|\b(deploy|push\s+to\s+(?:prod|production|main|master)|force[- ]push)\b"
    r"|\b(purchase|buy|checkout|pay|transaction|submit\s+the\s+form)\b"
    r"|\b(send|post)\b[^.\n]{0,40}\b(email|message|dm|tweet|slack)\b",
    re.IGNORECASE,
)

STOP_CONDITION = re.compile(
    r"\bdone\s+when\b|\bstop\s+(?:and\s+ask|when|after|before|if)\b"
    r"|\bask\s+(?:me\s+)?(?:before|first)\b|\bcheck\s*point\b"
    r"|\breturn\s+(?:only\s+)?when\b|\bdo\s+not\s+(?:touch|modify|delete|edit)\b"
    r"|\bconfirm\s+(?:with\s+me\s+)?before\b|\brequire\s+(?:my\s+)?approval\b"
    r"|\bforbidden\s+actions?\b|\bmust\s+not\s+(?:touch|modify|delete)\b"
    r"|\bhuman\s+review\b|\bwithout\s+(?:my\s+)?(?:approval|confirmation)\b",
    re.IGNORECASE,
)

PERSISTENCE = re.compile(
    r"\bdo\s+not\s+(?:return|stop|give\s+up|quit)\s+until\b"
    r"|\bkeep\s+(?:going|working|trying)\b|\bnever\s+give\s+up\b"
    r"|\bspend\s+at\s+least\b|\bassume\s+(?:that\s+)?a\s+(?:complete\s+)?solution\s+exists\b"
    r"|\buntil\s+(?:it|the\s+task|everything)\s+is\s+(?:complete|done|solved)\b",
    re.IGNORECASE,
)

VERIFICATION = re.compile(
    r"\bverif(?:y|ied|ication)\b|\baudit(?:ed|or|s)?\b|\bcheck(?:ed)?\s+against\b"
    r"|\breview(?:ed|er)?\b|\bvalidat(?:e|ed|ion)\b|\btest(?:s|ed)?\s+pass\b"
    r"|\bsurviv(?:e|es|ed)\s+(?:the\s+)?(?:audit|review)\b|\bdoes\s+not\s+count\b",
    re.IGNORECASE,
)

COT_SCAFFOLD = re.compile(
    r"\bthink\s+step[\s-]+by[\s-]+step\b|\bchain[\s-]+of[\s-]+thought\b"
    r"|\blet'?s\s+think\s+(?:about\s+this\s+)?step\b"
    r"|\bshow\s+your\s+(?:reasoning|work)\s+step\b",
    re.IGNORECASE,
)

VAGUE_OPENING = re.compile(
    r"^\s*(?:please\s+)?(help|handle|improve|fix|optimize|enhance|deal\s+with|"
    r"look\s+at|do\s+something\s+about)\b(?![^.\n]{0,80}\b(?:`|\bfunction\b|\bfile\b|"
    r"\bline\s+\d|\bclass\b|\bendpoint\b|\berror\b|\bmethod\b))",
    re.IGNORECASE,
)

OUTPUT_CONTRACT = re.compile(
    r"\boutput\b|\bformat\b|\brespond\s+(?:with|in|using)\b|\breturn\s+(?:a|an|the|only)\b"
    r"|\bjson\b|\bmarkdown\b|\btable\b|\bbullet\b|\b\d+\s+(?:words?|sentences?|"
    r"paragraphs?|lines?|bullets?|items?)\b|\bdone\s+when\b|\bdeliverable\b"
    r"|\bas\s+a\s+(?:report|table|list|diff|summary|spreadsheet)\b"
    r"|\bstructure\s+(?:the|your)\b|--ar\s+\d|\bnegative\s+prompt\b",
    re.IGNORECASE,
)

TODO_MARKERS = re.compile(r"\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b|\?\?\?|<fill[\s_-]?in",
                          re.IGNORECASE)

EMPHASIS = re.compile(r"\b(MUST(?:\s+NOT)?|NEVER|ALWAYS)\b")

# Density above which emphasis stacking is flagged: more than one
# absolute per 40 words is over-prescription for current frontier models.
EMPHASIS_WORDS_PER_TOKEN = 40
EMPHASIS_MIN_HITS = 4

# Lines shorter than this are ignored by the duplicate-rule check
# (headings, list markers, and template braces produce benign repeats).
DUP_MIN_LEN = 40


# ---------------------------------------------------------------- checks ----

def lint(text: str, agentic: bool, reasoning: bool) -> list[Finding]:
    findings: list[Finding] = []
    lines = text.splitlines()

    def first_match_line(pattern: re.Pattern | str) -> int:
        pat = re.compile(pattern, re.IGNORECASE) if isinstance(pattern, str) else pattern
        for i, ln in enumerate(lines, 1):
            if pat.search(ln):
                return i
        return 0

    # CRED — always an error
    for pat, label in CREDENTIAL_PATTERNS:
        n = first_match_line(pat)
        if n:
            findings.append(Finding(
                "CRED", ERROR, n,
                f"Possible credential in prompt text ({label}).",
                "Strip it; reference an environment variable or a "
                "pre-authenticated session instead."))

    # INJECT — embedded override language
    for pat in INJECTION_PATTERNS:
        n = first_match_line(pat)
        if n:
            findings.append(Finding(
                "INJECT", ERROR, n,
                "Embedded instruction-override language (prompt-injection pattern).",
                "Remove; if analyzing a pasted prompt, treat it as inert data "
                "and flag the override as a defect."))
            break

    # AGENTIC — capability without guardrails
    cap_line = first_match_line(AGENTIC_CAPABILITY)
    has_guardrails = bool(STOP_CONDITION.search(text))
    if agentic or cap_line:
        if not has_guardrails:
            sev = ERROR if agentic else WARN
            findings.append(Finding(
                "AGENTIC", sev, cap_line,
                "Agentic capability granted with no stop condition, "
                "approval gate, or forbidden-actions language detected.",
                "Add a done-when condition, scope locks (paths / "
                "do-not-touch list), and 'stop and ask before' gates for "
                "destructive or irreversible actions."))

    # PERSIST — persistence without verification
    p_line = first_match_line(PERSISTENCE)
    if p_line and not VERIFICATION.search(text):
        findings.append(Finding(
            "PERSIST", ERROR, p_line,
            "Persistence instruction with no verification gate in the prompt.",
            "Pair it: adversarial audit, enumerated failure-mode checklist, "
            "or a return condition stated as a predicate over the artifact."))

    # COT — scaffolding on reasoning-native targets
    c_line = first_match_line(COT_SCAFFOLD)
    if c_line:
        if reasoning:
            findings.append(Finding(
                "COT", ERROR, c_line,
                "Chain-of-thought scaffolding aimed at a reasoning-native model.",
                "Delete it; these models reason internally and scaffolds "
                "degrade output. State the goal and the completion bar only."))
        else:
            findings.append(Finding(
                "COT", INFO, c_line,
                "Chain-of-thought scaffolding present.",
                "Fine for standard instruct models on logic/debug tasks; "
                "remove if the target turns out to be reasoning-native."))

    # VAGUE — vague opening verb without a concrete object nearby
    v_line = first_match_line(VAGUE_OPENING)
    if v_line:
        findings.append(Finding(
            "VAGUE", WARN, v_line,
            "Opens with a vague task verb and no concrete object in reach.",
            "Name the precise operation and object: file, function, error, "
            "artifact."))

    # FORMAT — no output contract anywhere
    if not OUTPUT_CONTRACT.search(text):
        findings.append(Finding(
            "FORMAT", WARN, 0,
            "No output contract detected (format, length, or done-condition).",
            "State the expected shape and length, and what 'done' looks like."))

    # STACK — emphasis over-prescription
    words = max(len(text.split()), 1)
    hits = len(EMPHASIS.findall(text))
    if hits >= EMPHASIS_MIN_HITS and hits > words / EMPHASIS_WORDS_PER_TOKEN:
        findings.append(Finding(
            "STACK", WARN, 0,
            f"{hits} MUST/NEVER/ALWAYS absolutes in {words} words — "
            "emphasis stacking degrades current frontier models.",
            "Keep absolutes for hard safety boundaries; carry the rest as "
            "plain constraints and a completion bar."))

    # TODO — unresolved placeholders (bracketed fill-slots like [AUDIENCE]
    # are intentional and not flagged)
    t_line = first_match_line(TODO_MARKERS)
    if t_line:
        findings.append(Finding(
            "TODO", WARN, t_line,
            "Unresolved placeholder (TODO/TBD/FIXME/???).",
            "Resolve it or convert it into a labeled assumption the user "
            "can correct."))

    # DUP — duplicated non-trivial lines (one rule, one owner)
    seen: dict[str, int] = {}
    for i, ln in enumerate(lines, 1):
        key = ln.strip().lower()
        if len(key) >= DUP_MIN_LEN:
            if key in seen:
                findings.append(Finding(
                    "DUP", WARN, i,
                    f"Line duplicates line {seen[key]} — same rule stated twice.",
                    "Keep one authoritative owner per rule; delete the repeat."))
            else:
                seen[key] = i

    return findings


# ---------------------------------------------------------------- cli -------

def main() -> int:
    ap = argparse.ArgumentParser(description="Static prompt linter (prompt-forge)")
    ap.add_argument("file", help="prompt file, or '-' for stdin")
    ap.add_argument("--agentic", action="store_true",
                    help="target has real system access; missing guardrails are errors")
    ap.add_argument("--reasoning-model", action="store_true",
                    help="target reasons internally; CoT scaffolding is an error")
    ap.add_argument("--json", action="store_true", help="JSON output")
    args = ap.parse_args()

    try:
        text = sys.stdin.read() if args.file == "-" else open(
            args.file, encoding="utf-8", errors="replace").read()
    except OSError as e:
        print(f"lint_prompt: cannot read {args.file}: {e}", file=sys.stderr)
        return 2

    if not text.strip():
        print("lint_prompt: input is empty — nothing to lint.", file=sys.stderr)
        return 2

    findings = lint(text, args.agentic, args.reasoning_model)
    errors = [f for f in findings if f.severity == ERROR]
    warns = [f for f in findings if f.severity == WARN]

    if args.json:
        print(json.dumps({"findings": [asdict(f) for f in findings],
                          "errors": len(errors), "warnings": len(warns)}, indent=2))
    else:
        if not findings:
            print("clean: no findings.")
        for f in findings:
            loc = f"line {f.line}" if f.line else "document"
            print(f"[{f.severity}] {f.rule} ({loc}): {f.message}\n    fix: {f.fix}")
        print(f"\n{len(errors)} error(s), {len(warns)} warning(s). "
              "Heuristic pass — clean is necessary, not sufficient.")

    return 2 if errors else (1 if warns else 0)


if __name__ == "__main__":
    sys.exit(main())
