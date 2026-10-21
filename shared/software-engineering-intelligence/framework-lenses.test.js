"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildFrameworkLenses, FRAMEWORK_LENS_IDS } = require("./framework-lenses.js");

const CRITERIA = [
  { criterion_id: "test_execution", applicability: "applicable", maturity: "established", evidence_refs: ["test:package-script"] },
  { criterion_id: "ci_prerequisites", applicability: "not_scored", maturity: "not_scored", evidence_refs: [] },
  { criterion_id: "change_scope_coherence", applicability: "applicable", maturity: "provisional", evidence_refs: ["git:commits"] },
  { criterion_id: "contracts_and_runbooks", applicability: "not_applicable", maturity: "not_scored", evidence_refs: [] },
];

test("framework lenses reuse canonical criteria without emitting numeric score fields", () => {
  const lenses = buildFrameworkLenses({ criteria: CRITERIA });

  assert.deepEqual(lenses.map((lens) => lens.lens_id), FRAMEWORK_LENS_IDS);
  for (const lens of lenses) {
    assert.equal("score" in lens, false);
    assert.equal("weight" in lens, false);
    assert.equal("aggregate" in lens, false);
    for (const mapping of lens.criteria) {
      assert.ok(CRITERIA.some((criterion) => criterion.criterion_id === mapping.canonical_criterion_id));
      assert.equal("score" in mapping, false);
    }
  }
});

test("DORA calls absent performance evidence not_scored instead of inferring it from delivery prerequisites", () => {
  const dora = buildFrameworkLenses({ criteria: CRITERIA }).find((lens) => lens.lens_id === "DORA");
  assert.equal(dora.status, "not_scored");
  assert.ok(dora.criteria.some((criterion) => criterion.canonical_criterion_id === "ci_prerequisites"));
  assert.match(dora.reason, /authoritative deployment and incident evidence/i);
});

test("framework profiles can establish adoption/performance evidence without adding points", () => {
  const lenses = buildFrameworkLenses({
    criteria: CRITERIA,
    frameworkEvidence: {
      DORA: { applicability: { status: "applicable", evidence_refs: ["deployment-record:window"] } },
      Scrum: { applicability: { status: "applicable", evidence_refs: ["framework-adoption:scrum"] } },
    },
  });
  const dora = lenses.find((lens) => lens.lens_id === "DORA");
  const scrum = lenses.find((lens) => lens.lens_id === "Scrum");

  assert.equal(dora.status, "not_scored"); // no mapped DORA criterion is applicable in this fixture
  assert.equal(scrum.status, "provisional");
  assert.ok(scrum.evidence_refs.includes("framework-adoption:scrum"));
  assert.equal("score" in scrum, false);
});

test("a framework lens reports only the criteria that are present in the canonical assessment", () => {
  const agile = buildFrameworkLenses({ criteria: CRITERIA }).find((lens) => lens.lens_id === "Agile");
  assert.deepEqual(agile.criteria.map((criterion) => criterion.canonical_criterion_id), ["change_scope_coherence"]);
  assert.equal(agile.status, "provisional");
});

test("framework lenses fail closed when canonical criterion identities are duplicated or malformed", () => {
  assert.throws(
    () => buildFrameworkLenses({ criteria: [...CRITERIA, CRITERIA[0]] }),
    /FAIL-FRAMEWORK-LENS-CRITERIA/,
  );
  assert.throws(
    () => buildFrameworkLenses({ criteria: [{ criterion_id: "test_execution", applicability: "pass" }] }),
    /FAIL-FRAMEWORK-LENS-CRITERIA/,
  );
});
