"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { validateOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
const { normalizeCandidateFitness } = require("./architecture-fitness.js");

/** Architecture owns payload semantics; the shared validator owns the envelope. */
function validateArchitectureOwnerReturn(value, expected = {}) {
  const checked = validateOwnerReturn(value, { ...expected, owner: "architecture-improvement-intelligence" });
  if (!checked.ok) return checked;
  try {
    const bytes = fs.readFileSync(value.artifact_path);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== value.file_sha256) throw new Error("FAIL-ARCHITECTURE-FITNESS: artifact hash changed");
    const artifact = JSON.parse(bytes);
    if (artifact.repository_revision !== value.repository_revision) throw new Error("RIA_ENVELOPE_REVISION_MISMATCH: Architecture artifact differs from owner return");
    const normalized = normalizeCandidateFitness(artifact, { requireV2: expected.requireFitnessV2 === true });
    if (artifact.architecture_fitness?.schema_version === "architecture.fitness@2") {
      for (const key of ["score", "grade", "coverage", "confidence"]) {
        if (Object.hasOwn(artifact.architecture_fitness, key) && artifact.architecture_fitness[key] !== normalized.architecture_fitness[key]) throw new Error(`FAIL-ARCHITECTURE-FITNESS: inconsistent normalized ${key}`);
      }
      if (Object.hasOwn(artifact.architecture_fitness, "weights")) {
        const weights = artifact.architecture_fitness.weights;
        const entries = Object.entries(normalized.architecture_fitness.weights);
        if (!weights || typeof weights !== "object" || Array.isArray(weights) || Object.keys(weights).length !== entries.length || entries.some(([id, weight]) => weights[id] !== weight)) throw new Error("FAIL-ARCHITECTURE-FITNESS: inconsistent normalized weights");
      }
    }
    return checked;
  } catch (error) { return { ok: false, errors: [error.message] }; }
}
module.exports = { validateArchitectureOwnerReturn };
