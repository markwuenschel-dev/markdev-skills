"use strict";

const os = require("node:os");

function int(value, fallback = null, minimum = 1, maximum = 64) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) return fallback;
  return Math.min(parsed, maximum);
}

function hostParallelism() {
  const value = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : (os.cpus().length || 2);
  return Math.max(1, Number(value) || 1);
}

function resolveConcurrencyProfile(env = process.env, options = {}) {
  const host = int(options.host_parallelism, hostParallelism(), 1, 256);

  const configuredGlobal = int(env.REPOSITORY_ANALYSIS_MAX_WORKERS, null);
  const autoAgent = Math.min(32, Math.max(12, host * 2));
  const requestedAgent = Math.min(
    64,
    int(env.REPOSITORY_ANALYSIS_AGENT_WORKERS, configuredGlobal || autoAgent)
  );

  const global = Math.min(
    64,
    configuredGlobal || Math.max(requestedAgent, Math.min(32, Math.max(12, host * 2)))
  );
  const agent = Math.min(global, requestedAgent);

  const command = Math.min(
    global,
    int(env.REPOSITORY_ANALYSIS_COMMAND_WORKERS, Math.min(6, Math.max(2, Math.ceil(host / 2))))
  );

  const deterministic = Math.min(
    global,
    int(env.REPOSITORY_ANALYSIS_DETERMINISTIC_WORKERS, Math.min(12, Math.max(4, host)))
  );

  const synthesis = Math.min(
    global,
    int(env.REPOSITORY_ANALYSIS_SYNTHESIS_WORKERS, Math.min(4, Math.max(2, Math.ceil(host / 4))))
  );

  const report = Math.min(
    global,
    int(env.REPOSITORY_ANALYSIS_REPORT_WORKERS, 1)
  );

  const queueMultiplier = int(env.REPOSITORY_ANALYSIS_QUEUE_MULTIPLIER, 3, 1, 8);

  return Object.freeze({
    host_parallelism: host,
    global_worker_budget: global,
    queue_multiplier: queueMultiplier,
    target_ready_queue: Math.min(512, Math.max(agent, agent * queueMultiplier)),
    class_budgets: Object.freeze({
      agent,
      command,
      deterministic,
      synthesis,
      report,
      general: global
    })
  });
}

module.exports = { int, hostParallelism, resolveConcurrencyProfile };
