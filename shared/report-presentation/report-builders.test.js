"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const child = require("node:child_process");
const presentation = require("./report-presentation.js");

const sharedRoot = path.resolve(__dirname, "..");
const skillsRoot = path.resolve(sharedRoot, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "report-builders-"));
const ledger = JSON.parse(fs.readFileSync(path.join(sharedRoot, "candidate-ledger-spine", "canonical-ledger.json"), "utf8"));
const candidateId = ledger.candidates[0].candidate_id;

function initGitRepo(dir) {
  for (const args of [["init","-q"],["config","user.email","report-fixture@example.invalid"],["config","user.name","Report Fixture"]]) {
    const result = child.spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  }
  fs.writeFileSync(path.join(dir, ".fixture"), "report fixture\n", "utf8");
  let result = child.spawnSync("git", ["add",".fixture"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `git add failed: ${result.stderr}`);
  result = child.spawnSync("git", ["commit","-q","-m","fixture"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `git commit failed: ${result.stderr}`);
}
initGitRepo(temp);

function writeJson(name, value) {
  const file = path.join(temp, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  return file;
}

function runBuilder(skill, input, outputName) {
  const output = path.join(temp, outputName);
  const result = child.spawnSync(process.execPath, [
    path.join(skillsRoot, skill, "assets", "build-report.js"),
    "--input", input,
    "--output", output,
    "--repo", temp,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `${skill} builder failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(fs.existsSync(output), `${skill} report was not written`);
  const html = fs.readFileSync(output, "utf8");
  const quality = presentation.inspectResponsiveReport(html, { requireVisualization: true });
  assert.equal(quality.ok, true, `${skill} report presentation failed: ${quality.problems.join("; ")}`);
  assert.match(html, /data-report-responsive="1"/);
  assert.match(html, /data-rp-chart=/);
  assert.doesNotMatch(html, /main\s*\{[^}]*max-width\s*:\s*980px/s);
  return html;
}

try {
  const health = JSON.parse(fs.readFileSync(path.join(skillsRoot, "repository-health-assessment", "assets", "canonical-island.json"), "utf8"));
  const healthInput = writeJson("health.json", {
    report_schema_version: 1,
    health,
    prose: {
      "one-sentence-verdict": "The repository is stable but has meaningful enforcement gaps.",
      "executive-summary": "Canonical health evidence, grading, coverage, and verification are rendered quantitatively.",
      "grade-drivers": "The weakest lanes and grade caps determine the final grade.",
      "coverage-denominator": "Unavailable and uninspected surfaces remain visible in the denominator.",
      "architecture-and-integration-health": "Architecture boundaries are mostly sound but not uniformly enforced.",
      "confirmed-observations": "The verified commands and cited claims support the displayed score.",
      "inferred-observations": "Some maintainability risks remain inferred rather than directly observed.",
      "unknown-observations": "Uninspected surfaces remain explicitly unknown.",
      "confidence-improvement": "Broader runtime and ownership inspection would improve confidence."
    },
    performance_receipt: { profile: "fixture", wall_ms: 1200 }
  });
  const healthHtml = runBuilder("repository-health-assessment", healthInput, "health.html");
  assert.match(healthHtml, /Overall health score/);
  assert.match(healthHtml, /Lane profile/);

  const integrityInput = writeJson("integrity.json", {
    report_schema_version: 1,
    repository: { name: "fixture-repo", revision: "abc1234" },
    summary: "One evidence-backed integrity candidate is ready for review.",
    health_map: [
      { label: "Verification", state: "passing", detail: "Canonical fixture commands pass." },
      { label: "Contracts", state: "attention", detail: "Schema ownership is duplicated." }
    ],
    observations: {
      confirmed: ["Two schema representations exist."],
      inferred: ["They may drift without automation."],
      unknown: ["Production incident history is unavailable."]
    },
    ledger,
    candidates: [{
      candidate_id: candidateId,
      category: "contract integrity",
      location: "src/api/schema.ts",
      friction: "Two representations must be maintained together.",
      root_seam: "No canonical schema owner exists.",
      integrity_rule: "One source owns the contract or equivalence is mechanically enforced.",
      confirmed: ["Two representations are present."],
      inferred: ["Manual maintenance can drift."],
      unknown: ["The preferred owner requires a design decision."],
      before: "Two manually synchronized schema definitions.",
      after: "One owner with generated or verified equivalents.",
      recommended_branch: "integrity/schema-authority",
      recommended_lenses: ["contract", "verification"],
      enforceable_check: "Fail CI when the representations diverge.",
      benefits: ["Reduces drift", "Makes authority explicit"]
    }],
    performance_receipt: { profile: "fixture", wall_ms: 900 }
  });
  const integrityHtml = runBuilder("codebase-integrity-audit-loop", integrityInput, "integrity.html");
  assert.match(integrityHtml, /Candidate priority/);
  assert.match(integrityHtml, /Scoring profile/);

  const architectureInput = writeJson("architecture.json", {
    report_schema_version: 1,
    repository: { name: "fixture-repo", revision: "abc1234" },
    standfirst: "Architecture candidates are challenged and scored before presentation.",
    ledger,
    top_recommendation: { candidate_id: candidateId, why: "It removes duplicated contract authority." },
    candidates: [{
      candidate_id: candidateId,
      category: "contract authority",
      files: ["src/api/schema.ts", "src/api/schema.json"],
      problem: "Two schema owners can drift independently.",
      solution: "Consolidate ownership and generate or verify the secondary representation.",
      benefits: ["One authority", "Smaller interface burden", "Deterministic drift detection"],
      before: { label: "Before", modules: ["schema.ts", "schema.json"], note: "Manual synchronization." },
      after: { label: "After", module: "CanonicalSchema", interface: "generate/verify", internals: ["source schema", "generated projections"], note: "One authority." },
      adr_conflict: null
    }],
    performance_receipt: { profile: "fixture", wall_ms: 800 }
  });
  const architectureHtml = runBuilder("architecture-improvement-intelligence", architectureInput, "architecture.html");
  assert.match(architectureHtml, /Candidate priority/);
  assert.match(architectureHtml, /Value versus risk/);

  console.log("REPORT_BUILDERS_RESPONSIVE_ANALYTICS_OK");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
