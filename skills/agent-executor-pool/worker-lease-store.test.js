"use strict";
const assert=require("assert"), fs=require("fs"), os=require("os"), path=require("path"); const {WorkerLeaseStore}=require("./worker-lease-store");
let n=0; const ok=m=>{n++;console.log("ok  "+m)}; const d=fs.mkdtempSync(path.join(os.tmpdir(),"agent-pool-")); const s=new WorkerLeaseStore(d,{ttl_ms:100});
const a=s.claim("A","w1",1000); assert(a.claimed); ok("first worker claims assignment with generation/fence");
const live=s.claim("A","w2",1050); assert(!live.claimed && live.reason==="LEASE_LIVE"); ok("live lease cannot be displaced");
const b=s.recoverExpired("A","w2",1200); assert(b.claimed && b.lease.generation===2 && b.lease.fence_token!==a.lease.fence_token); ok("expired lease recovers with higher generation and new fence token");
const stale=s.conclude("A",a.lease.generation,a.lease.fence_token,"completed","old",1210); assert(!stale.ok && stale.reason==="STALE_FENCE"); ok("stale worker cannot publish a result after recovery");
const good=s.conclude("A",b.lease.generation,b.lease.fence_token,"completed","new",1210); assert(good.ok); ok("current fenced worker can conclude");
console.log(`GREEN — ${n}/${n}`);
