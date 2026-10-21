#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const errors = [];
const ok = (cond, msg) => { if (!cond) errors.push(msg); };
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const json = rel => JSON.parse(read(rel));

try {
  const manifest = json("MANIFEST.json");
  ok(manifest.version === "2.5.0", "manifest version must be 2.5.0");
  for (const dep of ["shared/evidence-recon", "shared/candidate-ledger-spine", "shared/assessment-acceleration", "shared/report-election", "shared/project-intelligence-workspace", "agent-executor-pool"])
    ok(manifest.depends_on.includes(dep), `missing dependency ${dep}`);
  ok(manifest.performance && manifest.performance.profile === "aggressive-threadpool-v2", "aggressive-threadpool-v2 profile missing");
  ok(manifest.performance.work_conserving_refill === true, "work-conserving refill must be true");
  ok(manifest.performance.as_completed_consumption === true, "as_completed consumption must be true");
  ok(manifest.performance.work_stealing === true, "work stealing must be true");
  ok(manifest.performance.pipeline_overlap === true, "pipeline overlap must be true");
  ok(manifest.performance.report_runtime_network === false, "report runtime network must be false");

  for (const rel of ["SKILL.md", "PERFORMANCE.md", "ARCHITECTURE-COVERAGE.md", "CANDIDATE-MODEL.md", "CANDIDATE-CRITIC.md", "ROUTING.md", "PARALLEL-LANE-PROTOCOL.md", "EVALUATIONS.yaml", "HTML-REPORT.md", "MIGRATIONS.md", "assets/performance-contract.json", "assets/architecture-candidate-set.schema.json", "assets/architecture-candidate-set.example.json", "assets/architecture-fitness.js", "assets/architecture-fitness.schema.json", "assets/architecture-fitness.test.js", "assets/write-candidate-set.js", "assets/build-report.js", "assets/report-scaffold.html"])
    ok(fs.existsSync(path.join(root, rel)), `missing required file ${rel}`);

  json("assets/architecture-candidate-set.schema.json");
  ok(json("RUNTIME-CONTRACT.json").version === manifest.version, "runtime and manifest version mismatch");
  for (const rel of ["assets/architecture-owner-return.js", "assets/architecture-fitness-v2.test.js", "assets/architecture-fitness-v2.schema.json"]) ok(fs.existsSync(path.join(root, rel)), `missing required file ${rel}`);
  ok(json("assets/architecture-fitness-v2.schema.json").properties.schema_version.const === "architecture.fitness@2", "fitness @2 schema missing");
  const perfContract = json("assets/performance-contract.json");
  ok(perfContract.profile === "aggressive-threadpool-v2", "performance contract profile mismatch");
  ok(perfContract.requirements && perfContract.requirements.as_completed_consumption === true, "performance contract as_completed invariant missing");
  const example = json("assets/architecture-candidate-set.example.json");
  ok(example.schema_version === 2, "candidate-set example schema_version must be 2");
  const { normalizeArchitectureFitness } = require(path.join(root, "assets", "architecture-fitness.js"));
  const fitness = normalizeArchitectureFitness(example.architecture_fitness);
  ok(fitness && Number.isFinite(fitness.score) && /^(?:A\+|A|A-|B\+|B|B-|C\+|C|C-|D\+|D|D-|F)$/.test(fitness.grade), "architecture fitness must be deterministically scored");
  ok(example.scope && example.scope.mutation_posture === "read-only", "example must remain read-only");

  const skill = read("SKILL.md");
  const perf = read("PERFORMANCE.md");
  const report = read("HTML-REPORT.md");
  const scaffold = read("assets/report-scaffold.html");
  const builder = read("assets/build-report.js");

  for (const phrase of ["Architecture rigor is mandatory. Architecture ceremony is conditional.", "shared/evidence-recon", "shared/report-election", "Architecture Candidate Critic", "Maximum safe concurrency", "as they complete"])
    ok(skill.includes(phrase), `SKILL missing invariant: ${phrase}`);

  for (const phrase of ["ThreadPool", "as_completed", "work stealing", "Critical-path", "single-flight", "Incremental synthesis", "queue_multiplier"])
    ok(perf.toLowerCase().includes(phrase.toLowerCase()), `PERFORMANCE missing: ${phrase}`);

  ok(!/https?:\/\//i.test(scaffold), "production report scaffold contains network URL");
  ok(!/cdn\.tailwindcss|cdn\.jsdelivr|unpkg\.com/i.test(report), "production report contract references CDN");
  ok(!/cdn\.tailwindcss|cdn\.jsdelivr|unpkg\.com/i.test(skill), "SKILL references CDN");
  ok(!/Add the term to `CONTEXT\.md`|Update `CONTEXT\.md` right there/.test(skill), "SKILL contains legacy mutation instruction");
  ok(!/After · deep module/.test(builder), "report builder still forces deep-module after state");

  new vm.Script(builder, { filename: "assets/build-report.js" });
} catch (err) {
  errors.push(err.stack || String(err));
}

if (errors.length) {
  console.error("AII_V2_3_PACKAGE_FAIL");
  for (const e of errors) console.error("- " + e);
  process.exit(1);
}
console.log("AII_V2_3_PACKAGE_OK");
