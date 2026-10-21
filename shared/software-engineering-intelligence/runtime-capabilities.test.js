"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assessJavaCapability,
  assessPythonCapability,
} = require("./runtime-capabilities");

test("normal Python admission accepts compatible future CPython and rejects missing capability", () => {
  assert.deepEqual(assessPythonCapability({ implementation: "cpython", python_version: "3.14.1" }), {
    status: "available",
    capability: "cpython-ast-feature-version-3.13",
    observed_version: "3.14.1",
    minimum_version: "3.13.0",
    reason_code: null,
  });
  assert.equal(assessPythonCapability({ implementation: "cpython", python_version: "3.12.9" }).reason_code, "PYTHON_AST_CAPABILITY_UNAVAILABLE");
  assert.equal(assessPythonCapability({ implementation: "pypy", python_version: "3.13.0" }).status, "unavailable");
});

test("exact Python reproducibility remains a separate lane", () => {
  const expected_identity = { implementation: "cpython", python_version: "3.13.7" };
  assert.equal(assessPythonCapability(expected_identity, { reproducibility: "exact", expected_identity }).status, "available");
  assert.equal(assessPythonCapability({ implementation: "cpython", python_version: "3.13.8" }, { reproducibility: "exact", expected_identity }).reason_code, "PYTHON_EXACT_REPRODUCIBILITY_UNAVAILABLE");
  assert.equal(assessPythonCapability(expected_identity, { reproducibility: "exact" }).reason_code, "PYTHON_EXACT_REPRODUCIBILITY_UNAVAILABLE");
});

test("normal Java admission accepts JDK 25 and newer while exact lane binds an expected identity", () => {
  assert.equal(assessJavaCapability({ java_runtime_version: "26.0.1", compiler_available: true }).status, "available");
  assert.equal(assessJavaCapability({ java_runtime_version: "24.0.2", compiler_available: true }).reason_code, "JAVA_COMPILER_CAPABILITY_UNAVAILABLE");
  const expected_identity = { compiler_available: true, java_runtime_version: "25.0.2", java_vendor: "fixture-vendor" };
  assert.equal(assessJavaCapability(expected_identity, { reproducibility: "exact", expected_identity }).status, "available");
  assert.equal(assessJavaCapability({ ...expected_identity, java_vendor: "other-vendor" }, { reproducibility: "exact", expected_identity }).reason_code, "JAVA_EXACT_REPRODUCIBILITY_UNAVAILABLE");
  assert.equal(assessJavaCapability(expected_identity, { reproducibility: "exact" }).reason_code, "JAVA_EXACT_REPRODUCIBILITY_UNAVAILABLE");
  assert.equal(assessJavaCapability({ java_runtime_version: "25.0.3", compiler_available: false }).status, "unavailable");
});
