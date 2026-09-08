"use strict";

const assert = require("node:assert/strict");
const child = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ria-durable-writer-"));
try {
  const digest = "a".repeat(64);
  const revision = "b".repeat(64);
  const baselineRef = { artifact_id: `ria-baseline:${digest}`, sha256: digest, repository_revision: revision };
  const projection = {
    stage: "ASSESS",
    owner: "repository-improvement-assessment",
    baseline_ref: baselineRef,
    engineering_intelligence_ref: {
      artifact_id: `engineering-intelligence:${digest}`,
      owner: "repository-improvement-assessment",
      kind: "engineering-intelligence",
      schema_version: "1.0.0",
      sha256: digest,
      repository_revision: revision,
      mission_id: "mission-test",
      scope_hash: "c".repeat(64),
      baseline_binding: baselineRef,
    },
    assessment_refs: [
      "repository-health-assessment",
      "codebase-integrity-audit-loop",
      "architecture-improvement-intelligence",
    ].map((owner, index) => ({ owner, artifact_id: `artifact:${index}`, sha256: String(index + 1).repeat(64), repository_revision: revision })),
  };
  const input = path.join(root, "projection.json");
  fs.writeFileSync(input, JSON.stringify(projection));
  const script = path.resolve(__dirname, "write-assess-projection.js");
  const written = JSON.parse(child.execFileSync(process.execPath, [script, "--input", input, "--repo", root, "--durable-mode", "content-addressed-degraded"], { encoding: "utf8" }));
  assert.equal(written.durable_mode, "content-addressed-degraded");
  assert.ok(fs.existsSync(written.path));
  assert.ok(written.path.includes(`${path.sep}.project-intelligence${path.sep}assessments${path.sep}ria${path.sep}`));
  const help = child.spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--input/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("RIA_DURABLE_STORAGE_OK");
