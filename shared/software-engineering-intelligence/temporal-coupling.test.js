"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveTemporalCoupling } = require("./temporal-coupling.js");
const { deriveRiskModelContractHash, materializeSnapshot, validateSnapshot } = require("./intelligence-engine.js");

function commit(revision, files) {
  return {
    revision,
    timestamp: `2026-08-10T00:00:0${revision.slice(-1)}.000Z`,
    author: "collector@example.test",
    files: files.map((file) => ({ path: file, eligible_for_temporal_coupling: true })),
  };
}

test("down-weighted mass changes preserve observed frequency while bounding pair generation deterministically", () => {
  const input = {
    commits: [
      commit("0".repeat(39) + "1", ["src/d.js", "src/b.js", "src/a.js", "src/c.js"]),
      commit("0".repeat(39) + "2", ["src/a.js", "src/b.js"]),
    ],
    policy: {
      policy_id: "temporal-coupling-mass-change-v1",
      policy_version: "1.0.0",
      threshold: 4,
      cap: 2,
      action: "down_weight",
    },
  };

  const first = deriveTemporalCoupling(input);
  const reordered = deriveTemporalCoupling({
    ...input,
    commits: input.commits.slice().reverse().map((entry) => ({ ...entry, files: entry.files.slice().reverse() })),
  });

  assert.deepEqual(first, reordered);
  assert.deepEqual(first.relationships, [{
    kind: "temporal_coupling",
    source: "src/a.js",
    target: "src/b.js",
    co_change_count: 2,
    coupling_ratio: 1,
    policy_status: "down_weighted",
    policy_reason: "mass-change-pairs-at-or-above-threshold-4-are-deterministically-capped-at-2-within-fixed-safe-maximum-40-with-minimum-observed-file-frequency-denominator",
  }]);
  assert.deepEqual(first.file_frequencies, {
    "src/a.js": 2,
    "src/b.js": 2,
    "src/c.js": 1,
    "src/d.js": 1,
  });
  assert.equal(first.mass_change_policy.action, "down_weight");
  assert.equal(first.mass_change_policy.total_commit_count, 2);
  assert.equal(first.mass_change_policy.eligible_commit_count, 2);
  assert.equal(first.mass_change_policy.mass_commit_count, 1);
  assert.equal(first.mass_change_policy.excluded_pairwise_count, 0);
  assert.equal(first.mass_change_policy.down_weighted_pairwise_count, 6);
  assert.match(first.mass_change_policy.policy_hash, /^sha256:[a-f0-9]{64}$/);
});

test("exclude emits no mass-commit pairs and retain fails before unbounded pairing", () => {
  const commits = [commit("0".repeat(39) + "3", ["src/a.js", "src/b.js", "src/c.js", "src/d.js"])];

  const excluded = deriveTemporalCoupling({
    commits,
    policy: { threshold: 4, cap: 2, action: "exclude" },
  });
  assert.deepEqual(excluded.relationships, []);
  assert.deepEqual(excluded.file_frequencies, {
    "src/a.js": 1,
    "src/b.js": 1,
    "src/c.js": 1,
    "src/d.js": 1,
  });
  assert.equal(excluded.mass_change_policy.excluded_pairwise_count, 6);
  assert.equal(excluded.mass_change_policy.down_weighted_pairwise_count, 0);

  assert.throws(
    () => deriveTemporalCoupling({ commits, policy: { threshold: 4, cap: 2, action: "retain" } }),
    /FAIL-MASS-CHANGE-POLICY: retain cannot enumerate a mass change/,
  );
});

test("the fixed safe mass cap rejects unsafe caller caps before pairing and keeps a 5k source shape bounded", () => {
  assert.throws(
    () => deriveTemporalCoupling({ commits: [], policy: { threshold: 2, cap: 5_000, action: "down_weight" } }),
    /FAIL-MASS-CHANGE-POLICY/,
  );

  const fiveThousandFiles = Array.from({ length: 5_000 }, (_, index) => `src/${String(index).padStart(4, "0")}.js`);
  const result = deriveTemporalCoupling({
    commits: [commit("0".repeat(39) + "6", fiveThousandFiles)],
    policy: { threshold: 2, cap: 40, action: "down_weight" },
  });
  assert.equal(result.pair_generation_bound, 780);
  assert.equal(result.relationships.length, 780);
  assert.match(result.mass_change_policy.reason, /capped-at-40/);
});

test("unsafe high thresholds cannot bypass the fixed pair-generation bound", () => {
  const oneHundredFiles = Array.from({ length: 100 }, (_, index) => `src/${String(index).padStart(3, "0")}.js`);
  const fiveThousandFiles = Array.from({ length: 5_000 }, (_, index) => `src/${String(index).padStart(4, "0")}.js`);

  assert.throws(
    () => deriveTemporalCoupling({
      commits: [commit("0".repeat(39) + "1", oneHundredFiles)],
      policy: { threshold: 101, cap: 40, action: "down_weight" },
    }),
    /FAIL-MASS-CHANGE-POLICY: threshold 101 exceeds fixed safe maximum 40/,
  );
  assert.throws(
    () => deriveTemporalCoupling({
      commits: [commit("0".repeat(39) + "2", fiveThousandFiles)],
      policy: { threshold: 5_001, cap: 40, action: "down_weight" },
    }),
    /FAIL-MASS-CHANGE-POLICY: threshold 5001 exceeds fixed safe maximum 40/,
  );
});

test("a down-weight policy receipt does not claim a cap when no reduction occurred", () => {
  const smallCommit = deriveTemporalCoupling({
    commits: [commit("0".repeat(39) + "3", ["src/a.js", "src/b.js"])],
    policy: { threshold: 4, cap: 2, action: "down_weight" },
  });

  assert.equal(smallCommit.pair_generation_bound, 1);
  assert.deepEqual(smallCommit.relationships.map(({ source, target }) => [source, target]), [["src/a.js", "src/b.js"]]);
  assert.doesNotMatch(smallCommit.mass_change_policy.reason, /capped-at-/);
  assert.match(smallCommit.mass_change_policy.reason, /no-mass-changes-observed/);

  const withinCapMassCommit = deriveTemporalCoupling({
    commits: [commit("0".repeat(39) + "4", ["src/a.js", "src/b.js", "src/c.js", "src/d.js"])],
    policy: { threshold: 4, cap: 40, action: "down_weight" },
  });
  assert.equal(withinCapMassCommit.pair_generation_bound, 6);
  assert.equal(withinCapMassCommit.mass_change_policy.down_weighted_pairwise_count, 0);
  assert.doesNotMatch(withinCapMassCommit.mass_change_policy.reason, /capped-at-/);
  assert.match(withinCapMassCommit.mass_change_policy.reason, /within-cap-40-so-no-cap-reduction/);
  assert.ok(withinCapMassCommit.relationships.every((relationship) => relationship.policy_status === "included"));
});

test("timezone-less temporal timestamps are rejected before host-local parsing while explicit offsets remain deterministic", () => {
  assert.throws(
    () => deriveTemporalCoupling({
      commits: [{
        revision: "0".repeat(39) + "7",
        timestamp: "2026-08-10T00:00:00",
        author: "collector@example.test",
        files: [{ path: "src/a.js", eligible_for_temporal_coupling: true }],
      }],
    }),
    /FAIL-MALFORMED-TEMPORAL-RECORD/,
  );
  const zulu = deriveTemporalCoupling({
    commits: [commit("0".repeat(39) + "8", ["src/a.js", "src/b.js"])],
  });
  const offset = deriveTemporalCoupling({
    commits: [{
      revision: "0".repeat(39) + "8",
      timestamp: "2026-08-10T02:00:08+02:00",
      author: "collector@example.test",
      files: [
        { path: "src/a.js", eligible_for_temporal_coupling: true },
        { path: "src/b.js", eligible_for_temporal_coupling: true },
      ],
    }],
  });
  assert.deepEqual(offset, zulu);
});

test("temporal coupling excludes paths whose human eligibility was not positively established", () => {
  const result = deriveTemporalCoupling({
    commits: [{
      revision: "0".repeat(39) + "9",
      timestamp: "2026-08-10T00:00:09.000Z",
      author: "collector@example.test",
      files: [
        { path: "src/a.js", eligible_for_temporal_coupling: true },
        { path: "src/b.js", eligible_for_temporal_coupling: true },
        { path: "vendor/unknown.js" },
      ],
    }],
  });
  assert.deepEqual(result.file_frequencies, { "src/a.js": 1, "src/b.js": 1 });
  assert.deepEqual(result.relationships.map(({ source, target }) => [source, target]), [["src/a.js", "src/b.js"]]);
});

test("generated or vendor paths are filtered before temporal frequencies and relationships", () => {
  const result = deriveTemporalCoupling({
    commits: [{
      revision: "0".repeat(39) + "4",
      timestamp: "2026-08-10T00:00:04.000Z",
      author: "collector@example.test",
      files: [
        { path: "src/a.js", eligible_for_temporal_coupling: true },
        { path: "src/b.js", eligible_for_temporal_coupling: true },
        { path: "vendor/library.js", eligible_for_temporal_coupling: false },
      ],
    }],
    policy: { threshold: 10, cap: 4, action: "down_weight" },
  });

  assert.deepEqual(result.file_frequencies, { "src/a.js": 1, "src/b.js": 1 });
  assert.deepEqual(result.relationships.map(({ source, target }) => [source, target]), [["src/a.js", "src/b.js"]]);
});

test("the bounded receipt and relationships fit M2's closed temporal risk-model variant", () => {
  const temporal = deriveTemporalCoupling({
    commits: [commit("0".repeat(39) + "5", ["src/a.js", "src/b.js", "src/c.js", "src/d.js"])],
    policy: { threshold: 4, cap: 2, action: "down_weight" },
  });
  const snapshot = structuredClone(require("./canonical-intelligence.json"));
  const metric = snapshot.measurements[0];
  snapshot.risk_models = [{
    risk_model_id: "temporal-coupling-pressure-v1",
    model_version: "1.0.0",
    model_contract_hash: deriveRiskModelContractHash("temporal-coupling-pressure-v1"),
    model_status: "heuristic",
    calibration: null,
    result: {
      result_id: `temporal-coupling-pressure-v1:${snapshot.repository.revision}`,
      kind: "temporal_coupling_pressure",
      status: "available",
      repository_revision: snapshot.repository.revision,
      evidence_metric_ids: [metric.metric_id],
      evidence_refs: [metric.source.evidence_refs[0]],
      interpretation_boundary: "source-bound co-change pressure only; not a defect probability or candidate priority",
      records: temporal.relationships,
      mass_change_policy: temporal.mass_change_policy,
    },
  }];

  const materialized = materializeSnapshot(snapshot);
  assert.deepEqual(validateSnapshot(materialized), { ok: true, errors: [] });
});
