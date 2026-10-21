"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const canonicalSnapshot = require("./canonical-intelligence.json");
const calibrationApi = require("./calibration.js");
const {
  backtestHeuristicHotspots,
  backtestHeuristicRisk,
  deriveLabelEventDigest,
  deriveSnapshotDocumentDigest,
} = require("./calibration.js");
const { materializeSnapshot } = require("./intelligence-engine.js");

const REVISION = Object.freeze({
  trainOne: "1111111111111111111111111111111111111111",
  trainTwo: "2222222222222222222222222222222222222222",
  holdoutOne: "3333333333333333333333333333333333333333",
  holdoutTwo: "4444444444444444444444444444444444444444",
});

const FEATURE_DEFINITIONS = Object.freeze([
  ["loc", "static.source_lines", "sei.static.source_lines@1", "lines", "static-source", "sei.lexical-js@1", "1.0.0"],
  ["complexity", "static.lexical_max_nesting_depth", "sei.static.lexical_max_nesting_depth@1", "lexical-brace-or-indentation-depth", "static-source", "sei.lexical-js@1", "1.0.0"],
  ["churn", "git.churn", "sei.git.churn@1", "lines-changed", "git-history", "sei.git-history@1", "1.2.0"],
  ["commit_count", "git.change_frequency", "sei.git.change_frequency@1", "revisions", "git-history", "sei.git-history@1", "1.2.0"],
]);

function metric(revision, path, feature, value) {
  const [, metricStem, definitionId, unit, collectorId, analyzerIdentity, analyzerVersion] = FEATURE_DEFINITIONS
    .find(([name]) => name === feature);
  return {
    metric_id: `${metricStem}:${path}`,
    definition_id: definitionId,
    family: collectorId === "git-history" ? "repository_behavior" : "structural_complexity",
    subject: `file:${path}`,
    repository_revision: revision,
    value,
    unit,
    measurement: { status: "measured", completeness: 1, confidence: 1, reason: null },
    source: {
      kind: collectorId === "git-history" ? "git-history" : "local-source",
      collector_id: collectorId,
      collector_version: "1.0.0",
      repository_revision: revision,
      command: null,
      artifact_refs: [path],
      evidence_refs: [path],
    },
    scope: {
      kind: "file",
      path,
      language: "javascript",
      generated_code: false,
      included_in_human_maintainability: true,
    },
    window: { kind: "revision", start: null, end: revision },
    analyzer_identity: analyzerIdentity,
    analyzer_version: analyzerVersion,
    comparability: {
      analyzer_identity: analyzerIdentity,
      analyzer_version: analyzerVersion,
      configuration_hash: canonicalSnapshot.repository.configuration_hash,
      compatible_with_prior: false,
      reason: "independent calibration snapshot observation",
    },
  };
}

function makeSnapshot(revision, rows) {
  const snapshot = structuredClone(canonicalSnapshot);
  snapshot.snapshot_id = "pending";
  snapshot.repository.revision = revision;
  snapshot.repository.history_boundary = { kind: "revision", start: null, end: revision };
  snapshot.collectors = [
    {
      collector_id: "static-source",
      collector_version: "1.0.0",
      status: "available",
      analyzer_identity: "sei.lexical-js@1",
      analyzer_version: "1.0.0",
      reason: null,
    },
    {
      collector_id: "git-history",
      collector_version: "1.0.0",
      status: "available",
      analyzer_identity: "sei.git-history@1",
      analyzer_version: "1.2.0",
      reason: null,
    },
  ];
  snapshot.measurements = rows.flatMap((row) => FEATURE_DEFINITIONS.map(([feature]) => metric(revision, row.path, feature, row[feature])));
  snapshot.risk_models = [];
  snapshot.profiles = [];
  snapshot.evidence_summary = {
    measurement_count: snapshot.measurements.length,
    status_counts: {
      measured: snapshot.measurements.length,
      inferred: 0,
      unavailable: 0,
      "not-applicable": 0,
      unverifiable: 0,
    },
  };
  snapshot.run_metadata = {
    generated_at: "2026-08-11T00:00:00.000Z",
    cache: { cache_key: "pending" },
  };
  return materializeSnapshot(snapshot);
}

function label(snapshot, subject, outcome, observedAt) {
  const result = {
    label_id: `label:${snapshot.snapshot_id.slice(-12)}:${subject.slice("file:".length)}`,
    snapshot_id: snapshot.snapshot_id,
    subject,
    observed_at: observedAt,
    outcome,
    source: {
      authority: "issue-tracker",
      artifact_ref: `issue:${snapshot.snapshot_id.slice(-12)}:${subject.slice("file:".length)}`,
      artifact_sha256: "sha256:pending",
      repository_revision: snapshot.repository.revision,
    },
  };
  result.source.artifact_sha256 = deriveLabelEventDigest(result);
  return result;
}

function rows(offset = 0) {
  return [
    { path: "src/a.js", loc: 100 + offset, complexity: 10, churn: 90, commit_count: 9 },
    { path: "src/b.js", loc: 80 + offset, complexity: 8, churn: 70, commit_count: 7 },
    { path: "src/c.js", loc: 20 + offset, complexity: 2, churn: 5, commit_count: 1 },
    { path: "src/d.js", loc: 10 + offset, complexity: 1, churn: 2, commit_count: 1 },
  ];
}

function completeInput() {
  const trainingOne = makeSnapshot(REVISION.trainOne, rows());
  const trainingTwo = makeSnapshot(REVISION.trainTwo, rows(1));
  const holdoutOne = makeSnapshot(REVISION.holdoutOne, rows(2));
  const holdoutTwo = makeSnapshot(REVISION.holdoutTwo, rows(3));
  const snapshots = [trainingOne, trainingTwo, holdoutOne, holdoutTwo];
  const labels = [
    ...[trainingOne, trainingTwo].flatMap((snapshot) => [
      label(snapshot, "file:src/a.js", "defect_observed", "2026-01-15T12:00:00.000Z"),
      label(snapshot, "file:src/b.js", "defect_observed", "2026-01-16T12:00:00.000Z"),
      label(snapshot, "file:src/c.js", "no_defect_observed", "2026-01-17T12:00:00.000Z"),
      label(snapshot, "file:src/d.js", "no_defect_observed", "2026-01-18T12:00:00.000Z"),
    ]),
    ...[holdoutOne, holdoutTwo].flatMap((snapshot) => [
      label(snapshot, "file:src/a.js", "defect_observed", "2026-03-15T12:00:00.000Z"),
      label(snapshot, "file:src/b.js", "defect_observed", "2026-03-16T12:00:00.000Z"),
      label(snapshot, "file:src/c.js", "no_defect_observed", "2026-03-17T12:00:00.000Z"),
      label(snapshot, "file:src/d.js", "no_defect_observed", "2026-03-18T12:00:00.000Z"),
    ]),
  ];
  return {
    schema_version: "1.0.0",
    snapshots,
    training: {
      window_id: "training-2026-q1-a",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-02-01T00:00:00.000Z",
      snapshot_ids: [trainingOne.snapshot_id, trainingTwo.snapshot_id],
    },
    holdout: {
      window_id: "holdout-2026-q1-b",
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-04-01T00:00:00.000Z",
      snapshot_ids: [holdoutOne.snapshot_id, holdoutTwo.snapshot_id],
    },
    labels,
    ranking_k: 2,
  };
}

function artifactDigest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

const FIXTURE_ISSUER_ID = "fixture-calibration-verifier";
const FIXTURE_ISSUER_KEY_ID = "fixture-ed25519-2026";
const FIXTURE_KEY_PAIR = crypto.generateKeyPairSync("ed25519");
const FIXTURE_PUBLIC_KEY = FIXTURE_KEY_PAIR.publicKey.export({ type: "spki", format: "pem" });

function fixtureStableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => fixtureStableStringify(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${fixtureStableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fixtureAttestationPayload(envelope) {
  return Buffer.from(fixtureStableStringify({
    schema_version: envelope.schema_version,
    kind: envelope.kind,
    issuer_id: envelope.issuer_id,
    issuer_key_id: envelope.issuer_key_id,
    statement: envelope.statement,
  }), "utf8");
}

function signAttestation(envelope, privateKey) {
  return {
    ...envelope,
    signature: {
      algorithm: "ed25519",
      value: crypto.sign(null, fixtureAttestationPayload(envelope), privateKey).toString("base64"),
    },
  };
}

function signFixtureAttestation(envelope) {
  return signAttestation(envelope, FIXTURE_KEY_PAIR.privateKey);
}

function cloneVerifierResult(proof) {
  return {
    status: proof.status,
    reason: proof.reason,
    attestations: proof.attestations.map((entry) => ({
      schema_version: entry.schema_version,
      kind: entry.kind,
      issuer_id: entry.issuer_id,
      issuer_key_id: entry.issuer_key_id,
      statement: { ...entry.statement },
      signature: { ...entry.signature },
    })),
  };
}

// This fixture deliberately models the complete shape of a purported external
// verifier.  It remains caller-controlled test data: until the host provisions
// a repository-owned pinned authority, it must never make public calibration
// results available.
function verifiedFixture(input, options = {}) {
  const snapshotById = new Map(input.snapshots.map((snapshot) => [snapshot.snapshot_id, snapshot]));
  const artifacts = new Map();
  const defaultSnapshotObservedAt = (snapshotId) => input.training.snapshot_ids.includes(snapshotId)
    ? "2026-01-10T00:00:00.000Z"
    : "2026-03-10T00:00:00.000Z";
  const proof = {
    status: "verified",
    reason: null,
    attestations: input.labels.map((rawLabel, index) => {
      const snapshot = snapshotById.get(rawLabel.snapshot_id);
      const artifactBytes = Buffer.from(JSON.stringify({
        kind: "fixture-immutable-label-event",
        event_id: rawLabel.label_id,
        snapshot_id: rawLabel.snapshot_id,
        subject: rawLabel.subject,
        outcome: rawLabel.outcome,
      }), "utf8");
      const snapshotObservedAt = options.snapshotObservedAt?.(rawLabel, snapshot, index) ?? defaultSnapshotObservedAt(rawLabel.snapshot_id);
      const observedAt = options.observedAt?.(rawLabel, snapshot, index) ?? rawLabel.observed_at;
      artifacts.set(rawLabel.source.artifact_ref, artifactBytes);
      return signFixtureAttestation({
        schema_version: "1.0.0",
        kind: "sei-calibration-label-attestation",
        issuer_id: FIXTURE_ISSUER_ID,
        issuer_key_id: FIXTURE_ISSUER_KEY_ID,
        statement: {
          attestation_id: `fixture-attestation:${index}`,
          event_id: rawLabel.label_id,
          snapshot_id: rawLabel.snapshot_id,
          snapshot_document_sha256: deriveSnapshotDocumentDigest(snapshot),
          repository_id: snapshot.repository.repository_id,
          repository_revision: snapshot.repository.revision,
          snapshot_observed_at: snapshotObservedAt,
          subject: rawLabel.subject,
          outcome: rawLabel.outcome,
          observed_at: observedAt,
          artifact_ref: rawLabel.source.artifact_ref,
          artifact_sha256: artifactDigest(artifactBytes),
        },
      });
    }),
  };
  const authority = {
    issuer_id: FIXTURE_ISSUER_ID,
    issuer_key_id: FIXTURE_ISSUER_KEY_ID,
    public_key: FIXTURE_PUBLIC_KEY,
    attest: () => cloneVerifierResult(proof),
    read_artifact: (artifactRef) => {
      if (!artifacts.has(artifactRef)) throw new Error("fixture artifact is absent");
      return Buffer.from(artifacts.get(artifactRef));
    },
  };
  return {
    proof,
    artifacts,
    authority,
  };
}

test("public calibration exports no caller-configurable verifier authority factory", () => {
  assert.equal(Object.hasOwn(calibrationApi, "createVerifierOwnedCalibrationEvaluator"), false);
});

test("self-generated verifier material cannot make canonical snapshots available without a provisioned repository authority", () => {
  const input = completeInput();
  const fixture = verifiedFixture(input);
  const attackerKeys = crypto.generateKeyPairSync("ed25519");
  const attackerIssuerId = "attacker-generated-calibration-verifier";
  const attackerIssuerKeyId = "attacker-ed25519-2026";
  const forgedProof = cloneVerifierResult(fixture.proof);
  forgedProof.attestations = forgedProof.attestations.map((entry) => signAttestation({
    ...entry,
    issuer_id: attackerIssuerId,
    issuer_key_id: attackerIssuerKeyId,
  }, attackerKeys.privateKey));
  const attackerAuthority = {
    issuer_id: attackerIssuerId,
    issuer_key_id: attackerIssuerKeyId,
    public_key: attackerKeys.publicKey.export({ type: "spki", format: "pem" }),
    attest: () => cloneVerifierResult(forgedProof),
    read_artifact: fixture.authority.read_artifact,
  };

  // This branch is the durable red probe for the former public factory: before
  // its removal it produced an available result using this attacker key.  Once
  // no such factory exists, the public API must ignore the same authority.
  const candidate = typeof calibrationApi.createVerifierOwnedCalibrationEvaluator === "function"
    ? calibrationApi.createVerifierOwnedCalibrationEvaluator(attackerAuthority).backtestHeuristicHotspots(input)
    : backtestHeuristicHotspots(input, attackerAuthority);
  assert.equal(candidate.status, "unverifiable");
  assert.match(candidate.reason, /repository-owned pinned.*not provisioned/i);

  const publicResults = [
    backtestHeuristicHotspots(input, attackerAuthority),
    backtestHeuristicHotspots(input, attackerAuthority.public_key),
    backtestHeuristicRisk(input, forgedProof),
  ];
  for (const result of publicResults) {
    assert.equal(result.status, "unverifiable");
    assert.match(result.reason, /repository-owned pinned.*not provisioned/i);
  }

  const first = publicResults[0];
  const shuffled = structuredClone(input);
  shuffled.snapshots.reverse();
  shuffled.labels.reverse();
  const second = backtestHeuristicHotspots(shuffled, attackerAuthority);

  assert.deepEqual(second, first);
  assert.deepEqual(backtestHeuristicRisk(input, attackerAuthority), first);
  assert.equal(first.status, "unverifiable");
  assert.equal(first.model_status, "heuristic");
  assert.equal(first.calibration_status, "not_calibrated");
  assert.equal(first.score_kind, "training-minmax-heuristic-ranking-not-probability");
  assert.deepEqual(first.protocol.training_snapshot_ids.sort(), input.training.snapshot_ids.slice().sort());
  assert.deepEqual(first.protocol.holdout_snapshot_ids.sort(), input.holdout.snapshot_ids.slice().sort());
  assert.deepEqual(first.protocol.training_observation_ids, []);
  assert.deepEqual(first.protocol.holdout_observation_ids, []);
  assert.equal(first.labels.length, 0);
  assert.deepEqual(first.results.map((result) => result.method_id), [
    "heuristic-combined-v1",
    "naive-loc-v1",
    "naive-lexical-complexity-v1",
    "naive-churn-v1",
    "naive-commit-frequency-v1",
  ]);
  for (const result of first.results) {
    assert.equal("probability" in result, false);
    assert.equal("validated" in result, false);
    assert.equal("calibrated" in result, false);
    assert.equal(result.holdout_count, 0);
    assert.equal(result.positive_count, 0);
    assert.equal(result.negative_count, 0);
    assert.equal(result.precision_at_k, null);
    assert.equal(result.recall, null);
    assert.equal(result.lift_at_k, null);
    assert.equal(result.auc, null);
    assert.equal(result.calibration_error, null);
    assert.equal(result.metric_availability.auc, "unverifiable");
  }
});

test("inline callback and authority fields remain outside the closed public calibration input", () => {
  const input = completeInput();
  input.calibration_verifier = {
    public_key: "attacker-key",
    attest: () => ({ status: "verified", reason: null, attestations: [] }),
  };

  assert.throws(() => backtestHeuristicHotspots(input), /FAIL-CALIBRATION-CONTRACT/);
});

test("backtesting fails closed on overlapping folds and injected model claims", () => {
  const overlapping = completeInput();
  overlapping.holdout.snapshot_ids = [overlapping.training.snapshot_ids[0], overlapping.holdout.snapshot_ids[1]];
  assert.throws(() => backtestHeuristicRisk(overlapping), /FAIL-CALIBRATION-LEAKAGE/);

  const injectedClaim = completeInput();
  injectedClaim.model_status = "validated";
  assert.throws(() => backtestHeuristicRisk(injectedClaim), /FAIL-CALIBRATION-CONTRACT/);
});

test("valid but underpowered cohorts cannot fabricate an insufficiency calculation before authority provisioning", () => {
  const source = completeInput();
  const onlyTraining = source.snapshots.find((snapshot) => snapshot.snapshot_id === source.training.snapshot_ids[0]);
  const onlyHoldout = source.snapshots.find((snapshot) => snapshot.snapshot_id === source.holdout.snapshot_ids[0]);
  const keep = new Set([onlyTraining.snapshot_id, onlyHoldout.snapshot_id]);
  const input = {
    ...source,
    snapshots: [onlyTraining, onlyHoldout],
    training: { ...source.training, snapshot_ids: [onlyTraining.snapshot_id] },
    holdout: { ...source.holdout, snapshot_ids: [onlyHoldout.snapshot_id] },
    labels: source.labels.filter((entry) => keep.has(entry.snapshot_id) && entry.subject === "file:src/a.js"),
  };

  const result = backtestHeuristicHotspots(input, verifiedFixture(input).authority);
  assert.equal(result.status, "unverifiable");
  assert.match(result.reason, /repository-owned pinned.*not provisioned/i);
  assert.equal(result.model_status, "heuristic");
  assert.equal(result.calibration_status, "not_calibrated");
  assert.equal(result.results.every((entry) => entry.precision_at_k === null && entry.auc === null && entry.calibration_error === null), true);
});

test("a caller-self-hashed arbitrary issue reference cannot make calibration available", () => {
  const attacker = completeInput();
  attacker.labels[0].source.artifact_ref = "issue:attacker-self-derived";
  attacker.labels[0].source.artifact_sha256 = deriveLabelEventDigest(attacker.labels[0]);

  const result = backtestHeuristicHotspots(attacker);
  assert.equal(result.status, "unverifiable");
  assert.equal(result.results.every((entry) => entry.metric_availability.auc !== "available"), true);
});

test("a caller-supplied verifier callback cannot substitute for verifier-owned authority", () => {
  const input = completeInput();
  const fixture = verifiedFixture(input);
  const attackerCallback = {
    verify: () => cloneVerifierResult(fixture.proof),
  };

  const result = backtestHeuristicRisk(input, attackerCallback);
  assert.equal(result.status, "unverifiable");
  assert.match(result.reason, /repository-owned pinned.*not provisioned/i);
});

test("a direct authority-shaped object cannot substitute for a provisioned repository authority", () => {
  const input = completeInput();
  const fixture = verifiedFixture(input);

  const direct = backtestHeuristicHotspots(input, fixture.authority);
  assert.equal(direct.status, "unverifiable");
  assert.match(direct.reason, /repository-owned pinned.*not provisioned/i);
});

test("authority-shaped values with hidden or inherited members cannot provision calibration", () => {
  const input = completeInput();
  const fixture = verifiedFixture(input);
  const hidden = { ...fixture.authority };
  Object.defineProperty(hidden, "caller_trust", { value: true, enumerable: false });

  const inherited = Object.create({ attest: fixture.authority.attest });
  Object.assign(inherited, {
    issuer_id: fixture.authority.issuer_id,
    issuer_key_id: fixture.authority.issuer_key_id,
    public_key: fixture.authority.public_key,
    read_artifact: fixture.authority.read_artifact,
  });

  const results = [
    backtestHeuristicHotspots(input, hidden),
    backtestHeuristicRisk(input, inherited),
  ];
  for (const result of results) {
    assert.equal(result.status, "unverifiable");
    assert.match(result.reason, /repository-owned pinned.*not provisioned/i);
  }
});

test("a caller-supplied signed envelope cannot alter the unavailable public calibration result", () => {
  const input = completeInput();
  const fixture = verifiedFixture(input);
  fixture.proof.attestations[0].statement.outcome = "no_defect_observed";

  const result = backtestHeuristicHotspots(input, fixture.authority);
  assert.equal(result.status, "unverifiable");
  assert.match(result.reason, /repository-owned pinned.*not provisioned/i);
});

test("legacy caller label claims remain closed and cannot add a trusted flag", () => {
  const attacker = completeInput();
  attacker.labels[0].trusted = true;

  assert.throws(() => backtestHeuristicHotspots(attacker), /FAIL-CALIBRATION-CONTRACT/);
});

test("future snapshot observations cannot be replayed into a prior training fold", () => {
  const attacker = completeInput();
  attacker.snapshots = attacker.snapshots.map((snapshot) => {
    const future = structuredClone(snapshot);
    future.run_metadata.generated_at = "2026-03-15T00:00:00.000Z";
    return materializeSnapshot(future);
  });
  const fixture = verifiedFixture(attacker, {
    snapshotObservedAt: () => "2026-03-15T00:00:00.000Z",
    observedAt: () => "2026-03-16T00:00:00.000Z",
  });

  const result = backtestHeuristicHotspots(attacker, fixture.authority);
  assert.equal(result.status, "unverifiable");
  assert.equal(result.results.every((entry) => entry.metric_availability.auc !== "available"), true);
});

test("attestation document binding includes generated_at even when snapshot identity is unchanged", () => {
  const source = completeInput();
  const fixture = verifiedFixture(source);
  const attacker = structuredClone(source);
  attacker.snapshots = attacker.snapshots.map((snapshot) => {
    const changed = structuredClone(snapshot);
    changed.run_metadata.generated_at = "2026-03-15T00:00:00.000Z";
    return materializeSnapshot(changed);
  });

  assert.deepEqual(attacker.snapshots.map((snapshot) => snapshot.snapshot_id), source.snapshots.map((snapshot) => snapshot.snapshot_id));
  assert.notEqual(deriveSnapshotDocumentDigest(attacker.snapshots[0]), deriveSnapshotDocumentDigest(source.snapshots[0]));
  const result = backtestHeuristicHotspots(attacker, fixture.authority);
  assert.equal(result.status, "unverifiable");
});

test("a verifier label event cannot predate its attested snapshot observation", () => {
  const input = completeInput();
  const targetSnapshotId = input.training.snapshot_ids[0];
  const fixture = verifiedFixture(input, {
    snapshotObservedAt: (rawLabel) => rawLabel.snapshot_id === targetSnapshotId
      ? "2026-01-16T12:00:00.000Z"
      : undefined,
  });

  const result = backtestHeuristicHotspots(input, fixture.authority);
  assert.equal(result.status, "unverifiable");
  assert.match(result.reason, /repository-owned pinned.*not provisioned/i);
});

test("a verifier artifact body must bind its returned immutable raw digest", () => {
  const input = completeInput();
  const fixture = verifiedFixture(input);
  fixture.artifacts.set(fixture.proof.attestations[0].statement.artifact_ref, Buffer.from("tampered immutable artifact", "utf8"));

  const result = backtestHeuristicHotspots(input, fixture.authority);
  assert.equal(result.status, "unverifiable");
  assert.match(result.reason, /repository-owned pinned.*not provisioned/i);
});

test("verifier attestation statements are closed and cannot carry caller trust claims", () => {
  const input = completeInput();
  const fixture = verifiedFixture(input);
  fixture.proof.attestations[0].statement.trusted = true;

  const result = backtestHeuristicHotspots(input, fixture.authority);
  assert.equal(result.status, "unverifiable");
  assert.match(result.reason, /repository-owned pinned.*not provisioned/i);
});
