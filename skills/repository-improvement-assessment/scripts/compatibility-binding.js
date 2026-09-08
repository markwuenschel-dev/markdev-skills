"use strict";

const crypto = require("node:crypto");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }

function deriveCompatibilityBinding(input = {}) {
  const effectiveConfiguration = canonical(input.effective_configuration ?? {});
  const executionContract = canonical(input.execution_contract ?? {});
  const historyWindow = canonical(input.history_window ?? { kind: "full" });
  const analyzerCapabilities = canonical(input.analyzer_capabilities ?? {});
  return Object.freeze(canonical({
    engine_version: String(input.engine_version || "unknown"),
    effective_configuration: effectiveConfiguration,
    config_hash: digest(effectiveConfiguration),
    execution_contract_hash: digest(executionContract),
    history_window: historyWindow,
    history_window_hash: digest(historyWindow),
    assessment_schema_version: String(input.assessment_schema_version || "sei.engineering-assessment@3"),
    analyzer_capabilities: analyzerCapabilities,
    analyzer_capability_hash: digest(analyzerCapabilities),
  }));
}

module.exports = { deriveCompatibilityBinding, digest };
