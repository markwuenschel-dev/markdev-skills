#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");

const [parentMarker, childMarker] = process.argv.slice(2);
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: false,
  stdio: "ignore",
  windowsHide: true,
});
fs.writeFileSync(parentMarker, String(process.pid), "utf8");
fs.writeFileSync(childMarker, String(child.pid), "utf8");
setInterval(() => {}, 1_000);
