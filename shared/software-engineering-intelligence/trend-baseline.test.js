"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const canonicalSnapshot = require("./canonical-intelligence.json");
const intelligenceEngine = require("./intelligence-engine.js");
const { materializeSnapshot } = intelligenceEngine;
const enginePrivate = intelligenceEngine[Symbol.for("sei.intelligence-engine.private.v1")];
const { evaluateProfiles } = require("./profiles.js");
const {
  AUTOMATIC_BASELINE_MAX_CANDIDATES,
  AUTOMATIC_BASELINE_MAX_SNAPSHOT_BYTES,
  discoverAutomaticTrendBaseline,
  deriveCanonicalRepositoryIdentity,
} = require("./trend-baseline.js");
const trendPrivate = require("./trend-baseline.js")[Symbol.for("sei.trend-baseline.private.v1")];

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "SEI Trend Test",
      GIT_AUTHOR_EMAIL: "sei-trend-test@example.invalid",
      GIT_COMMITTER_NAME: "SEI Trend Test",
      GIT_COMMITTER_EMAIL: "sei-trend-test@example.invalid",
      GIT_AUTHOR_DATE: "2001-02-03T04:05:06+00:00",
      GIT_COMMITTER_DATE: "2001-02-03T04:05:06+00:00",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-trend-identity-"));
  const source = path.join(root, "source");
  const cloneA = path.join(root, "clone-a");
  const cloneB = path.join(root, "different", "clone-b");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "index.js"), "export const value = 1;\n", "utf8");
  git(source, ["init", "--quiet"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "identity fixture"]);
  git(root, ["clone", "--quiet", source, cloneA]);
  fs.mkdirSync(path.dirname(cloneB), { recursive: true });
  git(root, ["clone", "--quiet", source, cloneB]);
  return { root, source, cloneA, cloneB, revision: git(source, ["rev-parse", "HEAD"]) };
}

function commitValue(repo, value, message) {
  fs.writeFileSync(path.join(repo, "index.js"), `export const value = ${value};\n`, "utf8");
  git(repo, ["add", "index.js"]);
  git(repo, ["commit", "--quiet", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function snapshotAt(revision, value, options = {}) {
  const replaced = JSON.stringify(canonicalSnapshot).replaceAll(canonicalSnapshot.repository.revision, revision);
  const snapshot = JSON.parse(replaced);
  snapshot.snapshot_id = "pending";
  snapshot.repository.repository_id = options.repository_id ?? "logical-repository";
  if (options.configuration_hash) {
    snapshot.repository.configuration_hash = options.configuration_hash;
    for (const metric of snapshot.measurements) {
      metric.comparability.configuration_hash = options.configuration_hash;
    }
  }
  snapshot.measurements[0].value = value;
  snapshot.run_metadata.generated_at = options.generated_at ?? snapshot.run_metadata.generated_at;
  return materializeSnapshot(snapshot);
}

function writeSnapshot(out, snapshot, filename = `${snapshot.snapshot_id}.json`) {
  const directory = path.join(out, "snapshots");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function rematerialize(snapshot, mutate) {
  const changed = structuredClone(snapshot);
  mutate(changed);
  changed.snapshot_id = "pending";
  return materializeSnapshot(changed);
}

test("repository identity is stable across clone paths and HTTPS versus SSH origins", (t) => {
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  git(sample.cloneA, ["remote", "set-url", "origin", "https://User@GitHub.com:443/Owner/Project.git/"]);
  git(sample.cloneB, ["remote", "set-url", "origin", "ssh://git@github.com:22/owner/project.git"]);

  const first = deriveCanonicalRepositoryIdentity({
    repository_root: sample.cloneA,
    repository_revision: sample.revision,
  });
  const second = deriveCanonicalRepositoryIdentity({
    repository_root: sample.cloneB,
    repository_revision: sample.revision,
  });

  assert.equal(first, second);
  assert.match(first, /^sei-repository-v1-[a-f0-9]{64}$/);

  git(sample.cloneA, ["remote", "set-url", "origin", "https://Example.INVALID/Owner/Project.git"]);
  git(sample.cloneB, ["remote", "set-url", "origin", "ssh://git@example.invalid:22/Owner/Project.git"]);
  const caseSensitivePath = deriveCanonicalRepositoryIdentity({
    repository_root: sample.cloneA,
    repository_revision: sample.revision,
  });
  assert.equal(caseSensitivePath, deriveCanonicalRepositoryIdentity({
    repository_root: sample.cloneB,
    repository_revision: sample.revision,
  }));
  git(sample.cloneB, ["remote", "set-url", "origin", "https://example.invalid/owner/project.git"]);
  assert.notEqual(caseSensitivePath, deriveCanonicalRepositoryIdentity({
    repository_root: sample.cloneB,
    repository_revision: sample.revision,
  }));
  assert.equal(deriveCanonicalRepositoryIdentity({
    repository_root: sample.cloneA,
    repository_revision: sample.revision,
    repository_id: "  explicit-logical-repository  ",
  }), "explicit-logical-repository");
});

test("local, file, and absent origins fall back to sorted full root commit IDs", (t) => {
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const localIdentity = deriveCanonicalRepositoryIdentity({
    repository_root: sample.cloneA,
    repository_revision: sample.revision,
  });
  git(sample.cloneB, ["remote", "set-url", "origin", `file:///${sample.source.replaceAll("\\", "/")}`]);
  const fileIdentity = deriveCanonicalRepositoryIdentity({
    repository_root: sample.cloneB,
    repository_revision: sample.revision,
  });
  const noOriginIdentity = deriveCanonicalRepositoryIdentity({
    repository_root: sample.source,
    repository_revision: sample.revision,
  });

  assert.equal(localIdentity, fileIdentity);
  assert.equal(fileIdentity, noOriginIdentity);
  assert.doesNotMatch(localIdentity, new RegExp(sample.root.replaceAll("\\", "\\\\"), "i"));
});

test("automatic baseline discovery establishes first history and selects the nearest strict ancestor deterministically", (t) => {
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const out = path.join(sample.root, "out");
  const firstRevision = sample.revision;
  const secondRevision = commitValue(sample.source, 2, "second");
  const currentRevision = commitValue(sample.source, 3, "current");
  const first = snapshotAt(firstRevision, 1);
  const secondA = snapshotAt(secondRevision, 2, { generated_at: "2026-08-10T00:00:01.000Z" });
  const secondB = snapshotAt(secondRevision, 20, { generated_at: "2026-08-10T00:00:02.000Z" });
  const current = snapshotAt(currentRevision, 3);

  const empty = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: first,
  });
  assert.equal(empty.status, "established");
  assert.equal(empty.eligible, true);
  assert.equal(empty.baseline, null);

  writeSnapshot(out, first);
  writeSnapshot(out, secondA);
  writeSnapshot(out, secondB);
  const expectedTieWinner = [secondA, secondB]
    .sort((left, right) => left.snapshot_id === right.snapshot_id ? 0 : left.snapshot_id < right.snapshot_id ? -1 : 1)[0];

  const selected = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: current,
  });
  assert.equal(selected.status, "selected");
  assert.equal(selected.baseline.snapshot_id, expectedTieWinner.snapshot_id);
  assert.equal(selected.baseline_repository_revision, secondRevision);
  assert.equal(selected.compatible_metric_count, 1);

  const repeated = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: current,
  });
  assert.deepEqual(repeated, selected);
});

test("first compatible observation records the nearest significant prior Git change", (t) => {
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const out = path.join(sample.root, "out");
  fs.writeFileSync(path.join(sample.source, "architecture.md"), `${"architecture\n".repeat(80)}`, "utf8");
  fs.writeFileSync(path.join(sample.source, "service.js"), `${"export const service = true;\n".repeat(40)}`, "utf8");
  fs.writeFileSync(path.join(sample.source, "tests.js"), `${"export const test = true;\n".repeat(20)}`, "utf8");
  git(sample.source, ["add", "."]);
  git(sample.source, ["commit", "--quiet", "-m", "introduce service architecture"]);
  const significantRevision = git(sample.source, ["rev-parse", "HEAD"]);
  const currentRevision = commitValue(sample.source, 2, "small follow-up");

  const result = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: snapshotAt(currentRevision, 2),
  });

  assert.equal(result.status, "established");
  assert.equal(result.baseline, null);
  assert.ok(result.historical_context, "history context should be available without a prior SEI snapshot");
  assert.equal(result.historical_context.kind, "significant-git-history");
  assert.equal(result.historical_context.repository_revision, significantRevision);
  assert.equal(result.historical_context.commit_distance, 1);
  assert.equal(result.historical_context.changed_file_count, 3);
  assert.ok(result.historical_context.text_churn >= 100);
  assert.match(result.historical_context.subject, /introduce service architecture/);
});

test("private branded trend probes preserve established and selected public results", (t) => {
  assert.equal(typeof trendPrivate.discoverAutomaticTrendBaselineFromProbe, "function");
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const out = path.join(sample.root, "out");
  const priorRevision = sample.revision;
  const currentRevision = commitValue(sample.source, 2, "current");
  const prior = snapshotAt(priorRevision, 1);
  const current = snapshotAt(currentRevision, 2);

  const publicEstablished = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: prior,
  });
  const privateEstablished = trendPrivate.discoverAutomaticTrendBaselineFromProbe({
    repository_root: sample.source,
    output_root: out,
    current_probe: enginePrivate.createTrendProbe(prior),
  });
  assert.deepEqual(privateEstablished, publicEstablished);

  writeSnapshot(out, prior);
  const publicSelected = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: current,
  });
  const privateSelected = trendPrivate.discoverAutomaticTrendBaselineFromProbe({
    repository_root: sample.source,
    output_root: out,
    current_probe: enginePrivate.createTrendProbe(current),
  });
  assert.deepEqual(privateSelected, publicSelected);
  assert.equal(privateSelected.status, "selected");
});

test("automatic baseline discovery selects a canonical candidate larger than the legacy 8 MiB boundary", (t) => {
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const out = path.join(sample.root, "out");
  const priorRevision = sample.revision;
  const currentRevision = commitValue(sample.source, 2, "current");
  const prior = rematerialize(snapshotAt(priorRevision, 1), (candidate) => {
    candidate.measurements[0].source.artifact_refs = [`evidence/${"x".repeat(13 * 1024 * 1024)}`];
  });
  writeSnapshot(out, prior);
  const candidatePath = path.join(out, "snapshots", `${prior.snapshot_id}.json`);
  assert.ok(fs.statSync(candidatePath).size > 8 * 1024 * 1024);

  const selected = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: snapshotAt(currentRevision, 2),
  });

  assert.equal(selected.status, "selected");
  assert.equal(selected.baseline_snapshot_id, prior.snapshot_id);
  assert.equal(selected.baseline_repository_revision, priorRevision);
});

test("automatic baseline discovery admits a bounded aggregate and fails closed above 256 MiB", (t) => {
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const out = path.join(sample.root, "out");
  const priorRevision = sample.revision;
  const currentRevision = commitValue(sample.source, 2, "current");
  const prior = rematerialize(snapshotAt(priorRevision, 1), (candidate) => {
    candidate.measurements[0].source.artifact_refs = [`evidence/${"x".repeat(13 * 1024 * 1024)}`];
  });
  writeSnapshot(out, prior);
  const snapshots = path.join(out, "snapshots");
  const writeSparseOversizedCandidate = (index) => {
    const candidatePath = path.join(snapshots, `zz-filler-${index}.json`);
    fs.closeSync(fs.openSync(candidatePath, "w"));
    fs.truncateSync(candidatePath, (32 * 1024 * 1024) + 1);
  };
  writeSparseOversizedCandidate(0);
  writeSparseOversizedCandidate(1);

  const withinBound = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: snapshotAt(currentRevision, 2),
  });
  assert.equal(withinBound.status, "selected");
  assert.equal(withinBound.baseline_snapshot_id, prior.snapshot_id);

  for (let index = 2; index < 8; index += 1) writeSparseOversizedCandidate(index);
  const overBound = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: snapshotAt(currentRevision, 2),
  });
  assert.equal(overBound.status, "established");
  assert.equal(overBound.baseline, null);
  assert.match(overBound.reason, /aggregate candidate byte bound exceeded.*256 MiB/i);
});

test("automatic baseline discovery selects a valid factual delta despite incomparable and insufficient siblings", (t) => {
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const out = path.join(sample.root, "out");
  const priorRevision = sample.revision;
  const currentRevision = commitValue(sample.source, 2, "current");
  const withSiblings = (revision, value, incompatibleDefinition) => rematerialize(snapshotAt(revision, value), (candidate) => {
    const incomparable = structuredClone(candidate.measurements[0]);
    incomparable.metric_id = "static.incomparable_sibling";
    incomparable.definition_id = incompatibleDefinition;
    const insufficient = structuredClone(candidate.measurements[0]);
    insufficient.metric_id = "static.insufficient_sibling";
    insufficient.definition_id = "sei.static.insufficient_sibling@1";
    insufficient.value = null;
    insufficient.measurement = {
      status: "unavailable",
      completeness: 0,
      confidence: 0,
      reason: "fixture intentionally supplies no numeric observation",
    };
    candidate.measurements.push(incomparable, insufficient);
    candidate.evidence_summary.measurement_count = 3;
    candidate.evidence_summary.status_counts.measured = 2;
    candidate.evidence_summary.status_counts.unavailable = 1;
  });
  const prior = withSiblings(priorRevision, 1, "sei.static.incomparable_sibling@1");
  const current = withSiblings(currentRevision, 2, "sei.static.incomparable_sibling@2");
  writeSnapshot(out, prior);

  const selected = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: current,
  });

  assert.equal(selected.status, "selected");
  assert.equal(selected.baseline_snapshot_id, prior.snapshot_id);
  assert.equal(selected.compatible_metric_count, 1);
});

test("automatic baseline discovery fails closed for same, descendant, divergent, drifted, corrupt, forged, and over-bound histories", (t) => {
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const out = path.join(sample.root, "out");
  const ancestorRevision = sample.revision;
  const currentRevision = commitValue(sample.source, 2, "current");
  const descendantRevision = commitValue(sample.source, 3, "descendant");
  git(sample.source, ["branch", "descendant", descendantRevision]);
  git(sample.source, ["checkout", "--quiet", currentRevision]);
  git(sample.source, ["checkout", "--quiet", "-b", "divergent", ancestorRevision]);
  const divergentRevision = commitValue(sample.source, 4, "divergent");
  git(sample.source, ["checkout", "--quiet", currentRevision]);

  const current = snapshotAt(currentRevision, 2);
  const driftHash = "b".repeat(64);
  const baseAncestor = snapshotAt(ancestorRevision, 1);
  const analyzerDrift = rematerialize(baseAncestor, (candidate) => {
    candidate.collectors[0].analyzer_identity = "sei.drifted-analyzer@1";
    candidate.measurements[0].analyzer_identity = "sei.drifted-analyzer@1";
    candidate.measurements[0].comparability.analyzer_identity = "sei.drifted-analyzer@1";
  });
  const collectorDrift = rematerialize(baseAncestor, (candidate) => {
    candidate.collectors[0].collector_version = "9.9.9";
    candidate.measurements[0].source.collector_version = "9.9.9";
  });
  const metricDrift = rematerialize(baseAncestor, (candidate) => {
    candidate.measurements[0].definition_id = "sei.static.source_lines@99";
  });
  const profileDrift = rematerialize(baseAncestor, (candidate) => {
    candidate.profiles = Object.values(evaluateProfiles(candidate, ["DORA"]));
  });
  for (const candidate of [
    snapshotAt(currentRevision, 2),
    snapshotAt(descendantRevision, 3),
    snapshotAt(divergentRevision, 4),
    snapshotAt(ancestorRevision, 1, { configuration_hash: driftHash }),
    analyzerDrift,
    collectorDrift,
    metricDrift,
    profileDrift,
  ]) writeSnapshot(out, candidate);
  writeSnapshot(out, { broken: true }, "corrupt.json");
  const forged = snapshotAt(ancestorRevision, 1);
  forged.snapshot_id = "sei-v1-forged";
  writeSnapshot(out, forged, "sei-v1-forged.json");
  const oversizedPath = path.join(out, "snapshots", "oversized.json");
  fs.closeSync(fs.openSync(oversizedPath, "w"));
  fs.truncateSync(oversizedPath, AUTOMATIC_BASELINE_MAX_SNAPSHOT_BYTES + 1);

  const rejected = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: current,
  });
  assert.equal(rejected.status, "established");
  assert.equal(rejected.baseline, null);
  assert.match(rejected.reason, /no prior compatible strict ancestor/i);

  for (let index = 0; index <= AUTOMATIC_BASELINE_MAX_CANDIDATES; index += 1) {
    fs.writeFileSync(path.join(out, "snapshots", `extra-${String(index).padStart(4, "0")}.json`), "{}", "utf8");
  }
  const overBound = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: current,
  });
  assert.equal(overBound.status, "established");
  assert.equal(overBound.baseline, null);
  assert.match(overBound.reason, /candidate bound/i);
});

test("automatic comparison requires a genuinely bindable numeric metric from matching available collectors", (t) => {
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const out = path.join(sample.root, "out");
  const priorRevision = sample.revision;
  const currentRevision = commitValue(sample.source, 2, "degraded current");
  const degrade = (candidate) => {
    candidate.collectors[0].status = "degraded";
    candidate.collectors[0].reason = "configuration observed but numeric result source is degraded";
  };
  const prior = rematerialize(snapshotAt(priorRevision, 1), degrade);
  const current = rematerialize(snapshotAt(currentRevision, 2), degrade);
  writeSnapshot(out, prior);

  const result = discoverAutomaticTrendBaseline({
    repository_root: sample.source,
    output_root: out,
    current_snapshot: current,
  });
  assert.equal(result.status, "established");
  assert.equal(result.eligible, false);
  assert.equal(result.baseline, null);
  assert.equal(result.compatible_metric_count, 0);
});

// P2 (composite-scoring-v3 §3, §12 test 21): a parentless significant commit
// must be skipped, never emitted with parent_count 0.
test("P2: a mocked git log with a parentless significant commit yields no history record", () => {
  const { significantHistoryFromLog } = trendPrivate;
  const root = "a".repeat(40);
  const rootOnly = `${root}\x00\x002001-02-03T04:05:06+00:00\x00Tester\x00initial import\x1e\n\n10\t0\ta.js\n10\t0\tb.js\n10\t0\tc.js\n`;
  assert.equal(significantHistoryFromLog(rootOnly), null);

  const child = "b".repeat(40);
  const withChild = `${child}\x00${root}\x002001-02-04T04:05:06+00:00\x00Tester\x00big change\x1e\n\n5\t1\ta.js\n5\t1\tb.js\n5\t1\tc.js\n${rootOnly}`;
  const record = significantHistoryFromLog(withChild);
  assert.equal(record.repository_revision, child);
  assert.equal(record.parent_count, 1);
  assert.equal(record.commit_distance, 1);
  assert.equal(record.changed_file_count, 3);
});

test("P2: a repository whose only significant prior commit is the root still establishes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-trend-p2-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(source, "src", "math.js"), "module.exports = 1;\n", "utf8");
  fs.writeFileSync(path.join(source, "index.js"), "export const value = 1;\n", "utf8");
  git(source, ["init", "--quiet"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "one"]);
  const currentRevision = commitValue(source, 2, "two");

  const result = discoverAutomaticTrendBaseline({
    repository_root: source,
    output_root: path.join(root, "out"),
    current_snapshot: snapshotAt(currentRevision, 2),
  });
  assert.equal(result.status, "established");
  assert.equal(result.historical_context ?? null, null);
});
