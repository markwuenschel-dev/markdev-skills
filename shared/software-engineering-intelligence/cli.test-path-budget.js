"use strict";

const assert = require("node:assert/strict");
const cliPrivate = require("./cli.js")[Symbol.for("sei.cli.private.v1")];
assert.equal(typeof cliPrivate.shortStagePrefix, "function");
const path = require("node:path");
const target = path.join(require("node:os").tmpdir(), "deep", "artifact.json");
const prefix = cliPrivate.shortStagePrefix(target);
assert.equal(prefix, path.join(path.dirname(target), ".sei-stage-"));
console.log("SEI_STAGE_PATH_BUDGET_OK");
