"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { compareAssessmentTrajectory } = require("./engineering-assessment-trajectory.js");

function assessment({ schema_version = "sei.engineering-assessment@2", score = 70, coverage = 0.6, complexity = 70, complexityCoverage = coverage, semantic_digest = "sha256:semantic-a", rubricDigest = "sha256:rubric-a", vocabularyDigest = "sha256:vocabulary-a" } = {}) {
  return {
    schema_version,
    assessment_id: "sha256:assessment-fixture",
    snapshot_binding: { repository_id: "fixture", configuration_hash: "sha256:config" },
    rubric: { digest: rubricDigest },
    standard: { digest: "sha256:standard-a" },
    applicability: { digest: "sha256:applicability-a" },
    observation_vocabulary: { digest: vocabularyDigest },
    semantic_digest,
    overview: { score, coverage },
    dimensions: [{ dimension_id: "maintainability", score, coverage }],
    criteria: [{ criterion_id: "complexity_concentration", dimension_id: "maintainability", score: complexity, coverage: complexityCoverage }],
  };
}

test("classifies score movement with stable evidence as engineering change and returns dimension and criterion deltas", () => {
  const prior = assessment({ score: 60, complexity: 55 });
  const current = assessment({ score: 75, complexity: 72 });
  const result = compareAssessmentTrajectory({ prior, current });

  assert.equal(result.state, "comparable");
  assert.equal(result.classification, "engineering_change");
  assert.equal(result.dimension_deltas[0].score_delta, 15);
  assert.equal(result.criterion_deltas[0].score_delta, 17);
});

test("classifies coverage expansion separately from engineering change", () => {
  const prior = assessment({ coverage: 0.4, complexityCoverage: 0.4 });
  const current = assessment({ coverage: 0.7, complexityCoverage: 0.7 });
  const result = compareAssessmentTrajectory({ prior, current });

  assert.equal(result.classification, "evidence_expansion");
  assert.equal(result.coverage_delta, 0.3);
  assert.equal(result.criterion_deltas[0].cause, "evidence_expansion");
});

test("classifies simultaneous material score and evidence changes as mixed", () => {
  const result = compareAssessmentTrajectory({
    prior: assessment({ score: 60, coverage: 0.4, complexity: 55, complexityCoverage: 0.4 }),
    current: assessment({ score: 80, coverage: 0.75, complexity: 78, complexityCoverage: 0.75 }),
  });
  assert.equal(result.classification, "mixed");
});

test("marks V1 and methodology mismatches not comparable without faking deltas", () => {
  const result = compareAssessmentTrajectory({
    prior: assessment({ schema_version: "sei.engineering-assessment@1" }),
    current: assessment(),
  });
  assert.equal(result.state, "methodology-changed");
  assert.equal(result.classification, "not_comparable");
  assert.equal(result.score_delta, null);
});

test("uses top-level observation vocabulary digests and rejects changed vocabulary", () => {
  const prior = assessment();
  const current = assessment();
  prior.observation_vocabulary_digest = "sha256:top-level-vocabulary-a";
  current.observation_vocabulary_digest = "sha256:top-level-vocabulary-b";
  const result = compareAssessmentTrajectory({ prior, current });

  assert.equal(result.state, "methodology-changed");
  assert.equal(result.classification, "not_comparable");
  assert.equal(result.score_delta, null);
});

test("returns first observation when no prior assessment exists", () => {
  const result = compareAssessmentTrajectory({ prior: null, current: assessment() });
  assert.equal(result.state, "first-observation");
  assert.equal(result.classification, "not_comparable");
});
