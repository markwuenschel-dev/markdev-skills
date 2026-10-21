"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AttemptStore } = require("./attempt-store");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-store-"));
const first = new AttemptStore(root);
const a1 = first.begin("campaign", "task", { max_attempts: 2, worker_identity: "w1" });
assert.equal(a1.started, true);
assert.equal(a1.attempt.attempt_number, 1);
first.appendEvidence("campaign", "task", a1.attempt.attempt_id, { kind: "command", ref: "receipt-1" });
const retry = first.finish("campaign", "task", a1.attempt.attempt_id, { outcome: "retryable-failure", reason: "TEST_FAILED" });
assert.equal(retry.status, "retryable");

const resumed = new AttemptStore(root);
const a2 = resumed.begin("campaign", "task", { max_attempts: 2, worker_identity: "w2" });
assert.equal(a2.attempt.attempt_number, 2, "new process/store instance resumes durable attempt count");
const stop = resumed.finish("campaign", "task", a2.attempt.attempt_id, { outcome: "retryable-failure", reason: "TEST_FAILED_AGAIN" });
assert.equal(stop.status, "hard-stop");
assert.equal(stop.reason, "RETRY_BUDGET_EXHAUSTED");
assert.equal(resumed.begin("campaign", "task", { max_attempts: 2, worker_identity: "w3" }).reason, "RETRY_BUDGET_EXHAUSTED");

const ok = resumed.begin("campaign", "other", { max_attempts: 3, worker_identity: "w" });
resumed.finish("campaign", "other", ok.attempt.attempt_id, { outcome: "succeeded" });
assert.equal(resumed.begin("campaign", "other", { max_attempts: 3, worker_identity: "w" }).reason, "ALREADY_SUCCEEDED");
assert.equal(resumed.read("campaign", "task").attempts[0].evidence[0].ref, "receipt-1");
console.log("GREEN — durable attempts resume, preserve evidence, and hard-stop at retry budget");
