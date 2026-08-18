#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ER = require("./evidence-recon.js");

const read = rel => JSON.parse(fs.readFileSync(path.join(__dirname, rel), "utf8"));
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = read("canonical-evidence-packet.json");
const expedition = read("fixtures/expedition-evidence-packet.json");

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function codes(result) { return new Set((result.problems || []).map(p => p.code)); }

function minimalExpeditionBase() {
  return {
    evidence_packet_version: 1,
    packet_id: "ER-MERGE-001",
    producer: { skill: "test", run_id: "merge-run", mode: "expedition", created_at: "2026-08-16T00:00:00Z" },
    scope: {
      claim_or_question: "What are the relevant facts?",
      objective: "Merge independent evidence lanes.",
      required_completeness: "representative",
      included_surfaces: [{ surface_id: "surface-a", description: "A" }, { surface_id: "surface-b", description: "B" }],
      excluded_surfaces: []
    },
    coverage_plan: {
      source_classes: ["code", "tests"],
      independent_surfaces: ["surface-a", "surface-b"],
      contradiction_risk: "medium",
      false_negative_cost: "medium",
      cross_source_reconciliation: true,
      parallelizable: true,
      selected_mode: "expedition",
      mode_rationale: "Two bounded lanes are intentionally being merged for the fixture."
    },
    claims: [], negative_claims: [], contradictions: [],
    handoff: { safe_to_assume: [], unresolved_facts: [], owner_intent_required: [], possible_decision_surfaces: [], consumer_notes: [] },
    lane_receipts: []
  };
}

function lane(laneId, claimId, surface) {
  return {
    expedition_lane_version: 1,
    lane_id: laneId,
    parent_packet_id: "ER-MERGE-001",
    surface,
    status: "complete",
    claims: [{
      claim_id: claimId,
      statement: `${surface} was inspected.`,
      epistemic_status: "confirmed",
      evidence_quality: "strong",
      coverage: { state: "inspected", scope: surface, methods: ["direct inspection"], limitations: [] },
      sources: [{ kind: "path", ref: `${surface}.txt` }],
      confidence: { level: "high", rationale: "Direct fixture inspection." },
      supports: [surface], contradiction_refs: [], limitations: []
    }],
    negative_claims: [], contradictions: [], limitations: []
  };
}

test("canonical inline packet validates", () => {
  const result = ER.validateEvidencePacket(canonical);
  assert.equal(result.ok, true, JSON.stringify(result.problems, null, 2));
  assert.equal(result.summary.absence_supported, 1);
});

test("canonical expedition packet validates", () => {
  const result = ER.validateEvidencePacket(expedition);
  assert.equal(result.ok, true, JSON.stringify(result.problems, null, 2));
  assert.equal(result.summary.lanes, 2);
});

test("negative absence claim requires exhaustive inspected receipt", () => {
  const packet = clone(canonical);
  packet.negative_claims[0].coverage.state = "sampled";
  packet.negative_claims[0].search_completeness = "representative";
  const result = ER.validateEvidencePacket(packet);
  assert.equal(result.ok, false);
  assert(codes(result).has("negative-claim-coverage-insufficient"));
  assert(codes(result).has("negative-claim-search-not-exhaustive"));
});

test("safe_to_assume rejects inferred claims", () => {
  const packet = clone(canonical);
  packet.handoff.safe_to_assume.push("ER-C-003");
  const result = ER.validateEvidencePacket(packet);
  assert.equal(result.ok, false);
  assert(codes(result).has("handoff-safe-not-confirmed"));
});

test("inspected plus weak evidence is contradictory", () => {
  const packet = clone(canonical);
  packet.claims[0].evidence_quality = "weak";
  const result = ER.validateEvidencePacket(packet);
  assert.equal(result.ok, false);
  assert(codes(result).has("coverage-evidence-mismatch"));
  assert(codes(result).has("confirmed-evidence-too-weak"));
});

test("inline mode rejects fabricated lane receipts", () => {
  const packet = clone(canonical);
  packet.lane_receipts.push({ lane_id: "L-X", surface: "x", status: "complete", claim_refs: [], negative_claim_refs: [], contradiction_refs: [], limitations: [] });
  const result = ER.validateEvidencePacket(packet);
  assert.equal(result.ok, false);
  assert(codes(result).has("inline-lanes-forbidden"));
});

test("expedition mode requires at least two lane receipts", () => {
  const packet = clone(expedition);
  packet.lane_receipts = packet.lane_receipts.slice(0, 1);
  const result = ER.validateEvidencePacket(packet);
  assert.equal(result.ok, false);
  assert(codes(result).has("expedition-lanes-missing"));
});

test("unknown claim cannot masquerade as high-confidence fact", () => {
  const packet = clone(canonical);
  packet.claims[3].confidence.level = "high";
  const result = ER.validateEvidencePacket(packet);
  assert.equal(result.ok, false);
  assert(codes(result).has("unknown-high-confidence"));
});

test("unavailable and not-applicable require reasons", () => {
  const packet = clone(canonical);
  packet.claims[0].coverage.state = "unavailable";
  delete packet.claims[0].coverage.reason;
  const result = ER.validateEvidencePacket(packet);
  assert.equal(result.ok, false);
  assert(codes(result).has("coverage-reason-missing"));
});

test("contradiction references must resolve", () => {
  const packet = clone(canonical);
  packet.contradictions[0].claim_refs[1] = "ER-MISSING";
  const result = ER.validateEvidencePacket(packet);
  assert.equal(result.ok, false);
  assert(codes(result).has("contradiction-ref-unknown"));
});

test("mode selection keeps bounded work inline", () => {
  const result = ER.recommendMode({
    source_classes: ["code", "tests"],
    independent_surfaces: ["one-route"],
    contradiction_risk: "low",
    false_negative_cost: "medium",
    required_completeness: "targeted",
    cross_source_reconciliation: false,
    parallelizable: true
  });
  assert.equal(result.mode, "inline");
});

test("mode selection promotes wide high-risk evidence to expedition", () => {
  const result = ER.recommendMode({
    source_classes: ["code", "tests", "history", "docs"],
    independent_surfaces: ["routes", "workers", "plugins"],
    contradiction_risk: "high",
    false_negative_cost: "high",
    required_completeness: "exhaustive",
    cross_source_reconciliation: true,
    parallelizable: true
  });
  assert.equal(result.mode, "expedition");
  assert(result.reasons.length >= 2);
});

test("deterministic expedition merge preserves lane provenance", () => {
  const merged = ER.mergeExpeditionLanes(minimalExpeditionBase(), [lane("ER-ML1", "ER-MC1", "surface-a"), lane("ER-ML2", "ER-MC2", "surface-b")]);
  assert.equal(merged.claims.length, 2);
  assert.equal(merged.lane_receipts.length, 2);
  assert.equal(merged.claims[0].origin_lane, "ER-ML1");
  assert.equal(ER.validateEvidencePacket(merged).ok, true);
});

test("expedition merge fails closed on identifier collision", () => {
  assert.throws(
    () => ER.mergeExpeditionLanes(minimalExpeditionBase(), [lane("ER-ML1", "ER-MC1", "surface-a"), lane("ER-ML2", "ER-MC1", "surface-b")]),
    /identifier collision/
  );
});

function run() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { fn(); console.log(`ok ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}`); console.error(error && error.stack ? error.stack : error); }
  }
  console.log(`${failed ? "RED" : "GREEN"} — ${tests.length - failed}/${tests.length} evidence-recon tests`);
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(run());
module.exports = { run };
