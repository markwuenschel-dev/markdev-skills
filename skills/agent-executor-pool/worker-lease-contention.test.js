"use strict";

const assert = require("node:assert");
const child = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lease-contention-"));
const start = path.join(root, "start");
const worker = path.join(__dirname, "worker-lease-contention-worker.js");
const children = Array.from({ length: 8 }, (_, index) => child.spawn(process.execPath, [worker, root, start, String(index)], {
  env: { ...process.env, AEP_TEST_CLAIM_DELAY_MS: "75" },
  stdio: ["ignore", "pipe", "inherit"]
}));
fs.writeFileSync(start, "go");

Promise.all(children.map(proc => new Promise((resolve, reject) => {
  let output = "";
  proc.stdout.on("data", chunk => { output += chunk; });
  proc.on("error", reject);
  proc.on("exit", code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error("worker exit " + code)));
}))).then(results => {
  assert.equal(results.filter(result => result.claimed).length, 1, JSON.stringify(results));
  const live = JSON.parse(fs.readFileSync(path.join(root, encodeURIComponent("same") + ".json"), "utf8"));
  assert.equal(live.status, "active");
  console.log("GREEN — exactly one real OS process wins a contested lease");
}).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
