"use strict";
const assert = require("assert");
const path = require("path");
const { convert } = require("./retro-to-ledger.js");

const spine = path.join(__dirname, "..", "..", "shared", "candidate-ledger-spine", "ledger-verify.js");
const opts = { at: "2026-10-21T00:00:00Z", spine };
const scores = (o = {}) => ({ severity: 4, confidence: 4, leverage: 4, locality: 4, testability: 4, blast_radius: 2, regression_risk: 2, human_decision_risk: 1, ...o });
const finding = (o = {}) => ({
  title: "Agent claimed tests passed without running them",
  category: "verification",
  status: "confirmed",
  evidence: [{ file: "session.jsonl", line: 42, observation: "claim at turn 12, no test command before it" }],
  change: "Declare the final gate in .agentic/command-policy.",
  next_run_proof: "gate-runner check-completion blocks a claim with no receipt",
  owner: "production-flywheel",
  scores: scores(),
  effort: "S",
  ...o,
});

// valid conversion, verified by the spine itself
let r = convert({ session: "s.jsonl", findings: [finding(), finding({ title: "Policy fork", scores: scores({ human_decision_risk: 4 }), owner: "skillwright-forge" })] }, opts);
assert.ok(!r.errors, JSON.stringify(r.errors));
const [a, b] = r.ledger.candidates;
assert.strictEqual(a.candidate_id, "RETRO-001");
assert.strictEqual(a.rollup.priority_score, 20 - 5);
assert.strictEqual(a.status, "ready");
assert.strictEqual(a.candidate_lifecycle.discovered_by, "retro-mwdev");
assert.match(a.summary, /Next-run proof: gate-runner/);
assert.strictEqual(b.status, "needs-human-decision");
assert.strictEqual(b.rollup.execution_mode, "blocked-needs-human-decision");
assert.deepStrictEqual(r.queue, ["RETRO-001"], "judgment-heavy finding is kept out of the eligible queue");

// honesty: an unverified finding cannot claim high confidence
r = convert({ findings: [finding({ status: "unverified" })] }, opts);
assert.ok(r.errors.some((e) => /unverified finding may not score confidence above 2/.test(e)));
assert.ok(!convert({ findings: [finding({ status: "unverified", scores: scores({ confidence: 2 }) })] }, opts).errors);

// shape errors
assert.ok(convert({ findings: [finding({ category: "vibes" })] }, opts).errors.some((e) => /category/.test(e)));
assert.ok(convert({ findings: [finding({ evidence: [] })] }, opts).errors.some((e) => /evidence/.test(e)));
assert.ok(convert({ findings: [finding({ next_run_proof: "" })] }, opts).errors.some((e) => /next_run_proof/.test(e)));
assert.ok(convert({ findings: [finding({ scores: scores({ severity: 9 }) })] }, opts).errors.some((e) => /severity/.test(e)));
assert.ok(convert({}, opts).errors.some((e) => /findings array/.test(e)));
// duplicate ids are caught by the spine verifier, not re-implemented here
assert.ok(convert({ findings: [finding({ id: "R-1" }), finding({ id: "R-1" })] }, opts).errors.some((e) => /dup-id/.test(e)));
console.log("retro-to-ledger: all assertions passed");
