"use strict";
const fs=require("fs"),path=require("path");const dir=path.resolve(__dirname,"..");let n=0;function ok(c,m){if(!c)throw new Error(m);n++;console.log("ok  "+m)}
for(const f of ["MANIFEST.json","context-policy.json","contracts/executor-job.schema.json","contracts/worker-lease.schema.json"]){JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));ok(true,`${f} parses`)}
const R=require(path.join(dir,"runtime.js")),L=require(path.join(dir,"worker-lease-store.js"));ok(typeof R.ExecutorPool==="function","ExecutorPool export exists");ok(typeof L.WorkerLeaseStore==="function","WorkerLeaseStore export exists");console.log(`GREEN — ${n}/${n}`);
