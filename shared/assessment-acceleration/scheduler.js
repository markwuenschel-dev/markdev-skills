"use strict";

const os = require("node:os");
const { resolveConcurrencyProfile } = require("./concurrency-profile.js");

function integer(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function defaultWorkerBudget(env = process.env) {
  return resolveConcurrencyProfile(env).global_worker_budget;
}

function inferExecutorClass(task) {
  const explicit = typeof task.executor_class === "string" ? task.executor_class : "";
  if (explicit) return explicit;
  const kind = String(task.kind || "").toLowerCase();
  if (/(agent|evidence|explore|scout|lane)/.test(kind)) return "agent";
  if (/(command|test|lint|build|coverage|static-tool|typecheck)/.test(kind)) return "command";
  if (/(synth|merge|reconcile|compare)/.test(kind)) return "synthesis";
  if (/(report|render|compile)/.test(kind)) return "report";
  if (/(fingerprint|inventory|graph|cache|deterministic|parse|index)/.test(kind)) return "deterministic";
  return "general";
}

function resolveClassBudgets(options = {}, maxParallel) {
  const profile = resolveConcurrencyProfile(options.env || process.env);
  const supplied = options.classBudgets || options.class_budgets || {};
  const result = { ...profile.class_budgets, ...supplied };
  for (const [key, value] of Object.entries(result)) {
    const normalized = integer(value, null, 0);
    if (normalized === null) throw new Error("CLASS_BUDGET_INVALID:" + key);
    result[key] = Math.min(normalized, maxParallel);
  }
  result.general = Math.min(integer(result.general, maxParallel, 0), maxParallel);
  return Object.freeze(result);
}

function normalizeTask(task, maxParallel) {
  if (!task || typeof task !== "object" || typeof task.id !== "string" || !task.id.trim()) throw new Error("TASK_ID_INVALID");
  const depends = task.depends_on || task.dependsOn || [];
  const resources = task.resources || [];
  if (!Array.isArray(depends) || !depends.every(item => typeof item === "string" && item)) throw new Error("TASK_DEPENDENCIES_INVALID:" + task.id);
  if (!Array.isArray(resources) || !resources.every(item => typeof item === "string" && item)) throw new Error("TASK_RESOURCES_INVALID:" + task.id);
  const weight = integer(task.weight, 1);
  if (weight > maxParallel) throw new Error("TASK_WEIGHT_EXCEEDS_BUDGET:" + task.id);
  return Object.freeze({
    ...task,
    id: task.id.trim(),
    owner: typeof task.owner === "string" && task.owner ? task.owner : "unowned",
    kind: typeof task.kind === "string" && task.kind ? task.kind : "task",
    executor_class: inferExecutorClass(task),
    depends_on: [...new Set(depends)],
    resources: [...new Set(resources)],
    weight,
    priority: Number.isFinite(Number(task.priority)) ? Number(task.priority) : 0,
    expected_ms: Number.isFinite(Number(task.expected_ms)) && Number(task.expected_ms) > 0 ? Number(task.expected_ms) : 1,
    retries: integer(task.retries, 0, 0),
    timeout_ms: Number.isFinite(Number(task.timeout_ms)) && Number(task.timeout_ms) > 0 ? Number(task.timeout_ms) : null,
    retry_on_timeout: task.retry_on_timeout === true,
    allow_failed_dependencies: task.allow_failed_dependencies === true
  });
}

function normalizeTasks(tasks, maxParallel) {
  if (!Array.isArray(tasks)) throw new Error("TASKS_INVALID");
  const normalized = tasks.map(task => normalizeTask(task, maxParallel));
  const ids = new Set();
  for (const task of normalized) {
    if (ids.has(task.id)) throw new Error("TASK_ID_DUPLICATE:" + task.id);
    ids.add(task.id);
  }
  for (const task of normalized) for (const dependency of task.depends_on) if (!ids.has(dependency)) throw new Error("TASK_DEPENDENCY_UNKNOWN:" + task.id + ":" + dependency);
  validateAcyclic(normalized);
  return normalized;
}

function validateAcyclic(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const state = new Map();
  function visit(id, stack) {
    const current = state.get(id) || 0;
    if (current === 1) throw new Error("TASK_CYCLE:" + [...stack, id].join("->"));
    if (current === 2) return;
    state.set(id, 1);
    for (const dependency of byId.get(id).depends_on) visit(dependency, [...stack, id]);
    state.set(id, 2);
  }
  for (const task of tasks) visit(task.id, []);
}

function criticalPathScores(tasks) {
  const successors = new Map(tasks.map(task => [task.id, []]));
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) for (const dependency of task.depends_on) successors.get(dependency).push(task.id);
  const memo = new Map();
  function score(id) {
    if (memo.has(id)) return memo.get(id);
    const own = byId.get(id).expected_ms;
    const downstream = successors.get(id).length ? Math.max(...successors.get(id).map(score)) : 0;
    const value = own + downstream;
    memo.set(id, value);
    return value;
  }
  for (const task of tasks) score(task.id);
  return memo;
}

function sortReady(tasks, critical) {
  return [...tasks].sort((a, b) =>
    (critical.get(b.id) - critical.get(a.id)) ||
    (b.priority - a.priority) ||
    (b.weight - a.weight) ||
    a.id.localeCompare(b.id)
  );
}

function planWaves(rawTasks, options = {}) {
  const maxParallel = integer(options.maxParallel, defaultWorkerBudget(options.env));
  const classBudgets = resolveClassBudgets(options, maxParallel);
  const tasks = normalizeTasks(rawTasks, maxParallel);
  const critical = criticalPathScores(tasks);
  const pending = new Map(tasks.map(task => [task.id, task]));
  const completed = new Set();
  const waves = [];
  while (pending.size) {
    const ready = sortReady([...pending.values()].filter(task => task.depends_on.every(id => completed.has(id))), critical);
    if (!ready.length) throw new Error("TASK_PLAN_DEADLOCK");
    const resources = new Set();
    let used = 0;
    const usedByClass = {};
    const selected = [];
    for (const task of ready) {
      const classUsed = usedByClass[task.executor_class] || 0;
      const classBudget = classBudgets[task.executor_class] ?? classBudgets.general ?? maxParallel;
      if (used + task.weight > maxParallel) continue;
      if (classUsed + task.weight > classBudget) continue;
      if (task.resources.some(resource => resources.has(resource))) continue;
      selected.push(task);
      used += task.weight;
      usedByClass[task.executor_class] = classUsed + task.weight;
      for (const resource of task.resources) resources.add(resource);
    }
    if (!selected.length) throw new Error("TASK_PLAN_UNSCHEDULABLE:" + ready[0].id);
    waves.push(Object.freeze({ index: waves.length, weight: used, class_weight: Object.freeze({ ...usedByClass }), task_ids: selected.map(task => task.id) }));
    for (const task of selected) { pending.delete(task.id); completed.add(task.id); }
  }
  return Object.freeze({ max_parallel: maxParallel, class_budgets: classBudgets, waves });
}

function timeoutPromise(promise, timeoutMs, taskId, controller) {
  if (!timeoutMs) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      const error = new Error("TASK_TIMEOUT:" + taskId);
      error.code = "TASK_TIMEOUT";
      reject(error);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runTask(task, runner, onEvent) {
  const started = Date.now();
  let lastError = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= task.retries + 1; attempt += 1) {
    attempts = attempt;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    onEvent({ event: "task-attempt-started", task_id: task.id, attempt, at: new Date().toISOString() });
    try {
      const value = await timeoutPromise(Promise.resolve().then(() => runner(task, { attempt, signal: controller && controller.signal })), task.timeout_ms, task.id, controller);
      return { ok: true, value, attempts: attempt, elapsed_ms: Date.now() - started };
    } catch (error) {
      lastError = error;
      onEvent({ event: "task-attempt-failed", task_id: task.id, attempt, error: (error && error.message) || String(error), at: new Date().toISOString() });
      // A timed-out Promise cannot be forcibly stopped by JavaScript. Retrying it
      // is safe only when the task explicitly opts in and its runner honors the
      // AbortSignal before beginning another attempt.
      if (error && error.code === "TASK_TIMEOUT" && !task.retry_on_timeout) break;
    }
  }
  return { ok: false, error: lastError, attempts, elapsed_ms: Date.now() - started };
}

async function runPool(rawTasks, runner, options = {}) {
  if (typeof runner !== "function") throw new Error("TASK_RUNNER_INVALID");
  const maxParallel = integer(options.maxParallel, defaultWorkerBudget(options.env));
  const classBudgets = resolveClassBudgets(options, maxParallel);
  const tasks = normalizeTasks(rawTasks, maxParallel);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const critical = criticalPathScores(tasks);
  const status = new Map(tasks.map(task => [task.id, "pending"]));
  const results = new Map();
  const running = new Map();
  const activeResources = new Set();
  const events = [];
  const collectEvents = options.collectEvents === true;
  const onEvent = event => { if (collectEvents) events.push(event); if (typeof options.onEvent === "function") options.onEvent(event); };
  let used = 0;
  let peak = 0;
  const usedByClass = {};
  const peakByClass = {};
  const started = Date.now();

  function dependencyState(task) {
    const states = task.depends_on.map(id => status.get(id));
    if (states.some(value => value === "pending" || value === "running")) return "waiting";
    if (!task.allow_failed_dependencies && states.some(value => value === "failed" || value === "blocked")) return "blocked";
    return "ready";
  }

  function release(task) {
    used -= task.weight;
    usedByClass[task.executor_class] = Math.max(0, (usedByClass[task.executor_class] || 0) - task.weight);
    for (const resource of task.resources) activeResources.delete(resource);
  }

  function start(task) {
    status.set(task.id, "running");
    used += task.weight;
    usedByClass[task.executor_class] = (usedByClass[task.executor_class] || 0) + task.weight;
    peak = Math.max(peak, used);
    peakByClass[task.executor_class] = Math.max(peakByClass[task.executor_class] || 0, usedByClass[task.executor_class]);
    for (const resource of task.resources) activeResources.add(resource);
    onEvent({ event: "task-started", task_id: task.id, owner: task.owner, kind: task.kind, executor_class: task.executor_class, at: new Date().toISOString() });
    const promise = runTask(task, runner, onEvent).then(outcome => {
      release(task);
      running.delete(task.id);
      if (outcome.ok) {
        status.set(task.id, "success");
        results.set(task.id, { status: "success", value: outcome.value, attempts: outcome.attempts, elapsed_ms: outcome.elapsed_ms });
        onEvent({ event: "task-completed", task_id: task.id, elapsed_ms: outcome.elapsed_ms, at: new Date().toISOString() });
      } else {
        status.set(task.id, "failed");
        results.set(task.id, { status: "failed", error: (outcome.error && outcome.error.message) || String(outcome.error), attempts: outcome.attempts, elapsed_ms: outcome.elapsed_ms });
        onEvent({ event: "task-failed", task_id: task.id, elapsed_ms: outcome.elapsed_ms, error: results.get(task.id).error, at: new Date().toISOString() });
      }
      return task.id;
    });
    running.set(task.id, promise);
  }

  while ([...status.values()].some(value => value === "pending" || value === "running")) {
    for (const task of tasks) {
      if (status.get(task.id) !== "pending") continue;
      if (dependencyState(task) === "blocked") {
        status.set(task.id, "blocked");
        results.set(task.id, { status: "blocked", reason: "dependency-failed" });
        onEvent({ event: "task-blocked", task_id: task.id, reason: "dependency-failed", at: new Date().toISOString() });
      }
    }

    const ready = sortReady(tasks.filter(task => status.get(task.id) === "pending" && dependencyState(task) === "ready"), critical);
    let admitted = false;
    for (const task of ready) {
      const classBudget = classBudgets[task.executor_class] ?? classBudgets.general ?? maxParallel;
      if (used + task.weight > maxParallel) continue;
      if ((usedByClass[task.executor_class] || 0) + task.weight > classBudget) continue;
      if (task.resources.some(resource => activeResources.has(resource))) continue;
      start(task);
      admitted = true;
    }

    if (running.size) {
      if (!admitted || used >= maxParallel) await Promise.race(running.values());
      continue;
    }

    const pending = tasks.filter(task => status.get(task.id) === "pending");
    if (pending.length) {
      for (const task of pending) {
        status.set(task.id, "blocked");
        results.set(task.id, { status: "blocked", reason: "scheduler-deadlock" });
      }
    }
  }

  const elapsed = Date.now() - started;
  const serialEstimate = [...results.values()].reduce((sum, result) => sum + (result.elapsed_ms || 0), 0);
  const output = Object.fromEntries(tasks.map(task => [task.id, results.get(task.id)]));
  return Object.freeze({
    ok: tasks.every(task => output[task.id] && output[task.id].status === "success"),
    max_parallel: maxParallel,
    class_budgets: classBudgets,
    peak_concurrency: peak,
    peak_by_class: Object.freeze({ ...peakByClass }),
    wall_elapsed_ms: elapsed,
    serial_estimate_ms: serialEstimate,
    speedup_estimate: elapsed > 0 ? serialEstimate / elapsed : null,
    results: output,
    events
  });
}

async function runThreadPool(items, worker, options = {}) {
  if (!Array.isArray(items)) throw new Error("POOL_ITEMS_INVALID");
  const executorClass = typeof options.executorClass === "string" ? options.executorClass : "agent";
  const tasks = items.map((item, index) => ({ id: "item-" + index, kind: "pool-item", executor_class: executorClass, payload: item }));
  const result = await runPool(tasks, task => worker(task.payload, Number(task.id.slice(5))), options);
  return items.map((_, index) => result.results["item-" + index]);
}

if (require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const command = process.argv[2];
  if (command === "plan" && process.argv[3]) {
    const input = JSON.parse(fs.readFileSync(path.resolve(process.argv[3]), "utf8"));
    const tasks = Array.isArray(input) ? input : input.tasks;
    const configured = process.argv[4] === undefined ? (Array.isArray(input) ? undefined : input.max_parallel) : Number(process.argv[4]);
    const classBudgets = Array.isArray(input) ? undefined : input.class_budgets;
    console.log(JSON.stringify(planWaves(tasks, { ...(configured === undefined ? {} : { maxParallel: configured }), ...(classBudgets ? { classBudgets } : {}) }), null, 2));
  } else {
    console.error("usage: node scheduler.js plan <task-graph.json> [max-parallel]");
    process.exitCode = 2;
  }
}

module.exports = { defaultWorkerBudget, inferExecutorClass, resolveClassBudgets, normalizeTasks, criticalPathScores, planWaves, runPool, runThreadPool };
