"use strict";

const path = require("node:path");
const Core = require("../internal/java-lane-core");

function runJavaLaneFixture(options) {
  return Core.runJavaLaneCore({
    execute: options.execute,
    pinnedToolchain: options.pinned_toolchain,
    javaHome: options.java_home,
    javaExecutable: options.java_executable,
    repositoryRoot: options.repository_root || path.resolve(__dirname, "..", ".."),
    environment: options.environment || {},
  });
}

function evaluateJavaLaneFixture(identity, pinnedToolchain) {
  return Core.evaluateJavaLane(identity, pinnedToolchain);
}

module.exports = Object.freeze({ evaluateJavaLaneFixture, runJavaLaneFixture });
