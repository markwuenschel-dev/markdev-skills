"use strict";
const assert=require("assert"); const {ExecutorPool}=require("./runtime");
let n=0; const ok=(m)=>{n++; console.log("ok  "+m)};

{
 const p=new ExecutorPool({budgets:{read_only:4,implementation:2,validation:2,integration:1,publication:1},resource_capacities:{repo:2}});
 p.submit({job_id:"A",scope_id:"c",class:"implementation",dependencies:[],resources:[{id:"repo",mode:"shared",permits:1}],priority:1,executor_depth:1,mutating:true});
 p.submit({job_id:"B",scope_id:"c",class:"implementation",dependencies:[],resources:[{id:"repo",mode:"shared",permits:1}],priority:1,executor_depth:1,mutating:true});
 p.submit({job_id:"C",scope_id:"c",class:"implementation",dependencies:["A"],resources:[{id:"repo",mode:"shared",permits:1}],priority:2,executor_depth:1,mutating:true});
 assert.deepStrictEqual(p.schedule().sort(),["A","B"]); ok("bounded implementation pool admits two ready jobs");
 p.complete("A"); assert.deepStrictEqual(p.schedule(),["C"]); ok("as-completed refill/work stealing admits newly ready C while B still runs");
}
{
 const p=new ExecutorPool({budgets:{implementation:3},resource_capacities:{db:4}});
 p.submit({job_id:"A",scope_id:"c",class:"implementation",dependencies:[],resources:[{id:"db",mode:"exclusive",permits:1}],priority:2,executor_depth:1,mutating:true});
 p.submit({job_id:"B",scope_id:"c",class:"implementation",dependencies:[],resources:[{id:"db",mode:"shared",permits:1}],priority:1,executor_depth:1,mutating:true});
 assert.deepStrictEqual(p.schedule(),["A"]); ok("exclusive semaphore serializes a conflicting resource despite spare workers");
}
{
 const p=new ExecutorPool({budgets:{implementation:2}});
 p.submit({job_id:"A",scope_id:"c",class:"implementation",dependencies:[],resources:[],priority:1,executor_depth:1,mutating:true});
 p.submit({job_id:"B",scope_id:"c",class:"implementation",dependencies:["A"],resources:[],priority:1,executor_depth:1,mutating:true});
 p.schedule(); p.fail("A"); const s=Object.fromEntries(p.snapshot().map(x=>[x.job_id,x.status])); assert.equal(s.B,"BLOCKED"); ok("failed dependency blocks downstream job rather than guessing around DAG");
}
{
 const p=new ExecutorPool(); assert.throws(()=>p.submit({job_id:"X",scope_id:"c",class:"implementation",dependencies:[],resources:[],priority:0,executor_depth:2,mutating:true}),/NESTED_MUTATING_EXECUTOR_FORBIDDEN/); ok("nested mutating executor is rejected");
}
{
 const p=new ExecutorPool({budgets:{read_only:1}}); p.submit({job_id:"A",scope_id:"c",class:"read_only",dependencies:[],resources:[],priority:0,executor_depth:2,mutating:false}); p.submit({job_id:"B",scope_id:"c",class:"read_only",dependencies:[],resources:[],priority:0,executor_depth:2,mutating:false}); p.schedule(); const r=p.cancelScope("c"); assert.deepStrictEqual(r.cancel_requests,["A"]); assert.deepStrictEqual(r.cancelled,["B"]); ok("structured cancellation requests running child stop and cancels queued child");
}
console.log(`GREEN — ${n}/${n}`);
