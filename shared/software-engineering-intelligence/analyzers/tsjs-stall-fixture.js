#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");

const marker = process.env.SEI_TSJS_STALL_MARKER;
if (!marker) {
  fs.writeFileSync(process.argv[3], String(process.pid), "utf8");
  setInterval(() => {}, 1_000);
} else if (process.argv[2] === "--probe") {
  const typescriptPath = process.argv[3];
  const ts = require(typescriptPath);
  const identity = {
    analyzer_sha256: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex")}`,
    analyzer_version: "sei.tsjs-ast@1",
    node_version: process.version,
    protocol: "sei.tsjs-ast@1",
    reason: null,
    script_kinds: ["javascript", "jsx", "typescript", "tsx"],
    status: "available",
    typescript_sha256: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(typescriptPath)).digest("hex")}`,
    typescript_version: ts.version,
  };
  process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a], [b]) => a.localeCompare(b)))));
} else {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  fs.writeFileSync(path.join(marker, "parent.pid"), String(process.pid), "utf8");
  fs.writeFileSync(path.join(marker, "child.pid"), String(child.pid), "utf8");
  setInterval(() => {}, 1_000);
}
