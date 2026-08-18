"use strict";

const assert = require("node:assert/strict");
const { resolveConcurrencyProfile } = require("./concurrency-profile.js");

{
  const p = resolveConcurrencyProfile({}, { host_parallelism: 8 });
  assert.equal(p.class_budgets.agent, 16);
  assert.ok(p.class_budgets.command < p.class_budgets.agent);
  assert.equal(p.queue_multiplier, 3);
  assert.equal(p.target_ready_queue, 48);
}

{
  const p = resolveConcurrencyProfile({
    REPOSITORY_ANALYSIS_MAX_WORKERS: "40",
    REPOSITORY_ANALYSIS_AGENT_WORKERS: "36",
    REPOSITORY_ANALYSIS_COMMAND_WORKERS: "5",
    REPOSITORY_ANALYSIS_QUEUE_MULTIPLIER: "4"
  }, { host_parallelism: 8 });
  assert.equal(p.global_worker_budget, 40);
  assert.equal(p.class_budgets.agent, 36);
  assert.equal(p.class_budgets.command, 5);
  assert.equal(p.target_ready_queue, 144);
}

{
  const p = resolveConcurrencyProfile({
    REPOSITORY_ANALYSIS_MAX_WORKERS: "999",
    REPOSITORY_ANALYSIS_AGENT_WORKERS: "999"
  }, { host_parallelism: 64 });
  assert.equal(p.global_worker_budget, 64);
  assert.equal(p.class_budgets.agent, 64);
}

{
  const p = resolveConcurrencyProfile({
    REPOSITORY_ANALYSIS_MAX_WORKERS: "20",
    REPOSITORY_ANALYSIS_AGENT_WORKERS: "36"
  }, { host_parallelism: 8 });
  assert.equal(p.global_worker_budget, 20);
  assert.equal(p.class_budgets.agent, 20, "class budget may not exceed explicit global ceiling");
}

console.log("GREEN — concurrency profile");
