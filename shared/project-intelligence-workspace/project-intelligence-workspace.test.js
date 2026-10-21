"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const W = require("./project-intelligence-workspace.js");
function git(repo,args){ const r=cp.spawnSync("git",["-C",repo,...args],{encoding:"utf8"}); if(r.status!==0) throw new Error(r.stderr); return (r.stdout||"").trim(); }
const root=fs.mkdtempSync(path.join(os.tmpdir(),"piw-test-"));
try {
  git(root,["init"]); git(root,["config","user.email","test@example.invalid"]); git(root,["config","user.name","Test"]);
  fs.writeFileSync(path.join(root,"tracked.txt"),"x\n"); git(root,["add","tracked.txt"]); git(root,["commit","-m","init"]);
  const ws=W.ensureWorkspace(root);
  assert.equal(path.basename(ws.workspace_root),".project-intelligence");
  assert.ok(fs.existsSync(ws.paths.manifest));
  assert.match(fs.readFileSync(W.gitExcludePath(root),"utf8"),/\/\.project-intelligence\//);
  assert.equal(git(root,["status","--porcelain"]),"");
  const report=W.reportPath(root,"repository-improvement-assessment","report.html");
  assert.ok(report.startsWith(ws.paths.reports + path.sep));
  const ca=W.contentAddressedPath(root,"artifacts","test","a".repeat(64),".json");
  assert.ok(ca.endsWith(path.join("test","aa",`${"a".repeat(64)}.json`)));
  const stored=W.storeJsonArtifact(root,"assessments","test-owner",{b:2,a:1});
  assert.ok(stored.path.startsWith(ws.paths.assessments));
  assert.equal(fs.readFileSync(stored.path,"utf8"),"{\n  \"a\": 1,\n  \"b\": 2\n}\n");
  const localScratch=W.createScratchSession(root,"local"); assert.equal(localScratch.external,false); assert.ok(localScratch.path.startsWith(ws.paths.scratch)); localScratch.cleanup();
  const shortScratch=W.createScratchSession(root,"short",{shortPathRequired:true,platform:"linux"}); assert.equal(shortScratch.external,true); assert.ok(shortScratch.path.includes("pi-tmp")); shortScratch.cleanup();
  const legacy=path.join(root,".decision-terrain","x"); fs.mkdirSync(legacy,{recursive:true});
  const preferred=W.decisionPath(root,"terrain","x","map.md");
  assert.equal(W.firstExisting(root,preferred,[".decision-terrain/x"]).source,"legacy");
  console.log("PROJECT_INTELLIGENCE_WORKSPACE_OK");
} finally { fs.rmSync(root,{recursive:true,force:true}); }
