"use strict";

// Cross-package contract scan for the ASSESS boundary. This is a documentation/
// manifest verifier; it deliberately does not run a lifecycle or mutate a repo.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const skillRoot = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(skillRoot, relative), "utf8");
const json = (relative) => JSON.parse(read(relative));
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

check("RIA returns an ASSESS-only projection", () => {
  const guide = read("repository-improvement-assessment/SKILL.md");
  const manifest = json("repository-improvement-assessment/MANIFEST.json");
  assert.match(guide, /"stage": "ASSESS"/);
  assert.match(guide, /directly invoked, read-only assessment owner/i);
  assert.doesNotMatch(guide, /loop-router/i);
  assert.equal(manifest.consumes.includes("loop-router"), false);
  assert.match(guide, /The projection contains no graph, frontier, action set, execution packet/i);
  assert.equal(manifest.returns, "assess-projection-v1");
  assert.match(guide, /shared\/report-election/i);
  assert.match(guide, /immutable ASSESS projection is always produced first/i);
  for (const downstream of ["remediation-graph-optimizer", "production-flywheel", "independent-verification", "shared/action-integration-reassessment"]) {
    assert.equal(manifest.consumes.includes(downstream), false, `${downstream} must not be an RIA ASSESS dependency`);
  }
});

check("RIA report, schema, evals, and assets retain only ASSESS-era semantics", () => {
  const template = read("repository-improvement-assessment/assets/report-template.md");
  const schema = json("repository-improvement-assessment/assets/report-schema.json");
  const evals = json("repository-improvement-assessment/evals/evals.json");
  assert.deepEqual(schema.properties.required_sections.prefixItems.map(item => item.const), ["Executive Assessment", "Health", "Integrity", "Architecture", "Cross-Cutting Synthesis", "Highest-Leverage Priorities", "Evidence Certainty and Gaps", "Downstream Disposition", "Coverage and Provenance", "Assessment Status", "Next Lifecycle"]);
  assert.equal(fs.existsSync(path.join(skillRoot, "repository-improvement-assessment", "references", "quick-fix-execution-contract.md")), false);
  assert.doesNotMatch(template, /^## (Reconciliation|Graph Topology|Automatic Run|Remaining Portfolio|Decision Leverage)$/mi);
  assert.match(template, /^## Executive Assessment$/m);
  assert.match(template, /^## Cross-Cutting Synthesis$/m);
  assert.match(template, /presentation order does not replace canonical owner scoring or remediation-graph authority/i);
  assert.doesNotMatch(JSON.stringify(evals), /Bucket 0|Bucket 1|stop_after_collective|production-flywheel/i);
  assert.match(template, /Return the ASSESS projection to the invoking caller/);
});

check("RIA owns one closed engineering-intelligence evidence ref without a fourth assessment owner", () => {
  const guide = read("repository-improvement-assessment/SKILL.md");
  const manifest = json("repository-improvement-assessment/MANIFEST.json");
  const policy = json("repository-improvement-assessment/context-policy.json");
  const contract = json("repository-improvement-assessment/engineering-intelligence.schema.json");
  const reportSchema = json("repository-improvement-assessment/assets/report-schema.json");
  const evidenceGuide = read("repository-improvement-assessment/references/engineering-intelligence.md");
  const ref = contract.$defs.engineeringIntelligenceRef;
  const artifact = contract.$defs.engineeringIntelligenceArtifact;
  const index = contract.$defs.baselineIntelligenceIndex;
  const pin = contract.$defs.baselineIntelligencePin;
  const projection = contract.$defs.assessProjection;
  const seiAssessment = contract.$defs.seiAssessmentRef;
  const expectedRefKeys = ["artifact_id", "owner", "kind", "schema_version", "sha256", "repository_revision", "mission_id", "scope_hash", "baseline_binding"].sort();

  assert.match(guide, /reads the immutable baseline-to-intelligence binding before it computes Software Engineering Intelligence/i);
  assert.match(guide, /not a fourth member of `assessment_refs`/i);
  assert.ok(manifest.contracts.includes("references/engineering-intelligence.md"));
  assert.ok(manifest.contracts.includes("engineering-intelligence.schema.json"));
  assert.deepEqual(policy.conditional.engineering_intelligence.refs, ["engineering-intelligence.schema.json", "references/engineering-intelligence.md"]);
  assert.deepEqual(Object.keys(ref.properties).sort(), expectedRefKeys);
  assert.equal(ref.additionalProperties, false);
  assert.equal(ref.properties.owner.const, "repository-improvement-assessment");
  assert.equal(ref.properties.kind.const, "engineering-intelligence");
  assert.equal(ref.properties.schema_version.const, "1.0.0");
  assert.equal(artifact.additionalProperties, false);
  assert.equal(index.additionalProperties, false);
  assert.equal(index.properties.owner.const, "repository-improvement-assessment");
  assert.equal(index.properties.kind.const, "engineering-intelligence-baseline-index");
  assert.deepEqual(Object.keys(index.properties).sort(), ["baseline_binding", "binding_hash", "engineering_intelligence_ref", "first_minted_artifact_id", "first_minted_sha256", "kind", "mission_id", "owner", "repository_revision", "schema_version", "scope_hash"]);
  assert.deepEqual(index.required.slice().sort(), ["baseline_binding", "binding_hash", "engineering_intelligence_ref", "first_minted_artifact_id", "first_minted_sha256", "kind", "mission_id", "owner", "repository_revision", "schema_version", "scope_hash"]);
  assert.equal(pin.additionalProperties, false);
  assert.equal(pin.properties.owner.const, "repository-improvement-assessment");
  assert.equal(pin.properties.kind.const, "engineering-intelligence-baseline-pin");
  assert.deepEqual(Object.keys(pin.properties).sort(), ["baseline_binding", "binding_hash", "engineering_intelligence_ref", "kind", "mission_id", "owner", "repository_revision", "schema_version", "scope_hash"]);
  assert.deepEqual(pin.required.slice().sort(), ["baseline_binding", "binding_hash", "engineering_intelligence_ref", "kind", "mission_id", "owner", "repository_revision", "schema_version", "scope_hash"]);
  assert.deepEqual(Object.keys(projection.properties).sort(), ["assessment_refs", "baseline_ref", "engineering_intelligence_ref", "owner", "sei_assessment_ref", "stage"]);
  assert.equal(projection.properties.assessment_refs.maxItems, 3);
  assert.equal(seiAssessment.additionalProperties, false);
  assert.deepEqual(seiAssessment.required.slice().sort(), ["applicability_digest", "artifact_path", "artifact_sha256", "assessment_id", "config_digest", "evaluator", "rubric", "schema_version", "snapshot_binding", "standard"]);
  assert.deepEqual(seiAssessment.properties.schema_version.enum.slice().sort(), ["sei.engineering-assessment@1", "sei.engineering-assessment@2", "sei.engineering-assessment@3"]);
  assert.equal(seiAssessment.properties.evaluator.$ref, "#/$defs/seiAssessmentEvaluator");
  assert.equal(contract.$defs.seiAssessmentEvaluator.properties.id.const, "sei.engineering-assessment");
  assert.ok(reportSchema.required.includes("baseline_ref"));
  assert.ok(reportSchema.required.includes("engineering_intelligence_ref"));
  assert.equal(reportSchema.required.includes("sei_assessment_ref"), false, "the SEI sidecar remains additive for v1 report compatibility");
  assert.equal(reportSchema.$defs.engineeringIntelligenceRef.additionalProperties, false);
  assert.equal(reportSchema.$defs.seiAssessmentRef.additionalProperties, false);
  const reportOwnerBranches = reportSchema.properties.assessment_refs.items.oneOf
    .map((branch) => reportSchema.$defs[branch.$ref.split("/").at(-1)].properties.owner.const)
    .sort();
  assert.deepEqual(reportOwnerBranches, ["architecture-improvement-intelligence", "codebase-integrity-audit-loop", "repository-health-assessment"]);
  const reportOwnerOrder = reportSchema.properties.assessment_refs.prefixItems
    .map((branch) => reportSchema.$defs[branch.$ref.split("/").at(-1)].properties.owner.const);
  assert.deepEqual(reportOwnerOrder, ["repository-health-assessment", "codebase-integrity-audit-loop", "architecture-improvement-intelligence"]);
  assert.equal(reportSchema.properties.assessment_refs.not.minItems, 4);
  assert.match(guide, /baseline-index\/<binding-hash>\.json/i);
  assert.match(guide, /baseline-pin\/<binding-hash>\.json/i);
  assert.match(evidenceGuide, /rehashes bytes before parsing/i);
  assert.match(evidenceGuide, /never silently recomputes or overwrites/i);
  assert.match(evidenceGuide, /optional, verified `sei_assessment_ref`/i);
  assert.match(evidenceGuide, /forged digest, unknown schema version, non-SEI evaluator/i);
});

check("RIA evidence envelopes preserve the three child owners and leave runtime opaque", () => {
  const health = read("repository-health-assessment/SKILL.md");
  const integrity = read("codebase-integrity-audit-loop/PARALLEL-REPORT.md");
  const architecture = read("architecture-improvement-intelligence/SKILL.md");
  const topology = read("human-directed-swarm-planner/SWARM-TYPES.md");
  const runtime = read("shared/orchestration-runtime/runtime.schema.json");

  assert.match(health, /engineering_intelligence_ref.*health-owned grade authority/i);
  assert.match(integrity, /engineering_intelligence_ref.*candidate authority/i);
  assert.match(architecture, /engineering_intelligence_ref/i);
  assert.match(architecture, /support architecture findings/i);
  assert.match(health, /optional verified `sei_assessment_ref`/i);
  assert.match(integrity, /optional verified `sei_assessment_ref`/i);
  assert.match(architecture, /`sei_assessment_ref`.*optional/i);
  assert.match(topology, /exactly three hash-bound owner references plus the one RIA-owned opaque engineering intelligence reference/i);
  assert.doesNotMatch(runtime, /engineering[_-]intelligence/i);
});

check("RGO is explicit-only and has no raw HTML report contract", () => {
  const rgo = json("remediation-graph-optimizer/MANIFEST.json");
  const guide = read("remediation-graph-optimizer/SKILL.md");
  assert.deepEqual(rgo.invocation.expected_callers, ["user"]);
  assert.deepEqual(rgo.files, { skill: "SKILL.md" });
  assert.match(guide, /user explicitly selects reconciliation/i);
  assert.match(guide, /separate exact authorization and direct invocation of `production-flywheel`/i);
  assert.doesNotMatch(guide, /loop-router/i);
  assert.match(guide, /no execution completion, independent-verification verdict, Stage 15 receipt/i);
});

check("RIA topology stays subordinate and uses the canonical architecture owner", () => {
  const topology = read("human-directed-swarm-planner/SWARM-TYPES.md");
  const architecture = read("architecture-improvement-intelligence/SKILL.md");
  assert.match(topology, /^## RIA Assessment Topology$/m);
  assert.doesNotMatch(topology, /^## Repository Improvement Assessment swarm$/m);
  assert.match(topology, /architecture-improvement-intelligence --assessment/);
  assert.match(architecture, /## `--assessment` — canonical RIA owner mode/);
  assert.match(architecture, /reference-only return|Return exactly one immutable reference/i);
});

check("canonical action graph and policy-gated publication remain separate from legacy graph mode", () => {
  const flywheel = read("production-flywheel/SKILL.md");
  const manual = read("production-flywheel/references/manual-delivery.md");
  assert.match(flywheel, /(?:Legacy `--graph`.*compatibility|`--graph` is a legacy candidate-ledger compatibility path)/i);
  assert.match(flywheel, /(?:Canonical `--action-graph`|`--action-graph` is the canonical execution path)/i);
  assert.match(flywheel, /`local_only`.*`push_allowed`.*`pr_allowed`/s);
  assert.match(flywheel, /Publication is never automatic/i);
  assert.match(manual, /## Stage 13 — Publish \(explicit policy only; never merge\)/);
});

check("D7 and Stage 15 retain an action-local freeze and Flywheel-owned integration boundary", () => {
  const actionGraph = read("production-flywheel/ACTION-GRAPH-MODE.md");
  const stage15 = read("production-flywheel/INTEGRATION-REASSESSMENT-STAGE.md");
  const integration = json("shared/action-integration-reassessment/MANIFEST.json");
  assert.match(actionGraph, /requires a concluded wave-boundary receipt/i);
  assert.match(stage15, /action-local freeze/i);
  assert.match(actionGraph, /requires a concluded wave-boundary receipt/i);
  assert.equal(integration.consumers.some((entry) => entry.startsWith("loop-router")), false);
  assert.ok(integration.consumers.some((entry) => entry.startsWith("production-flywheel")));
  assert.equal(integration.consumers.some((entry) => entry.startsWith("repository-improvement-assessment")), false);
});

if (failures) process.exitCode = 1;
