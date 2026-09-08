"use strict";
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

test("RIA v0.8 package check passes as an executable gate", () => {
  const result = childProcess.spawnSync(process.execPath, [path.resolve(__dirname, "package-check.js")], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /RIA_V0_8_PACKAGE_OK/);
});
