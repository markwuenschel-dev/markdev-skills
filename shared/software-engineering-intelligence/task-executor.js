"use strict";

const os = require("node:os");
const { performance } = require("node:perf_hooks");

const RESOURCE_CLASSES = Object.freeze([
  "io_light",
  "io_git",
  "cpu_light",
  "cpu_heavy",
  "external_process",
  "memory_heavy",
  "network_adapter",
]);

const CONSTRUCTOR_KEYS = new Set([
  "maxWorkers",
  "resourceLimits",
  "groupLimits",
  "maxQueued",
  "maxMemoryWeight",
  "defaultTimeoutMs",
  "hostCapacity",
]);
const TASK_KEYS = new Set([
  "id",
  "resourceClass",
  "deterministicOrderKey",
  "dependencies",
  "timeoutMs",
  "memoryWeight",
  "concurrencyGroup",
  "run",
]);
const MAX_TIMER_MS = 2_147_483_647;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value > 0 && value <= maximum;
}

function isNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value);
}

function isNonblankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hostParallelism() {
  const detected = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, Number.isFinite(detected) ? Math.floor(detected) : 1);
}

function detectedHostCapacity() {
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  return {
    parallelism: hostParallelism(),
    totalMemoryBytes,
    freeMemoryBytes: Math.min(freeMemoryBytes, totalMemoryBytes),
  };
}

function validateHostCapacity(value) {
  if (!isRecord(value)) fail("FAIL-TASK-CONFIG", "hostCapacity must be a closed record");
  const keys = Object.keys(value);
  const expected = ["freeMemoryBytes", "parallelism", "totalMemoryBytes"];
  if (keys.length !== expected.length || keys.sort().some((key, index) => key !== expected[index])) {
    fail("FAIL-TASK-CONFIG", "hostCapacity must contain exactly parallelism, totalMemoryBytes, and freeMemoryBytes");
  }
  if (!isPositiveInteger(value.parallelism, 1024)) {
    fail("FAIL-TASK-CONFIG", "hostCapacity.parallelism must be an integer from 1 through 1024");
  }
  if (!isPositiveInteger(value.totalMemoryBytes) || !isNonnegativeInteger(value.freeMemoryBytes)) {
    fail("FAIL-TASK-CONFIG", "hostCapacity memory values must be safe nonnegative byte counts with positive total memory");
  }
  if (value.freeMemoryBytes > value.totalMemoryBytes) {
    fail("FAIL-TASK-CONFIG", "hostCapacity.freeMemoryBytes cannot exceed totalMemoryBytes");
  }
  return Object.freeze({
    parallelism: value.parallelism,
    totalMemoryBytes: value.totalMemoryBytes,
    freeMemoryBytes: value.freeMemoryBytes,
  });
}

function memoryPressure(capacity) {
  const freeRatio = capacity.freeMemoryBytes / capacity.totalMemoryBytes;
  if (capacity.freeMemoryBytes < 1024 ** 3 || freeRatio < 0.1) return "constrained";
  if (capacity.freeMemoryBytes < 4 * 1024 ** 3 || freeRatio < 0.25) return "balanced";
  return "abundant";
}

function automaticWorkerLimit(capacity, pressure) {
  if (pressure === "constrained") return Math.max(1, Math.min(4, capacity.parallelism));
  if (pressure === "balanced") {
    return Math.max(1, Math.min(16, Math.max(capacity.parallelism, Math.ceil(capacity.parallelism * 1.25))));
  }
  return Math.max(1, Math.min(32, Math.max(capacity.parallelism, Math.ceil(capacity.parallelism * 1.5))));
}

function automaticMemoryWeightLimit(pressure) {
  if (pressure === "constrained") return 2;
  if (pressure === "balanced") return 6;
  return 12;
}

function automaticResourceLimits(capacity, globalLimit, pressure) {
  const host = capacity.parallelism;
  const processSlots = Math.max(1, Math.floor(capacity.freeMemoryBytes / (768 * 1024 ** 2)));
  const heavySlots = Math.max(1, Math.floor(capacity.freeMemoryBytes / (2 * 1024 ** 3)));
  const cpuHeavyCeiling = pressure === "constrained" ? 1 : pressure === "balanced" ? 4 : 8;
  return {
    io_light: Math.min(globalLimit, Math.max(1, Math.min(16, host * 2))),
    io_git: Math.min(globalLimit, Math.max(1, Math.min(4, Math.ceil(host / 4)))),
    cpu_light: Math.min(globalLimit, Math.max(1, host)),
    cpu_heavy: Math.min(globalLimit, Math.max(1, Math.min(cpuHeavyCeiling, Math.floor(host * 0.75), processSlots))),
    external_process: Math.min(globalLimit, Math.max(1, Math.min(6, Math.ceil(host / 4), processSlots))),
    memory_heavy: Math.min(globalLimit, Math.max(1, Math.min(4, Math.floor(host / 4), heavySlots))),
    network_adapter: Math.min(globalLimit, Math.max(1, Math.min(16, host))),
  };
}

function validateLimitMap(value, label, { allowZero }) {
  if (!isRecord(value)) fail("FAIL-TASK-CONFIG", `${label} must be a closed record`);
  const output = Object.create(null);
  for (const [key, limit] of Object.entries(value)) {
    if (!isNonblankString(key)) fail("FAIL-TASK-CONFIG", `${label} names must be nonblank strings`);
    if (!(allowZero ? isNonnegativeInteger(limit) : isPositiveInteger(limit))) {
      fail("FAIL-TASK-CONFIG", `${label}.${key} must be ${allowZero ? "a nonnegative" : "a positive"} integer`);
    }
    output[key] = limit;
  }
  return output;
}

function compareTasks(left, right) {
  if (left.deterministicOrderKey < right.deterministicOrderKey) return -1;
  if (left.deterministicOrderKey > right.deterministicOrderKey) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function deterministicAdmissionCapacity(tasks, executor) {
  const classUse = Object.fromEntries(RESOURCE_CLASSES.map((name) => [name, 0]));
  const groupUse = new Map();
  let memoryUse = 0;
  let admitted = 0;
  for (const task of tasks) {
    if (admitted >= executor.workerLimit) break;
    const groupLimit = task.concurrencyGroup === null
      ? Number.MAX_SAFE_INTEGER
      : Object.hasOwn(executor.groupLimits, task.concurrencyGroup)
        ? executor.groupLimits[task.concurrencyGroup]
        : 1;
    if (
      classUse[task.resourceClass] >= executor.resourceLimits[task.resourceClass]
      || memoryUse + task.memoryWeight > executor.maxMemoryWeight
      || (task.concurrencyGroup !== null && (groupUse.get(task.concurrencyGroup) ?? 0) >= groupLimit)
    ) {
      continue;
    }
    classUse[task.resourceClass] += 1;
    if (task.concurrencyGroup !== null) {
      groupUse.set(task.concurrencyGroup, (groupUse.get(task.concurrencyGroup) ?? 0) + 1);
    }
    memoryUse += task.memoryWeight;
    admitted += 1;
  }
  return admitted;
}

class TaskExecutor {
  constructor(options = {}) {
    if (!isRecord(options)) fail("FAIL-TASK-CONFIG", "constructor options must be a closed record");
    for (const key of Object.keys(options)) {
      if (!CONSTRUCTOR_KEYS.has(key)) fail("FAIL-TASK-CONFIG", `unknown constructor option ${key}`);
    }

    const {
      maxWorkers = "auto",
      resourceLimits = null,
      groupLimits = {},
      maxQueued = 1024,
      maxMemoryWeight = "auto",
      defaultTimeoutMs = 300_000,
      hostCapacity = null,
    } = options;
    if (maxWorkers !== "auto" && !isPositiveInteger(maxWorkers, 32)) {
      fail("FAIL-TASK-CONFIG", "maxWorkers must be auto or an integer from 1 through 32");
    }
    if (!isNonnegativeInteger(maxQueued)) fail("FAIL-TASK-CONFIG", "maxQueued must be a nonnegative integer");
    if (maxMemoryWeight !== "auto" && !isPositiveInteger(maxMemoryWeight)) {
      fail("FAIL-TASK-CONFIG", "maxMemoryWeight must be auto or a positive integer");
    }
    if (!isPositiveInteger(defaultTimeoutMs, MAX_TIMER_MS)) {
      fail("FAIL-TASK-CONFIG", `defaultTimeoutMs must be an integer from 1 through ${MAX_TIMER_MS}`);
    }

    const resourceOverrides = resourceLimits === null
      ? {}
      : validateLimitMap(resourceLimits, "resourceLimits", { allowZero: true });
    for (const key of Object.keys(resourceOverrides)) {
      if (!RESOURCE_CLASSES.includes(key)) fail("FAIL-TASK-CONFIG", `unknown resource class ${key}`);
    }

    this.hostCapacity = validateHostCapacity(hostCapacity === null ? detectedHostCapacity() : hostCapacity);
    this.hostParallelism = this.hostCapacity.parallelism;
    this.memoryPressure = memoryPressure(this.hostCapacity);
    this.automaticWorkerLimit = automaticWorkerLimit(this.hostCapacity, this.memoryPressure);
    this.requestedWorkers = maxWorkers;
    this.workerLimit = maxWorkers === "auto" ? this.automaticWorkerLimit : maxWorkers;
    this.resourceLimits = Object.freeze({
      ...automaticResourceLimits(this.hostCapacity, this.workerLimit, this.memoryPressure),
      ...resourceOverrides,
    });
    this.groupLimits = Object.freeze(validateLimitMap(groupLimits, "groupLimits", { allowZero: false }));
    this.maxQueued = maxQueued;
    this.maxMemoryWeight = maxMemoryWeight === "auto" ? automaticMemoryWeightLimit(this.memoryPressure) : maxMemoryWeight;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async run(tasks, options = {}) {
    if (!isRecord(options) || Object.keys(options).some((key) => key !== "signal")) {
      fail("FAIL-TASK-GRAPH", "run options must be a closed record containing only signal");
    }
    const definitions = this.#validateGraph(tasks);
    const parentSignal = options.signal;
    if (parentSignal !== undefined && (
      parentSignal === null ||
      typeof parentSignal.aborted !== "boolean" ||
      typeof parentSignal.addEventListener !== "function" ||
      typeof parentSignal.removeEventListener !== "function"
    )) {
      fail("FAIL-TASK-GRAPH", "signal must be an AbortSignal");
    }
    const startedAt = performance.now();
    const workloadClassCounts = Object.fromEntries(RESOURCE_CLASSES.map((name) => [name, 0]));
    for (const task of definitions) workloadClassCounts[task.resourceClass] += 1;
    const workloadCapacity = RESOURCE_CLASSES.reduce(
      (total, name) => total + Math.min(workloadClassCounts[name], this.resourceLimits[name]),
      0,
    );
    const effectiveWorkers = definitions.length === 0
      ? 0
      : Math.min(this.workerLimit, definitions.length, workloadCapacity);
    const byId = new Map(definitions.map((task) => [task.id, task]));
    const dependents = new Map(definitions.map((task) => [task.id, []]));
    for (const task of definitions) {
      for (const dependency of task.dependencies) dependents.get(dependency).push(task.id);
    }
    const ready = [];
    const deferredReady = [];
    const pendingReadyIds = new Set();
    const running = new Map();
    const executionControls = new Map();
    const results = new Map();
    const taskTimings = new Map();
    const propagated = new Set();
    const classUse = Object.fromEntries(RESOURCE_CLASSES.map((name) => [name, 0]));
    const groupUse = new Map();
    let memoryUse = 0;
    let maxInFlight = 0;
    let maxQueued = 0;
    let peakMemoryWeight = 0;
    let batchCancelled = parentSignal?.aborted === true;

    const cancelRunning = () => {
      batchCancelled = true;
      for (const control of executionControls.values()) control.abort("cancelled");
    };
    parentSignal?.addEventListener("abort", cancelRunning, { once: true });

    const canStart = (task) => (
      running.size < effectiveWorkers &&
      classUse[task.resourceClass] < Math.min(this.resourceLimits[task.resourceClass], effectiveWorkers) &&
      memoryUse + task.memoryWeight <= this.maxMemoryWeight &&
      (task.concurrencyGroup === null || (groupUse.get(task.concurrencyGroup) ?? 0) < (
        Object.hasOwn(this.groupLimits, task.concurrencyGroup) ? this.groupLimits[task.concurrencyGroup] : 1
      ))
    );

    const enqueueReady = (task, readyAt) => {
      if (pendingReadyIds.has(task.id)) fail("FAIL-TASK-GRAPH", `task ${task.id} was made ready more than once`);
      pendingReadyIds.add(task.id);
      deferredReady.push({ ...task, readyAt });
    };

    const start = (task) => {
      classUse[task.resourceClass] += 1;
      if (task.concurrencyGroup !== null) groupUse.set(task.concurrencyGroup, (groupUse.get(task.concurrencyGroup) ?? 0) + 1);
      memoryUse += task.memoryWeight;
      maxInFlight = Math.max(maxInFlight, running.size + 1);
      peakMemoryWeight = Math.max(peakMemoryWeight, memoryUse);
      const taskStartedAt = performance.now();
      const controller = new AbortController();
      let abortCause = null;
      const abort = (cause) => {
        if (abortCause !== null) return;
        abortCause = cause;
        controller.abort(cause === "timed_out"
          ? new Error(`task ${task.id} timed out`)
          : parentSignal?.reason);
      };
      executionControls.set(task.id, { abort });
      const timer = setTimeout(() => abort("timed_out"), task.timeoutMs);
      const completion = Promise.resolve()
        .then(() => task.run({ signal: controller.signal }))
        .then(
          (value) => abortCause === "timed_out"
            ? { state: "timed_out", error: { code: "FAIL-TASK-TIMEOUT", message: `task ${task.id} timed out after ${task.timeoutMs} ms` } }
            : abortCause === "cancelled"
              ? { state: "cancelled", error: { code: "FAIL-TASK-CANCELLED", message: `task ${task.id} was cancelled` } }
              : { state: "succeeded", value },
          (error) => {
            if (abortCause === "timed_out") {
              return { state: "timed_out", error: { code: "FAIL-TASK-TIMEOUT", message: `task ${task.id} timed out after ${task.timeoutMs} ms` } };
            }
            if (abortCause === "cancelled") {
              return { state: "cancelled", error: { code: "FAIL-TASK-CANCELLED", message: error instanceof Error ? error.message : `task ${task.id} was cancelled` } };
            }
            return {
              state: "failed",
              error: {
                code: typeof error?.code === "string" ? error.code : "FAIL-TASK-RUN",
                message: error instanceof Error ? error.message : String(error),
              },
            };
          },
        )
        .then((outcome) => {
          const finishedAt = performance.now();
          clearTimeout(timer);
          executionControls.delete(task.id);
          classUse[task.resourceClass] -= 1;
          if (task.concurrencyGroup !== null) groupUse.set(task.concurrencyGroup, groupUse.get(task.concurrencyGroup) - 1);
          memoryUse -= task.memoryWeight;
          taskTimings.set(task.id, {
            queueWaitMs: Math.max(0, taskStartedAt - task.readyAt),
            workerBusyMs: Math.max(0, finishedAt - taskStartedAt),
          });
          const result = {
            id: task.id,
            deterministic_order_key: task.deterministicOrderKey,
            state: outcome.state,
            ...(outcome.state === "succeeded" ? { value: outcome.value } : { error: outcome.error }),
          };
          results.set(task.id, result);
          return task.id;
        });
      const trackedCompletion = completion.then((id) => {
        running.delete(id);
        return id;
      });
      running.set(task.id, trackedCompletion);
    };

    const scheduleReady = () => {
      const candidates = [...ready, ...deferredReady].sort(compareTasks);
      ready.length = 0;
      deferredReady.length = 0;
      while (candidates.length > 0 && running.size < effectiveWorkers) {
        const candidateIndex = candidates.findIndex((task) => canStart(task));
        if (candidateIndex === -1) break;
        const [candidate] = candidates.splice(candidateIndex, 1);
        pendingReadyIds.delete(candidate.id);
        start(candidate);
      }
      for (const candidate of candidates) {
        if (ready.length < this.maxQueued) ready.push(candidate);
        else deferredReady.push(candidate);
      }
    };

    for (const task of definitions) {
      if (task.dependencies.length === 0) enqueueReady(task, startedAt);
    }

    const cancelQueued = () => {
      const terminalAt = performance.now();
      for (const task of definitions) {
        if (results.has(task.id) || running.has(task.id)) continue;
        taskTimings.set(task.id, {
          queueWaitMs: Math.max(0, terminalAt - startedAt),
          workerBusyMs: 0,
        });
        results.set(task.id, {
          id: task.id,
          deterministic_order_key: task.deterministicOrderKey,
          state: "cancelled",
          error: {
            code: "FAIL-TASK-CANCELLED",
            message: `task ${task.id} was cancelled before it started`,
          },
        });
      }
      ready.length = 0;
      deferredReady.length = 0;
      pendingReadyIds.clear();
    };

    const propagateTerminals = () => {
      const queue = [...results.keys()].filter((id) => !propagated.has(id));
      while (queue.length > 0) {
        const completedId = queue.shift();
        if (propagated.has(completedId)) continue;
        propagated.add(completedId);
        for (const dependentId of dependents.get(completedId)) {
          if (results.has(dependentId) || running.has(dependentId) || pendingReadyIds.has(dependentId)) continue;
          const dependent = byId.get(dependentId);
          const dependencyResults = dependent.dependencies.map((id) => results.get(id));
          if (dependencyResults.some((result) => result === undefined)) continue;
          const failedDependencies = dependent.dependencies.filter((id, index) => dependencyResults[index] && dependencyResults[index].state !== "succeeded");
          if (failedDependencies.length > 0) {
            const terminalAt = performance.now();
            taskTimings.set(dependentId, {
              queueWaitMs: Math.max(0, terminalAt - startedAt),
              workerBusyMs: 0,
            });
            results.set(dependentId, {
              id: dependent.id,
              deterministic_order_key: dependent.deterministicOrderKey,
              state: "blocked",
              error: {
                code: "FAIL-TASK-BLOCKED",
                message: `blocked by ${failedDependencies.sort().join(", ")}`,
              },
            });
            queue.push(dependentId);
          } else if (dependencyResults.every((result) => result?.state === "succeeded")) {
            enqueueReady(dependent, performance.now());
          }
        }
      }
    };

    while (results.size < definitions.length) {
      propagateTerminals();
      if (batchCancelled) {
        cancelQueued();
      } else {
        scheduleReady();
      }
      maxQueued = Math.max(maxQueued, ready.length);
      if (results.size === definitions.length) break;
      if (running.size === 0) fail("FAIL-TASK-GRAPH", "valid task graph made no scheduling progress");
      await Promise.race(running.values());
    }
    propagateTerminals();
    parentSignal?.removeEventListener("abort", cancelRunning);

    const orderedResults = definitions.map((task) => results.get(task.id));
    const finishedAt = performance.now();
    const queueWaitMs = definitions.reduce((total, task) => total + taskTimings.get(task.id).queueWaitMs, 0);
    const workerBusyMs = definitions.reduce((total, task) => total + taskTimings.get(task.id).workerBusyMs, 0);
    const failures = orderedResults.filter((result) => result.state !== "succeeded").length;
    const cancellations = orderedResults.filter((result) => result.state === "cancelled").length;
    const effectiveResourceLimits = Object.fromEntries(
      Object.entries(this.resourceLimits).map(([name, limit]) => [name, Math.min(limit, effectiveWorkers)]),
    );
    return {
      status: cancellations > 0 ? "cancelled" : failures === 0 ? "succeeded" : "completed_with_failures",
      results: orderedResults,
      telemetry: {
        host_parallelism: this.hostParallelism,
        host_total_memory_bytes: this.hostCapacity.totalMemoryBytes,
        host_free_memory_bytes: this.hostCapacity.freeMemoryBytes,
        capacity_policy: "adaptive-host-v2",
        memory_pressure: this.memoryPressure,
        automatic_worker_limit: this.automaticWorkerLimit,
        requested_workers: this.requestedWorkers,
        effective_workers: effectiveWorkers,
        resource_limits: effectiveResourceLimits,
        tasks_submitted: definitions.length,
        tasks_completed: orderedResults.length,
        max_in_flight: maxInFlight,
        max_queued: maxQueued,
        peak_memory_weight: peakMemoryWeight,
        memory_weight_limit: this.maxMemoryWeight,
        queue_wait_ms: queueWaitMs,
        worker_busy_ms: workerBusyMs,
        wall_ms: Math.max(0, finishedAt - startedAt),
        retries: 0,
        timeouts: orderedResults.filter((result) => result.state === "timed_out").length,
        cancelled: cancellations,
        blocked: orderedResults.filter((result) => result.state === "blocked").length,
        serial_fallback: effectiveWorkers <= 1,
      },
    };
  }

  #validateGraph(tasks) {
    if (!Array.isArray(tasks)) fail("FAIL-TASK-GRAPH", "tasks must be an array containing one complete DAG");

    const byId = new Map();
    for (const candidate of tasks) {
      if (!isRecord(candidate)) fail("FAIL-TASK-GRAPH", "every task must be a closed record");
      for (const key of Object.keys(candidate)) {
        if (!TASK_KEYS.has(key)) fail("FAIL-TASK-GRAPH", `task contains unknown key ${key}`);
      }
      const {
        id,
        resourceClass,
        deterministicOrderKey,
        dependencies = [],
        timeoutMs = this.defaultTimeoutMs,
        memoryWeight = 1,
        concurrencyGroup = null,
        run,
      } = candidate;
      if (!isNonblankString(id) || byId.has(id)) fail("FAIL-TASK-GRAPH", "task IDs must be unique nonblank strings");
      if (!RESOURCE_CLASSES.includes(resourceClass)) fail("FAIL-TASK-GRAPH", `task ${id} has an unknown resource class`);
      if (!isNonblankString(deterministicOrderKey)) fail("FAIL-TASK-GRAPH", `task ${id} has an invalid deterministic order key`);
      if (!Array.isArray(dependencies) || dependencies.some((entry) => !isNonblankString(entry)) || new Set(dependencies).size !== dependencies.length) {
        fail("FAIL-TASK-GRAPH", `task ${id} has invalid dependencies`);
      }
      if (!isPositiveInteger(timeoutMs, MAX_TIMER_MS)) fail("FAIL-TASK-GRAPH", `task ${id} has an invalid timeout`);
      if (!isPositiveInteger(memoryWeight)) fail("FAIL-TASK-GRAPH", `task ${id} has an invalid memory weight`);
      if (concurrencyGroup !== null && !isNonblankString(concurrencyGroup)) fail("FAIL-TASK-GRAPH", `task ${id} has an invalid concurrency group`);
      if (typeof run !== "function") fail("FAIL-TASK-GRAPH", `task ${id} requires a run callback`);
      if (this.resourceLimits[resourceClass] === 0 || memoryWeight > this.maxMemoryWeight) {
        fail("FAIL-TASK-GRAPH", `task ${id} can never fit configured resource budgets`);
      }
      byId.set(id, {
        id,
        resourceClass,
        deterministicOrderKey,
        dependencies: [...dependencies],
        timeoutMs,
        memoryWeight,
        concurrencyGroup,
        run,
      });
    }

    for (const task of byId.values()) {
      for (const dependency of task.dependencies) {
        if (dependency === task.id) fail("FAIL-TASK-GRAPH", `task ${task.id} depends on itself`);
        if (!byId.has(dependency)) fail("FAIL-TASK-GRAPH", `task ${task.id} has missing dependency ${dependency}`);
      }
    }

    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
      if (visiting.has(id)) fail("FAIL-TASK-GRAPH", "task graph contains a dependency cycle");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id).dependencies) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of [...byId.keys()].sort()) visit(id);

    const definitions = [...byId.values()].sort(compareTasks);
    const readyDefinitions = definitions.filter((task) => task.dependencies.length === 0);
    const admissionCapacity = deterministicAdmissionCapacity(readyDefinitions, this);
    if (readyDefinitions.length > this.maxQueued + admissionCapacity) {
      fail("FAIL-TASK-GRAPH", "task graph exceeds maxQueued after resource admission bounds");
    }
    return definitions;
  }
}

module.exports = { RESOURCE_CLASSES, TaskExecutor };
