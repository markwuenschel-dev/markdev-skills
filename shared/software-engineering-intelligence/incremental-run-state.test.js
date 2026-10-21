"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const incrementalRunState = require("./incremental-run-state.js");
const statePrivate = incrementalRunState[Symbol.for("sei.incremental-run-state.private.v2")];
const canonicalSnapshot = require("./canonical-intelligence.json");
const enginePrivate = require("./intelligence-engine.js")[Symbol.for("sei.intelligence-engine.private.v1")];
const reportModule = require("./report.js");
const { renderReport } = reportModule;
const reportPrivate = reportModule[Symbol.for("sei.report.private.v1")];
const dependencyFixtures = require("./fixtures/dependency-invalidation/scenarios.js");

const REVISION = "1".repeat(40);
const TREE = "2".repeat(40);
const BLOB = "3".repeat(40);

function staticBinding(overrides = {}) {
  return {
    repository_id: "repo:fixture",
    repository_revision: REVISION,
    root_tree_oid: TREE,
    object_format: "sha1",
    index_digest: `sha256:${"4".repeat(64)}`,
    classification_policy_version: "sei.repository-classification@2",
    collector_version: "1.2.0",
    analyzer_identity: "sei.lexical-js@1",
    analyzer_version: "1.1.0",
    configuration_hash: "5".repeat(64),
    ...overrides,
  };
}

function staticEntry(overrides = {}) {
  return {
    path: "src/index.js",
    blob_oid: BLOB,
    content_key: `git-blob:sha1:${BLOB}`,
    entry_key: `sha256:${"6".repeat(64)}`,
    mode: "100644",
    language: "javascript",
    generated_code: false,
    generated_classification_known: true,
    included_in_human_maintainability: true,
    source_lines: 2,
    lexical_function_count: 1,
    lexical_max_nesting_depth: 1,
    ...overrides,
  };
}

function historyBinding(overrides = {}) {
  return {
    repository_id: "repo:fixture",
    object_format: "sha1",
    history_kind: "revision-range",
    history_start: "0".repeat(40),
    history_end: REVISION,
    collector_version: "1.2.0",
    analyzer_identity: "sei.git@1",
    analyzer_version: "1.4.1",
    configuration_hash: "5".repeat(64),
    temporal_policy_hash: `sha256:${"7".repeat(64)}`,
    ...overrides,
  };
}

function commitRow(overrides = {}) {
  return {
    revision: REVISION,
    timestamp: "2026-01-01T00:00:00.000Z",
    author: "fixture@example.invalid",
    is_merge: false,
    files: [{
      path: "src/index.js",
      added: 2,
      deleted: 0,
      binary_change: false,
      change_kind: "add",
    }],
    ...overrides,
  };
}

function sessionInput(outputRoot, overrides = {}) {
  const automaticBaseline = typeof statePrivate.automaticBaselineInventoryBinding === "function"
    ? statePrivate.automaticBaselineInventoryBinding(outputRoot)
    : { digest: `sha256:${"0".repeat(64)}`, candidate_count: 0, total_bytes: 0 };
  return {
    output_root: outputRoot,
    state_root: path.join(outputRoot, "incremental-run-state-v1", crypto.createHash("sha256").update("repo:fixture").digest("hex")),
    performance_output_path: null,
    repository: {
      repository_id: "repo:fixture",
      revision: REVISION,
      root_tree_oid: TREE,
      object_format: "sha1",
    },
    repository_index_binding: {
      index_version: "sei.repository-index@1",
      classification_policy_version: "sei.repository-classification@2",
      repository_revision: REVISION,
      root_tree_oid: TREE,
      object_format: "sha1",
      classification_policy_hash: `sha256:${"1".repeat(64)}`,
      index_key: `sha256:${"2".repeat(64)}`,
      index_digest: `sha256:${"3".repeat(64)}`,
      entry_count: 1,
      total_blob_bytes: 10,
      exclusion_count: 0,
    },
    collector_configuration_hash: "4".repeat(64),
    history_window: { kind: "revision-range", start: REVISION, end: REVISION },
    config_bytes_sha256: `sha256:${"5".repeat(64)}`,
    external_input_bindings: [],
    explicit_baseline_binding: null,
    automatic_baseline_inventory_binding: automaticBaseline,
    runtime_binding: {
      node: { version: process.version, platform: process.platform, architecture: process.arch },
      git: { version: "git version fixture", object_format: "sha1" },
      python: { status: "unavailable", executable: null, identity: null },
    },
    execution_contract_hash: `sha256:${"6".repeat(64)}`,
    assessment_config_sha256: null,
    source_tree_clean: true,
    mode: "auto",
    ...overrides,
  };
}

test("compact stage artifacts are closed, immutable, content-addressed, and discoverable", (t) => {
  assert.deepEqual(Object.keys(incrementalRunState), ["openIncrementalRun"]);
  assert.equal(typeof statePrivate.createStaticStage, "function");
  assert.equal(typeof statePrivate.createHistoryStage, "function");
  assert.equal(typeof statePrivate.artifactForStage, "function");
  assert.equal(typeof statePrivate.discoverStages, "function");
  assert.equal(typeof statePrivate.readStage, "function");

  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-incremental-state-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const staticStage = statePrivate.createStaticStage({ binding: staticBinding(), entries: [staticEntry()] });
  const historyStage = statePrivate.createHistoryStage({ binding: historyBinding(), commits: [commitRow()] });
  const staticArtifact = statePrivate.artifactForStage({ output_root: outputRoot, repository_id: "repo:fixture", stage: staticStage });
  const historyArtifact = statePrivate.artifactForStage({ output_root: outputRoot, repository_id: "repo:fixture", stage: historyStage });

  for (const artifact of [staticArtifact, historyArtifact]) {
    assert.match(artifact.path, /[0-9a-f]{64}\.json$/);
    assert.equal(typeof artifact.bytes, "string");
    fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
    fs.writeFileSync(artifact.path, artifact.bytes, "utf8");
  }

  const discoveredStatic = statePrivate.discoverStages({ output_root: outputRoot, repository_id: "repo:fixture", kind: "static" });
  const discoveredHistory = statePrivate.discoverStages({ output_root: outputRoot, repository_id: "repo:fixture", kind: "history" });
  assert.equal(discoveredStatic.stages.length, 1);
  assert.equal(discoveredHistory.stages.length, 1);
  assert.deepEqual(statePrivate.readStage(discoveredStatic.stages[0], "static"), statePrivate.readStage(staticStage, "static"));
  assert.deepEqual(statePrivate.readStage(discoveredHistory.stages[0], "history"), statePrivate.readStage(historyStage, "history"));
  assert.equal(Object.isFrozen(statePrivate.readStage(staticStage, "static")), true);
  assert.throws(() => statePrivate.readStage(structuredClone(statePrivate.readStage(staticStage, "static")), "static"), /FAIL-INCREMENTAL-STATE.*brand/);
});

test("assessment sidecars persist in repository-keyed state and reject conflicting bytes", (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-assessment-state-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const binding = sessionInput(outputRoot);
  const assessmentId = `sha256:${"a".repeat(64)}`;
  const bytes = JSON.stringify({ assessment_id: assessmentId, schema_version: "sei.engineering-assessment@2" });
  const target = statePrivate.persistAssessmentInState(binding, bytes);
  assert.match(target, /assessments[\\/][a-f0-9]{64}\.json$/);
  const discovered = statePrivate.discoverPersistedAssessments(binding);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].assessment.assessment_id, assessmentId);
  assert.throws(
    () => statePrivate.persistAssessmentInState(binding, JSON.stringify({ assessment_id: assessmentId, schema_version: "changed" })),
    /ASSESSMENT-STATE.*differs/,
  );
});

test("compact static stages persist only a closed dependency snapshot bound to the same index", (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-incremental-dependency-state-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const snapshot = dependencyFixtures.pair("isolated").prior;
  const index = snapshot.repositoryIndex;
  const binding = staticBinding({
    repository_revision: index.binding.repository_revision,
    root_tree_oid: index.binding.root_tree_oid,
    object_format: index.binding.object_format,
    index_digest: index.binding.index_digest,
    classification_policy_version: index.binding.classification_policy_version,
  });
  const entries = index.entries.map((entry) => staticEntry({
    path: entry.path,
    blob_oid: entry.blob_oid,
    content_key: entry.content_key,
    entry_key: entry.entry_key,
    mode: entry.mode,
    language: entry.language,
  }));
  const stage = statePrivate.createStaticStage({ binding, entries, dependency_snapshot: snapshot });
  const artifact = statePrivate.artifactForStage({ output_root: outputRoot, repository_id: binding.repository_id, stage });
  fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
  fs.writeFileSync(artifact.path, artifact.bytes, "utf8");

  const [discovered] = statePrivate.discoverStages({
    output_root: outputRoot,
    repository_id: binding.repository_id,
    kind: "static",
  }).stages;
  const replay = statePrivate.readStaticDependencySnapshot(discovered);
  assert.equal(replay.repositoryIndex.binding.index_digest, index.binding.index_digest);
  assert.equal(JSON.stringify(statePrivate.readStage(discovered, "static")).includes("readBlobs"), false);
  assert.throws(() => statePrivate.createStaticStage({
    binding: { ...binding, index_digest: `sha256:${"f".repeat(64)}` },
    entries,
    dependency_snapshot: snapshot,
  }), /FAIL-INCREMENTAL-STATE.*does not bind/);
});

test("openIncrementalRun acquires one output-specific writer and releases it explicitly", async (t) => {
  assert.equal(typeof incrementalRunState.openIncrementalRun, "function");
  assert.equal(typeof statePrivate.automaticBaselineInventoryBinding, "function");
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-incremental-session-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const first = await incrementalRunState.openIncrementalRun(sessionInput(outputRoot));
  assert.equal(first.discovery.mode, "cold");
  assert.equal(first.exact_bundle, null);
  assert.deepEqual(first.prior_stages, { static: [], history: [] });
  await assert.rejects(
    incrementalRunState.openIncrementalRun(sessionInput(outputRoot)),
    /FAIL-INCREMENTAL-WRITER.*held/,
  );
  await first.close();
  const second = await incrementalRunState.openIncrementalRun(sessionInput(outputRoot));
  await second.close();
});

test("private state writer applies the existing lease and immutable publication discipline", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-private-state-writer-"));
  const outputRoot = path.join(root, "out");
  const stateRoot = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const writer = await statePrivate.openStateWriter({
    output_root: outputRoot,
    state_root: stateRoot,
    repository_id: "repo:fixture",
  });
  const leaseAccess = statePrivate.stateWriterAccess(writer, { state_root: stateRoot, repository_id: "repo:fixture" });
  assert.deepEqual(Object.keys(leaseAccess).sort(), ["runWithLease", "state_root"]);
  assert.equal(leaseAccess.runWithLease(() => "active"), "active");
  if (process.platform === "win32") {
    assert.equal(typeof leaseAccess.runWithLease((rootCapability) => rootCapability.identity), "string");
  }
  await assert.rejects(
    statePrivate.openStateWriter({ output_root: outputRoot, state_root: stateRoot, repository_id: "repo:fixture" }),
    /FAIL-INCREMENTAL-WRITER.*held/,
  );
  const objectPath = path.join(stateRoot, "predictive-test", "objects", "object.json");
  const manifestPath = path.join(stateRoot, "predictive-test", "manifests", "manifest.json");
  const receipt = writer.publish({
    artifacts: [{ label: "INCREMENTAL_PREDICTIVE_OBJECT", path: objectPath, bytes: "object\n" }],
    manifest: { label: "INCREMENTAL_PREDICTIVE_MANIFEST", path: manifestPath, bytes: "manifest\n" },
  });
  assert.equal(receipt.manifest_published_last, true);
  assert.equal(fs.readFileSync(objectPath, "utf8"), "object\n");
  await writer.close();
  assert.throws(() => leaseAccess.runWithLease(() => "closed"), /FAIL-INCREMENTAL-PUBLICATION.*closed/);
});

test("alternate spellings of one state root cannot acquire split writer leases", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows canonical-path alias contract");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-writer-root-alias-"));
  const outputRoot = path.join(root, "out");
  const stateRoot = path.join(root, "CanonicalState");
  fs.mkdirSync(stateRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonicalRoot = fs.realpathSync.native(stateRoot);
  const aliases = [
    `\\\\?\\${canonicalRoot}`,
    path.join(path.dirname(canonicalRoot), path.basename(canonicalRoot).toLowerCase()),
  ];

  const writer = await statePrivate.openStateWriter({
    output_root: outputRoot,
    state_root: canonicalRoot,
    repository_id: "repo:fixture",
  });
  for (const alias of aliases) {
    await assert.rejects(async () => {
      const escaped = await statePrivate.openStateWriter({
        output_root: path.join(root, "alias-out"),
        state_root: alias,
        repository_id: "repo:fixture",
      });
      await escaped.close();
    }, /FAIL-INCREMENTAL-(?:STATE.*canonical|WRITER.*held)/i);
  }
  await writer.close();
  for (const alias of aliases) {
    await assert.rejects(
      statePrivate.openStateWriter({ output_root: outputRoot, state_root: alias, repository_id: "repo:fixture" }),
      /FAIL-INCREMENTAL-STATE.*canonical/i,
    );
  }
  const shortNameRoot = `${path.parse(canonicalRoot).root}PROGRA~1`;
  if (fs.existsSync(shortNameRoot)) {
    await assert.rejects(
      statePrivate.openStateWriter({ output_root: outputRoot, state_root: shortNameRoot, repository_id: "repo:fixture" }),
      /FAIL-INCREMENTAL-STATE.*canonical/i,
    );
  } else {
    t.diagnostic(`No conventional 8.3 Program Files alias is available at ${shortNameRoot}`);
  }

  const canonicalInput = sessionInput(outputRoot, {
    state_root: canonicalRoot,
    automatic_baseline_inventory_binding: statePrivate.automaticBaselineInventoryBinding(outputRoot, [], canonicalRoot),
  });
  const session = await incrementalRunState.openIncrementalRun(canonicalInput);
  for (const alias of aliases) {
    const aliasInput = sessionInput(path.join(root, "session-alias-out"), {
      state_root: alias,
      automatic_baseline_inventory_binding: statePrivate.automaticBaselineInventoryBinding(
        path.join(root, "session-alias-out"), [], alias,
      ),
    });
    await assert.rejects(async () => {
      const escaped = await incrementalRunState.openIncrementalRun(aliasInput);
      await escaped.close();
    }, /FAIL-INCREMENTAL-(?:STATE.*canonical|WRITER.*held)/i);
  }
  await session.close();
  const reopened = await statePrivate.openStateWriter({
    output_root: outputRoot,
    state_root: canonicalRoot,
    repository_id: "repo:fixture",
  });
  await reopened.close();
});

test("repository-keyed state survives an output-root move", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-incremental-stable-state-"));
  const stateRoot = path.join(root, "state");
  const firstOutput = path.join(root, "runs", "first");
  const movedOutput = path.join(root, "runs", "moved", "nested");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = await incrementalRunState.openIncrementalRun(sessionInput(firstOutput, { state_root: stateRoot }));
  assert.equal(first.discovery.mode, "cold");
  const stage = statePrivate.createStaticStage({ binding: staticBinding(), entries: [staticEntry()] });
  const artifact = statePrivate.artifactForStage({
    output_root: firstOutput,
    state_root: stateRoot,
    repository_id: "repo:fixture",
    stage,
  });
  fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
  fs.writeFileSync(artifact.path, artifact.bytes, "utf8");
  await first.close();

  const second = await incrementalRunState.openIncrementalRun(sessionInput(movedOutput, { state_root: stateRoot }));
  assert.equal(second.discovery.mode, "prior");
  assert.equal(second.prior_stages.static.length, 1);
  await second.close();
});

test("stable state root is independent of output root for the same repository identity", () => {
  const first = statePrivate.stateRoot({ output_root: "C:/one/run", repository_id: "repo:fixture" });
  const second = statePrivate.stateRoot({ output_root: "C:/two/run", repository_id: "repo:fixture" });
  assert.equal(first, second);
  assert.match(first, /[0-9a-f]{64}$/);
});

test("publication uses a short internal staging root for nested Windows-style output paths", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-incremental-staging-"));
  const outputRoot = path.join(root, "a".repeat(32), "b".repeat(32), "c".repeat(32));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = await incrementalRunState.openIncrementalRun(sessionInput(outputRoot));
  const artifactPath = path.join(outputRoot, "reports", "report.html");
  const manifestPath = path.join(outputRoot, "manifests", "run.json");
  const result = await session.publish({
    artifacts: [{ label: "REPORT", path: artifactPath, bytes: "report\n" }],
    manifest: { label: "MANIFEST", path: manifestPath, bytes: "manifest\n" },
  });
  assert.equal(result.linked_count, 2);
  assert.equal(fs.readFileSync(artifactPath, "utf8"), "report\n");
  await session.close();
});

test("session publication is atomic, idempotent, and leaves no manifest on collision", async (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-incremental-publish-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const session = await incrementalRunState.openIncrementalRun(sessionInput(outputRoot));
  const firstPath = path.join(outputRoot, "public", "first.txt");
  const secondPath = path.join(outputRoot, "public", "second.txt");
  const manifestPath = path.join(outputRoot, "incremental-run-state-v1", "manifests", "fixture.json");
  const receipt = await session.publish({
    artifacts: [
      { label: "FIRST", path: firstPath, bytes: "first\n" },
      { label: "SECOND", path: secondPath, bytes: "second\n" },
    ],
    manifest: { label: "MANIFEST", path: manifestPath, bytes: "manifest\n" },
  });
  assert.equal(receipt.linked_count, 3);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "manifest\n");
  await session.close();

  const replay = await incrementalRunState.openIncrementalRun(sessionInput(outputRoot, {
    automatic_baseline_inventory_binding: statePrivate.automaticBaselineInventoryBinding(outputRoot, [], sessionInput(outputRoot).state_root),
  }));
  const replayReceipt = await replay.publish({
    artifacts: [
      { label: "FIRST", path: firstPath, bytes: "first\n" },
      { label: "SECOND", path: secondPath, bytes: "second\n" },
    ],
    manifest: { label: "MANIFEST", path: manifestPath, bytes: "manifest\n" },
  });
  assert.equal(replayReceipt.existing_count, 3);
  assert.equal(replayReceipt.linked_count, 0);
  await replay.close();

  fs.writeFileSync(secondPath, "different\n", "utf8");
  const blocked = await incrementalRunState.openIncrementalRun(sessionInput(outputRoot, {
    automatic_baseline_inventory_binding: statePrivate.automaticBaselineInventoryBinding(outputRoot),
  }));
  assert.throws(
    () => blocked.publish({
      artifacts: [
        { label: "FIRST", path: firstPath, bytes: "first\n" },
        { label: "SECOND", path: secondPath, bytes: "second\n" },
      ],
      manifest: { label: "NEW_MANIFEST", path: path.join(path.dirname(manifestPath), "new.json"), bytes: "new\n" },
    }),
    /FAIL-IMMUTABLE-SECOND.*differ/,
  );
  assert.equal(fs.existsSync(path.join(path.dirname(manifestPath), "new.json")), false);
  await blocked.close();

  const snapshotPath = path.join(outputRoot, "public", "snapshot.json");
  const cachePath = path.join(outputRoot, "public", "cache.json");
  const duplicateSnapshotPath = path.join(outputRoot, "public", "duplicate-snapshot.json");
  fs.writeFileSync(snapshotPath, "same\n", "utf8");
  fs.linkSync(snapshotPath, cachePath);
  fs.linkSync(snapshotPath, duplicateSnapshotPath);
  const aliased = await incrementalRunState.openIncrementalRun(sessionInput(outputRoot, {
    automatic_baseline_inventory_binding: statePrivate.automaticBaselineInventoryBinding(outputRoot),
  }));
  assert.throws(
    () => aliased.publish({
      artifacts: [
        { label: "SNAPSHOT", path: snapshotPath, bytes: "same\n" },
        { label: "CACHE", path: cachePath, bytes: "same\n" },
        { label: "SNAPSHOT", path: duplicateSnapshotPath, bytes: "same\n" },
      ],
      manifest: { label: "ALIAS_MANIFEST", path: path.join(path.dirname(manifestPath), "alias.json"), bytes: "manifest\n" },
    }),
    /FAIL-ARTIFACT-ALIAS.*aliases/,
  );
  assert.equal(fs.existsSync(path.join(path.dirname(manifestPath), "alias.json")), false);
  await aliased.close();
});

test("post-inventory manifest reopens as one fully validated exact bundle and rejects artifact tampering", async (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-incremental-exact-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const canonicalArtifact = enginePrivate.canonicalArtifactFromSnapshot(canonicalSnapshot);
  const canonicalState = enginePrivate.readCanonicalArtifact(canonicalArtifact);
  const snapshotBytes = canonicalState.snapshot_json;
  const reportBytes = renderReport(canonicalState.snapshot);
  const snapshotPath = path.join(outputRoot, "snapshots", `${canonicalSnapshot.snapshot_id}.json`);
  const reportPath = path.join(outputRoot, "reports", `${canonicalSnapshot.snapshot_id}.html`);
  const repository = {
    repository_id: canonicalSnapshot.repository.repository_id,
    revision: canonicalSnapshot.repository.revision,
    root_tree_oid: TREE,
    object_format: "sha1",
  };
  const initial = sessionInput(outputRoot, {
    repository,
    repository_index_binding: {
      ...sessionInput(outputRoot).repository_index_binding,
      repository_revision: repository.revision,
      root_tree_oid: TREE,
    },
    history_window: canonicalSnapshot.repository.history_boundary,
    automatic_baseline_inventory_binding: statePrivate.automaticBaselineInventoryBinding(outputRoot),
  });
  const session = await incrementalRunState.openIncrementalRun(initial);
  const artifacts = [
    { label: "SNAPSHOT", path: snapshotPath, bytes: snapshotBytes },
    { label: "REPORT", path: reportPath, bytes: reportBytes },
  ];
  const postInventory = statePrivate.automaticBaselineInventoryBinding(outputRoot, [{
    name: path.basename(snapshotPath),
    bytes: snapshotBytes,
  }], initial.state_root);
  assert.throws(
    () => session.publish({
      artifacts,
      post_automatic_baseline_inventory_binding: postInventory,
      result: {
        snapshot_id: canonicalSnapshot.snapshot_id,
        revision: canonicalSnapshot.repository.revision,
        comparison: {
          baseline_source: "automatic",
          baseline_status: "established",
          baseline_eligible: true,
          baseline_snapshot_id: null,
          baseline_repository_revision: null,
          label: "insufficient-history",
          reason: "fixture has no prior compatible snapshot",
          trend: {
            status: "insufficient_history",
            previous_snapshot_id: null,
            current_snapshot_id: "forged-snapshot-id",
            reason: "fixture has no prior compatible snapshot",
            trends: [],
          },
        },
      },
    }),
    /FAIL-INCREMENTAL-PUBLICATION.*comparison or snapshot binding/,
  );
  await session.publish({
    artifacts,
    post_automatic_baseline_inventory_binding: postInventory,
    result: {
      snapshot_id: canonicalSnapshot.snapshot_id,
      revision: canonicalSnapshot.repository.revision,
      comparison: {
        baseline_source: "automatic",
        baseline_status: "established",
        baseline_eligible: true,
        baseline_snapshot_id: null,
        baseline_repository_revision: null,
        label: "insufficient-history",
        reason: "fixture has no prior compatible snapshot",
        trend: {
          status: "insufficient_history",
          previous_snapshot_id: null,
          current_snapshot_id: canonicalSnapshot.snapshot_id,
          reason: "fixture has no prior compatible snapshot",
          trends: [],
        },
      },
    },
  });
  await session.close();

  const reportModulePath = require.resolve("./report.js");
  const originalReportExports = require.cache[reportModulePath].exports;
  let publicVerifierCalled = false;
  const isolatedReportExports = {
    ...originalReportExports,
    verifyRenderedReport() {
      publicVerifierCalled = true;
      throw new Error("public exact-bundle verifier must not run after canonical artifact formation");
    },
  };
  Object.defineProperty(isolatedReportExports, Symbol.for("sei.report.private.v1"), {
    value: reportPrivate,
  });
  require.cache[reportModulePath].exports = isolatedReportExports;
  let exact;
  try {
    exact = await incrementalRunState.openIncrementalRun({ ...initial, automatic_baseline_inventory_binding: postInventory });
  } finally {
    require.cache[reportModulePath].exports = originalReportExports;
  }
  assert.equal(exact.discovery.mode, "exact", exact.discovery.exact_rejection_reason);
  assert.equal(exact.exact_bundle.snapshot_id, canonicalSnapshot.snapshot_id);
  assert.equal(exact.exact_bundle.report_bytes, reportBytes);
  assert.equal(publicVerifierCalled, false);
  await exact.close();

  const drifts = [
    { config_bytes_sha256: `sha256:${"7".repeat(64)}` },
    { collector_configuration_hash: "8".repeat(64) },
    { execution_contract_hash: `sha256:${"9".repeat(64)}` },
    { external_input_bindings: [{ format: "lcov", canonical_path: "fixture", size: 1, sha256: `sha256:${"a".repeat(64)}` }] },
    { explicit_baseline_binding: { snapshot_id: "different", sha256: `sha256:${"b".repeat(64)}` } },
    { runtime_binding: { ...initial.runtime_binding, node: { ...initial.runtime_binding.node, version: "v0.0.0-drift" } } },
    { source_tree_clean: false },
  ];
  for (const drift of drifts) {
    const candidate = await incrementalRunState.openIncrementalRun({
      ...initial,
      automatic_baseline_inventory_binding: postInventory,
      ...drift,
    });
    assert.notEqual(candidate.discovery.mode, "exact", JSON.stringify(drift));
    assert.equal(candidate.exact_bundle, null);
    await candidate.close();
  }

  fs.writeFileSync(path.join(outputRoot, "snapshots", `${"f".repeat(64)}.json`), "{}\n", "utf8");
  const changedInventory = statePrivate.automaticBaselineInventoryBinding(outputRoot, [], initial.state_root);
  const inventoryDrift = await incrementalRunState.openIncrementalRun({
    ...initial,
    automatic_baseline_inventory_binding: changedInventory,
  });
  assert.notEqual(inventoryDrift.discovery.mode, "exact");
  await inventoryDrift.close();
  fs.unlinkSync(path.join(outputRoot, "snapshots", `${"f".repeat(64)}.json`));

  fs.writeFileSync(reportPath, `${reportBytes} `, "utf8");
  const rejected = await incrementalRunState.openIncrementalRun({ ...initial, automatic_baseline_inventory_binding: postInventory });
  assert.notEqual(rejected.discovery.mode, "exact");
  assert.equal(rejected.exact_bundle, null);
  await rejected.close();
});

test("stage discovery ignores malformed, noncanonical, forged-name, and symlink hints", (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-incremental-hostile-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const stage = statePrivate.createStaticStage({ binding: staticBinding(), entries: [staticEntry()] });
  const artifact = statePrivate.artifactForStage({ output_root: outputRoot, repository_id: "repo:fixture", stage });
  fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
  fs.writeFileSync(artifact.path, artifact.bytes, "utf8");
  fs.writeFileSync(path.join(path.dirname(artifact.path), `${"8".repeat(64)}.json`), artifact.bytes, "utf8");
  fs.writeFileSync(path.join(path.dirname(artifact.path), `${"9".repeat(64)}.json`), `${artifact.bytes} `, "utf8");
  fs.writeFileSync(path.join(path.dirname(artifact.path), `${"a".repeat(64)}.json`), "{", "utf8");
  try {
    fs.symlinkSync(artifact.path, path.join(path.dirname(artifact.path), `${"b".repeat(64)}.json`));
  } catch {
    // Some Windows hosts do not grant symlink creation; the other hostile hints remain mandatory.
  }

  const discovered = statePrivate.discoverStages({ output_root: outputRoot, repository_id: "repo:fixture", kind: "static" });
  assert.equal(discovered.stages.length, 1);
  assert.ok(discovered.telemetry.rejected >= 3);
});

test("state construction rejects duplicate paths, commits, and malformed closed bindings", () => {
  assert.throws(
    () => statePrivate.createStaticStage({ binding: staticBinding(), entries: [staticEntry(), staticEntry()] }),
    /FAIL-INCREMENTAL-STATE.*duplicate static path/,
  );
  assert.throws(
    () => statePrivate.createHistoryStage({ binding: historyBinding(), commits: [commitRow(), commitRow()] }),
    /FAIL-INCREMENTAL-STATE.*duplicate history revision/,
  );
  assert.throws(
    () => statePrivate.createStaticStage({ binding: { ...staticBinding(), extra: true }, entries: [staticEntry()] }),
    /FAIL-INCREMENTAL-STATE.*binding/,
  );
});

test("report-mode skip publishes a reusable exact manifest without requiring REPORT", async (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-incremental-reportless-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const canonicalArtifact = enginePrivate.canonicalArtifactFromSnapshot(canonicalSnapshot);
  const snapshotBytes = enginePrivate.readCanonicalArtifact(canonicalArtifact).snapshot_json;
  const snapshotPath = path.join(outputRoot, "snapshots", `${canonicalSnapshot.snapshot_id}.json`);
  const repository = {
    repository_id: canonicalSnapshot.repository.repository_id,
    revision: canonicalSnapshot.repository.revision,
    root_tree_oid: TREE,
    object_format: "sha1",
  };
  const initial = sessionInput(outputRoot, {
    repository,
    repository_index_binding: {
      ...sessionInput(outputRoot).repository_index_binding,
      repository_revision: repository.revision,
      root_tree_oid: TREE,
    },
    history_window: canonicalSnapshot.repository.history_boundary,
    automatic_baseline_inventory_binding: statePrivate.automaticBaselineInventoryBinding(outputRoot),
  });
  const session = await incrementalRunState.openIncrementalRun(initial);
  const artifacts = [{ label: "SNAPSHOT", path: snapshotPath, bytes: snapshotBytes }];
  const postInventory = statePrivate.automaticBaselineInventoryBinding(outputRoot, [{
    name: path.basename(snapshotPath),
    bytes: snapshotBytes,
  }], initial.state_root);
  await session.publish({
    artifacts,
    post_automatic_baseline_inventory_binding: postInventory,
    result: {
      snapshot_id: canonicalSnapshot.snapshot_id,
      revision: canonicalSnapshot.repository.revision,
      comparison: {
        baseline_source: "automatic",
        baseline_status: "established",
        baseline_eligible: true,
        baseline_snapshot_id: null,
        baseline_repository_revision: null,
        label: "insufficient-history",
        reason: "fixture has no prior compatible snapshot",
        trend: {
          status: "insufficient_history",
          previous_snapshot_id: null,
          current_snapshot_id: canonicalSnapshot.snapshot_id,
          reason: "fixture has no prior compatible snapshot",
          trends: [],
        },
      },
    },
  });
  await session.close();

  const exact = await incrementalRunState.openIncrementalRun({ ...initial, automatic_baseline_inventory_binding: postInventory });
  assert.equal(exact.discovery.mode, "exact", exact.discovery.exact_rejection_reason);
  assert.equal(exact.exact_bundle.snapshot_id, canonicalSnapshot.snapshot_id);
  assert.equal(exact.exact_bundle.report_bytes, null);
  assert.equal(exact.exact_bundle.report_path, null);
  assert.match(exact.exact_bundle.manifest_bytes, /sei\.incremental-run-manifest@2/);
  await exact.close();
});

// ---- Lane D: replay identity (binding @2, assessment profile binding) ----

const engineeringAssessment = require("./engineering-assessment.js");

function canonicalJsonForTest(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    return item;
  };
  return JSON.stringify(canonical(value));
}

function prettyCanonical(value) {
  return `${JSON.stringify(JSON.parse(canonicalJsonForTest(value)), null, 2)}\n`;
}

function sha256Of(text) {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

function canonicalSessionInput(outputRoot, overrides = {}) {
  const repository = {
    repository_id: canonicalSnapshot.repository.repository_id,
    revision: canonicalSnapshot.repository.revision,
    root_tree_oid: TREE,
    object_format: "sha1",
  };
  return sessionInput(outputRoot, {
    repository,
    state_root: path.join(outputRoot, "incremental-run-state-v1", crypto.createHash("sha256").update(repository.repository_id).digest("hex")),
    repository_index_binding: {
      ...sessionInput(outputRoot).repository_index_binding,
      repository_revision: repository.revision,
      root_tree_oid: TREE,
    },
    history_window: canonicalSnapshot.repository.history_boundary,
    automatic_baseline_inventory_binding: statePrivate.automaticBaselineInventoryBinding(outputRoot),
    ...overrides,
  });
}

function canonicalAssessment(assessmentConfig) {
  return engineeringAssessment.assessRepositoryEngineering({
    snapshot: canonicalSnapshot,
    repositoryIndex: {
      binding: { repository_revision: canonicalSnapshot.repository.revision, index_digest: `sha256:${"3".repeat(64)}` },
      entries: [],
      exclusions: [],
    },
    assessmentConfig,
  });
}

function reportlessResult() {
  return {
    snapshot_id: canonicalSnapshot.snapshot_id,
    revision: canonicalSnapshot.repository.revision,
    comparison: {
      baseline_source: "automatic",
      baseline_status: "established",
      baseline_eligible: true,
      baseline_snapshot_id: null,
      baseline_repository_revision: null,
      label: "insufficient-history",
      reason: "fixture has no prior compatible snapshot",
      trend: {
        status: "insufficient_history",
        previous_snapshot_id: null,
        current_snapshot_id: canonicalSnapshot.snapshot_id,
        reason: "fixture has no prior compatible snapshot",
        trends: [],
      },
    },
  };
}

// Publishes one reportless exact bundle (optionally with an ASSESSMENT) and
// returns the session input that reopens it exactly.
async function publishReportlessBundle(outputRoot, overrides, assessment = null) {
  const initial = canonicalSessionInput(outputRoot, overrides);
  const snapshotBytes = enginePrivate.readCanonicalArtifact(enginePrivate.canonicalArtifactFromSnapshot(canonicalSnapshot)).snapshot_json;
  const snapshotPath = path.join(outputRoot, "snapshots", `${canonicalSnapshot.snapshot_id}.json`);
  const session = await incrementalRunState.openIncrementalRun(initial);
  const postInventory = statePrivate.automaticBaselineInventoryBinding(outputRoot, [{
    name: path.basename(snapshotPath),
    bytes: snapshotBytes,
  }], initial.state_root);
  const artifacts = [{ label: "SNAPSHOT", path: snapshotPath, bytes: snapshotBytes }];
  if (assessment !== null) {
    artifacts.push({
      label: "ASSESSMENT",
      path: path.join(outputRoot, "assessments", `${assessment.assessment_id.slice("sha256:".length)}.json`),
      bytes: `${JSON.stringify(assessment, null, 2)}\n`,
    });
  }
  await session.publish({ artifacts, post_automatic_baseline_inventory_binding: postInventory, result: reportlessResult() });
  await session.close();
  return { ...initial, automatic_baseline_inventory_binding: postInventory };
}

test("session input requires assessment_config_sha256 and rejects a malformed digest", async (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-binding-v2-input-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const { assessment_config_sha256: _omitted, ...missing } = sessionInput(outputRoot);
  await assert.rejects(incrementalRunState.openIncrementalRun(missing), /incremental session input is incomplete/);
  await assert.rejects(
    incrementalRunState.openIncrementalRun(sessionInput(outputRoot, { assessment_config_sha256: "not-a-digest" })),
    /incremental session scalar bindings are invalid/,
  );
});

test("binding @2: a manifest written under the @1 run key is a clean miss, never an error", async (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-binding-v1-miss-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const reopen = await publishReportlessBundle(outputRoot, {});
  const manifestsDir = path.join(reopen.state_root, "manifests");
  const [current] = fs.readdirSync(manifestsDir).filter((name) => name.endsWith(".json"));
  const currentPath = path.join(manifestsDir, current);
  const document = JSON.parse(fs.readFileSync(currentPath, "utf8"));
  assert.equal(Object.hasOwn(document.binding, "assessment_config_sha256"), true);
  // The @2 manifest reopens exactly.
  const exact = await incrementalRunState.openIncrementalRun(reopen);
  assert.equal(exact.discovery.mode, "exact", exact.discovery.exact_rejection_reason);
  await exact.close();

  // Rewrite the state as an @1-era writer would have left it: binding without
  // the profile digest, keyed under the @1 schema.
  const { assessment_config_sha256: _dropped, ...legacyBinding } = document.binding;
  const legacyKey = sha256Of(canonicalJsonForTest({ schema_version: "sei.incremental-run-binding@1", binding: legacyBinding }));
  const legacyBody = { ...document, binding: legacyBinding, run_key: legacyKey };
  delete legacyBody.manifest_sha256;
  const legacyDocument = { ...legacyBody, manifest_sha256: sha256Of(canonicalJsonForTest(legacyBody)) };
  fs.rmSync(currentPath);
  fs.writeFileSync(path.join(manifestsDir, `${legacyKey.slice("sha256:".length)}.json`), prettyCanonical(legacyDocument));
  const legacyMiss = await incrementalRunState.openIncrementalRun(reopen);
  assert.equal(legacyMiss.exact_bundle, null);
  assert.equal(legacyMiss.discovery.exact_rejection_reason, "manifest-unavailable");
  await legacyMiss.close();

  // Even planted at the @2 file name, an @1 document fails the key check.
  fs.writeFileSync(currentPath, prettyCanonical(legacyDocument));
  const planted = await incrementalRunState.openIncrementalRun(reopen);
  assert.equal(planted.exact_bundle, null);
  assert.equal(planted.discovery.exact_rejection_reason, "manifest-contract");
  await planted.close();
});

test("a changed assessment profile digest changes the run key (profile is in the replay identity)", async (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-binding-profile-key-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const reopen = await publishReportlessBundle(outputRoot, { assessment_config_sha256: null });
  const other = await incrementalRunState.openIncrementalRun({ ...reopen, assessment_config_sha256: sha256Of("profile-b") });
  assert.equal(other.exact_bundle, null);
  assert.equal(other.discovery.exact_rejection_reason, "manifest-unavailable");
  await other.close();
});

test("exact replay selects the assessment bound to the current profile, not the first valid one", async (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-binding-assessment-select-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const profileA = { coverage_gate: { required_criteria: 10, denominator: 30 } };
  const profileB = { coverage_gate: { required_criteria: 20, denominator: 30 } };
  const assessmentA = canonicalAssessment(profileA);
  const assessmentB = canonicalAssessment(profileB);
  // The recorded standard digest cannot tell these profiles apart; only the
  // profile binding can.
  assert.equal(assessmentA.standard.digest, assessmentB.standard.digest);
  assert.notEqual(assessmentA.assessment_id, assessmentB.assessment_id);
  const digestA = sha256Of("profile-a");
  const digestB = sha256Of("profile-b");
  const reopenA = await publishReportlessBundle(outputRoot, { assessment_config_sha256: digestA }, assessmentA);
  const reopenB = await publishReportlessBundle(outputRoot, {
    assessment_config_sha256: digestB,
    automatic_baseline_inventory_binding: reopenA.automatic_baseline_inventory_binding,
  }, assessmentB);
  // Both profiles share one snapshot, so the post-publication inventory is the same.
  assert.deepEqual(reopenA.automatic_baseline_inventory_binding, reopenB.automatic_baseline_inventory_binding);
  for (const [reopen, expected] of [[reopenA, assessmentA], [reopenB, assessmentB]]) {
    const exact = await incrementalRunState.openIncrementalRun(reopen);
    assert.equal(exact.discovery.mode, "exact", exact.discovery.exact_rejection_reason);
    assert.equal(exact.exact_bundle.assessment?.assessment_id, expected.assessment_id);
    await exact.close();
  }
  // An assessment with no binding for the requested profile (for example,
  // state written before the binding existed) is never offered for replay.
  const unbound = statePrivate.assessmentsBoundToProfile(
    { ...reopenA, assessment_config_sha256: sha256Of("profile-c") },
    statePrivate.discoverPersistedAssessments(reopenA),
  );
  assert.deepEqual(unbound, []);
});
