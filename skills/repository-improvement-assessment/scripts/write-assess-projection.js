#!/usr/bin/env node
"use strict";
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const {validateAssessProjection}=require("../engineering-intelligence.js");
const storage=require("./durable-storage.js");
function parse(argv){const o={"durable-mode":"git"};for(let i=0;i<argv.length;i++){const a=argv[i];if(["--input","--repo","--output","--durable-mode"].includes(a)){if(!argv[i+1])throw new Error(`MISSING_VALUE:${a}`);o[a.slice(2)]=argv[++i];}else if(a==="--help"||a==="-h")o.help=true;else throw new Error(`UNKNOWN_ARGUMENT:${a}`);}storage.normalizeMode(o["durable-mode"]);return o;}
function explicitWrite(output,bytes){if(fs.existsSync(output))throw new Error(`REFUSING_TO_OVERWRITE:${output}`);fs.mkdirSync(path.dirname(output),{recursive:true});const tmp=output+`.${process.pid}.tmp`;try{fs.writeFileSync(tmp,bytes,{flag:"wx"});fs.renameSync(tmp,output);}finally{try{fs.unlinkSync(tmp);}catch{}}}
function main(){const a=parse(process.argv.slice(2));if(a.help){console.log("usage: node scripts/write-assess-projection.js --input <assess.json> [--repo <repository-root>] [--durable-mode git|content-addressed-degraded] [--output <json>]");return;}if(!a.input)throw new Error("--input is required");const value=JSON.parse(fs.readFileSync(path.resolve(a.input),"utf8"));const result=validateAssessProjection(value);if(!result.ok)throw new Error(result.errors.join("\n"));const bytes=storage.canonicalJsonBytes(value);let stored;if(a.output){const output=path.resolve(a.output);explicitWrite(output,bytes);stored={path:output,sha256:crypto.createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};}else stored=storage.storeJsonArtifact(a.repo||process.cwd(),a["durable-mode"],"assessments","ria",value);console.log(JSON.stringify({kind:"ria-assess-projection",artifact_id:`ria-assess:${stored.sha256}`,sha256:stored.sha256,repository_revision:value.baseline_ref.repository_revision,durable_mode:a["durable-mode"],path:stored.path,bytes:stored.bytes},null,2));}
try{main();}catch(e){console.error(e.stack||e);process.exitCode=1;}
