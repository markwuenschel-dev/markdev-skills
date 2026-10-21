"use strict";
const assert=require("node:assert/strict");
const test=require("node:test");
const { normalizeArchitectureFitness }=require("./architecture-fitness.js");
test("architecture fitness is a deterministic weighted repository score",()=>{
 const result=normalizeArchitectureFitness({confidence:.9,dimensions:{
  boundary_integrity:60,dependency_direction_cycle_control:80,cohesion_locality:70,interface_contract_clarity:90,
  state_data_ownership:80,change_containment_evolvability:70,duplication_competing_implementations:50,architectural_testability_observability:80
 }});
 assert.equal(result.score,72);
 assert.equal(result.grade,"C-");
 assert.equal(result.coverage,1);
});
// composite-scoring-v3 §12 test 1 (P1): one null dimension is unscored, so the
// remaining weight renormalizes: 80 over weight 90 is 80, not 80*90/100 = 72.
test("a null fitness dimension is absent and coverage counts only scored weight",()=>{
 const result=normalizeArchitectureFitness({confidence:null,dimensions:{
  boundary_integrity:80,dependency_direction_cycle_control:80,cohesion_locality:80,interface_contract_clarity:80,
  state_data_ownership:null,change_containment_evolvability:80,duplication_competing_implementations:80,architectural_testability_observability:80
 }});
 assert.equal(result.score,80);
 assert.equal(result.coverage,0.9);
 assert.equal(result.dimensions.state_data_ownership,null);
 assert.equal(result.confidence,null);
});
