#!/usr/bin/env node
/* parity-check.js — development-time parity harness.
 *
 * The package deliberately states two rules in two places:
 *
 *   health.schema.json  is the SPECIFICATION
 *   health-verify.js    COMPILES the load-bearing rules, so a self-contained
 *                       report can enforce them offline without bundling a
 *                       JSON Schema validator
 *
 * Two statements of one rule always eventually disagree, so this harness runs
 * a sabotage corpus through both layers and records which layer owns each
 * rejection. It is a dev tool: it needs `ajv`, and nothing in the generated
 * report ever loads it.
 *
 *   npm install ajv
 *   node assets/parity-check.js
 *
 * Exit 0 = parity holds. Exit 1 = a mutation slipped past the verifier, or a
 * mutation the schema catches is invisible to the verifier.
 *
 * Ownership rules:
 *   - The VERIFIER must reject every mutation. It is the enforcing layer and
 *     the only one that runs at report time.
 *   - The SCHEMA should reject everything structural. Cross-reference rules
 *     (a claim_ref naming a real claim in the same lane, a lane weight equal
 *     to its locked value, a derived baseline matching its commands, delta
 *     continuity) are not expressible in JSON Schema and are listed below as
 *     verifier-owned on purpose — not as gaps.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const here = __dirname;
const island = JSON.parse(fs.readFileSync(path.join(here, "canonical-island.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

/* load the verifier (classic script, attaches to globalThis) */
eval(fs.readFileSync(path.join(here, "health-verify.js"), "utf8"));
const HV = globalThis.HealthVerify;

/* Parity must run with the installed shared-spine dependency. Earlier
   versions tolerated ledger-module-missing, which meant every mutation looked
   rejected even when its own rule was invisible. Set LEDGER_VERIFY_PATH when
   the sibling skill is not at the default family location. */
const spinePath = process.env.LEDGER_VERIFY_PATH
  ? path.resolve(process.env.LEDGER_VERIFY_PATH)
  : path.resolve(here, "../../../shared/candidate-ledger-spine/ledger-verify.js");
try {
  eval(fs.readFileSync(spinePath, "utf8"));
} catch (e) {
  console.error("parity-check requires shared/candidate-ledger-spine/ledger-verify.js; set LEDGER_VERIFY_PATH or install the canonical shared spine");
  process.exit(2);
}

let Ajv;
try { Ajv = require("ajv/dist/2020"); }
catch (e) {
  console.error("parity-check needs ajv (dev only): npm install ajv");
  process.exit(2);
}
const ajv = new Ajv({ strict: false, allErrors: true });
const schemaOk = ajv.compile(JSON.parse(fs.readFileSync(path.join(here, "health.schema.json"), "utf8")));

/* Each entry: [name, mutate, owner] where owner is "both" or "verifier-only". */
const CORPUS = [
  // ---- structural: both layers ----
  ["schema version wrong", (i) => { i.health_schema_version = 3; }, "both"],
  ["shared spine version wrong", (i) => { i.spine_version = 2; }, "both"],
  ["repository block removed", (i) => { delete i.repository; }, "both"],
  ["verification block removed", (i) => { delete i.verification; }, "both"],
  ["freshness outside its domain", (i) => { i.repository.freshness = "banana"; }, "both"],
  ["freshness evidence removed", (i) => { delete i.repository.freshness_evidence; }, "both"],
  ["freshness evidence dirty while declared fresh", (i) => { i.repository.freshness_evidence.working_tree_clean = false; }, "verifier-only"],
  ["repository revision disagrees with freshness evidence", (i) => { i.repository.revision = "different"; }, "verifier-only"],
  ["unknown top-level property", (i) => { i.covrage = i.coverage; }, "both"],
  ["unknown repository property", (i) => { i.repository.freshnes = "fresh"; }, "both"],
  ["unknown surface property", (i) => { i.coverage[0].covrage = "x"; }, "both"],
  ["surface evidence_refs removed", (i) => { delete i.coverage[0].evidence_refs; }, "both"],
  ["surface evidence malformed", (i) => { i.coverage[0].evidence_refs = [{ kind: "path" }]; }, "both"],
  ["strong surface backed only by rationale", (i) => { i.coverage[0].evidence_refs = [{ kind: "rationale", ref: "looks complete" }]; }, "verifier-only"],
  ["surface evidence cites unknown claim", (i) => { i.coverage[0].evidence_refs = [{ kind: "claim", ref: "NOPE-99" }]; }, "verifier-only"],
  ["unknown command property", (i) => { i.verification.commands[0].durationn = 1; }, "both"],
  ["command_id removed", (i) => { delete i.verification.commands[0].command_id; }, "both"],
  ["duplicate command_id", (i) => { i.verification.commands[1].command_id = i.verification.commands[0].command_id; }, "verifier-only"],
  ["unknown evidence property", (i) => { i.claims[0].evidence[0].lines2 = "1-2"; }, "both"],
  ["unknown observation property", (i) => { i.claims[0].observation.confirmd = "x"; }, "both"],
  ["unknown grade property", (i) => { i.grade = { finl_grade: "A" }; }, "both"],
  ["default surface omitted", (i) => { i.coverage = i.coverage.filter((s) => s.id !== "contracts-and-wiring"); }, "both"],
  ["core surface marked not-applicable", (i) => { const s = i.coverage.find((x) => x.id === "verification"); s.coverage = "not-applicable"; s.reason = "no tests"; delete s.evidence_quality; }, "both"],
  ["unknown coverage state", (i) => { i.coverage[0].coverage = "mostly"; }, "both"],
  ["inspected with weak evidence", (i) => { i.coverage[0].evidence_quality = "weak"; }, "both"],
  ["surface weight out of range", (i) => { i.coverage[0].criticality_weight = 9; }, "both"],
  ["dimension level out of range", (i) => { i.lanes[0].scores.observed_soundness.level = 7; }, "both"],
  ["dimension missing rationale", (i) => { delete i.lanes[0].scores.observed_soundness.rationale; }, "both"],
  ["dimension missing claim_refs", (i) => { delete i.lanes[0].scores.observed_soundness.claim_refs; }, "both"],
  ["bare-string claim_ref (v2 shape)", (i) => { i.lanes[0].scores.observed_soundness.claim_refs = ["CORE-01"]; }, "both"],
  ["claim_ref with no support line", (i) => { i.lanes[0].scores.observed_soundness.claim_refs = [{ claim_id: "CORE-01" }]; }, "both"],
  ["claim with a bad result", (i) => { i.claims[0].result = "maybe"; }, "both"],
  ["claim with no evidence", (i) => { i.claims[0].evidence = []; }, "both"],
  ["claim carrying score_effect (v1)", (i) => { i.claims[0].score_effect = -8; }, "both"],
  ["claim carrying affects_dimensions (v2)", (i) => { i.claims[0].affects_dimensions = ["observed_soundness"]; }, "both"],
  ["executed command with no exit_code", (i) => { delete i.verification.commands[0].exit_code; }, "both"],
  ["executed command with no elapsed_seconds", (i) => { delete i.verification.commands[0].elapsed_seconds; }, "both"],
  ["result pass with exit_code 1", (i) => { i.verification.commands[0].exit_code = 1; }, "both"],
  ["skipped command carrying metrics", (i) => { i.verification.commands[2].exit_code = 0; }, "both"],
  ["bad isolation mode", (i) => { i.verification.isolation = "yolo"; }, "both"],
  ["optional lane neither scored nor declared", (i) => { delete i.lane_applicability["security-and-production-safety"]; }, "both"],
  ["applicability declaration with no rationale", (i) => { delete i.lane_applicability["gpu-equivalence"].rationale; }, "both"],
  ["applicability declaration with no surface_refs", (i) => { delete i.lane_applicability["gpu-equivalence"].surface_refs; }, "both"],

  // ---- cross-reference: verifier-owned by construction ----
  ["lane weight demoted below its locked value", (i) => { i.lanes[0].criticality_weight = 1; }, "verifier-only"],
  ["dimension citing another lane's claim", (i) => { i.lanes[1].scores.observed_soundness.claim_refs = [{ claim_id: "CONTRACT-01", support: "x" }]; }, "verifier-only"],
  ["dimension citing a nonexistent claim", (i) => { i.lanes[1].scores.observed_soundness.claim_refs = [{ claim_id: "NOPE-99", support: "x" }]; }, "verifier-only"],
  ["one claim reused with identical support text", (i) => { const l = i.lanes[1]; const p = i.claims.find((c) => c.lane === l.lane && c.result === "pass").claim_id; Object.keys(l.scores).forEach((k) => { l.scores[k].level = 3; l.scores[k].claim_refs = [{ claim_id: p, support: "it is fine" }]; }); }, "verifier-only"],
  ["level 4 evidenced only by a partial claim", (i) => { const l = i.lanes[1]; const p = i.claims.find((c) => c.lane === l.lane && c.result === "partial").claim_id; Object.keys(l.scores).forEach((k, n) => { l.scores[k].level = 4; l.scores[k].claim_refs = [{ claim_id: p, support: "aspect " + n }]; }); }, "verifier-only"],
  ["declared baseline disagreeing with the commands", (i) => { i.verification.commands[0].result = "fail"; i.verification.commands[0].exit_code = 1; }, "verifier-only"],
  ["stored lane_score that lies", (i) => { i.lanes[0].lane_score = 95; }, "verifier-only"],
  ["stored final_grade that lies", (i) => { i.grade = { final_grade: "A" }; }, "verifier-only"],
  ["stored raw_grade that lies", (i) => { i.grade = { raw_grade: "A" }; }, "verifier-only"],
  ["stored confidence_index that lies", (i) => { i.grade = { confidence_index: 99 }; }, "verifier-only"],
  ["fabricated cap", (i) => { i.grade = { caps_applied: ["uncontained-critical-failure"] }; }, "verifier-only"],
  ["activated optional lane silently dropped", (i) => { i.lanes = i.lanes.filter((l) => l.lane !== "data-and-migrations"); i.claims = i.claims.filter((c) => c.lane !== "data-and-migrations"); }, "verifier-only"],
  ["applicability naming a surface not in the inventory", (i) => { i.lane_applicability["gpu-equivalence"].surface_refs = ["ghost-surface"]; }, "verifier-only"],
  ["candidate with no summary", (i) => { delete i.candidates[0].summary; }, "both"],
  ["candidate with no rollup", (i) => { delete i.candidates[0].rollup; }, "both"],
  ["candidate with no scheduling arrays", (i) => { delete i.candidates[0].depends_on; }, "both"],
  ["candidate with no dedup record", (i) => { delete i.candidates[0].dedup; }, "both"],
  ["candidate with no claim_refs", (i) => { delete i.candidates[0].claim_refs; }, "verifier-only"],
  ["candidate citing a claim outside its lane_sources", (i) => { i.candidates[0].claim_refs = ["VERIF-01"]; }, "verifier-only"],
  ["previous snapshot with duplicate candidate ids", (i) => { i.previous.candidates = [{ candidate_id: "X", lifecycle_status: "completed" }, { candidate_id: "X", lifecycle_status: "completed" }]; }, "verifier-only"],
  ["candidate vanishing with no terminal lifecycle_status", (i) => { i.previous.candidates = [{ candidate_id: "STILL-OPEN-1", status: "ready" }]; i.candidates = []; }, "verifier-only"],
  ["completed candidate with no resolution", (i) => { i.previous.candidates = [{ candidate_id: "DONE-1", lifecycle_status: "completed" }]; i.candidates = []; }, "both"],
  ["completed candidate with no verification refs", (i) => { i.previous.candidates = [{ candidate_id: "DONE-1", lifecycle_status: "completed", resolution: { completed_at: "2026-07-20" } }]; i.candidates = []; }, "both"],
  ["superseded candidate with no superseded_by", (i) => { i.previous.candidates = [{ candidate_id: "OLD-1", lifecycle_status: "superseded", resolution: { reason: "merged" } }]; i.candidates = []; }, "both"],

  // ---- structural: both layers (v5 sprawl pressure) ----
  ["sprawl_pressure removed entirely", (i) => { delete i.sprawl_pressure; }, "both"],
  ["sprawl automated_sprawl_checks outside its enum", (i) => { i.sprawl_pressure.automated_sprawl_checks = "yes"; }, "both"],
  ["sprawl assessment outside its enum", (i) => { i.sprawl_pressure.assessment = "critical"; }, "both"],
  ["sprawl competing-implementations group with only one member", (i) => { i.sprawl_pressure.competing_authoritative_implementations[0].members = ["solo.ts"]; }, "both"],
  ["sprawl duplicated-contract entry with only one location", (i) => { i.sprawl_pressure.duplicated_contract_representations[0].locations = ["only.ts"]; }, "both"],
  ["unknown property inside a sprawl entry", (i) => { i.sprawl_pressure.stale_reachable_paths[0].pathh = "typo"; }, "both"],

  // ---- cross-reference: verifier-owned by construction (v5 sprawl pressure) ----
  ["sprawl entry citing an unknown claim_id", (i) => { i.sprawl_pressure.stale_reachable_paths[0].claim_id = "NOPE-99"; }, "verifier-only"],
  ["sprawl entry citing a claim outside architecture-fitness/maintainability-and-ownership", (i) => { i.sprawl_pressure.stale_reachable_paths[0].claim_id = "CORE-01"; }, "verifier-only"],
];

const base = HV.verifyHealth(island);
const baseOk = base.ok;

let fail = 0;
const line = (mark, text) => console.log("  " + mark + " " + text);

console.log("canonical island");
line(schemaOk(island) ? "ok  " : "FAIL", "schema accepts it");
if (!schemaOk(island)) fail++;
line(baseOk ? "ok  " : "FAIL", "verifier accepts it with the installed shared-spine dependency");
if (!baseOk) fail++;

console.log("\nsabotage corpus — " + CORPUS.length + " mutations");
const surprises = [];
for (const [name, mutate, owner] of CORPUS) {
  const i = clone(island); mutate(i);
  const bySchema = !schemaOk(i);
  const byVerifier = !HV.verifyHealth(i).ok;
  let mark = "ok  ", note = "";
  if (!byVerifier) { mark = "FAIL"; fail++; note = " — VERIFIER MISSED IT"; }
  else if (owner === "both" && !bySchema) { mark = "warn"; note = " — schema missed it (expected both); reclassify or extend the schema"; surprises.push(name); }
  else if (owner === "verifier-only" && bySchema) { note = " — schema also caught it (bonus)"; }
  line(mark, name + "  [" + (bySchema ? "schema+" : "") + "verifier]" + note);
}

console.log("\n" + (fail ? "RED" : "GREEN") + " — verifier rejected " + (CORPUS.length - fail) + "/" + CORPUS.length +
  " mutations; " + surprises.length + " ownership surprises");
process.exit(fail ? 1 : 0);
