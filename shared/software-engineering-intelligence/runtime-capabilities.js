"use strict";

function versionParts(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value ?? "");
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

function atLeast(parts, minimum) {
  if (parts === null) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

function result(status, capability, observedVersion, minimumVersion, reasonCode) {
  return Object.freeze({
    status,
    capability,
    observed_version: observedVersion ?? null,
    minimum_version: minimumVersion,
    reason_code: reasonCode,
  });
}

function exactPythonIdentity(identity, expected) {
  return expected && typeof expected === "object" && !Array.isArray(expected)
    && expected.implementation === identity?.implementation
    && expected.python_version === identity?.python_version;
}

function exactJavaIdentity(identity, expected) {
  return expected && typeof expected === "object" && !Array.isArray(expected)
    && expected.compiler_available === identity?.compiler_available
    && expected.java_runtime_version === identity?.java_runtime_version
    && expected.java_vendor === identity?.java_vendor;
}

function assessPythonCapability(identity, options = {}) {
  const observed = identity?.python_version;
  const compatible = identity?.implementation === "cpython" && atLeast(versionParts(observed), [3, 13, 0]);
  if (!compatible) return result("unavailable", "cpython-ast-feature-version-3.13", observed, "3.13.0", "PYTHON_AST_CAPABILITY_UNAVAILABLE");
  if (options.reproducibility === "exact" && !exactPythonIdentity(identity, options.expected_identity)) {
    return result("unavailable", "cpython-ast-feature-version-3.13", observed, "3.13.0", "PYTHON_EXACT_REPRODUCIBILITY_UNAVAILABLE");
  }
  return result("available", "cpython-ast-feature-version-3.13", observed, "3.13.0", null);
}

function assessJavaCapability(identity, options = {}) {
  const observed = identity?.java_runtime_version;
  const parts = versionParts(observed);
  const compatible = identity?.compiler_available === true && atLeast(parts, [25, 0, 0]);
  if (!compatible) return result("unavailable", "jdk-compiler-source-25", observed, "25.0.0", "JAVA_COMPILER_CAPABILITY_UNAVAILABLE");
  if (options.reproducibility === "exact" && !exactJavaIdentity(identity, options.expected_identity)) {
    return result("unavailable", "jdk-compiler-source-25", observed, "25.0.0", "JAVA_EXACT_REPRODUCIBILITY_UNAVAILABLE");
  }
  return result("available", "jdk-compiler-source-25", observed, "25.0.0", null);
}

module.exports = Object.freeze({
  assessJavaCapability,
  assessPythonCapability,
});
