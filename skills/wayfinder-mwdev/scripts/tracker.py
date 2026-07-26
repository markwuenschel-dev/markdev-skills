#!/usr/bin/env python3
"""Wayfinder fallback-tracker helper (local-markdown tracker only).

Usage:
  tracker.py frontier <map-dir>   List open, unclaimed, unblocked tickets in id order.
  tracker.py check    <map-dir>   Report map/ticket integrity findings.

<map-dir> is the directory containing map.md and tickets/.
Native trackers (GitHub, Linear, ...) use their own queries instead; this
script is only for the fallback layout in references/tracker-fallback.md.

Exit codes: 0 ok / clean, 1 integrity findings, 2 usage error, 3 parse error.
Stdlib only.
"""
import re
import sys
from pathlib import Path

TYPES = {"research", "grilling", "design", "prototype", "task"}


def fail(code, msg):
    print(msg, file=sys.stderr)
    sys.exit(code)


def parse_frontmatter(path):
    """Tolerant parser for the small frontmatter schema tickets use."""
    text = path.read_text(encoding="utf-8")
    m = re.match(r"\A---\s*\n(.*?)\n---\s*\n?", text, re.DOTALL)
    if not m:
        raise ValueError(f"{path}: missing '---' frontmatter block")
    fm = {}
    for lineno, raw in enumerate(m.group(1).splitlines(), start=2):
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if ":" not in line:
            raise ValueError(f"{path}:{lineno}: expected 'key: value', got {raw!r}")
        key, _, val = line.partition(":")
        fm[key.strip()] = val.strip().strip('"').strip("'")
    body = text[m.end():]
    return fm, body


def parse_id_list(val, path):
    val = (val or "").strip()
    if val in ("", "[]"):
        return []
    inner = val[1:-1] if val.startswith("[") and val.endswith("]") else val
    ids = []
    for part in inner.split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isdigit():
            raise ValueError(f"{path}: blocked_by entry {part!r} is not a ticket id")
        ids.append(int(part))
    return ids


def load_map(map_dir):
    map_dir = Path(map_dir)
    map_md = map_dir / "map.md"
    tickets_dir = map_dir / "tickets"
    if not map_md.is_file():
        fail(2, f"error: {map_md} not found — is {map_dir} a wayfinder map directory?")
    tickets, errors = [], []
    if tickets_dir.is_dir():
        for path in sorted(tickets_dir.glob("*.md")):
            try:
                fm, body = parse_frontmatter(path)
                t = {
                    "path": path,
                    "id": int(fm.get("id", "-1")) if str(fm.get("id", "")).lstrip("-").isdigit() else None,
                    "title": fm.get("title", "") or path.stem,
                    "type": fm.get("type", ""),
                    "state": fm.get("state", ""),
                    "claimed_by": fm.get("claimed_by", "") or fm.get("assignee", ""),
                    "legacy_assignee": "assignee" in fm,
                    "decision_owner": fm.get("decision_owner", ""),
                    "blocked_by": parse_id_list(fm.get("blocked_by", "[]"), path),
                    "has_resolution": bool(re.search(r"^##\s+Resolution\b", body, re.MULTILINE)),
                }
                tickets.append(t)
            except ValueError as e:
                errors.append(str(e))
    if errors:
        fail(3, "parse errors:\n  " + "\n  ".join(errors))
    return map_md.read_text(encoding="utf-8"), tickets


def frontier(map_dir):
    _, tickets = load_map(map_dir)
    closed = {t["id"] for t in tickets if t["state"] == "closed"}
    rows = [
        t for t in tickets
        if t["state"] == "open" and not t["claimed_by"]
        and all(b in closed for b in t["blocked_by"])
    ]
    rows.sort(key=lambda t: (t["id"] is None, t["id"]))
    if not rows:
        blocked = [t for t in tickets if t["state"] == "open" and not t["claimed_by"]]
        claimed = [t for t in tickets if t["state"] == "open" and t["claimed_by"]]
        holders = {}
        for t2 in claimed:
            holders[t2["claimed_by"]] = holders.get(t2["claimed_by"], 0) + 1
        held = ", ".join(f"{k}({v})" for k, v in sorted(holders.items())) or "none"
        print(f"frontier empty ({len(blocked)} open-unclaimed-but-blocked, "
              f"{len(claimed)} claimed, of {len(tickets)} tickets; claims held by: {held})")
        return 0
    for t in rows:
        print(f"{t['id']:>4}\t{t['type'] or '?'}\t{t['title']}\t{t['path']}")
    return 0


def check(map_dir):
    map_text, tickets = load_map(map_dir)
    findings = []
    by_id = {}
    for t in tickets:
        name = f"[{t['title']}]({t['path'].name})"
        if t["id"] is None:
            findings.append(f"{t['path']}: missing or non-numeric id")
            continue
        if t["id"] in by_id:
            findings.append(f"duplicate id {t['id']}: {t['path'].name} and {by_id[t['id']]['path'].name}")
        by_id[t["id"]] = t
        if t["state"] not in ("open", "closed"):
            findings.append(f"{name}: state must be open|closed, got {t['state']!r}")
        if t["type"] not in TYPES:
            findings.append(f"{name}: type must be one of {sorted(TYPES)}, got {t['type']!r}")
        if t["state"] == "closed" and not t["has_resolution"]:
            findings.append(f"{name}: closed without a '## Resolution' section")
        if t["state"] == "open" and t["has_resolution"]:
            findings.append(f"{name}: open but carries a '## Resolution' — close+index it, or remove it")
        if t["legacy_assignee"]:
            findings.append(f"{name}: legacy 'assignee' field — rename to claimed_by (worker identity) "
                            f"and decision_owner (human); treated as claimed meanwhile")
    for t in tickets:
        for b in t["blocked_by"]:
            if b not in by_id:
                findings.append(f"[{t['title']}]({t['path'].name}): blocked_by references missing ticket id {b}")
    # blocking cycles among open tickets
    open_ids = {t["id"] for t in tickets if t["state"] == "open" and t["id"] is not None}
    edges = {t["id"]: [b for b in t["blocked_by"] if b in open_ids]
             for t in tickets if t["id"] in open_ids}
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {i: WHITE for i in edges}

    def dfs(node, stack):
        color[node] = GRAY
        for nxt in edges.get(node, []):
            if color[nxt] == GRAY:
                cyc = stack[stack.index(nxt):] + [nxt]
                findings.append("blocking cycle among open tickets: "
                                + " -> ".join(by_id[i]["title"] for i in cyc))
            elif color[nxt] == WHITE:
                dfs(nxt, stack + [nxt])
        color[node] = BLACK

    for i in list(edges):
        if color[i] == WHITE:
            dfs(i, [i])
    # index vs closed tickets: map links must cover closed, not point at open/missing
    linked = set(re.findall(r"\]\(tickets/(\d+)[^)]*\)", map_text))
    linked_ids = {int(x) for x in linked}
    for t in tickets:
        if t["id"] is None:
            continue
        if t["state"] == "closed" and t["id"] not in linked_ids:
            findings.append(f"[{t['title']}]({t['path'].name}): closed but not indexed on the map "
                            f"(no Decisions-so-far or Out-of-scope line links it)")
    for i in sorted(linked_ids):
        if i not in by_id:
            findings.append(f"map.md links tickets/{i:03d}-... which does not exist")
        elif by_id[i]["state"] == "open":
            findings.append(f"map.md links open ticket [{by_id[i]['title']}] — the map indexes closed tickets only")
    if findings:
        print(f"{len(findings)} finding(s):")
        for f in findings:
            print(f"  - {f}")
        print("repair order: half-recorded resolutions -> index lines -> blocking edges -> new work "
              "(see references/recovery.md)")
        return 1
    print(f"clean: {len(tickets)} tickets, "
          f"{sum(1 for t in tickets if t['state'] == 'closed')} closed, index consistent")
    return 0


def main(argv):
    if len(argv) != 3 or argv[1] not in ("frontier", "check"):
        fail(2, __doc__.strip())
    return {"frontier": frontier, "check": check}[argv[1]](argv[2])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
