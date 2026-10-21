#!/usr/bin/env node
/* run-headless.js — runs the pure-model checks of health-verify.test.html
 * under Node, without a browser.
 *
 *   node assets/test/run-headless.js
 *
 * Source of truth for the checks is the browser fixture itself: every block
 * between `/* headless:begin` and `/* headless:end` markers in
 * health-verify.test.html is extracted and executed here with the same
 * helpers (check / sab / head / clone / passClaim / setDim) and the same GOOD
 * island (the fixture's #health JSON). DOM-bound checks (rendering, report
 * binding, degradation) stay browser-only; the model facts those sections
 * assert are re-stated below in "good island — model facts".
 *
 * Set LEDGER_VERIFY_PATH to use a non-default shared spine module.
 * Exit 0 = all pass. Exit 1 = any failure. Exit 2 = harness could not load.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const assets = path.resolve(__dirname, "..");
const fixturePath = path.join(assets, "health-verify.test.html");
const ledgerPath = process.env.LEDGER_VERIFY_PATH
  ? path.resolve(process.env.LEDGER_VERIFY_PATH)
  : path.resolve(assets, "../../shared/candidate-ledger-spine/ledger-verify.js");

function load(file) {
  vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
}

try {
  load(ledgerPath);
} catch (e) {
  console.error("run-headless: cannot load ledger-verify.js at " + ledgerPath + " — " + e.message);
  process.exit(2);
}
load(path.join(assets, "health-verify.js"));
const HV = globalThis.HealthVerify;
const HAS_SPINE = !!globalThis.LedgerVerify;

const html = fs.readFileSync(fixturePath, "utf8");
const islandMatch = html.match(/<script type="application\/json" id="health">([\s\S]*?)<\/script>/);
if (!islandMatch) { console.error("run-headless: #health island not found in the fixture"); process.exit(2); }
const GOOD = JSON.parse(islandMatch[1]);
const canonical = JSON.parse(fs.readFileSync(path.join(assets, "canonical-island.json"), "utf8"));

const regions = [];
const re = /\/\*\s*headless:begin[\s\S]*?\*\/([\s\S]*?)\/\*\s*headless:end\s*\*\//g;
let m;
while ((m = re.exec(html))) regions.push(m[1]);
if (!regions.length) { console.error("run-headless: no headless:begin/end regions found in the fixture"); process.exit(2); }
const extracted = regions.join("\n");
if (/\bdocument\b|\bwindow\b|runHealth\(/.test(extracted)) {
  console.error("run-headless: a headless region references the DOM (document/window/runHealth) — move that check out of the region");
  process.exit(2);
}

/* ---- harness, mirroring the fixture's helpers ---- */
let passed = 0, failed = 0, skipped = 0, section = "(top)";
const failures = [];
const sectionStats = [];
function head(t) { section = t; sectionStats.push({ name: t, pass: 0, fail: 0 }); }
function cur() { if (!sectionStats.length) head("(top)"); return sectionStats[sectionStats.length - 1]; }
function check(n, c, e) {
  if (c) { passed++; cur().pass++; }
  else { failed++; cur().fail++; failures.push({ section, name: n, detail: e }); }
}
function skip(n, w) { skipped++; console.log("  skip  " + n + " (" + w + ")"); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const sab = function (name, mutate, code) {
  const i = clone(GOOD); mutate(i); const v = HV.verifyHealth(i);
  const codes = v.problems.map((p) => p.code);
  check(name, !v.ok && codes.indexOf(code) > -1, v.ok ? "STILL GREEN" : "expected " + code + ", got " + codes.slice(0, 4).join(","));
};
const passClaim = function (i, lane) { return i.claims.filter((c) => c.lane === lane && c.result === "pass")[0].claim_id; };
const setDim = function (i, li, level, ids) {
  const l = i.lanes[li];
  Object.keys(l.scores).forEach((k, n) => { l.scores[k].level = level; l.scores[k].claim_refs = ids.map((id) => ({ claim_id: id, support: "distinct support text " + n })); });
};

/* ---- harness preconditions ---- */
head("harness");
check("health-verify.js loaded", !!HV);
check("shared spine module loaded (ledger-verify.js)", HAS_SPINE, ledgerPath);
check("fixture #health island equals assets/canonical-island.json", JSON.stringify(GOOD) === JSON.stringify(canonical),
  "the browser fixture and the canonical island drifted — re-sync them");
check("found " + regions.length + " headless regions in the fixture", regions.length >= 2);

/* ---- good island: the model facts the DOM section asserts ---- */
head("good island — model facts");
const good = HV.verifyHealth(GOOD);
check("good: verifies clean with the sibling spine module present", good.ok === true, JSON.stringify(good.problems.slice(0, 3)));
check("good: contracts lane recomputes to 48.75", good.lanes.filter((l) => l.lane === "contracts-and-integration")[0].computed.score === 48.75);
check("good: an activated optional lane is scored alongside the six required ones", good.lanes.length === 7);
check("good: eleven default surfaces in the coverage rows", good.coverage.rows.length === 11);
check("good: at least one cap fires and each names its trigger", good.grade.caps_applied.length > 0 && good.grade.caps_applied.every((c) => typeof c.trigger === "string" && c.trigger));
check("good: six confidence inputs", good.confidence.parts.length === 6);
check("good: candidate priority is computed by the spine module, not re-implemented",
  !!good.ledger && good.ledger.candidates.some((c) => c.candidate_id === "CONTRACT-007" && c.computed.priority === 8));

/* ---- the fixture's pure-model regions ----
 * Split at each head("...") so one section that throws is reported as a
 * failure without hiding every section after it. All chunks share one vm
 * context, so `var` helpers defined in an earlier section stay visible. */
const ctx = vm.createContext({ HV, GOOD, HAS_SPINE, clone, sab, check, head, skip, passClaim, setDim, good, JSON, Math, Object, Array, String, Number });
const chunks = extracted.split(/\n(?=[ \t]*head\()/);
chunks.forEach((chunk, n) => {
  try {
    vm.runInContext(chunk, ctx, { filename: "health-verify.test.html#headless-chunk-" + n });
  } catch (e) {
    failed++; cur().fail++;
    failures.push({ section, name: "fixture section threw", detail: (e && e.message) || String(e) });
  }
});

/* ---- report ---- */
console.log("health-verify headless run — " + path.relative(process.cwd(), fixturePath));
for (const s of sectionStats) {
  if (!s.pass && !s.fail) continue;
  console.log("  " + (s.fail ? "FAIL" : "ok  ") + "  " + s.name + "  (" + s.pass + "/" + (s.pass + s.fail) + ")");
}
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log("  ✗ [" + f.section + "] " + f.name + (f.detail ? "  ← " + f.detail : ""));
}
console.log("\n" + (failed ? "RED" : "GREEN") + " — " + passed + "/" + (passed + failed) + " checks passed" + (skipped ? " · " + skipped + " skipped" : ""));
process.exit(failed ? 1 : 0);
