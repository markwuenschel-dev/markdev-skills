"use strict";
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadLineage, recordArtifact, lineagePath } = require("./workspace-lineage.js");
const { resolveStartup, repositoryIdentity } = require("./startup-resolver.js");
const workspace = require("../../shared/project-intelligence-workspace/project-intelligence-workspace.js");

function sha(bytes){ return crypto.createHash("sha256").update(bytes).digest("hex"); }
function run(repo,args){ return childProcess.execFileSync("git",["-C",repo,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim(); }
const repo=fs.mkdtempSync(path.join(os.tmpdir(),"ria-lineage-"));
run(repo,["init"]); run(repo,["config","user.email","test@example.invalid"]); run(repo,["config","user.name","Test"]);
fs.writeFileSync(path.join(repo,"a.txt"),"a\n"); run(repo,["add","a.txt"]); run(repo,["commit","-m","a"]);
workspace.ensureWorkspace(repo);
const id=repositoryIdentity(repo);
const artifact=workspace.resolvePath(repo,"evidence","sei-test.json"); const bytes=Buffer.from('{"ok":true}\n'); fs.writeFileSync(artifact,bytes);
const config="a".repeat(64), contract="b".repeat(64);
recordArtifact(repo,"sei",{repository_key:id.repository_key,revision:id.revision,working_tree_fingerprint:id.working_tree_fingerprint,engine_version:"1.3.0",config_hash:config,execution_contract_hash:contract,sha256:sha(bytes),path:artifact,artifact_id:"sei:test"});
const lineage=loadLineage(repo); assert.equal(lineage.sei_artifacts.length,1); assert.ok(lineagePath(repo).includes(`${path.sep}.project-intelligence${path.sep}lineage${path.sep}`));
const resolution=resolveStartup({repository:{root:repo},engine_version:"1.3.0",config_hash:config,execution_contract_hash:contract,baseline_ref:{sha256:"c".repeat(64)},owners:[]});
assert.equal(resolution.startup_mode,"EXACT_REUSE");
const status=run(repo,["status","--porcelain"]); assert.equal(status,"", "workspace state must be locally excluded from git status");
fs.rmSync(repo,{recursive:true,force:true});

const nonGit=fs.mkdtempSync(path.join(os.tmpdir(),"ria-lineage-degraded-"));
fs.writeFileSync(path.join(nonGit,"a.txt"),"degraded\n");
const degradedId=repositoryIdentity(nonGit,"content-addressed-degraded");
const degradedArtifact=path.join(nonGit,".project-intelligence","evidence","sei.json"); const degradedBytes=Buffer.from('{"ok":"degraded"}\n'); fs.mkdirSync(path.dirname(degradedArtifact),{recursive:true}); fs.writeFileSync(degradedArtifact,degradedBytes);
recordArtifact(nonGit,"sei",{repository_key:degradedId.repository_key,revision:degradedId.revision,working_tree_fingerprint:degradedId.working_tree_fingerprint,engine_version:"1.3.0",config_hash:config,execution_contract_hash:contract,sha256:sha(degradedBytes),path:degradedArtifact,artifact_id:"sei:degraded"},{durableMode:"content-addressed-degraded"});
const degradedLineage=loadLineage(nonGit,{durableMode:"content-addressed-degraded"}); assert.equal(degradedLineage.sei_artifacts.length,1);
const degradedResolution=resolveStartup({durable_mode:"content-addressed-degraded",repository:{root:nonGit},engine_version:"1.3.0",config_hash:config,execution_contract_hash:contract,baseline_ref:{sha256:"d".repeat(64)},owners:[]});
assert.equal(degradedResolution.startup_mode,"EXACT_REUSE");
fs.rmSync(nonGit,{recursive:true,force:true});
console.log("RIA_WORKSPACE_LINEAGE_OK");
