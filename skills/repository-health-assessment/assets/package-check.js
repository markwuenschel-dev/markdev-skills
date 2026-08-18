#!/usr/bin/env node
/* Dependency-free release check for repository-health-assessment.
 *
 * Usage:
 *   node assets/package-check.js /path/to/ledger-verify.js /path/to/evidence-recon.js
 *
 * This is intentionally narrower than parity-check.js: it verifies the
 * canonical island, the shared-spine boundary, the v4 attacks added after
 * the second audit, the v5 code-sprawl-pressure attacks, and the v5.2
 * Evidence Recon sidecar boundary. parity-check.js
 * remains the complete schema/runtime corpus.
 */
"use strict";
const fs=require("fs"), path=require("path"), os=require("os"), cp=require("child_process");
const here=__dirname;
const ledgerPath=process.argv[2] || process.env.LEDGER_VERIFY_PATH || path.resolve(here,"../../../shared/candidate-ledger-spine/ledger-verify.js");
const evidenceReconPath=process.argv[3] || process.env.EVIDENCE_RECON_PATH || path.resolve(here,"../../../shared/evidence-recon/evidence-recon.js");
if(!fs.existsSync(path.resolve(ledgerPath))){ console.error("package-check requires shared/candidate-ledger-spine/ledger-verify.js; set LEDGER_VERIFY_PATH or pass an explicit path"); process.exit(2); }
if(!fs.existsSync(path.resolve(evidenceReconPath))){ console.error("package-check requires shared/evidence-recon/evidence-recon.js; set EVIDENCE_RECON_PATH or pass an explicit third argument"); process.exit(2); }
eval(fs.readFileSync(path.resolve(ledgerPath),"utf8"));
eval(fs.readFileSync(path.join(here,"health-verify.js"),"utf8"));
const HV=globalThis.HealthVerify;
const canonical=JSON.parse(fs.readFileSync(path.join(here,"canonical-island.json"),"utf8"));
const ER=require(path.resolve(evidenceReconPath));
const {projectHealthIslandToEvidencePacket}=require(path.join(here,"evidence-recon-projection.js"));
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
  ["sprawl-shape",i=>{delete i.sprawl_pressure;}],
  ["sprawl-claim-unknown",i=>{i.sprawl_pressure.stale_reachable_paths[0].claim_id="NOPE-99";}],
  ["sprawl-claim-foreign",i=>{i.sprawl_pressure.stale_reachable_paths[0].claim_id="CORE-01";}],
  ["sprawl-enum",i=>{i.sprawl_pressure.assessment="critical";}],
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

let evidenceChecks=0;
try {
  const packet=projectHealthIslandToEvidencePacket(canonical,{evidenceReconPath:path.resolve(evidenceReconPath)});
  const v=ER.validateEvidencePacket(packet);
  const ok=v.ok; evidenceChecks++;
  console.log((ok?"ok  ":"FAIL")+" evidence-recon-projection");
  if(!ok){ failed++; console.error(v.problems); }

  const unsupported=packet.negative_claims.filter(x=>x.supports_absence===false);
  const notPromoted=unsupported.length>0 && unsupported.every(x=>!packet.handoff.safe_to_assume.includes(x.negative_claim_id));
  evidenceChecks++; console.log((notPromoted?"ok  ":"FAIL")+" evidence-negative-claims-conservative");
  if(!notPromoted) failed++;

  const augmented=projectHealthIslandToEvidencePacket(canonical,{
    evidenceReconPath:path.resolve(evidenceReconPath),
    negative_claim_receipts:{
      "DATA-03":{
        search_scope:["all CI, hook, and repository policy configuration"],
        search_methods:["bounded configuration inventory","direct inspection of every matching guard definition"],
        coverage:{state:"inspected",scope:"finite configuration and policy surface",methods:["bounded-exhaustive configuration search"],limitations:[]},
        evidence_quality:"strong",
        sources:[{kind:"inventory",ref:"fixture guard-configuration inventory"}],
        exclusions:[],
        search_completeness:"bounded-exhaustive",
        supports_absence:true,
        confidence:{level:"high",rationale:"The finite guard-configuration surface was fully inventoried and inspected."},
        limitations:[]
      }
    }
  });
  const augmentedId="RHA:DATA-03:confirmed";
  const receiptOk=ER.validateEvidencePacket(augmented).ok && augmented.handoff.safe_to_assume.includes(augmentedId);
  evidenceChecks++; console.log((receiptOk?"ok  ":"FAIL")+" evidence-negative-receipt-promotion");
  if(!receiptOk) failed++;

  const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),"rha-evidence-recon-"));
  const islandFile=path.join(tempDir,"island.json"), sidecarFile=path.join(tempDir,"sidecar.json");
  fs.writeFileSync(islandFile,JSON.stringify(canonical));
  const cli=cp.spawnSync(process.execPath,[path.join(here,"write-evidence-recon-sidecar.js"),islandFile,sidecarFile,"",evidenceReconPath],{encoding:"utf8"});
  const cliPacket=cli.status===0&&fs.existsSync(sidecarFile)?JSON.parse(fs.readFileSync(sidecarFile,"utf8")):null;
  const cliOk=cli.status===0&&cliPacket&&ER.validateEvidencePacket(cliPacket).ok;
  evidenceChecks++; console.log((cliOk?"ok  ":"FAIL")+" evidence-sidecar-atomic-writer");
  if(!cliOk){ failed++; if(cli.stderr) console.error(cli.stderr); }
  fs.rmSync(tempDir,{recursive:true,force:true});
} catch(error) {
  failed++; evidenceChecks++; console.error("FAIL evidence-recon integration:",error.problems||error);
}
const total=attacks.length+1+evidenceChecks;
console.log((failed?"RED":"GREEN")+" — "+(total-failed)+"/"+total);
process.exit(failed?1:0);
