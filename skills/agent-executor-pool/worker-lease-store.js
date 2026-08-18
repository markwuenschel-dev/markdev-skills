"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

function atomicWrite(file, value) { fs.mkdirSync(path.dirname(file), {recursive:true}); const tmp=file+".tmp-"+process.pid+"-"+crypto.randomBytes(4).toString("hex"); fs.writeFileSync(tmp, JSON.stringify(value,null,2)+"\n"); fs.renameSync(tmp,file); }
function read(file) { try { return JSON.parse(fs.readFileSync(file,"utf8")); } catch (_) { return null; } }
function iso(ms) { return new Date(ms).toISOString(); }

class WorkerLeaseStore {
  constructor(stateDir, options={}) { this.stateDir=stateDir; this.ttlMs=Number(options.ttl_ms || 120000); fs.mkdirSync(stateDir,{recursive:true}); }
  _file(id){ return path.join(this.stateDir, encodeURIComponent(id)+".json"); }
  _token(){ return crypto.randomBytes(24).toString("hex"); }
  _validCurrent(cur,generation,token){ return cur && cur.generation===generation && cur.fence_token===token && cur.status==="active"; }
  claim(assignmentId, workerIdentity, now=Date.now()) {
    const file=this._file(assignmentId), cur=read(file);
    if (cur && cur.status==="active" && Date.parse(cur.expires_at)>now) return {claimed:false, reason:"LEASE_LIVE", lease:cur};
    const generation=(cur && Number.isInteger(cur.generation) ? cur.generation : 0)+1;
    const lease={schema_version:1,assignment_id:assignmentId,generation,fence_token:this._token(),worker_identity:workerIdentity,status:"active",leased_at:iso(now),heartbeat_at:iso(now),expires_at:iso(now+this.ttlMs),result_ref:null};
    atomicWrite(file,lease); return {claimed:true,lease};
  }
  heartbeat(id,generation,token,now=Date.now()) { const file=this._file(id),cur=read(file); if(!this._validCurrent(cur,generation,token)) return {ok:false,reason:"STALE_FENCE"}; cur.heartbeat_at=iso(now); cur.expires_at=iso(now+this.ttlMs); atomicWrite(file,cur); return {ok:true,lease:cur}; }
  conclude(id,generation,token,status,resultRef=null,now=Date.now()) { if(!["completed","failed","cancelled"].includes(status)) throw new Error("LEASE_TERMINAL_STATUS_INVALID"); const file=this._file(id),cur=read(file); if(!this._validCurrent(cur,generation,token)) return {ok:false,reason:"STALE_FENCE"}; cur.status=status; cur.heartbeat_at=iso(now); cur.expires_at=iso(now); cur.result_ref=resultRef; atomicWrite(file,cur); return {ok:true,lease:cur}; }
  recoverExpired(id,workerIdentity,now=Date.now()) { const file=this._file(id),cur=read(file); if(!cur) return this.claim(id,workerIdentity,now); if(cur.status==="active" && Date.parse(cur.expires_at)>now) return {claimed:false,reason:"LEASE_LIVE",lease:cur}; if(cur.status==="active") { cur.status="stale"; atomicWrite(file,cur); } return this.claim(id,workerIdentity,now); }
  read(id){ return read(this._file(id)); }
}
module.exports={WorkerLeaseStore};
