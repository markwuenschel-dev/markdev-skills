"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ASSESSMENT_TARGET_POLICY_VERSION,
  DEFAULT_SCORE_BANDS,
  resolveAssessmentTargetPolicy,
} = require("./assessment-target-policy.js");

const REVISION = "a".repeat(40);

function fixtureRepository(t, profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-assessment-targets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (profile !== undefined) {
    fs.mkdirSync(path.join(root, ".sei"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sei", "assessment-profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
  }
  return root;
}

const recipes = {
  complexity_concentration: {
    recipe_id: "complexity-tail-pressure@1",
    slots: [
      { role: "primary", observation_id: "engineering.complexity.production.p90", direction: "lower", good: 5, poor: 25, facet_id: "tail", weight: 1 },
    ],
  },
};

const observations = [{
  observation_id: "engineering.complexity.production.p90",
  value: 7,
  unit: "complexity-points",
  state: "complete",
  coverage: 1,
  confidence: 1,
  context: { family: "complexity", languages: ["python"] },
  source_metric_ids: ["static.cyclomatic_complexity_p90"],
  evidence_refs: ["artifact:fixture"],
}];

test("default target policy is deterministic, frozen, and exposes SEI target bands", () => {
  const first = resolveAssessmentTargetPolicy({ recipes, observations });
  const second = resolveAssessmentTargetPolicy({ recipes, observations: structuredClone(observations) });

  assert.equal(first.schema_version, ASSESSMENT_TARGET_POLICY_VERSION);
  assert.deepEqual(first.score_bands, DEFAULT_SCORE_BANDS);
  assert.equal(first.source.kind, "sei-default");
  assert.equal(first.criteria[0].criterion_id, "complexity_concentration");
  assert.equal(first.criteria[0].acceptable_score, 70);
  assert.equal(first.criteria[0].target_source, "sei-default");
  assert.deepEqual(first.criteria[0].observations[0], {
    observation_id: "engineering.complexity.production.p90",
    direction: "at_or_below",
    acceptable_value: 5,
    concern_value: 25,
    unit: "complexity-points",
  });
  assert.deepEqual(first, second);
  assert.match(first.policy_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.criteria[0].observations[0]), true);
});

test("repository target overrides change observation thresholds but cannot change semantic meaning", (t) => {
  const root = fixtureRepository(t, {
    standard: "sei-default",
    targets: {
      complexity_concentration: {
        observations: [{
          observation_id: "engineering.complexity.production.p90",
          direction: "at_or_below",
          acceptable_value: 4,
          concern_value: 18,
          unit: "complexity-points",
        }],
      },
    },
  });
  const policy = resolveAssessmentTargetPolicy({ repositoryRoot: root, recipes, observations });
  assert.equal(policy.source.kind, "repository-override");
  assert.equal(policy.criteria[0].target_source, "repository-override");
  assert.equal(policy.criteria[0].observations[0].acceptable_value, 4);
  assert.equal(policy.criteria[0].observations[0].concern_value, 18);
  assert.notEqual(policy.policy_digest, resolveAssessmentTargetPolicy({ recipes, observations }).policy_digest);
});

test("target overrides fail closed for unknown observations, direction drift, units, and inverted ranges", (t) => {
  const cases = [
    ["unknown observation", { observation_id: "engineering.fake.target", direction: "at_or_below", acceptable_value: 1, concern_value: 2, unit: "complexity-points" }],
    ["direction drift", { observation_id: "engineering.complexity.production.p90", direction: "at_or_above", acceptable_value: 4, concern_value: 18, unit: "complexity-points" }],
    ["unit mismatch", { observation_id: "engineering.complexity.production.p90", direction: "at_or_below", acceptable_value: 4, concern_value: 18, unit: "lines" }],
    ["inverted range", { observation_id: "engineering.complexity.production.p90", direction: "at_or_below", acceptable_value: 20, concern_value: 4, unit: "complexity-points" }],
  ];
  for (const [label, observation] of cases) {
    const root = fixtureRepository(t, { standard: "sei-default", targets: { complexity_concentration: { observations: [observation] } } });
    assert.throws(() => resolveAssessmentTargetPolicy({ repositoryRoot: root, recipes, observations }), /FAIL-ASSESSMENT-TARGET-POLICY/, label);
  }
});

test("explicit target policy is accepted and profile target payload is closed", (t) => {
  const root = fixtureRepository(t, { standard: "sei-default" });
  const policy = resolveAssessmentTargetPolicy({
    repositoryRoot: root,
    assessmentConfig: {
      target_policy: {
        targets: {
          complexity_concentration: {
            observations: [{
              observation_id: "engineering.complexity.production.p90",
              direction: "at_or_below",
              acceptable_value: 3,
              concern_value: 12,
              unit: "complexity-points",
            }],
          },
        },
      },
    },
    recipes,
    observations,
  });
  assert.equal(policy.source.kind, "explicit_config");
  assert.equal(policy.criteria[0].observations[0].acceptable_value, 3);
  assert.throws(() => resolveAssessmentTargetPolicy({
    repositoryRoot: root,
    assessmentConfig: { target_policy: { unexpected: true } },
    recipes,
    observations,
  }), /FAIL-ASSESSMENT-TARGET-POLICY/);
});

