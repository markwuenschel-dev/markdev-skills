#!/usr/bin/env node
"use strict";
const fs=require("node:fs");
const path=require("node:path");
function parse(argv){const o={};for(let i=0;i<argv.length;i++){const a=argv[i];if(["--input","--repo","--output","--ria-envelope","--return-out"].includes(a)){if(!argv[i+1])throw new Error(`MISSING_VALUE:${a}`);o[a.slice(2).replace(/-/g,"_")]=argv[++i];}else if(a==="--help"||a==="-h")o.help=true;else throw new Error(`UNKNOWN_ARGUMENT:${a}`);}return o;}
function requireShape(v){if(!v||typeof v!=="object"||Array.isArray(v))throw new Error("CANDIDATE_SET_INVALID:root");for(const k of ["schema_version","run_id","scope","evidence_packet_refs","coverage_receipt","candidates","performance_receipt"])if(!(k in v))throw new Error(`CANDIDATE_SET_INVALID:missing:${k}`);if(v.schema_version!==2)throw new Error("CANDIDATE_SET_INVALID:schema_version");if(!Array.isArray(v.candidates))throw new Error("CANDIDATE_SET_INVALID:candidates");for(const [i,c] of v.candidates.entries()){for(const k of ["candidate_id","title","transformation_kind","structural_problem","evidence_refs","current_state","proposed_state","authority_before","authority_after","complexity_destination","deletion_test","simpler_alternative","risks","verification_obligations","critic","disposition"])if(!(k in (c||{})))throw new Error(`CANDIDATE_SET_INVALID:candidates[${i}].${k}`);}return v;}
function shared(skillRoot,pkg,file){for(const c of [path.resolve(skillRoot,"..","shared",pkg,file),path.resolve(skillRoot,"..","..","shared",pkg,file),path.resolve(process.cwd(),"shared",pkg,file),path.resolve(process.cwd(),"skills","shared",pkg,file)])if(fs.existsSync(c))return c;throw new Error(`SHARED_FILE_NOT_FOUND:${pkg}/${file}`);}
function explicitWrite(output,bytes){if(fs.existsSync(output))throw new Error(`REFUSING_TO_OVERWRITE:${output}`);fs.mkdirSync(path.dirname(output),{recursive:true});const tmp=output+`.${process.pid}.tmp`;try{fs.writeFileSync(tmp,bytes,{flag:"wx"});fs.renameSync(tmp,output);}finally{try{fs.unlinkSync(tmp);}catch{}}}
/** RIA requires the owner return as a FILE at the path it names; stdout alone left the
 * redirect as an unwritten manual step. */
function emitOwnerReturn(value,destination){const json=JSON.stringify(value,null,2);if(!destination){console.log(json);return;}const target=path.resolve(destination);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,`${json}
`,"utf8");console.log(target);}
function main() {
  const a = parse(process.argv.slice(2));
  if (a.help || !a.input) { console.log("usage: node assets/write-candidate-set.js --input <candidate-set.json> [--repo <repository-root>] [--output <json>] [--ria-envelope <json>] [--return-out <owner-return.json>]"); return; }
  const root = path.resolve(__dirname, "..");
  const W = require(shared(root, "project-intelligence-workspace", "project-intelligence-workspace.js"));
  const input = requireShape(JSON.parse(fs.readFileSync(path.resolve(a.input), "utf8")));
  const envelope = a.ria_envelope ? JSON.parse(fs.readFileSync(path.resolve(a.ria_envelope), "utf8")) : null;
  if (a.ria_envelope && (!envelope?.baseline_ref?.repository_revision || input.repository_revision !== envelope.baseline_ref.repository_revision)) {
    throw new Error("RIA_ENVELOPE_REVISION_MISMATCH: Architecture input must match baseline_ref.repository_revision");
  }
  // composite-scoring-v3 §5.3: string refs, or {kind: "sei-criterion", criterion_id, metric_id}
  // citations that must exist in the bound SEI assessment bytes (fail fast here; RIA re-checks).
  for (const [i, c] of input.candidates.entries()) for (const [j, r] of (c.evidence_refs || []).entries()) {
    const ok = (typeof r === "string" && r.trim()) || (r && typeof r === "object" && !Array.isArray(r) && r.kind === "sei-criterion" && Object.keys(r).every((k) => ["kind", "criterion_id", "metric_id"].includes(k)) && typeof r.criterion_id === "string" && r.criterion_id && typeof r.metric_id === "string" && r.metric_id);
    if (!ok) throw new Error(`CANDIDATE_SET_INVALID:candidates[${i}].evidence_refs[${j}] must be a reference string or {kind: "sei-criterion", criterion_id, metric_id}`);
  }
  if (envelope) {
    const reader = require(path.resolve(root, "..", "repository-improvement-assessment", "engineering-intelligence-reader.js"));
    const citations = reader.collectSeiCitations(input);
    if (citations.length) {
      const evidence = reader.readSeiEvidence({ repository_root: path.resolve(a.repo || process.cwd()), envelope });
      const problems = reader.seiCitationProblems(evidence.assessment, citations);
      if (problems.length) throw new Error(`FAIL-SEI-CITATION-INVALID:\n${problems.join("\n")}`);
    }
  }
  const { normalizeCandidateFitness } = require("./architecture-fitness.js");
  const value = normalizeCandidateFitness(input, { requireV2: Boolean(a.ria_envelope) });
  // architecture.evidence-binding@1 (composite-scoring-v3 §5.2, §6.1–§6.3): under an envelope every
  // packet ref is structured and bound, and every scored fitness dimension resolves to the claims it used.
  if (envelope) {
    const binding = require("./architecture-evidence-binding.js");
    const repositoryRoot = path.resolve(a.repo || process.cwd());
    binding.resolveArchitectureEvidence(value, { mode: "write", repositoryRoot, binding: binding.bindingFromEnvelope(envelope), allowedRoots: [path.join(repositoryRoot, ".project-intelligence"), process.env.RIA_RUNTIME_ROOT].filter(Boolean) });
  }
  const bytes = W.canonicalJsonBytes(value);
  let stored;
  if (a.output) {
    const output = path.resolve(a.output); explicitWrite(output, bytes);
    const crypto = require("node:crypto");
    stored = { path: output, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  } else stored = W.storeJsonArtifact(a.repo || process.cwd(), "assessments", "architecture", value);
  const revision = value.repository_revision ?? null;
  const ref = { owner: "architecture-improvement-intelligence", artifact_id: `architecture-assessment:${stored.sha256}`, sha256: stored.sha256, repository_revision: revision };
  if (envelope) {
    const { createOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
    const returned = createOwnerReturn({ owner: ref.owner, canonical_artifact_ref: ref, repository_revision: revision, artifact_path: stored.path, input_binding_echo: envelope, warnings: [] });
    const validation = require("./architecture-owner-return.js").validateArchitectureOwnerReturn(returned, { requireFitnessV2: true });
    if (!validation.ok) throw new Error(validation.errors.join("\n"));
    emitOwnerReturn(returned, a.return_out);
  } else console.log(JSON.stringify({ ...ref, path: stored.path, bytes: stored.bytes }, null, 2));
}
try{main();}catch(e){console.error(e.stack||e);process.exitCode=1;}
