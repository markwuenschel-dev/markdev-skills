#!/usr/bin/env python3
"""Wayfinder benchmark runner (v2.1.2) — minimal empirical harness, not a platform.

  benchmark_runner.py --run-all --fresh-context [--model M]
  benchmark_runner.py --run <id> --fresh-context [--model M]
  benchmark_runner.py --validate-results
  benchmark_runner.py --score <normalized.json> --evaluator NAME --pass|--fail \\
      --dim interview=N --dim adaptation=N --dim swarm=N --dim map=N \\
      --dim evolution=N --dim integration=N --dim boundaries=N [--note TEXT] \\
      [--deficiency model|fixture|runner|evaluator]
  benchmark_runner.py --report

Each benchmark runs as ONE brand-new API conversation: only the skill context
files, the scenario fixture, and the scripted turns from
assets/benchmark-fixtures.yaml enter the context. No other run, score, hint, or
map state is included — recorded per run under fresh_context. Raw API responses
are stored byte-identical (raw.json); the normalized record is derived alongside,
never in place of, the raw output. Scoring is PERFORMED by an evaluator via
--score against the frozen rubric; auto-checks are evidence, not scores.
Requires: python3, pyyaml; ANTHROPIC_API_KEY for --run.
Exit codes: 0 ok, 1 findings/failures, 2 usage/environment, 3 parse error.
"""
import argparse, datetime, json, os, re, sys, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "benchmarks" / "runs"
SCORES = ROOT / "benchmarks" / "scores"
FIXTURES = ROOT / "assets" / "benchmark-fixtures.yaml"
API = "https://api.anthropic.com/v1/messages"
WEIGHTS = {"interview": 0.25, "adaptation": 0.15, "swarm": 0.15, "map": 0.20,
           "evolution": 0.10, "integration": 0.10, "boundaries": 0.05}  # frozen; never override

def die(code, msg):
    print(msg, file=sys.stderr); sys.exit(code)

def load_fixtures():
    try:
        import yaml
    except ImportError:
        die(2, "pyyaml required: pip install pyyaml")
    try:
        return yaml.safe_load(FIXTURES.read_text(encoding="utf-8"))
    except Exception as e:
        die(3, f"WF211-PARSE-FAILURE {FIXTURES}: {e}")

def system_prompt(fx):
    parts = ["You are Wayfinder, operating exactly per the following skill package. "
             "Fixture-provided scout packets and decision-owner answers are your only "
             "external inputs; never write the human's side of any exchange."]
    for rel in fx["skill_context_files"]:
        parts.append(f"\n===== {rel} =====\n" + (ROOT / rel).read_text(encoding="utf-8"))
    return "\n".join(parts)

def call_api(model, system, messages, key):
    body = json.dumps({"model": model, "max_tokens": 4000, "temperature": 0,
                       "system": system, "messages": messages}).encode()
    req = urllib.request.Request(API, data=body, headers={
        "content-type": "application/json", "x-api-key": key,
        "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())

QUESTION_RE = re.compile(r"^\s*>?\s*\d+\.\s+(.+?\?)\s*$", re.MULTILINE)

def extract_questions(text):
    return [q.strip() for q in QUESTION_RE.findall(text)]

def norm_tokens(q):
    stop = {"the","a","an","or","and","of","for","to","is","are","do","does","on","in",
            "it","its","we","our","be","with","which","what","who","when","how","should"}
    return {w for w in re.sub(r"[^a-z0-9 ]", " ", q.lower()).split() if w and w not in stop}

def near_duplicate(q1, q2, threshold=0.6):
    a, b = norm_tokens(q1), norm_tokens(q2)
    if not a or not b:
        return False
    inter = len(a & b)
    return max(inter / len(a | b), inter / min(len(a), len(b))) >= threshold

def run_checks(bench, assistant_texts):
    joined = "\n".join(assistant_texts)
    questions = [q for t in assistant_texts for q in extract_questions(t)]
    results = []
    for chk in bench.get("checks", []):
        ok, evidence = True, []
        for tok in chk.get("forbid_question_tokens", []):
            hits = [q for q in questions if tok.lower() in q.lower()]
            if hits: ok = False; evidence += hits
        for tok in chk.get("require_packet_tokens", []) + chk.get("require_output_tokens", []):
            if tok.lower() not in joined.lower(): ok = False; evidence.append(f"missing: {tok}")
        for tok in chk.get("forbid_output_tokens", []):
            if tok.lower() in joined.lower(): ok = False; evidence.append(f"present: {tok}")
        if "min_questions" in chk:
            n = len(extract_questions(assistant_texts[-1] if assistant_texts else ""))
            if not (chk["min_questions"] <= n <= chk["max_questions"]):
                ok = False; evidence.append(f"final-turn question count {n}")
        if "require_order_tokens" in chk:
            a, b = chk["require_order_tokens"]
            ia, ib = joined.lower().find(a.lower()), joined.lower().find(b.lower())
            if not (0 <= ia < ib): ok = False; evidence.append(f"order {a!r} before {b!r} not observed")
        if chk.get("dedup_threshold"):
            for i in range(len(questions)):
                for j in range(i + 1, len(questions)):
                    if near_duplicate(questions[i], questions[j], chk["dedup_threshold"]):
                        ok = False; evidence.append(f"near-duplicate: {questions[i]!r} ~ {questions[j]!r}")
        results.append({"id": chk["id"], "ok": ok,
                        "fail_code": chk.get("fail_code", "WF211-EVIDENCE-INCOMPLETE"),
                        "evidence": evidence[:6]})
    return results, questions

def run_one(bench, fx, model, key):
    ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    messages, raw_responses, assistant_texts = [], [], []
    system = system_prompt(fx)
    for turn in bench["turns"]:
        messages.append({"role": turn["role"], "content": turn["content"]})
        resp = call_api(model, system, messages, key)
        raw_responses.append(resp)  # stored unmodified
        text = "".join(b.get("text", "") for b in resp.get("content", []))
        assistant_texts.append(text)
        messages.append({"role": "assistant", "content": text})
    RUNS.mkdir(parents=True, exist_ok=True)
    base = RUNS / f"{bench['id']}-{ts}"
    raw = {"benchmark_id": bench["id"], "benchmark_version": bench["version"],
           "executed_at": ts, "agent_configuration": {"model": model, "temperature": 0,
           "system_context_files": fx["skill_context_files"]},
           "fresh_context": {"fresh": True, "method":
               "new API conversation per benchmark; context = skill files + this "
               "benchmark's fixture turns only; no other runs, scores, hints, or map state",
           "prior_runs_in_context": False},
           "fixture_turns": bench["turns"], "raw_api_responses": raw_responses}
    (base.with_suffix(".raw.json")).write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
    checks, questions = run_checks(bench, assistant_texts)
    normalized = {"benchmark_id": bench["id"], "benchmark_version": bench["version"],
                  "executed_at": ts, "raw_record": base.with_suffix(".raw.json").name,
                  "assistant_turns": assistant_texts, "extracted_questions": questions,
                  "auto_checks": checks,
                  "extraction_method": "regex question extraction + token checks; "
                                       "auto-checks are evidence for the evaluator, not scores",
                  "scoring_status": "pending-evaluator"}
    (base.with_suffix(".normalized.json")).write_text(json.dumps(normalized, indent=2) + "\n", encoding="utf-8")
    print(f"{bench['id']}: captured raw + normalized -> {base.name}.{{raw,normalized}}.json "
          f"({sum(1 for c in checks if c['ok'])}/{len(checks)} auto-checks ok)")
    return base

def cmd_run(ids, fx, model):
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        die(2, "WF211-RUNNER-NO-CREDENTIALS: ANTHROPIC_API_KEY is not set. No benchmark was "
               "executed and no evidence was fabricated. Set the key (or run the documented "
               "Claude Code operator procedure) and re-run --run-all --fresh-context.")
    for b in fx["benchmarks"]:
        if ids and b["id"] not in ids:
            continue
        try:
            run_one(b, fx, model, key)
        except urllib.error.HTTPError as e:
            die(1, f"WF211-EVIDENCE-INCOMPLETE: API error on {b['id']}: {e.code} {e.read()[:300]!r}")

def cmd_validate(fx):
    findings = []
    for b in fx["benchmarks"]:
        raws = sorted(RUNS.glob(f"{b['id']}-*.raw.json"))
        norms = sorted(RUNS.glob(f"{b['id']}-*.normalized.json"))
        if not raws:
            findings.append(f"WF211-BENCHMARK-MISSING-RAW-OUTPUT: {b['id']} has no captured fresh-context run")
            continue
        rec = json.loads(raws[-1].read_text(encoding="utf-8"))
        for field in ("benchmark_id", "benchmark_version", "executed_at",
                      "agent_configuration", "fresh_context", "raw_api_responses"):
            if field not in rec:
                findings.append(f"WF211-EVIDENCE-INCOMPLETE: {raws[-1].name} missing {field}")
        if not rec.get("fresh_context", {}).get("fresh"):
            findings.append(f"WF211-BENCHMARK-NOT-FRESH: {raws[-1].name}")
        if not norms:
            findings.append(f"WF211-EVIDENCE-INCOMPLETE: {b['id']} raw exists but no normalized record")
        if b["id"] == "b1" and norms:
            n = json.loads(norms[-1].read_text(encoding="utf-8"))
            if "scout" not in "\n".join(n.get("assistant_turns", [])).lower():
                findings.append(f"WF211-BENCHMARK-MISSING-SCOUT-TRACE: {norms[-1].name}")
        if b["id"] in ("b2", "b3", "b4") and norms:
            n = json.loads(norms[-1].read_text(encoding="utf-8"))
            joined = "\n".join(n.get("assistant_turns", [])).lower()
            if not any(w in joined for w in ("ticket", "fog", "frontier", "closed", "index")):
                findings.append(f"WF211-BENCHMARK-MISSING-MAP-DELTA: {norms[-1].name}")
        if not sorted(SCORES.glob(f"{b['id']}-*.score.json")):
            findings.append(f"WF211-BENCHMARK-UNSCORED: {b['id']} has no performed scorecard")
    if findings:
        print(f"{len(findings)} finding(s):")
        for f in findings: print(f"  - {f}")
        sys.exit(1)
    print("all four benchmarks: raw captured, normalized, fresh, scored")

def cmd_score(path, args):
    rec = json.loads(Path(path).read_text(encoding="utf-8"))
    dims = dict(kv.split("=") for kv in args.dim)
    if set(dims) != set(WEIGHTS):
        die(2, f"provide all frozen dimensions once: {sorted(WEIGHTS)}")
    scores = {k: float(v) for k, v in dims.items()}
    weighted = round(sum(scores[k] * WEIGHTS[k] for k in WEIGHTS), 3)
    SCORES.mkdir(parents=True, exist_ok=True)
    out = SCORES / f"{rec['benchmark_id']}-{rec['executed_at']}.score.json"
    out.write_text(json.dumps({
        "benchmark_id": rec["benchmark_id"], "benchmark_version": rec["benchmark_version"],
        "run": Path(path).name, "evaluator": args.evaluator,
        "dimension_scores": scores, "weights": WEIGHTS, "weighted_score": weighted,
        "result": "pass" if args.passed else "fail",
        "deficiency_attribution": args.deficiency, "notes": args.note,
        "auto_checks_evidence": rec.get("auto_checks", [])}, indent=2) + "\n", encoding="utf-8")
    print(f"scored {rec['benchmark_id']}: weighted {weighted} ({'pass' if args.passed else 'fail'}) -> {out.name}")

def cmd_report(fx):
    rows, agg = [], {"suite_version": fx["suite_version"], "benchmarks": []}
    for b in fx["benchmarks"]:
        raws = sorted(RUNS.glob(f"{b['id']}-*.raw.json"))
        sc = sorted(SCORES.glob(f"{b['id']}-*.score.json"))
        entry = {"id": b["id"], "raw": raws[-1].name if raws else None,
                 "score": json.loads(sc[-1].read_text(encoding="utf-8")) if sc else None}
        agg["benchmarks"].append(entry)
        s = entry["score"]
        rows.append(f"| {b['id']} | {b['title']} | {entry['raw'] or 'MISSING'} | "
                    f"{(str(s['weighted_score']) + ' ' + s['result']) if s else 'UNSCORED'} |")
    (ROOT / "benchmarks" / "aggregate.json").write_text(json.dumps(agg, indent=2) + "\n", encoding="utf-8")
    md = ["# Benchmark aggregate report", "", "| id | scenario | raw evidence | weighted score |",
          "|---|---|---|---|"] + rows + ["", "Evidence: `benchmarks/runs/`, scorecards: `benchmarks/scores/`."]
    (ROOT / "benchmarks" / "REPORT.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("wrote benchmarks/aggregate.json and benchmarks/REPORT.md")

def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--run-all", action="store_true"); ap.add_argument("--run")
    ap.add_argument("--fresh-context", action="store_true")
    ap.add_argument("--model", default="claude-sonnet-4-6")
    ap.add_argument("--validate-results", action="store_true")
    ap.add_argument("--score"); ap.add_argument("--evaluator")
    ap.add_argument("--dim", action="append", default=[])
    ap.add_argument("--pass", dest="passed", action="store_true")
    ap.add_argument("--fail", dest="passed", action="store_false")
    ap.add_argument("--note", default=""); ap.add_argument("--deficiency", default="model",
                    choices=["model", "fixture", "runner", "evaluator"])
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    fx = load_fixtures()
    if a.run_all or a.run:
        if not a.fresh_context:
            die(2, "refusing to run without --fresh-context (freshness must be explicit)")
        cmd_run([a.run] if a.run else [], fx, a.model)
    elif a.validate_results:
        cmd_validate(fx)
    elif a.score:
        if not a.evaluator: die(2, "--score requires --evaluator")
        cmd_score(a.score, a)
    elif a.report:
        cmd_report(fx)
    else:
        ap.print_help(); sys.exit(2)

if __name__ == "__main__":
    main()
