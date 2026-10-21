"use strict";
const fs=require("node:fs"); const path=require("node:path"); const cp=require("node:child_process");
const root=__dirname; const manifest=JSON.parse(fs.readFileSync(path.join(root,"MANIFEST.json"),"utf8"));
for(const file of manifest.files) if(!fs.existsSync(path.join(root,file))) throw new Error("MISSING:"+file);
const r=cp.spawnSync(process.execPath,[path.join(root,"project-intelligence-workspace.test.js")],{encoding:"utf8"});
if(r.status!==0) throw new Error((r.stdout||"")+(r.stderr||""));
console.log("PROJECT_INTELLIGENCE_WORKSPACE_PACKAGE_OK");
