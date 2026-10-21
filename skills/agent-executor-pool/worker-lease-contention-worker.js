"use strict";

const fs = require("node:fs");
const { WorkerLeaseStore } = require("./worker-lease-store");
const [root, start, identity] = process.argv.slice(2);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(start)) Atomics.wait(sleeper, 0, 0, 2);
const result = new WorkerLeaseStore(root, { ttl_ms: 5000, lock_timeout_ms: 5000 }).claim("same", "worker-" + identity, 1000);
process.stdout.write(JSON.stringify({ claimed: result.claimed, reason: result.reason || null }));
