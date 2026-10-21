#!/usr/bin/env node
/* Dependency-free release check for repository-health-assessment.
 *
 * Usage:
 *   node assets/package-check.js /path/to/ledger-verify.js /path/to/evidence-recon.js
 *
 * This is intentionally narrower than parity-check.js: it verifies the
 * canonical island, the shared-spine boundary, the v4 attacks added after
 * the second audit, the v5 code-sprawl-pressure attacks, the v5.2
 * Evidence Recon sidecar boundary, and the v5.6 judgment-evidence rules. parity-check.js
 * remains the complete schema/runtime corpus.
 */
"use strict";
const fs=require("fs"), path=require("path"), os=require("os"), cp=require("child_process");
const here=__dirname;
const ledgerPath=process.argv[2] || process.env.LEDGER_VERIFY_PATH || path.resolve(here,"../../shared/candidate-ledger-spine/ledger-verify.js");
const evidenceReconPath=process.argv[3] || process.env.EVIDENCE_RECON_PATH || path.resolve(here,"../../shared/evidence-recon/evidence-recon.js");
if(!fs.existsSync(path.resolve(ledgerPath))){ console.error("package-check requires shared/candidate-ledger-spine/ledger-verify.js; set LEDGER_VERIFY_PATH or pass an explicit path"); process.exit(2); }
if(!fs.existsSync(path.resolve(evidenceReconPath))){ console.error("package-check requires shared/evidence-recon/evidence-recon.js; set EVIDENCE_RECON_PATH or pass an explicit third argument"); process.exit(2); }
eval(fs.readFileSync(path.resolve(ledgerPath),"utf8"));
eval(fs.readFileSync(path.join(here,"health-verify.js"),"utf8"));
const HV=globalThis.HealthVerify;
const canonical=JSON.parse(fs.readFileSync(path.join(here,"canonical-island.json"),"utf8"));
const ER=require(path.resolve(evidenceReconPath));
const {projectHealthIslandToEvidencePacket}=require(path.join(here,"evidence-recon-projection.js"));
const clone=(x)=>JSON.parse(JSON.stringify(x));
const judged=i=>i.claims.find(c=>c.review_source&&c.review_source.proof_basis==="judgment");
const vr=i=>i.lanes.find(l=>l.lane==="verification-readiness");
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
  // v5.6 judgment evidence (review_source.proof_basis, R1-R6)
  ["claim-review-source",i=>{delete i.claims.find(c=>c.review_source).review_source.proof_basis;}],
  ["claim-judgment-confirmed",i=>{judged(i).observation.confirmed="x";}],
  ["level-judgment-only",i=>{vr(i).scores.observed_soundness.claim_refs=[{claim_id:judged(i).claim_id,support:"judged soundness"}];}],
  ["level4-needs-mechanical-pass",i=>{vr(i).scores.verification_readiness.claim_refs=[{claim_id:judged(i).claim_id,support:"judged pass"},{claim_id:"VERIF-02",support:"mechanical partial"}];}],
  ["surface-strong-judgment-only",i=>{i.coverage.find(s=>s.id==="verification").evidence_refs=[{kind:"claim",ref:judged(i).claim_id}];}],
  ["uncontained-critical-judgment",i=>{const c=judged(i);c.result="fail";i.uncontained_critical_failure={claim_id:c.claim_id,statement:"x"};}],
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
  const cli=cp.spawnSync(process.execPath,[path.join(here,"write-evidence-recon-sidecar.js"),islandFile,sidecarFile],{encoding:"utf8",env:{...process.env,RIA_RUNTIME_ROOT:tempDir,LEDGER_VERIFY_PATH:path.resolve(ledgerPath)}});
  const cliPacket=cli.status===0&&fs.existsSync(sidecarFile)?JSON.parse(fs.readFileSync(sidecarFile,"utf8")):null;
  const cliOk=cli.status===0&&cliPacket&&ER.validateEvidencePacket(cliPacket).ok;
  evidenceChecks++; console.log((cliOk?"ok  ":"FAIL")+" evidence-sidecar-atomic-writer");
  if(!cliOk){ failed++; if(cli.stderr) console.error(cli.stderr); }
  fs.rmSync(tempDir,{recursive:true,force:true});
} catch(error) {
  failed++; evidenceChecks++; console.error("FAIL evidence-recon integration:",error.problems||error);
}
/* ---- writer, projection, and sidecar hardening (5.x lane beta) ---- */
let extraChecks=0;
function check(name,ok,detail){ extraChecks++; console.log((ok?"ok  ":"FAIL")+" "+name); if(!ok){ failed++; if(detail) console.error(String(detail).slice(0,2000)); } }
const {NEGATIVE_RE,healthArtifactRefNote}=require(path.join(here,"evidence-recon-projection.js"));
for(const phrase of ["nothing tests this","the handler is not tested","CI lacks a lint step","there are zero integration tests","auth isn't enforced","cannot be reached"]) check("negative-re: "+phrase,NEGATIVE_RE.test(phrase));
check("negative-re: positive statement stays positive",!NEGATIVE_RE.test("CI runs lint on every push"));
try {
  const erPath=path.resolve(evidenceReconPath);
  const neg=clone(canonical); const target=neg.claims.find(c=>c.observation&&typeof c.observation.confirmed==="string");
  target.observation={confirmed:"nothing tests this handler"};
  const negPacket=projectHealthIslandToEvidencePacket(neg,{evidenceReconPath:erPath});
  const negId="RHA:"+target.claim_id+":confirmed";
  check("negative-re: 'nothing tests this' not promoted to safe_to_assume",negPacket.negative_claims.some(x=>x.negative_claim_id===negId)&&!negPacket.handoff.safe_to_assume.includes(negId));

  const lanes=[...new Set(canonical.claims.map(c=>c.lane))];
  const w=clone(canonical);
  w.evidence_workers=[{worker_id:"W-1",lane:lanes[0],status:"timeout",limitations:["ran out of time on src/"]},{worker_id:"W-2",lane:lanes[1],status:"partial",limitations:["sampled only"]},{worker_id:"W-3",lane:"orphan-lane",status:"blocked",limitations:["no access"]}];
  const wp=projectHealthIslandToEvidencePacket(w,{evidenceReconPath:erPath});
  const rec=lane=>wp.lane_receipts.find(r=>r.surface==="RHA lane "+lane);
  const r0=rec(lanes[0]),r1=rec(lanes[1]),r2=lanes[2]&&rec(lanes[2]),ro=rec("orphan-lane");
  check("lane-receipts: timeout worker -> failed + timeout limitation",r0&&r0.status==="failed"&&r0.limitations.some(l=>/timeout/.test(l))&&r0.limitations.some(l=>/ran out of time/.test(l)),JSON.stringify(r0));
  check("lane-receipts: partial worker carried with limitations",r1&&r1.status==="partial"&&r1.limitations.some(l=>/sampled only/.test(l)),JSON.stringify(r1));
  check("lane-receipts: lane without worker but with claims stays complete",!r2||r2.status==="complete",JSON.stringify(r2));
  check("lane-receipts: worker-only lane is receipted (blocked)",ro&&ro.status==="blocked"&&ER.validateEvidencePacket(wp).ok,JSON.stringify(ro));

  const p1=projectHealthIslandToEvidencePacket(canonical,{evidenceReconPath:erPath}), p2=projectHealthIslandToEvidencePacket(canonical,{evidenceReconPath:erPath});
  const p3=projectHealthIslandToEvidencePacket(neg,{evidenceReconPath:erPath});
  check("packet-id: content-derived and deterministic",/^RHA-ER:sha256:[0-9a-f]{64}$/.test(p1.packet_id)&&p1.packet_id===p2.packet_id&&p1.packet_id!==p3.packet_id,p1.packet_id);
} catch(error){ check("projection hardening cases",false,error.stack||JSON.stringify(error.problems||error)); }

{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"rha-writers-"));
  const env={...process.env,RIA_RUNTIME_ROOT:tmp,LEDGER_VERIFY_PATH:path.resolve(ledgerPath),EVIDENCE_RECON_PATH:path.resolve(evidenceReconPath)};
  const envNoRoot={...env}; delete envNoRoot.RIA_RUNTIME_ROOT;
  const run=(script,argv,e=env)=>cp.spawnSync(process.execPath,[path.join(here,script),...argv],{encoding:"utf8",env:e,cwd:tmp});
  const islandFile=path.join(tmp,"island.json"); fs.writeFileSync(islandFile,JSON.stringify(canonical));
  try {
    let r=run("write-health-artifact.js",["--repo","."]);
    check("writer: missing --input exits 2 with usage",r.status===2&&/usage:/.test(r.stderr),`status=${r.status} ${r.stderr}`);
    r=run("write-health-artifact.js",["--help"]);
    check("writer: --help exits 0",r.status===0&&/usage:/.test(r.stdout),`status=${r.status}`);
    r=run("build-report.js",["--repo","."]);
    check("build-report: missing --input exits 2 with usage",r.status===2&&/usage:/.test(r.stderr),`status=${r.status} ${r.stderr}`);
    r=run("write-evidence-recon-sidecar.js",[]);
    check("sidecar: missing --island exits 2",r.status===2,`status=${r.status}`);

    const outside=path.join(os.tmpdir(),"rha-outside-"+process.pid+"-"+Date.now()+".json");
    r=run("write-health-artifact.js",["--input",islandFile,"--output",outside],envNoRoot);
    check("writer: --output outside allowed roots refused",r.status!==0&&/OUTPUT_PATH_OUTSIDE_ALLOWED_ROOTS/.test(r.stderr)&&!fs.existsSync(outside),`status=${r.status} ${r.stderr}`);
    r=run("write-evidence-recon-sidecar.js",["--island",islandFile,"--output",outside],envNoRoot);
    check("sidecar: --output outside allowed roots refused",r.status!==0&&/OUTPUT_PATH_OUTSIDE_ALLOWED_ROOTS/.test(r.stderr)&&!fs.existsSync(outside),`status=${r.status} ${r.stderr}`);

    const bad=clone(canonical); bad.spine_version=2; const badFile=path.join(tmp,"bad.json"); fs.writeFileSync(badFile,JSON.stringify(bad));
    const badOut=path.join(tmp,"bad-sidecar.json");
    r=run("write-evidence-recon-sidecar.js",["--island",badFile,"--output",badOut]);
    check("sidecar: invalid island refused (exit 1)",r.status===1&&!fs.existsSync(badOut),`status=${r.status} ${r.stderr}`);

    const sidecar=path.join(tmp,"sidecar.json");
    r=run("write-evidence-recon-sidecar.js",["--island",islandFile,"--output",sidecar]);
    let out=null; try{ out=JSON.parse(r.stdout); }catch{}
    const sideBytes=fs.existsSync(sidecar)?fs.readFileSync(sidecar):null;
    const sideOk=r.status===0&&out&&sideBytes&&out.sha256===require("crypto").createHash("sha256").update(sideBytes).digest("hex")&&out.health_artifact_ref&&JSON.parse(sideBytes).handoff.consumer_notes.includes(healthArtifactRefNote(out.health_artifact_ref))&&Array.isArray(JSON.parse(sideBytes).producer.artifact_refs)&&JSON.parse(sideBytes).producer.artifact_refs[0].sha256===out.health_artifact_ref.sha256;
    check("sidecar: --output prints sha256 and binds health_artifact_ref (note + producer.artifact_refs)",sideOk,`status=${r.status} ${r.stderr} ${r.stdout}`);

    const artifactOut=path.join(tmp,"health.json");
    r=run("write-health-artifact.js",["--input",islandFile,"--output",artifactOut]);
    let stored=null; try{ stored=JSON.parse(r.stdout); }catch{}
    const persisted=fs.existsSync(artifactOut)?JSON.parse(fs.readFileSync(artifactOut,"utf8")):null;
    check("writer: persisted artifact carries grade block and matches sidecar binding",r.status===0&&persisted&&persisted.grade&&persisted.grade.final_grade&&Array.isArray(persisted.grade.caps_applied)&&HV.verifyHealth(persisted,{persisted:true}).ok&&out&&stored&&stored.sha256===out.health_artifact_ref.sha256,`status=${r.status} ${r.stderr}`);

    const rev=canonical.repository.revision, H="0".repeat(64);
    const baselineFile=path.join(tmp,"verification-baseline.json"); fs.writeFileSync(baselineFile,"{\"baseline\":true}\n");
    const baselineSha=require("crypto").createHash("sha256").update(fs.readFileSync(baselineFile)).digest("hex");
    const envelope=over=>({baseline_ref:{artifact_id:"baseline:x",sha256:H,repository_revision:rev},engineering_intelligence_ref:{artifact_id:"sei:x",owner:"software-engineering-intelligence",kind:"snapshot",schema_version:"x",sha256:H,repository_revision:rev,mission_id:"m",scope_hash:"s",baseline_binding:{artifact_id:"baseline:x",sha256:H,repository_revision:rev}},verification_baseline_ref:{artifact_id:"verification:x",content_sha256:baselineSha,file_sha256:baselineSha,sha256:baselineSha,repository_revision:rev,path:baselineFile},...over});
    const writeEnv=(name,value)=>{ const f=path.join(tmp,name); fs.writeFileSync(f,JSON.stringify(value)); return f; };
    const goodEnv=writeEnv("envelope.json",envelope({}));
    const ret=path.join(tmp,"owner-return.json");
    r=run("write-health-artifact.js",["--input",islandFile,"--output",path.join(tmp,"health-ria.json"),"--ria-envelope",goodEnv,"--evidence-recon",sidecar,"--return-out",ret]);
    let ownerReturn=null; try{ ownerReturn=JSON.parse(fs.readFileSync(ret,"utf8")); }catch{}
    const sref=ownerReturn&&(ownerReturn.specialist_refs||[]).find(x=>x.kind==="evidence-recon");
    check("writer: --evidence-recon adds evidence-recon specialist_ref",r.status===0&&sref&&sideBytes&&sref.sha256===out.sha256&&sref.packet_id===JSON.parse(sideBytes).packet_id,`status=${r.status} ${r.stderr}`);
    const before=fs.existsSync(ret)?fs.readFileSync(ret,"utf8"):null;
    r=run("write-health-artifact.js",["--input",islandFile,"--output",path.join(tmp,"health-ria-2.json"),"--ria-envelope",goodEnv,"--return-out",ret]);
    check("writer: --return-out refuses overwrite (wx)",r.status!==0&&/REFUSING_TO_OVERWRITE_RETURN/.test(r.stderr)&&before!==null&&fs.readFileSync(ret,"utf8")===before,`status=${r.status} ${r.stderr}`);

    // Either binding form alone is accepted; a disagreeing sha256 in either form is refused.
    {
      const base=JSON.parse(sideBytes);
      const isNote=n=>typeof n==="string"&&n.startsWith("health_artifact_ref ");
      const variant=(name,mutate)=>{ const p=clone(base); mutate(p); return writeEnv(name,p); };
      const attempt=(file,tag)=>run("write-health-artifact.js",["--input",islandFile,"--output",path.join(tmp,"health-"+tag+".json"),"--ria-envelope",goodEnv,"--evidence-recon",file]);
      const structuredOnly=variant("sidecar-structured-only.json",p=>{ p.handoff.consumer_notes=p.handoff.consumer_notes.filter(n=>!isNote(n)); });
      const noteOnly=variant("sidecar-note-only.json",p=>{ delete p.producer.artifact_refs; });
      const badStructured=variant("sidecar-bad-structured.json",p=>{ p.producer.artifact_refs[0].sha256="f".repeat(64); });
      const badNote=variant("sidecar-bad-note.json",p=>{ p.handoff.consumer_notes=p.handoff.consumer_notes.map(n=>isNote(n)?n.replace(/sha256=[0-9a-f]{64}/,"sha256="+"f".repeat(64)):n); });
      const rs=attempt(structuredOnly,"so"), rn=attempt(noteOnly,"no"), rbs=attempt(badStructured,"bs"), rbn=attempt(badNote,"bn");
      check("writer: --evidence-recon accepts structured-only / note-only, rejects disagreement",
        rs.status===0&&rn.status===0&&rbs.status===1&&/EVIDENCE_RECON_SIDECAR_UNBOUND/.test(rbs.stderr)&&rbn.status===1&&/EVIDENCE_RECON_SIDECAR_UNBOUND/.test(rbn.stderr),
        `structured-only=${rs.status} ${rs.stderr} | note-only=${rn.status} ${rn.stderr} | bad-structured=${rbs.status} ${rbs.stderr} | bad-note=${rbn.status} ${rbn.stderr}`);
    }

    const mismatch=writeEnv("envelope-mismatch.json",envelope({baseline_ref:{artifact_id:"baseline:x",sha256:H,repository_revision:"deadbeef"}}));
    r=run("write-health-artifact.js",["--input",islandFile,"--output",path.join(tmp,"health-mm.json"),"--ria-envelope",mismatch]);
    check("writer: envelope revision mismatch refused",r.status!==0&&/RIA_ENVELOPE_REVISION_MISMATCH/.test(r.stderr)&&!fs.existsSync(path.join(tmp,"health-mm.json")),`status=${r.status} ${r.stderr}`);
    const tampered=writeEnv("envelope-hash.json",envelope({verification_baseline_ref:{artifact_id:"verification:x",content_sha256:H,file_sha256:H,sha256:H,repository_revision:rev,path:baselineFile}}));
    r=run("write-health-artifact.js",["--input",islandFile,"--output",path.join(tmp,"health-hash.json"),"--ria-envelope",tampered]);
    check("writer: verification baseline re-hash mismatch refused",r.status!==0&&/RIA_VERIFICATION_BASELINE_HASH_MISMATCH/.test(r.stderr),`status=${r.status} ${r.stderr}`);
    const tf=writeEnv("testing-fitness.json",{schema_version:"ria.testing-fitness@1",source:{}});
    r=run("write-health-artifact.js",["--input",islandFile,"--output",path.join(tmp,"health-tf.json"),"--ria-envelope",goodEnv,"--testing-fitness",tf]);
    check("writer: --testing-fitness without source.repository_revision refused",r.status!==0&&/TESTING_FITNESS_REVISION_MISSING/.test(r.stderr)&&/DEPRECATED/.test(r.stderr),`status=${r.status} ${r.stderr}`);
  } catch(error){ check("writer CLI cases",false,error.stack||error); }
  finally { fs.rmSync(tmp,{recursive:true,force:true}); }
}
const total=attacks.length+1+evidenceChecks+extraChecks;
console.log((failed?"RED":"GREEN")+" — "+(total-failed)+"/"+total);
process.exit(failed?1:0);
