"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { RESOURCE_CLASSES, TaskExecutor } = require("./task-executor.js");

function task(id, overrides = {}) {
  return {
    id,
    resourceClass: "io_light",
    deterministicOrderKey: id,
    run: async () => id,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not observed");
}

async function observePeak(executor, definitions, expectedPeak) {
  const release = deferred();
  let active = 0;
  let peak = 0;
  const run = executor.run(definitions.map((definition) => task(definition.id, {
    ...definition,
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
      return definition.id;
    },
  })));
  await waitFor(() => active === expectedPeak);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, expectedPeak);
  release.resolve();
  return run;
}

test("TaskExecutor rejects every malformed DAG before any task callback starts", async () => {
  let callbacks = 0;
  const counted = (id, overrides = {}) => task(id, {
    run: async () => {
      callbacks += 1;
      return id;
    },
    ...overrides,
  });
  const cases = [
    [new TaskExecutor(), [counted("duplicate"), counted("duplicate")]],
    [new TaskExecutor(), [counted(" ")]],
    [new TaskExecutor(), [counted("missing", { dependencies: ["absent"] })]],
    [new TaskExecutor(), [counted("self", { dependencies: ["self"] })]],
    [new TaskExecutor(), [counted("a", { dependencies: ["b"] }), counted("b", { dependencies: ["a"] })]],
    [new TaskExecutor(), [counted("unknown-key", { surprise: true })]],
    [new TaskExecutor(), [counted("unknown-class", { resourceClass: "network_magic" })]],
    [new TaskExecutor(), [counted("bad-timeout", { timeoutMs: 0 })]],
    [new TaskExecutor(), [counted("bad-weight", { memoryWeight: 0 })]],
    [new TaskExecutor(), [counted("bad-order", { deterministicOrderKey: "" })]],
    [new TaskExecutor(), [counted("bad-group", { concurrencyGroup: "" })]],
    [new TaskExecutor({ maxWorkers: 1, maxQueued: 0 }), [counted("over-a"), counted("over-b")]],
    [new TaskExecutor({ resourceLimits: { io_light: 0 } }), [counted("never-fit")]],
    [new TaskExecutor({ maxMemoryWeight: 1 }), [counted("never-fit-memory", { memoryWeight: 2 })]],
  ];

  for (const [executor, graph] of cases) {
    await assert.rejects(
      executor.run(graph),
      (error) => error?.code === "FAIL-TASK-GRAPH",
    );
  }
  assert.equal(callbacks, 0);
});

test("TaskExecutor admits work only within global, class, group, and memory limits", async () => {
  const fourTasks = ["a", "b", "c", "d"].map((id) => ({ id }));
  const global = await observePeak(
    new TaskExecutor({ maxWorkers: 2, resourceLimits: { io_light: 4 } }),
    fourTasks,
    2,
  );
  assert.equal(global.telemetry.max_in_flight, 2);

  const resourceClass = await observePeak(
    new TaskExecutor({ maxWorkers: 4, resourceLimits: { io_light: 2 } }),
    fourTasks,
    2,
  );
  assert.equal(resourceClass.telemetry.max_in_flight, 2);

  const group = await observePeak(
    new TaskExecutor({ maxWorkers: 4, resourceLimits: { io_light: 4 }, groupLimits: { repository: 1 } }),
    fourTasks.map((definition) => ({ ...definition, concurrencyGroup: "repository" })),
    1,
  );
  assert.equal(group.telemetry.max_in_flight, 1);

  const prototypeNamedLimits = Object.create(null);
  prototypeNamedLimits.__proto__ = 1;
  const prototypeNamedGroup = await observePeak(
    new TaskExecutor({ maxWorkers: 2, resourceLimits: { io_light: 2 }, groupLimits: prototypeNamedLimits }),
    fourTasks.slice(0, 2).map((definition) => ({ ...definition, concurrencyGroup: "__proto__" })),
    1,
  );
  assert.equal(prototypeNamedGroup.telemetry.max_in_flight, 1);

  const memory = await observePeak(
    new TaskExecutor({ maxWorkers: 4, resourceLimits: { io_light: 4 }, maxMemoryWeight: 3 }),
    fourTasks.map((definition) => ({ ...definition, memoryWeight: 2 })),
    1,
  );
  assert.equal(memory.telemetry.max_in_flight, 1);
  assert.equal(memory.telemetry.peak_memory_weight, 2);
});

test("TaskExecutor applies maxQueued after class, group, and memory admission bounds", async () => {
  let callbacks = 0;
  const counted = (id, overrides = {}) => task(id, {
    run: async () => {
      callbacks += 1;
      return id;
    },
    ...overrides,
  });
  const cases = [
    [
      new TaskExecutor({
        maxWorkers: 3,
        resourceLimits: { io_light: 3 },
        maxQueued: 2,
        maxMemoryWeight: 3,
      }),
      [
        counted("future", { deterministicOrderKey: "00", dependencies: ["heavy"] }),
        counted("heavy", { deterministicOrderKey: "10", memoryWeight: 3 }),
        counted("light-a", { deterministicOrderKey: "20" }),
        counted("light-b", { deterministicOrderKey: "30" }),
        counted("light-c", { deterministicOrderKey: "40" }),
      ],
    ],
    [
      new TaskExecutor({ maxWorkers: 4, resourceLimits: { io_light: 1 }, maxQueued: 0 }),
      [counted("class-a"), counted("class-b")],
    ],
    [
      new TaskExecutor({ maxWorkers: 4, resourceLimits: { io_light: 4 }, maxMemoryWeight: 2, maxQueued: 0 }),
      [counted("memory-a", { memoryWeight: 2 }), counted("memory-b", { memoryWeight: 2 })],
    ],
    [
      new TaskExecutor({
        maxWorkers: 4,
        resourceLimits: { io_light: 4 },
        groupLimits: { repository: 1 },
        maxQueued: 0,
      }),
      [
        counted("group-a", { concurrencyGroup: "repository" }),
        counted("group-b", { concurrencyGroup: "repository" }),
      ],
    ],
  ];

  for (const [executor, graph] of cases) {
    await assert.rejects(
      executor.run(graph),
      (error) => error?.code === "FAIL-TASK-GRAPH" && /maxQueued/.test(error.message),
    );
  }
  assert.equal(callbacks, 0);
});

test("TaskExecutor applies maxQueued after a completed dependency releases a wide fan-out", async () => {
  const report = await new TaskExecutor({
    maxWorkers: 1,
    resourceLimits: { io_light: 1 },
    maxQueued: 0,
  }).run([
    task("root", { deterministicOrderKey: "00" }),
    task("dependent-a", { deterministicOrderKey: "10", dependencies: ["root"] }),
    task("dependent-b", { deterministicOrderKey: "20", dependencies: ["root"] }),
    task("dependent-c", { deterministicOrderKey: "30", dependencies: ["root"] }),
  ]);

  assert.equal(report.status, "succeeded");
  assert.equal(report.telemetry.max_queued, 0);
  assert.deepEqual(report.results.map(({ id, state }) => ({ id, state })), [
    { id: "root", state: "succeeded" },
    { id: "dependent-a", state: "succeeded" },
    { id: "dependent-b", state: "succeeded" },
    { id: "dependent-c", state: "succeeded" },
  ]);
});

test("TaskExecutor releases successful dependents, continues independent work, and blocks failed descendants", async () => {
  const events = [];
  const report = await new TaskExecutor({ maxWorkers: 3 }).run([
    task("root", {
      deterministicOrderKey: "10",
      run: async () => {
        events.push("root:run");
        return "root-value";
      },
    }),
    task("dependent", {
      deterministicOrderKey: "20",
      dependencies: ["root"],
      run: async () => {
        events.push("dependent:run");
        assert.ok(events.includes("root:run"));
        return "dependent-value";
      },
    }),
    task("failure", {
      deterministicOrderKey: "30",
      run: async () => {
        events.push("failure:run");
        throw Object.assign(new Error("planned failure"), { code: "E_PLANNED" });
      },
    }),
    task("blocked", {
      deterministicOrderKey: "40",
      dependencies: ["failure"],
      run: async () => assert.fail("blocked task must not run"),
    }),
    task("blocked-descendant", {
      deterministicOrderKey: "50",
      dependencies: ["blocked"],
      run: async () => assert.fail("blocked descendant must not run"),
    }),
    task("independent", {
      deterministicOrderKey: "60",
      run: async () => {
        events.push("independent:run");
        return "independent-value";
      },
    }),
  ]);

  assert.equal(report.status, "completed_with_failures");
  assert.deepEqual(report.results.map(({ id, state }) => ({ id, state })), [
    { id: "root", state: "succeeded" },
    { id: "dependent", state: "succeeded" },
    { id: "failure", state: "failed" },
    { id: "blocked", state: "blocked" },
    { id: "blocked-descendant", state: "blocked" },
    { id: "independent", state: "succeeded" },
  ]);
  assert.deepEqual(report.results.find(({ id }) => id === "failure").error, {
    code: "E_PLANNED",
    message: "planned failure",
  });
  assert.equal(report.telemetry.blocked, 2);
  assert.equal(report.telemetry.tasks_completed, 6);
  assert.ok(events.includes("independent:run"));
});

test("TaskExecutor materializes terminal results by deterministic key and ID, not completion order", async () => {
  assert.deepEqual(RESOURCE_CLASSES, [
    "io_light",
    "io_git",
    "cpu_light",
    "cpu_heavy",
    "external_process",
    "memory_heavy",
    "network_adapter",
  ]);
  const releases = new Map([
    ["z", deferred()],
    ["a", deferred()],
    ["m", deferred()],
  ]);
  let started = 0;
  const run = new TaskExecutor({ maxWorkers: 3 }).run([
    task("z", { deterministicOrderKey: "20", run: async () => { started += 1; return releases.get("z").promise; } }),
    task("a", { deterministicOrderKey: "20", run: async () => { started += 1; return releases.get("a").promise; } }),
    task("m", { deterministicOrderKey: "10", run: async () => { started += 1; return releases.get("m").promise; } }),
  ]);
  await waitFor(() => started === 3);
  releases.get("z").resolve("z-value");
  await new Promise((resolve) => setImmediate(resolve));
  releases.get("a").resolve("a-value");
  await new Promise((resolve) => setImmediate(resolve));
  releases.get("m").resolve("m-value");

  const report = await run;
  assert.deepEqual(report.results.map(({ id, value }) => ({ id, value })), [
    { id: "m", value: "m-value" },
    { id: "a", value: "a-value" },
    { id: "z", value: "z-value" },
  ]);
});

test("TaskExecutor keeps serial and concurrent outcomes identical and runtime timing noncanonical", async () => {
  const definitions = [
    task("third", { deterministicOrderKey: "30", run: async () => ({ observed: "third" }) }),
    task("first", { deterministicOrderKey: "10", run: async () => ({ observed: "first" }) }),
    task("second", { deterministicOrderKey: "20", run: async () => ({ observed: "second" }) }),
  ];
  const serial = await new TaskExecutor({ maxWorkers: 1 }).run(definitions);
  const concurrent = await new TaskExecutor({ maxWorkers: 3 }).run(definitions);

  assert.deepEqual(serial.results, concurrent.results);
  assert.deepEqual(serial.results.map((result) => Object.keys(result)), [
    ["id", "deterministic_order_key", "state", "value"],
    ["id", "deterministic_order_key", "state", "value"],
    ["id", "deterministic_order_key", "state", "value"],
  ]);
  assert.equal(serial.telemetry.serial_fallback, true);
  assert.equal(concurrent.telemetry.serial_fallback, false);
  assert.equal(serial.telemetry.max_in_flight, 1);
  assert.equal(concurrent.telemetry.max_in_flight, 3);
});

test("TaskExecutor waits for every fan-in dependency before materializing a deterministic blocked result", async () => {
  const runWithFailureOrder = async (firstFailure) => {
    const gates = new Map([["a", deferred()], ["b", deferred()]]);
    let started = 0;
    const run = new TaskExecutor({ maxWorkers: 2 }).run([
      task("a", {
        deterministicOrderKey: "10",
        run: async () => {
          started += 1;
          await gates.get("a").promise;
          throw Object.assign(new Error("a failed"), { code: "E_A" });
        },
      }),
      task("b", {
        deterministicOrderKey: "20",
        run: async () => {
          started += 1;
          await gates.get("b").promise;
          throw Object.assign(new Error("b failed"), { code: "E_B" });
        },
      }),
      task("child", {
        deterministicOrderKey: "30",
        dependencies: ["a", "b"],
        run: async () => assert.fail("blocked fan-in child must not run"),
      }),
    ]);
    await waitFor(() => started === 2);
    gates.get(firstFailure).resolve();
    await new Promise((resolve) => setImmediate(resolve));
    gates.get(firstFailure === "a" ? "b" : "a").resolve();
    return run;
  };

  const aThenB = await runWithFailureOrder("a");
  const bThenA = await runWithFailureOrder("b");
  assert.deepEqual(aThenB.results, bThenA.results);
  assert.deepEqual(aThenB.results.find(({ id }) => id === "child").error, {
    code: "FAIL-TASK-BLOCKED",
    message: "blocked by a, b",
  });
});

test("TaskExecutor times out locally, blocks descendants, and awaits cooperative cleanup", async () => {
  let cleanupComplete = false;
  let dependentStarted = false;
  const report = await new TaskExecutor({ maxWorkers: 2 }).run([
    task("slow", {
      deterministicOrderKey: "10",
      timeoutMs: 5,
      run: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          setImmediate(() => {
            cleanupComplete = true;
            resolve("late-success-must-not-win");
          });
        }, { once: true });
      }),
    }),
    task("dependent", {
      deterministicOrderKey: "20",
      dependencies: ["slow"],
      run: async () => {
        dependentStarted = true;
      },
    }),
    task("independent", { deterministicOrderKey: "30", run: async () => "still-ran" }),
  ]);

  assert.equal(cleanupComplete, true);
  assert.equal(dependentStarted, false);
  assert.deepEqual(report.results.map(({ id, state }) => ({ id, state })), [
    { id: "slow", state: "timed_out" },
    { id: "dependent", state: "blocked" },
    { id: "independent", state: "succeeded" },
  ]);
  assert.equal(report.results[0].error.code, "FAIL-TASK-TIMEOUT");
  assert.equal(report.telemetry.timeouts, 1);
  assert.equal(report.telemetry.blocked, 1);
});

test("TaskExecutor cancellation aborts running work, never starts queued work, and waits for cleanup", async () => {
  const controller = new AbortController();
  const running = deferred();
  const cleanup = deferred();
  let callbacks = 0;
  let observedAbort = false;
  const run = new TaskExecutor({ maxWorkers: 1 }).run([
    task("running", {
      deterministicOrderKey: "10",
      run: async ({ signal }) => {
        callbacks += 1;
        running.resolve();
        await new Promise((resolve) => signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true }));
        await cleanup.promise;
        return "late-success-must-not-win";
      },
    }),
    task("queued", {
      deterministicOrderKey: "20",
      run: async () => {
        callbacks += 1;
        return "must-not-run";
      },
    }),
  ], { signal: controller.signal });

  await running.promise;
  controller.abort(new Error("stop requested"));
  await waitFor(() => observedAbort);
  let returned = false;
  run.then(() => { returned = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false, "run must wait for cooperative task cleanup");
  cleanup.resolve();
  const report = await run;

  assert.equal(callbacks, 1);
  assert.equal(report.status, "cancelled");
  assert.deepEqual(report.results.map(({ id, state }) => ({ id, state })), [
    { id: "running", state: "cancelled" },
    { id: "queued", state: "cancelled" },
  ]);
  assert.equal(report.telemetry.cancelled, 2);

  const preAborted = new AbortController();
  preAborted.abort();
  const preAbortedReport = await new TaskExecutor().run([
    task("never-started", { run: async () => { callbacks += 1; } }),
  ], { signal: preAborted.signal });
  assert.equal(callbacks, 1);
  assert.equal(preAbortedReport.status, "cancelled");
  assert.equal(preAbortedReport.results[0].state, "cancelled");
});

test("TaskExecutor reports exact semantic telemetry and finite operational timing", async () => {
  const report = await new TaskExecutor({
    maxWorkers: 1,
    resourceLimits: { io_light: 1 },
    maxMemoryWeight: 2,
  }).run([
    task("success", { deterministicOrderKey: "10", memoryWeight: 2, run: async () => "ok" }),
    task("failure", { deterministicOrderKey: "20", run: async () => { throw new Error("nope"); } }),
    task("abort-shaped-failure", {
      deterministicOrderKey: "30",
      run: async () => { throw new DOMException("adapter cancelled", "AbortError"); },
    }),
    task("timeout", {
      deterministicOrderKey: "40",
      timeoutMs: 5,
      run: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    }),
    task("blocked", {
      deterministicOrderKey: "50",
      dependencies: ["failure"],
      run: async () => assert.fail("blocked task must not run"),
    }),
  ]);

  assert.equal(report.status, "completed_with_failures");
  assert.equal(report.telemetry.host_parallelism >= 1, true);
  assert.equal(report.telemetry.requested_workers, 1);
  assert.equal(report.telemetry.effective_workers, 1);
  assert.equal(report.telemetry.resource_limits.io_light, 1);
  assert.equal(report.telemetry.tasks_submitted, 5);
  assert.equal(report.telemetry.tasks_completed, 5);
  assert.equal(report.telemetry.max_in_flight, 1);
  assert.equal(report.telemetry.max_queued, 3);
  assert.equal(report.telemetry.peak_memory_weight, 2);
  assert.equal(report.telemetry.retries, 0);
  assert.equal(report.telemetry.timeouts, 1);
  assert.equal(report.telemetry.cancelled, 0);
  assert.equal(report.telemetry.blocked, 1);
  assert.equal(report.telemetry.serial_fallback, true);
  for (const value of [
    report.telemetry.queue_wait_ms,
    report.telemetry.worker_busy_ms,
    report.telemetry.wall_ms,
  ]) {
    assert.equal(Number.isFinite(value) && value >= 0, true);
  }
});

test("TaskExecutor constructor rejects open or invalid capacity configuration", () => {
  const invalidOptions = [
    { unknown: true },
    { maxWorkers: 0 },
    { maxWorkers: 33 },
    { resourceLimits: { unknown: 1 } },
    { resourceLimits: { io_light: -1 } },
    { groupLimits: { repository: 0 } },
    { maxQueued: -1 },
    { maxMemoryWeight: 0 },
    { defaultTimeoutMs: 0 },
    { hostCapacity: {} },
    { hostCapacity: { parallelism: 0, totalMemoryBytes: 1, freeMemoryBytes: 1 } },
    { hostCapacity: { parallelism: 1, totalMemoryBytes: 0, freeMemoryBytes: 0 } },
    { hostCapacity: { parallelism: 1, totalMemoryBytes: 1024, freeMemoryBytes: 2048 } },
  ];
  for (const options of invalidOptions) {
    assert.throws(
      () => new TaskExecutor(options),
      (error) => error?.code === "FAIL-TASK-CONFIG",
    );
  }
});

test("TaskExecutor derives adaptive class and global capacity from host memory and workload", async () => {
  const gib = 1024 ** 3;
  const abundant = new TaskExecutor({
    hostCapacity: {
      parallelism: 16,
      totalMemoryBytes: 64 * gib,
      freeMemoryBytes: 32 * gib,
    },
  });
  const abundantReport = await abundant.run([
    task("fs-a", { resourceClass: "io_light" }),
    task("fs-b", { resourceClass: "io_light" }),
    task("git", { resourceClass: "io_git" }),
    task("cpu", { resourceClass: "cpu_heavy" }),
    task("analyzer", { resourceClass: "external_process" }),
    task("network", { resourceClass: "network_adapter" }),
  ]);

  assert.equal(abundantReport.telemetry.capacity_policy, "adaptive-host-v2");
  assert.equal(abundantReport.telemetry.memory_pressure, "abundant");
  assert.equal(abundantReport.telemetry.host_parallelism, 16);
  assert.equal(abundantReport.telemetry.automatic_worker_limit, 24);
  assert.equal(abundantReport.telemetry.effective_workers, 6);
  assert.deepEqual(abundantReport.telemetry.resource_limits, {
    io_light: 6,
    io_git: 4,
    cpu_light: 6,
    cpu_heavy: 6,
    external_process: 4,
    memory_heavy: 4,
    network_adapter: 6,
  });
  assert.equal(abundantReport.telemetry.memory_weight_limit, 12);

  const constrained = new TaskExecutor({
    hostCapacity: {
      parallelism: 16,
      totalMemoryBytes: 8 * gib,
      freeMemoryBytes: 512 * 1024 ** 2,
    },
  });
  const releases = Array.from({ length: 6 }, () => deferred());
  let active = 0;
  let peak = 0;
  const constrainedRun = constrained.run(releases.map((release, index) => task(`external-${index}`, {
    resourceClass: "external_process",
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
    },
  })));
  await waitFor(() => active === 1);
  assert.equal(peak, 1);
  releases.forEach(({ resolve }) => resolve());
  const constrainedReport = await constrainedRun;
  assert.equal(constrainedReport.telemetry.memory_pressure, "constrained");
  assert.equal(constrainedReport.telemetry.automatic_worker_limit, 4);
  assert.equal(constrainedReport.telemetry.resource_limits.external_process, 1);
  assert.equal(constrainedReport.telemetry.memory_weight_limit, 2);
});

test("TaskExecutor explicit worker and memory overrides remain authoritative under adaptive capacity", async () => {
  const gib = 1024 ** 3;
  const executor = new TaskExecutor({
    maxWorkers: 2,
    maxMemoryWeight: 3,
    resourceLimits: { cpu_heavy: 2, network_adapter: 1 },
    hostCapacity: {
      parallelism: 32,
      totalMemoryBytes: 128 * gib,
      freeMemoryBytes: 96 * gib,
    },
  });
  const report = await executor.run([
    task("cpu-a", { resourceClass: "cpu_heavy" }),
    task("cpu-b", { resourceClass: "cpu_heavy" }),
    task("network", { resourceClass: "network_adapter" }),
  ]);
  assert.equal(report.telemetry.requested_workers, 2);
  assert.equal(report.telemetry.automatic_worker_limit, 32);
  assert.equal(report.telemetry.effective_workers, 2);
  assert.equal(report.telemetry.resource_limits.cpu_heavy, 2);
  assert.equal(report.telemetry.resource_limits.network_adapter, 1);
  assert.equal(report.telemetry.memory_weight_limit, 3);
});
