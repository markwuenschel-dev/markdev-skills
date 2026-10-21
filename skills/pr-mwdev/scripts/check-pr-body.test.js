"use strict";
const assert = require("assert");
const { check } = require("./check-pr-body.js");

const good = `## Summary

Cache saves when content is unchanged.

\`\`\`diff
 on(save)
+  if content is unchanged
+    return cached result
## not a heading inside a fence
\`\`\`

## Evidence

- **Before:** \`npm test save.spec\` fails: wrote twice
  **After:** passes

| Check | Source | Status |
| --- | --- | --- |
| npm test | local | PASS |
| e2e | CI | NOT RUN |

## Merge Danger

**Door:** two-way — revert the merge commit

**Blast Radius:** save path

## Out of scope

- cache eviction
`;
assert.deepStrictEqual(check(good), []);
assert.deepStrictEqual(check(good.replace(/\n/g, "\r\n")), [], "CRLF accepted");
const has = (md, re) => check(md).some((e) => re.test(e));
assert(has(good.replace("## Evidence", "## Evidance"), /missing heading: Evidence/));
assert(has(good.replace("two-way", "sideways"), /invalid door/));
assert(has(good.replace("two-way", "unknown"), /./) === false);
assert(has(good.replace("| PASS |", "| OK |"), /invalid status 'OK'/));
assert(has(good.replace("**Blast Radius:** save path", "**Blast Radius:**"), /Blast Radius/));
assert(has(good.replace(/- \*\*Before:\*\*[^\n]*\n[^\n]*\n/, ""), /Before/));
assert(!has(good.replace(/- \*\*Before:\*\*[^\n]*\n[^\n]*\n/, "No before/after captured\n"), /Before/));
assert(has(good + "\n## Summary\n\nagain\n", /duplicate heading: Summary/));
assert(has(good.replace("Cache saves when content is unchanged.", "<one sentence: the outcome>"), /placeholder/));
assert(has(good.replace("## Out of scope\n\n- cache eviction\n", "## Out of scope\n\n"), /empty section: Out of scope/));
const swapped = good.replace("## Evidence", "## TMP").replace("## Merge Danger", "## Evidence").replace("## TMP", "## Merge Danger");
assert(has(swapped, /out of order/));

// --- statuses shared with gate-runner / independent-verification
assert.deepStrictEqual(check(good.replace("| PASS |", "| BLOCKED-UNVERIFIABLE |")), [], "BLOCKED-UNVERIFIABLE is a valid status");

// --- receipt cross-check
const fs = require("fs");
const os = require("os");
const path = require("path");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "prbody-"));
const rel = ".agentic/gate-evidence/final/run-1/receipt.json";
fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
const writeReceipt = (o) => fs.writeFileSync(path.join(repo, rel), JSON.stringify({ gate_receipt: o }));
const cited = (status) => good.replace("| npm test | local | PASS |", `| final gate | \`${rel}\` | ${status} |`);
writeReceipt({ outcome: "PASS", fresh: true });
assert.deepStrictEqual(check(cited("PASS"), { repo }), []);
assert(check(cited("FAIL"), { repo }).some((e) => /contradicts receipt outcome 'PASS'/.test(e)));
writeReceipt({ outcome: "FAIL", fresh: true });
assert(check(cited("PASS"), { repo }).some((e) => /contradicts receipt outcome 'FAIL'/.test(e)), "PASS over a failed run is caught");
writeReceipt({ outcome: "PASS", fresh: false });
assert(check(cited("PASS"), { repo }).some((e) => /stale/.test(e)));
fs.writeFileSync(path.join(repo, rel), JSON.stringify({ outcome: "BLOCKED-UNVERIFIABLE" }));
assert.deepStrictEqual(check(cited("BLOCKED-UNVERIFIABLE"), { repo }), [], "flat receipt shape accepted");
fs.rmSync(path.join(repo, rel));
assert(check(cited("PASS"), { repo }).some((e) => /not found/.test(e)));
assert.deepStrictEqual(check(cited("PASS")), [], "without --repo receipts are not resolved");
// a cited path that climbs out of the repo is refused even when the outside file exists and says PASS
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prbody-outside-"));
fs.mkdirSync(path.join(outside, ".agentic/gate-evidence/final/r"), { recursive: true });
fs.writeFileSync(path.join(outside, ".agentic/gate-evidence/final/r/receipt.json"), JSON.stringify({ outcome: "PASS" }));
const escape = `.agentic/gate-evidence/../../../${path.basename(outside)}/.agentic/gate-evidence/final/r/receipt.json`;
assert.ok(fs.existsSync(path.resolve(repo, escape)), "fixture: escaping path resolves to a real file");
assert(check(good.replace("| npm test | local | PASS |", `| x | \`${escape}\` | PASS |`), { repo }).some((e) => /escapes repo/.test(e)));

// --- caller contracts
assert.deepStrictEqual(check(good, { caller: "land-pr" }), []);
const noTable = good.replace(/\| Check[\s\S]*?\| e2e \| CI \| NOT RUN \|\n/, "");
assert.notStrictEqual(noTable, good);
assert(check(noTable, { caller: "land-pr" }).some((e) => /land-pr: Evidence needs a status table/.test(e)));
const fly = good
  .replace("## Merge Danger", "Verdict PASS, round 1, packet_lock_sha256 `abc123`, tamper_evidence chain-only.\n\n## Merge Danger")
  .replace("Cache saves when content is unchanged.", "Cache saves when content is unchanged.\n\nThe machine verdict authorizes review, not merge.");
assert.deepStrictEqual(check(fly, { caller: "flywheel" }), []);
assert(check(good, { caller: "flywheel" }).some((e) => /human-gate line/.test(e)));
assert(check(fly.replace("packet_lock_sha256", "lock"), { caller: "flywheel" }).some((e) => /packet_lock_sha256/.test(e)));
assert(check(fly.replace("tamper_evidence", "tamper"), { caller: "flywheel" }).some((e) => /tamper_evidence/.test(e)));
console.log("check-pr-body: all assertions passed");
