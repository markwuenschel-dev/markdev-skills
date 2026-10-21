"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  DUPLICATION_ANALYZER_VERSION,
  analyzeDuplicationIntelligence,
  projectDuplicationEvidence,
} = require("./duplication-intelligence");
const { buildRepositoryIndex } = require("./repository-index");

const FIXTURE_ROOT = path.join(__dirname, "fixtures", "duplication-structural");
const HEAVY_POSTINGS_FIXTURE_ROOT = path.join(__dirname, "fixtures", "duplication-heavy-postings");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function createRepository(fixtureRoot = FIXTURE_ROOT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-duplication-"));
  fs.cpSync(fixtureRoot, root, { recursive: true });
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.name", "SEI Fixture"], root);
  run("git", ["config", "user.email", "fixture@example.invalid"], root);
  run("git", ["add", "--all"], root);
  run("git", ["commit", "--quiet", "-m", "fixture"], root);
  return { root, revision: run("git", ["rev-parse", "HEAD"], root) };
}

test("heavy fingerprint postings retain deterministic lower-bound duplication evidence", async (t) => {
  const repository = createRepository(HEAVY_POSTINGS_FIXTURE_ROOT);
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);

  const pathChanges = repositoryIndex.entries
    .filter((entry) => entry.classifications.source)
    .map((entry, index) => ({ path: entry.path, change_count: index + 1 }));
  const changeSignals = {
    evidence_digest: `sha256:${"2".repeat(64)}`,
    repository_revision: repository.revision,
    path_changes: pathChanges,
    simultaneous_changes: [],
  };
  const result = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration({ maxOccurrencesPerFingerprint: 4 }),
    changeSignals,
  });
  const reordered = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration({ maxOccurrencesPerFingerprint: 4 }),
    changeSignals: { ...changeSignals, path_changes: [...pathChanges].reverse() },
  });

  assert.deepEqual(reordered, result);
  assert.equal(result.status, "partial");
  assert.equal(result.termination.kind, "resource-limited");
  assert.equal(result.coverage.lower_bound, true);
  assert.equal(result.coverage.eligible_source_entry_count, 8);
  assert.equal(result.coverage.analyzed_source_entry_count, 8);
  assert.equal(result.coverage.policy_excluded_source_entry_count, 0);
  assert.equal(result.coverage.analysis_excluded_source_entry_count, 0);
  assert.equal(result.coverage.policy_excluded_source_bytes, 0);
  assert.equal(result.coverage.analysis_excluded_source_bytes, 0);
  assert.deepEqual(result.coverage.policy_excluded_entries, []);
  assert.deepEqual(result.coverage.analysis_excluded_entries, []);
  assert.equal(result.coverage.candidate_space.status, "partial");
  assert.ok(result.coverage.candidate_space.fingerprint_coverage_ratio > 0);
  assert.ok(result.coverage.candidate_space.fingerprint_coverage_ratio < 1);
  assert.ok(result.summary.clone_family_count >= 1);
  assert.ok(result.summary.duplicated_source_lines > 0);
  assert.equal(result.summary.duplication_percentage, null);
  assert.ok(result.summary.observed_duplication_percentage > 0);
  assert.match(result.reason, /^FAIL-DUPLICATION-PARTIAL-RESOURCE-LIMIT:/);
  assert.ok(result.telemetry.limit_events.some((event) => (
    event.limit === "maxOccurrencesPerFingerprint"
      && event.disposition === "partial-lower-bound"
  )));
});

test("complete analysis with no clone family is measured zero rather than unavailable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-duplication-zero-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "unique.js"), [
    "export function classifyUniqueInvoice(invoice) {",
    "  if (invoice.total > 100 && invoice.currency === 'USD') return 'large';",
    "  if (invoice.cancelled) return 'cancelled';",
    "  return invoice.items.length === 0 ? 'empty' : 'standard';",
    "}",
    "",
  ].join("\n"));
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.name", "SEI Fixture"], root);
  run("git", ["config", "user.email", "fixture@example.invalid"], root);
  run("git", ["add", "--all"], root);
  run("git", ["commit", "--quiet", "-m", "complete zero"], root);
  const repositoryIndex = await buildRepositoryIndex({
    repository_root: root,
    repository_revision: run("git", ["rev-parse", "HEAD"], root),
    generated_path_patterns: ["generated/**"],
  });

  const result = await analyzeDuplicationIntelligence({ repositoryIndex, configuration: configuration() });

  assert.equal(result.status, "measured");
  assert.equal(result.reason, null);
  assert.equal(result.termination.kind, "complete");
  assert.equal(result.coverage.status, "complete");
  assert.equal(result.coverage.lower_bound, false);
  assert.equal(result.summary.clone_family_count, 0);
  assert.equal(result.summary.duplicated_source_lines, 0);
  assert.equal(result.summary.duplication_percentage, 0);
  assert.equal(result.summary.observed_duplication_percentage, 0);
});

async function indexRepository(repository, classified = true) {
  return buildRepositoryIndex({
    repository_root: repository.root,
    repository_revision: repository.revision,
    ...(classified ? { generated_path_patterns: ["generated/**"] } : {}),
  });
}

function configuration(overrides = {}) {
  return {
    minTokens: 20,
    minSourceLines: 4,
    largeFamilyMinDuplicatedLines: 12,
    highChangeMinCount: 10,
    simultaneousChangeMinCount: 2,
    maxSourceFiles: 100,
    maxFileBytes: 64 * 1024,
    maxTotalSourceBytes: 1024 * 1024,
    maxTotalTokens: 100_000,
    maxFingerprintWindows: 100_000,
    maxOccurrencesPerFingerprint: 32,
    maxCandidatePairs: 10_000,
    maxCloneFamilies: 100,
    maxReadBatchBytes: 256 * 1024,
    maxChangePaths: 100,
    maxSimultaneousPairs: 100,
    ...overrides,
  };
}

function revisionBoundSignals(revision, reverse = false) {
  const pathChanges = [
    { path: "packages/api/src/invoices.ts", change_count: 15 },
    { path: "packages/core/src/orders.ts", change_count: 20 },
    { path: "packages/core/src/shipments.ts", change_count: 4 },
  ];
  const simultaneousChanges = [
    {
      left_path: "packages/api/src/invoices.ts",
      right_path: "packages/core/src/orders.ts",
      change_count: 3,
    },
    {
      left_path: "packages/api/src/invoices.ts",
      right_path: "packages/core/src/shipments.ts",
      change_count: 1,
    },
    {
      left_path: "packages/core/src/orders.ts",
      right_path: "packages/core/src/shipments.ts",
      change_count: 2,
    },
  ];
  return {
    evidence_digest: `sha256:${"1".repeat(64)}`,
    repository_revision: revision,
    path_changes: reverse ? pathChanges.reverse() : pathChanges,
    simultaneous_changes: reverse ? simultaneousChanges.reverse() : simultaneousChanges,
  };
}

test("token-structural clone families exclude generated/vendor code and produce exact line distributions", async (t) => {
  const repository = createRepository();
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);

  const result = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration(),
  });

  assert.equal(DUPLICATION_ANALYZER_VERSION, "sei.structural-duplication@1");
  assert.deepEqual(Object.keys(require("./duplication-intelligence")).sort(), [
    "DUPLICATION_ANALYZER_VERSION",
    "analyzeDuplicationIntelligence",
    "projectDuplicationEvidence",
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.clone_families));
  assert.equal(result.status, "measured");
  assert.equal(result.summary.clone_family_count, 1);
  assert.equal(result.summary.clone_occurrence_count, 3);
  assert.equal(result.summary.analyzed_source_lines, 25);
  assert.equal(result.summary.duplicated_source_lines, 18);
  assert.equal(result.summary.duplication_percentage, 72);
  assert.equal(result.summary.cross_module_clone_family_count, 1);
  assert.equal(result.summary.cross_module_duplicated_source_lines, 18);

  const family = result.clone_families[0];
  assert.match(family.family_id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(family.occurrence_count, 3);
  assert.equal(family.cross_module, true);
  assert.equal(family.large_family, true);
  assert.deepEqual(family.modules, ["packages/api", "packages/core"]);
  assert.deepEqual(family.occurrences.map((occurrence) => occurrence.path), [
    "packages/api/src/invoices.ts",
    "packages/core/src/orders.ts",
    "packages/core/src/shipments.ts",
  ]);
  assert.ok(family.occurrences.every((occurrence) => occurrence.start_line === 1 && occurrence.end_line === 6));
  assert.ok(family.occurrences.every((occurrence) => occurrence.source_line_count === 6));

  assert.deepEqual(result.modules, [
    {
      module_id: "literals",
      analyzed_source_files: 2,
      analyzed_source_lines: 2,
      duplicated_source_lines: 0,
      duplication_percentage: 0,
      duplication_concentration: 0,
      clone_family_count: 0,
      cross_module_clone_family_count: 0,
    },
    {
      module_id: "packages/api",
      analyzed_source_files: 1,
      analyzed_source_lines: 6,
      duplicated_source_lines: 6,
      duplication_percentage: 100,
      duplication_concentration: 33.33333333,
      clone_family_count: 1,
      cross_module_clone_family_count: 1,
    },
    {
      module_id: "packages/core",
      analyzed_source_files: 3,
      analyzed_source_lines: 17,
      duplicated_source_lines: 12,
      duplication_percentage: 70.58823529,
      duplication_concentration: 66.66666667,
      clone_family_count: 1,
      cross_module_clone_family_count: 1,
    },
  ]);

  assert.deepEqual(result.coverage.excluded_entries, [
    { byte_size: 300, path: "generated/orders-copy.ts", reason: "generated" },
    { byte_size: 300, path: "vendor/acme/orders-copy.ts", reason: "vendor" },
  ]);
  assert.deepEqual(family.occurrences.map((occurrence) => occurrence.path).filter((filePath) => filePath.startsWith("literals/")), []);
  assert.equal(result.interpretation_boundary, "structural-investigation-signal-only-not-a-defect-or-causality-claim");
});

test("revision-bound change intersections are factual, canonical, deeply frozen, and identity-bound", async (t) => {
  const repository = createRepository();
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);

  const first = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration(),
    changeSignals: revisionBoundSignals(repository.revision),
  });
  const reordered = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration(),
    changeSignals: revisionBoundSignals(repository.revision, true),
  });

  assert.deepEqual(reordered, first);
  assert.match(first.result_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.binding.analysis_key, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.binding.configuration_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.binding.change_signal_input_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.binding.repository_index_version, "sei.repository-index@1");
  assert.equal(first.binding.repository_revision, repository.revision);
  assert.equal(first.binding.change_signal_evidence_digest, `sha256:${"1".repeat(64)}`);
  assert.equal(first.summary.high_change_clone_family_count, 1);
  assert.equal(first.summary.simultaneous_change_clone_family_count, 1);

  const signals = first.clone_families[0].investigation_signals;
  assert.ok(Object.isFrozen(signals));
  assert.ok(Object.isFrozen(signals.high_change_paths[0]));
  assert.deepEqual(signals, {
    status: "measured",
    reason: null,
    high_change_paths: [
      { path: "packages/api/src/invoices.ts", change_count: 15 },
      { path: "packages/core/src/orders.ts", change_count: 20 },
    ],
    simultaneous_change_pairs: [
      {
        left_path: "packages/api/src/invoices.ts",
        right_path: "packages/core/src/orders.ts",
        change_count: 3,
      },
      {
        left_path: "packages/core/src/orders.ts",
        right_path: "packages/core/src/shipments.ts",
        change_count: 2,
      },
    ],
  });
  assert.equal(Object.hasOwn(signals, "defect_claim"), false);
  assert.equal(first.interpretation_boundary, "structural-investigation-signal-only-not-a-defect-or-causality-claim");
});

test("candidate bounds retain lower-bound facts while pre-analysis bounds remain unavailable", async (t) => {
  const repository = createRepository();
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);

  const candidateBound = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration({ maxCandidatePairs: 1 }),
  });
  assert.equal(candidateBound.status, "partial");
  assert.match(candidateBound.reason, /^FAIL-DUPLICATION-PARTIAL-RESOURCE-LIMIT:/);
  assert.equal(candidateBound.termination.kind, "resource-limited");
  assert.ok(candidateBound.summary.clone_family_count >= 1);
  assert.ok(candidateBound.summary.duplicated_source_lines > 0);
  assert.equal(candidateBound.summary.duplication_percentage, null);
  assert.ok(candidateBound.summary.observed_duplication_percentage > 0);
  assert.equal(candidateBound.coverage.eligible_source_entry_count, 6);
  assert.equal(candidateBound.coverage.analyzed_source_entry_count, 6);
  assert.equal(candidateBound.coverage.analyzed_entry_ratio, 1);
  assert.equal(candidateBound.coverage.analyzed_byte_ratio, 1);
  assert.equal(candidateBound.coverage.policy_excluded_source_entry_count, 2);
  assert.equal(candidateBound.coverage.analysis_excluded_source_entry_count, 0);
  assert.ok(candidateBound.coverage.policy_excluded_source_bytes > 0);
  assert.equal(candidateBound.coverage.analysis_excluded_source_bytes, 0);
  assert.deepEqual(candidateBound.coverage.analysis_excluded_entries, []);
  assert.equal(candidateBound.coverage.policy_excluded_entries.length, 2);
  assert.equal(candidateBound.coverage.candidate_space.status, "partial");
  assert.equal(candidateBound.coverage.lower_bound, true);
  assert.deepEqual(candidateBound.telemetry.limit_events, [{
    limit: "maxCandidatePairs",
    observed: 2,
    maximum: 1,
    disposition: "partial-lower-bound",
  }]);
  const projectedCandidateBound = projectDuplicationEvidence({
    result: candidateBound,
    configuration_hash: "a".repeat(64),
    history_window: { kind: "revision", start: null, end: repository.revision },
  });
  assert.equal(projectedCandidateBound.collectors[0].status, "degraded");
  const projectedFamilyCount = projectedCandidateBound.metrics.find((metric) => metric.metric_id === "static.duplication.clone_family_count");
  const projectedPercentage = projectedCandidateBound.metrics.find((metric) => metric.metric_id === "static.duplication.percentage");
  const projectedObservedPercentage = projectedCandidateBound.metrics.find((metric) => metric.metric_id === "static.duplication.observed_percentage");
  assert.equal(projectedFamilyCount.measurement.status, "measured");
  assert.match(projectedFamilyCount.measurement.reason, /^FAIL-DUPLICATION-PARTIAL-RESOURCE-LIMIT:/);
  assert.equal(projectedPercentage.measurement.status, "unavailable");
  assert.equal(projectedPercentage.value, null);
  assert.equal(projectedObservedPercentage.measurement.status, "measured");
  assert.ok(projectedObservedPercentage.value > 0);

  const fingerprintBound = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration({ maxFingerprintWindows: 1 }),
  });
  assert.equal(fingerprintBound.status, "partial");
  assert.equal(fingerprintBound.termination.kind, "resource-limited");
  assert.equal(fingerprintBound.coverage.candidate_space.status, "partial");
  assert.equal(fingerprintBound.coverage.lower_bound, true);
  assert.equal(fingerprintBound.summary.duplication_percentage, null);
  assert.ok(Array.isArray(fingerprintBound.clone_families));
  assert.ok(fingerprintBound.telemetry.limit_events.some((event) => (
    event.limit === "maxFingerprintWindows"
      && event.disposition === "partial-lower-bound"
  )));

  const sourceBound = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration({ maxSourceFiles: 1 }),
  });
  assert.equal(sourceBound.status, "unavailable");
  assert.equal(sourceBound.telemetry.blob_read_batches, 0);
  assert.deepEqual(sourceBound.telemetry.limit_events, [{
    limit: "maxSourceFiles",
    observed: 6,
    maximum: 1,
    disposition: "unavailable-no-truncation",
  }]);

  const changeSignalBound = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration({ maxChangePaths: 1 }),
    changeSignals: revisionBoundSignals(repository.revision),
  });
  assert.equal(changeSignalBound.status, "unavailable");
  assert.equal(changeSignalBound.telemetry.blob_read_batches, 0);
  assert.equal(changeSignalBound.binding.change_signal_input_digest, null);
  assert.deepEqual(changeSignalBound.telemetry.limit_events, [{
    limit: "maxChangePaths",
    observed: 3,
    maximum: 1,
    disposition: "unavailable-no-truncation",
  }]);
});

test("unclassified generated provenance produces unavailable coverage instead of analyzing unknown code", async (t) => {
  const repository = createRepository();
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository, false);

  const result = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration(),
  });

  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /^FAIL-DUPLICATION-NO-ANALYZABLE-SOURCE:/);
  assert.equal(result.summary.analyzed_source_lines, null);
  assert.equal(result.summary.duplication_percentage, null);
  assert.equal(result.coverage.status, "unavailable");
  assert.equal(result.telemetry.blob_read_batches, 0);
  assert.equal(result.coverage.excluded_entries.filter((entry) => entry.reason === "generated-classification-unknown").length, 7);
  assert.deepEqual(result.coverage.excluded_entries.filter((entry) => entry.reason === "vendor").map((entry) => entry.path), [
    "vendor/acme/orders-copy.ts",
  ]);
});

test("closed contracts reject stale signals and cancellation stops between bounded blob batches", async (t) => {
  const repository = createRepository();
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }));
  const repositoryIndex = await indexRepository(repository);

  await assert.rejects(analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration({ unexpected: 1 }),
  }), (error) => error.code === "FAIL-DUPLICATION-CONFIG" && /unexpected/.test(error.message));

  await assert.rejects(analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration(),
    changeSignals: revisionBoundSignals("0".repeat(40)),
  }), (error) => error.code === "FAIL-DUPLICATION-SIGNALS" && /must match/.test(error.message));

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration(),
    signal: alreadyAborted.signal,
  }), (error) => error.code === "FAIL-DUPLICATION-CANCELLED");

  const betweenBatches = new AbortController();
  let blobReadCalls = 0;
  const cancellingIndex = Object.freeze({
    binding: repositoryIndex.binding,
    entries: repositoryIndex.entries,
    exclusions: repositoryIndex.exclusions,
    readBlobs: async (...args) => {
      blobReadCalls += 1;
      const blobs = await repositoryIndex.readBlobs(...args);
      betweenBatches.abort();
      return blobs;
    },
  });
  await assert.rejects(analyzeDuplicationIntelligence({
    repositoryIndex: cancellingIndex,
    configuration: configuration({ maxFileBytes: 512, maxReadBatchBytes: 512 }),
    signal: betweenBatches.signal,
  }), (error) => error.code === "FAIL-DUPLICATION-CANCELLED");
  assert.equal(blobReadCalls, 1);
});

test("candidate-pair bounds count unique maximal clone pairs rather than overlapping fingerprint windows", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-duplication-pair-dedupe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repeated = [
    "export function calculate(input) {",
    "  const normalized = input.trim();",
    "  if (normalized.length === 0) return null;",
    "  const segments = normalized.split(',');",
    "  return segments.map((segment) => segment.trim()).filter(Boolean);",
    "}",
  ].join("\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), `${repeated}\n`);
  fs.writeFileSync(path.join(root, "src", "b.js"), `${repeated}\n`);
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.name", "SEI Fixture"], root);
  run("git", ["config", "user.email", "fixture@example.invalid"], root);
  run("git", ["add", "--all"], root);
  run("git", ["commit", "--quiet", "-m", "pair dedupe"], root);
  const repositoryIndex = await buildRepositoryIndex({
    repository_root: root,
    repository_revision: run("git", ["rev-parse", "HEAD"], root),
    generated_path_patterns: ["generated/**"],
  });

  const result = await analyzeDuplicationIntelligence({
    repositoryIndex,
    configuration: configuration({ maxCandidatePairs: 1 }),
  });
  assert.equal(result.status, "measured", JSON.stringify(result.telemetry));
  assert.equal(result.summary.clone_family_count, 1);
  assert.equal(result.telemetry.candidate_pairs, 1);
});

test("duplication intelligence projects bounded canonical evidence metrics", async () => {
  const repository = createRepository();
  const repositoryIndex = await indexRepository(repository);
  const result = await analyzeDuplicationIntelligence({ repositoryIndex, configuration: configuration() });
  const projected = projectDuplicationEvidence({
    result,
    configuration_hash: "a".repeat(64),
    history_window: { kind: "revision", start: null, end: repository.revision },
  });
  assert.equal(projected.collectors.length, 1);
  assert.equal(projected.collectors[0].status, "available");
  const percentage = projected.metrics.find((metric) => metric.metric_id === "static.duplication.percentage");
  const familyCount = projected.metrics.find((metric) => metric.metric_id === "static.duplication.clone_family_count");
  assert.equal(percentage.value, result.summary.duplication_percentage);
  assert.equal(familyCount.value, result.summary.clone_family_count);
  assert.equal(projected.clone_families.length <= 25, true);
  assert.equal(Object.isFrozen(projected), true);
});
