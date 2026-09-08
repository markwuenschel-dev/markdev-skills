"use strict";
const assert = require("node:assert/strict");
const { validate } = require("./runtime-contract.js");
const value = {
 schema_version:"assessment-runtime-contract@1", owner:"fixture", version:"1.0.0", entrypoint:"SKILL.md",
 input:{required:["baseline_ref"],optional:[]}, output:{kind:"fixture",schema:"fixture@1",immutable:true,reference_fields:["owner","artifact_id","sha256","repository_revision"]},
 authority:{owns:["fixture"],does_not_own:["routing"],source_repository_mutation:false},
 presentation:{supports_report:true,accepts_inherit:true,canonical_independent_of_report:true},
 verification:{consumes_shared_baseline:true,targeted_reverification_allowed:true},
 execution:{executor_class:"agent",flatten_under_ria:true,full_skill_read_by_parent:false}
};
assert.equal(validate(value).ok,true);
assert.throws(()=>validate({...value, execution:{...value.execution,full_skill_read_by_parent:true}}));
console.log("ASSESSMENT_RUNTIME_CONTRACT_OK");
