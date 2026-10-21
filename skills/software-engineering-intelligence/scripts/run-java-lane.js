#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Core = require("../internal/java-lane-core");

const MANIFEST_PATH = path.resolve(__dirname, "..", "MANIFEST.json");
const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");
// fail = tests ran and did not pass; any other non-pass outcome is 2;
// an admission error (identity conflict, bad pin, relative path) is 3.
const EXIT_CODES = Object.freeze({ pass: 0, fail: 1, "admission-error": 3 });

function loadPinnedToolchain() {
  return Core.loadPinnedToolchain(MANIFEST_PATH);
}

function evaluateJavaLane(identity) {
  return Core.evaluateJavaLane(identity, loadPinnedToolchain());
}

function runJavaLane() {
  return Core.runJavaLaneCore({
    execute: spawnSync,
    pinnedToolchain: loadPinnedToolchain(),
    javaHome: process.env.SEI_JAVA_25_HOME || null,
    javaExecutable: process.env.SEI_JAVA_25 || null,
    repositoryRoot: REPOSITORY_ROOT,
    environment: process.env,
  });
}

function admissionErrorReceipt(error) {
  const message = String(error?.message ?? error);
  return Object.freeze({
    schema_version: Core.RECEIPT_SCHEMA_VERSION,
    lane: "hermetic-jdk25-integration",
    status: "admission-error",
    error_code: /^FAIL-[A-Z0-9-]+/.exec(message)?.[0] ?? "FAIL-SEI-JAVA-LANE-INTERNAL",
    error: message,
  });
}

function main() {
  let receipt;
  try {
    receipt = runJavaLane();
  } catch (error) {
    receipt = admissionErrorReceipt(error);
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return EXIT_CODES[receipt.status] ?? 2;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = Object.freeze({ EXIT_CODES, HERMETIC_TESTS: Core.HERMETIC_TESTS, admissionErrorReceipt, evaluateJavaLane, loadPinnedToolchain, runJavaLane });
