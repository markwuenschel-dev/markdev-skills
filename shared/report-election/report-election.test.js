"use strict";
const assert = require("node:assert/strict");
const { recommendLean, resolvePolicy, validateElectionRecord } = require("./report-election.js");

assert.equal(recommendLean({ finding_count: 1, report_cost: "low" }).lean, "skip");
assert.equal(recommendLean({ finding_count: 6, cross_cutting_count: 1, durable_review_value: true }).lean, "generate");
assert.equal(recommendLean({ finding_count: 20, parent_report_pending: true }).lean, "skip");
assert.equal(resolvePolicy({ policy: "generate" }).state, "elected-generate");
assert.equal(resolvePolicy({ policy: "skip" }).state, "elected-skip");
assert.equal(resolvePolicy({ policy: "inherit", report_owner: "repository-improvement-assessment" }).state, "inherited");
assert.throws(() => resolvePolicy({ policy: "inherit" }), /REPORT_OWNER_REQUIRED/);
const record = { schema_version:1, policy:"ask", report_owner:null, lean:"generate", reason:"useful", state:"pending-user-election" };
assert.deepEqual(validateElectionRecord(record), { ok:true, problems:[] });
console.log("REPORT_ELECTION_TEST_OK");
