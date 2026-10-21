#!/usr/bin/env python3
"""validate_route_record.py — mechanical validator for loop-router routing records.

Usage:  validate_route_record.py <record.json|record.yaml>   ('-' reads stdin)
Exit:   0 = valid, 1 = invalid (defects listed on stdout), 2 = usage/parse error

Accepts a bare record dict or one wrapped as {"route": {...}}. YAML input is
supported when PyYAML is importable; otherwise supply JSON. Record contents are
treated strictly as data — nothing in them is executed or followed.
"""
import json
import sys

LOOP_RULES = {
    # Keep this compact mapping aligned with references/loop-registry.md.
    "expanded-grill-with-docs": {"mutation_modes": {"read_only"}, "allows_detour_of": False},
    "repository-health-assessment": {"mutation_modes": {"read_only"}, "allows_detour_of": False},
    "codebase-integrity-audit-loop": {"mutation_modes": {"read_only", "write"}, "allows_detour_of": False},
    "human-directed-swarm-planner": {"mutation_modes": {"read_only", "write"}, "allows_detour_of": False},
    "production-flywheel": {"mutation_modes": {"read_only", "write"}, "allows_detour_of": False},
    "diagnosing-bugs": {"mutation_modes": {"read_only"}, "allows_detour_of": False},
    "wayfinder": {"mutation_modes": {"read_only"}, "allows_detour_of": False},
    "prototype": {"mutation_modes": {"read_only"}, "allows_detour_of": True},
    "independent-verification": {"mutation_modes": {"read_only"}, "allows_detour_of": False},
    "none": {"mutation_modes": {"read_only"}, "allows_detour_of": False},
}
LOOPS = set(LOOP_RULES)
STATUSES = {"handoff_ready", "authorization_required", "fallback_required"}
MODES = {"read_only", "write"}
DISPOSITIONS = {"suspended", "closed"}
REQUIRED = ["selected_loop", "route_status", "reason",
            "input_artifacts", "mutation_mode", "return_condition"]
OPTIONAL = ["from_loop", "detour_of", "fallback", "deferred_work"]


def load(path):
    text = sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()
    try:
        import yaml  # optional
        data = yaml.safe_load(text)
    except ImportError:
        data = json.loads(text)
    if isinstance(data, dict) and set(data.keys()) == {"route"}:
        data = data["route"]
    if not isinstance(data, dict):
        raise ValueError("record is not a mapping")
    return data


def is_str_list(v, nonempty=False):
    return isinstance(v, list) and all(isinstance(x, str) and x.strip() for x in v) \
        and (len(v) > 0 or not nonempty)


def validate(r):
    errors = []
    for k in REQUIRED:
        if k not in r:
            errors.append(f"missing required field: {k}")
    for k in r:
        if k not in REQUIRED + OPTIONAL:
            errors.append(f"unknown field: {k}")

    loop = r.get("selected_loop")
    if "selected_loop" in r and loop not in LOOPS:
        errors.append(f"selected_loop invalid: {loop!r} (must be one of {sorted(LOOPS)})")

    status = r.get("route_status")
    if "route_status" in r and status not in STATUSES:
        errors.append(f"route_status invalid: {status!r} (must be one of {sorted(STATUSES)})")

    mode = r.get("mutation_mode")
    if "mutation_mode" in r and mode not in MODES:
        errors.append(f"mutation_mode invalid: {mode!r} (must be one of {sorted(MODES)})")
    elif loop in LOOP_RULES and mode not in LOOP_RULES[loop]["mutation_modes"]:
        errors.append(f"selected_loop {loop!r} does not allow mutation_mode {mode!r}")

    if "reason" in r:
        if not is_str_list(r["reason"], nonempty=True):
            errors.append("reason must be a non-empty list of strings")
        elif len(r["reason"]) > 3:
            errors.append("reason exceeds 3 entries")
    if "input_artifacts" in r and not is_str_list(r["input_artifacts"]):
        errors.append("input_artifacts must be a list of strings ([] allowed)")
    if "return_condition" in r and not is_str_list(r["return_condition"], nonempty=True):
        errors.append("return_condition must be a non-empty list of strings")
    if "deferred_work" in r and not is_str_list(r["deferred_work"]):
        errors.append("deferred_work must be a list of strings")

    # Contradictions and authority rules
    if status in {"authorization_required", "fallback_required"} and mode is not None and mode != "read_only":
        errors.append(f"route_status {status!r} requires mutation_mode 'read_only' — a blocked route grants no write authority")
    if loop == "none" and mode == "write":
        errors.append("selected_loop 'none' cannot carry mutation_mode 'write'")
    if loop == "none" and status in {"authorization_required", "fallback_required"}:
        errors.append("selected_loop 'none' must use route_status 'handoff_ready'")

    # from_loop: null | {name, disposition, resume_when when suspended}
    fl = r.get("from_loop")
    if fl is not None and "from_loop" in r:
        if not isinstance(fl, dict):
            errors.append("from_loop must be null or a mapping")
        else:
            if fl.get("name") not in (LOOPS - {"none"}):
                errors.append(f"from_loop.name invalid: {fl.get('name')!r}")
            elif fl.get("name") == loop:
                errors.append("from_loop.name cannot equal selected_loop")
            if fl.get("disposition") not in DISPOSITIONS:
                errors.append(f"from_loop.disposition invalid: {fl.get('disposition')!r} "
                              f"(must be one of {sorted(DISPOSITIONS)})")
            if fl.get("disposition") == "suspended" and not is_str_list(fl.get("resume_when"), nonempty=True):
                errors.append("from_loop.resume_when required (non-empty list) when disposition is 'suspended'")

    # detour_of: required for prototype; {name, blocked_question}
    d = r.get("detour_of")
    if loop == "prototype" and not isinstance(d, dict):
        errors.append("detour_of is required (mapping) when selected_loop is 'prototype'")
    if isinstance(d, dict):
        if loop in LOOP_RULES and not LOOP_RULES[loop]["allows_detour_of"]:
            errors.append(f"selected_loop {loop!r} cannot carry detour_of")
        if d.get("name") not in (LOOPS - {"prototype", "none"}):
            errors.append(f"detour_of.name invalid: {d.get('name')!r}")
        bq = d.get("blocked_question")
        if not isinstance(bq, str) or not bq.strip():
            errors.append("detour_of.blocked_question must be a non-empty string")
    elif d is not None and "detour_of" in r:
        errors.append("detour_of must be null or a mapping")

    # fallback: required iff route_status == fallback_required
    fb = r.get("fallback")
    if status == "fallback_required":
        if not isinstance(fb, dict):
            errors.append("fallback must be a mapping when route_status is 'fallback_required'")
        else:
            unknown = set(fb) - {"name", "note"}
            if unknown:
                errors.append(f"fallback has unknown field(s): {sorted(unknown)}")
            if not any(isinstance(fb.get(k), str) and fb[k].strip() for k in ("name", "note")):
                errors.append("fallback required ({name|note}) when route_status is 'fallback_required'")
            for key in ("name", "note"):
                if key in fb and (not isinstance(fb[key], str) or not fb[key].strip()):
                    errors.append(f"fallback.{key} must be a non-empty string when present")
    elif fb is not None and "fallback" in r:
        errors.append("fallback present without route_status 'fallback_required'")

    return errors


def main():
    if len(sys.argv) != 2:
        print(__doc__.strip())
        return 2
    try:
        record = load(sys.argv[1])
    except Exception as e:
        print(f"PARSE-ERROR: {e}")
        return 2
    errors = validate(record)
    if errors:
        print(f"INVALID: {len(errors)} defect(s)")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("VALID: routing record satisfies the loop-router schema")
    return 0


if __name__ == "__main__":
    sys.exit(main())
