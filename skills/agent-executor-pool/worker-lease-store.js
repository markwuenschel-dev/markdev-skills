"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { withFileLock } = require("./file-lock");

function atomicWrite(file, value) { fs.mkdirSync(path.dirname(file), {recursive:true}); const tmp=file+".tmp-"+process.pid+"-"+crypto.randomBytes(4).toString("hex"); fs.writeFileSync(tmp, JSON.stringify(value,null,2)+"\n"); fs.renameSync(tmp,file); }
function read(file) { try { return JSON.parse(fs.readFileSync(file,"utf8")); } catch (_) { return null; } }
function iso(ms) { return new Date(ms).toISOString(); }

class WorkerLeaseStore {
  constructor(stateDir, options={}) { this.stateDir=stateDir; this.ttlMs=Number(options.ttl_ms || 120000); this.lockTimeoutMs=Number(options.lock_timeout_ms || 10000); this.lockStaleMs=Number(options.lock_stale_ms || 300000); fs.mkdirSync(stateDir,{recursive:true}); }
  _file(id){ return path.join(this.stateDir, encodeURIComponent(id)+".json"); }
  _lock(id){ return this._file(id)+".lock"; }
  _withLock(id, operation){ return withFileLock(this._lock(id), operation, {timeout_ms:this.lockTimeoutMs,stale_ms:this.lockStaleMs}); }
  _token(){ return crypto.randomBytes(24).toString("hex"); }
  _validCurrent(cur,generation,token,now=Date.now()){ return cur && cur.generation===generation && cur.fence_token===token && cur.status==="active" && Date.parse(cur.expires_at)>now; }
  claim(assignmentId, workerIdentity, now=Date.now()) {
    if(typeof assignmentId!=="string"||!assignmentId||typeof workerIdentity!=="string"||!workerIdentity) throw new Error("LEASE_IDENTITY_INVALID");
    return this._withLock(assignmentId,()=>{
      const file=this._file(assignmentId), cur=read(file);
      if (cur && cur.status==="active" && Date.parse(cur.expires_at)>now) return {claimed:false, reason:"LEASE_LIVE", lease:cur};
      const generation=(cur && Number.isInteger(cur.generation) ? cur.generation : 0)+1;
      if(process.env.AEP_TEST_CLAIM_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.AEP_TEST_CLAIM_DELAY_MS));
      const lease={schema_version:2,assignment_id:assignmentId,generation,fence_token:this._token(),worker_identity:workerIdentity,status:"active",leased_at:iso(now),heartbeat_at:iso(now),expires_at:iso(now+this.ttlMs),result_ref:null};
      atomicWrite(file,lease); return {claimed:true,lease};
    });
  }
  heartbeat(id,generation,token,now=Date.now()) { return this._withLock(id,()=>{ const file=this._file(id),cur=read(file); if(!this._validCurrent(cur,generation,token,now)) return {ok:false,reason:"STALE_FENCE"}; cur.heartbeat_at=iso(now); cur.expires_at=iso(now+this.ttlMs); atomicWrite(file,cur); return {ok:true,lease:cur}; }); }
  withCurrent(id,generation,token,operation,now=Date.now()) { if(typeof operation!=="function") throw new Error("LEASE_OPERATION_REQUIRED"); return this._withLock(id,()=>{ const cur=read(this._file(id)); if(!this._validCurrent(cur,generation,token,now)) return {ok:false,reason:"STALE_FENCE"}; return {ok:true,lease:cur,value:operation(cur)}; }); }
  concludeWith(id,generation,token,status,resultRef,operation,now=Date.now()) { if(!["completed","failed","cancelled"].includes(status)) throw new Error("LEASE_TERMINAL_STATUS_INVALID"); if(typeof operation!=="function") throw new Error("LEASE_OPERATION_REQUIRED"); return this._withLock(id,()=>{ const file=this._file(id),cur=read(file); if(!this._validCurrent(cur,generation,token,now)) return {ok:false,reason:"STALE_FENCE"}; const value=operation(cur); cur.status=status; cur.heartbeat_at=iso(now); cur.expires_at=iso(now); cur.result_ref=resultRef; atomicWrite(file,cur); return {ok:true,lease:cur,value}; }); }
  conclude(id,generation,token,status,resultRef=null,now=Date.now()) { return this.concludeWith(id,generation,token,status,resultRef,()=>null,now); }
  recoverExpired(id,workerIdentity,now=Date.now()) { return this._withLock(id,()=>{ const file=this._file(id),cur=read(file); if(cur&&cur.status==="active"&&Date.parse(cur.expires_at)>now) return {claimed:false,reason:"LEASE_LIVE",lease:cur}; if(cur&&cur.status==="active") { cur.status="stale"; atomicWrite(file,cur); } const generation=(cur&&Number.isInteger(cur.generation)?cur.generation:0)+1; const lease={schema_version:2,assignment_id:id,generation,fence_token:this._token(),worker_identity:workerIdentity,status:"active",leased_at:iso(now),heartbeat_at:iso(now),expires_at:iso(now+this.ttlMs),result_ref:null}; atomicWrite(file,lease); return {claimed:true,lease}; }); }
  read(id){ return read(this._file(id)); }
}
module.exports={WorkerLeaseStore};
