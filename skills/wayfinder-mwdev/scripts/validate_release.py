#!/usr/bin/env python3
"""Wayfinder release validator (v2.1.2) — smallest sufficient check set.

  validate_release.py --transcripts | --traceability | --capability-names
                      | --tracker | --package | --all

Failure codes (stable, machine-readable): WF211-QUESTION-DUPLICATE,
WF211-CLAIM-OWNER-CONFLATION, WF211-DEPENDENCY-UNSUPPORTED,
WF211-APPROVAL-LANGUAGE-STALE, WF211-EVAL-BENCHMARK-MISMATCH,
WF211-CAPABILITY-NAME-STALE, WF211-PARSE-FAILURE, WF211-COMPILE-FAILURE,
WF211-EVIDENCE-INCOMPLETE. Exit 0 clean, 1 findings, 2 usage, 3 parse error.
"""
import json, os, py_compile, re, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRANSCRIPTS = ROOT / "assets" / "benchmark-transcripts.md"
SUITE = ROOT / "assets" / "evaluation-suite.json"
HISTORICAL_ALLOWLIST = ["references/migration-"]  # explicitly historical material

sys.path.insert(0, str(ROOT / "scripts"))
from benchmark_runner import extract_questions, near_duplicate  # shared normalization

F = []
def finding(code, msg): F.append(f"{code}: {msg}")

# ---------------- transcripts ----------------
def check_transcripts():
    text = TRANSCRIPTS.read_text(encoding="utf-8")
    # regression self-test: the detector must catch the original B2/B3 duplicate pair
    orig_b2 = ("During migration, may services still write identity fields locally with "
               "reconciliation later, or does auth become the single write path on day one?")
    b3_q = "Single write path on day one, or dual-write with reconciliation for a bounded window?"
    good = "Does decommission sequencing for the legacy table need a decision on this map?"
    if not near_duplicate(orig_b2, b3_q):
        finding("WF211-EVIDENCE-INCOMPLETE", "dedup self-test: detector misses the original B2/B3 duplicate")
    if near_duplicate(good, b3_q):
        finding("WF211-EVIDENCE-INCOMPLETE", "dedup self-test: detector false-positives on distinct questions")
    # duplicate / materially-equivalent questions within and across packets
    questions = extract_questions(text)
    for i in range(len(questions)):
        for j in range(i + 1, len(questions)):
            if near_duplicate(questions[i], questions[j]):
                finding("WF211-QUESTION-DUPLICATE",
                        f"{questions[i]!r} ~ {questions[j]!r}")
    # claim/owner conflation in human-facing prose
    if re.search(r"your claim", text, re.IGNORECASE):
        finding("WF211-CLAIM-OWNER-CONFLATION", "human-facing 'your claim' present in transcripts")
    if "claimed_by" not in text or "decision_owner" not in text:
        finding("WF211-CLAIM-OWNER-CONFLATION", "transcripts no longer show both identity fields")
    # unsupported dependency language (transcripts must assert independence, not wire edges)
    for pat in ("wired: backfill", "backfill blocked by", "blocked_by: [7]"):
        if pat in text:
            finding("WF211-DEPENDENCY-UNSUPPORTED", f"dependency assertion present: {pat!r}")
    if "no edge is wired" not in text:
        finding("WF211-DEPENDENCY-UNSUPPORTED", "B4 no-edge assertion missing")
    # stale approval language vs required confirmation semantics
    for pat in ("approval is recorded", "approval bundle"):
        if pat in text.lower():
            finding("WF211-APPROVAL-LANGUAGE-STALE", f"{pat!r} present")
    if "confirmed the decisions during the child interview" not in text:
        finding("WF211-APPROVAL-LANGUAGE-STALE", "B4 confirmation language missing")
    # every benchmark carries id + version
    for bid in ("b1", "b2", "b3", "b4"):
        if not re.search(rf"Benchmark id `{bid}`, version 2\.1\.2", text):
            finding("WF211-EVIDENCE-INCOMPLETE", f"benchmark {bid} missing id/version header")
    # the write-authority question appears exactly once across the effort (inside B3)
    wa = [q for q in questions if near_duplicate(q, b3_q)]
    if len(wa) != 1:
        finding("WF211-QUESTION-DUPLICATE",
                f"write-authority question appears {len(wa)}x across transcripts; expected exactly 1 (in B3)")

# ---------------- traceability ----------------
ANCHORS = {  # terms that must appear in BOTH the eval case text and its benchmark section
    "b1": ["dual-writ", "legacy"],
    "b2": ["email", "canonical", "write authority"],
    "b3": ["write authority", "fog"],
    "b4": ["cutover", "backfill"],
}
def check_traceability():
    suite = json.loads(SUITE.read_text(encoding="utf-8"))
    text = TRANSCRIPTS.read_text(encoding="utf-8")
    sections = {}
    for bid in ANCHORS:
        m = re.search(rf"## B{bid[1]} — .*?(?=\n## B|\Z)", text, re.DOTALL)
        if not m:
            finding("WF211-EVAL-BENCHMARK-MISMATCH", f"benchmark section {bid} not found"); continue
        sections[bid] = m.group(0).lower()
    rows = []
    for case in suite["cases"]:
        link = case.get("benchmark")
        if not link:
            continue
        bid = link.rsplit("#", 1)[-1]
        case_text = json.dumps(case).lower().replace("-", " ")
        ok, missing = True, []
        if bid not in sections:
            ok = False; missing.append("section-missing")
        else:
            for term in (a.replace("-", " ") for a in ANCHORS[bid]):
                if term not in case_text or term not in sections[bid].replace("-", " "):
                    ok = False; missing.append(term)
        if not ok:
            finding("WF211-EVAL-BENCHMARK-MISMATCH",
                    f"{case['id']} -> {bid}: anchor terms not shared: {missing}")
        rows.append({"evaluation_case": case["id"],
                     "evaluated_behavior": case["expected_behavior"][0],
                     "linked_benchmark": bid,
                     "scenario_match": "exact" if ok else "MISMATCH",
                     "evidence_location": f"assets/benchmark-transcripts.md#{bid}",
                     "status": "aligned-v2.1.2" if ok else "unresolved"})
    out = ROOT / "benchmarks" / "traceability.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    md = ["| evaluation case | evaluated behavior | linked benchmark | scenario match | evidence location | status |",
          "|---|---|---|---|---|---|"]
    md += [f"| {r['evaluation_case']} | {r['evaluated_behavior'][:60]}… | {r['linked_benchmark']} | "
           f"{r['scenario_match']} | {r['evidence_location']} | {r['status']} |" for r in rows]
    (ROOT / "benchmarks" / "traceability.md").write_text("\n".join(md) + "\n", encoding="utf-8")

# ---------------- capability names ----------------
def check_capability_names():
    # Claude Code build: capability references use the slash form (/expanded-grill-with-docs).
    # The harness-neutral $ form stays accepted so historical material still validates.
    stale = re.compile(r"(?<![$/])\bexpanded-grill-with-docs\b")
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or path.suffix not in (".md", ".json", ".yaml", ".py"):
            continue
        rel = path.relative_to(ROOT).as_posix()
        if any(rel.startswith(a) for a in HISTORICAL_ALLOWLIST) or rel == "scripts/validate_release.py" \
           or rel.startswith("benchmarks/"):
            continue
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if stale.search(line):
                finding("WF211-CAPABILITY-NAME-STALE", f"{rel}:{n}: {line.strip()[:90]}")

# ---------------- fallback tracker ----------------
def _wt(d, name, fm, body="## Question\nQ\n"):
    (d / "tickets").mkdir(exist_ok=True)
    (d / "tickets" / name).write_text("---\n" + fm + "---\n" + body, encoding="utf-8")

def check_tracker():
    tracker = ROOT / "scripts" / "tracker.py"
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "m"; d.mkdir()
        (d / "map.md").write_text("---\nkind: wayfinder-map\nstate: open\ndriver: \"mark\"\n"
            "created: 2026-07-22\nsuccessor: null\n---\n## Destination\nT\n## Decisions so far\n"
            "- [Done](tickets/001-done.md) — g\n## Not yet specified\n## Out of scope\n", encoding="utf-8")
        _wt(d, "001-done.md", 'id: 1\ntitle: "Done"\ntype: grilling\nstate: closed\nclaimed_by: ""\n'
            'decision_owner: "mark"\nblocked_by: []\ncreated: 2026-07-22\nclosed: 2026-07-22\n',
            "## Question\nQ\n## Resolution\nA\n")
        _wt(d, "002-mine.md", 'id: 2\ntitle: "Mine"\ntype: task\nstate: open\nclaimed_by: "mark-cc-a"\n'
            'decision_owner: "mark"\nblocked_by: []\ncreated: 2026-07-22\nclosed: null\n')
        _wt(d, "003-yours.md", 'id: 3\ntitle: "Yours"\ntype: task\nstate: open\nclaimed_by: "mark-cc-b"\n'
            'decision_owner: "mark"\nblocked_by: []\ncreated: 2026-07-22\nclosed: null\n')
        _wt(d, "004-legacy.md", 'id: 4\ntitle: "Legacy"\ntype: task\nstate: open\nassignee: "mark"\n'
            'blocked_by: []\ncreated: 2026-07-22\nclosed: null\n')
        _wt(d, "005-free.md", 'id: 5\ntitle: "Free"\ntype: design\nstate: open\nclaimed_by: ""\n'
            'decision_owner: ""\nblocked_by: []\ncreated: 2026-07-22\nclosed: null\n')
        _wt(d, "006-indep.md", 'id: 6\ntitle: "Indep"\ntype: grilling\nstate: open\nclaimed_by: ""\n'
            'decision_owner: ""\nblocked_by: []\ncreated: 2026-07-22\nclosed: null\n')
        fr = subprocess.run([sys.executable, str(tracker), "frontier", str(d)],
                            capture_output=True, text=True)
        # claimed (modern x2 + legacy) excluded; two independent items on the frontier
        for absent in ("Mine", "Yours", "Legacy"):
            if absent in fr.stdout:
                finding("WF211-EVIDENCE-INCOMPLETE", f"tracker frontier includes claimed ticket {absent}")
        if not ("Free" in fr.stdout and "Indep" in fr.stdout):
            finding("WF211-EVIDENCE-INCOMPLETE", "tracker frontier missing independent unclaimed tickets")
        ck = subprocess.run([sys.executable, str(tracker), "check", str(d)],
                            capture_output=True, text=True)
        if ck.returncode != 1 or "legacy 'assignee'" not in ck.stdout:
            finding("WF211-EVIDENCE-INCOMPLETE", "tracker check did not flag legacy assignee migration")
        # shared decision_owner must never merge distinct work claims
        (d / "tickets" / "005-free.md").write_text((d / "tickets" / "005-free.md").read_text(encoding="utf-8")
            .replace('claimed_by: ""', 'claimed_by: "kira-cc-c"'), encoding="utf-8")
        (d / "tickets" / "006-indep.md").write_text((d / "tickets" / "006-indep.md").read_text(encoding="utf-8")
            .replace('claimed_by: ""', 'claimed_by: "kira-cc-c"'), encoding="utf-8")
        fr2 = subprocess.run([sys.executable, str(tracker), "frontier", str(d)],
                             capture_output=True, text=True)
        if "mark-cc-a(1)" not in fr2.stdout or "mark-cc-b(1)" not in fr2.stdout:
            finding("WF211-EVIDENCE-INCOMPLETE",
                    "empty frontier does not distinguish separate workers for the same human")

# ---------------- package integrity ----------------
def check_package():
    try:
        import yaml
    except ImportError:
        yaml = None
        finding("WF211-PARSE-FAILURE", "pyyaml unavailable — YAML parse validation not performed")
    for path in sorted(ROOT.rglob("*")):
        rel = path.relative_to(ROOT).as_posix()
        if path.is_symlink():
            finding("WF211-EVIDENCE-INCOMPLETE", f"symlink present: {rel}")
        if not path.is_file():
            continue
        try:
            if path.suffix == ".json":
                json.loads(path.read_text(encoding="utf-8"))
            elif path.suffix == ".yaml" and yaml:
                yaml.safe_load(path.read_text(encoding="utf-8"))
            elif path.suffix == ".py":
                py_compile.compile(str(path), doraise=True)
        except py_compile.PyCompileError as e:
            finding("WF211-COMPILE-FAILURE", f"{rel}: {e}")
        except Exception as e:
            finding("WF211-PARSE-FAILURE", f"{rel}: {e}")

CHECKS = {"--transcripts": check_transcripts, "--traceability": check_traceability,
          "--capability-names": check_capability_names, "--tracker": check_tracker,
          "--package": check_package}

def main():
    args = sys.argv[1:] or ["--all"]
    selected = list(CHECKS) if "--all" in args else [a for a in args if a in CHECKS]
    if not selected:
        print(__doc__); sys.exit(2)
    for name in selected:
        before = len(F)
        CHECKS[name]()
        delta = len(F) - before
        print(f"{name[2:]}: {'ok' if delta == 0 else f'{delta} finding(s)'}")
    if F:
        print(f"\n{len(F)} finding(s):")
        for f in F: print(f"  - {f}")
        sys.exit(1)
    print("\nALL SELECTED CHECKS CLEAN")

if __name__ == "__main__":
    main()
