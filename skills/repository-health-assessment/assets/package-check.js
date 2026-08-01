#!/usr/bin/env node
/* Dependency-free release check for repository-health-assessment.
 *
 * Usage:
 *   node assets/package-check.js /path/to/ledger-verify.js
 *
 * This is intentionally narrower than parity-check.js: it verifies the
 * canonical island, the shared-spine boundary, and the v4 attacks added after
 * the second audit. parity-check.js remains the complete schema/runtime corpus.
 */
"use strict";
const fs=require("fs"), path=require("path");
const here=__dirname;
const ledgerPath=process.argv[2] || process.env.LEDGER_VERIFY_PATH || path.resolve(here,"../../shared/candidate-ledger-spine/ledger-verify.js");
if(!fs.existsSync(path.resolve(ledgerPath))){ console.error("package-check requires shared/candidate-ledger-spine/ledger-verify.js; set LEDGER_VERIFY_PATH or pass an explicit path"); process.exit(2); }
eval(fs.readFileSync(path.resolve(ledgerPath),"utf8"));
eval(fs.readFileSync(path.join(here,"health-verify.js"),"utf8"));
const HV=globalThis.HealthVerify;
const canonical=JSON.parse(fs.readFileSync(path.join(here,"canonical-island.json"),"utf8"));
const clone=(x)=>JSON.parse(JSON.stringify(x));
const attacks=[
  ["spine-version",i=>{i.spine_version=2;}],
  ["candidate-shape",i=>{delete i.candidates[0].summary;}],
  ["candidate-rollup",i=>{delete i.candidates[0].rollup;}],
  ["candidate-scheduling",i=>{delete i.candidates[0].depends_on;}],
  ["candidate-dedup",i=>{delete i.candidates[0].dedup;}],
  ["candidate-resolution-missing",i=>{i.previous.candidates=[{candidate_id:"DONE",lifecycle_status:"completed"}];i.candidates=[];}],
  ["surface-evidence-missing",i=>{delete i.coverage[0].evidence_refs;}],
  ["surface-evidence-unknown",i=>{i.coverage[0].evidence_refs=[{kind:"claim",ref:"NOPE"}];}],
  ["surface-evidence-weak",i=>{i.coverage[0].evidence_refs=[{kind:"rationale",ref:"looks complete"}];}],
  ["freshness-evidence",i=>{delete i.repository.freshness_evidence;}],
  ["freshness-inconsistent",i=>{i.repository.freshness_evidence.working_tree_clean=false;}],
  ["baseline-command-shape",i=>{delete i.verification.commands[0].command_id;}],
  ["baseline-command-duplicate",i=>{i.verification.commands[1].command_id=i.verification.commands[0].command_id;}],
];
let failed=0;
const base=HV.verifyHealth(canonical);
if(!base.ok){ failed++; console.error("FAIL canonical:",base.problems); }
else console.log("ok canonical: health v"+HV.HEALTH_SCHEMA_VERSION+", spine v"+HV.HEALTH_SPINE_VERSION);
for(const [code,mutate] of attacks){
  const i=clone(canonical); mutate(i);
  const v=HV.verifyHealth(i);
  const caught=!v.ok&&v.problems.some(p=>p.code===code);
  console.log((caught?"ok  ":"FAIL")+" "+code);
  if(!caught) failed++;
}
console.log((failed?"RED":"GREEN")+" — "+(attacks.length+1-failed)+"/"+(attacks.length+1));
process.exit(failed?1:0);
