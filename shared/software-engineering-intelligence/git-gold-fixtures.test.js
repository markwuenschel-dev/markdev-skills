"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { collectGitEvidence, collectGitEvidenceAsync } = require("./collectors.js");
const { execute } = require("./cli.js");
const {
  createConflictMergeGoldFixture,
  createGitGoldFixture,
  removeGitGoldFixture,
} = require("./git-gold-fixtures.js");

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`batch Git fixture command failed: git ${args.join(" ")} (${result.stderr || result.error?.message || result.status})`);
  }
  return result.stdout.trim();
}

function createLargeBatchMarkerFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-git-batch-marker-"));
  try {
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.email", "batch@example.test"]);
    runGit(root, ["config", "user.name", "SEI Batch Fixture"]);
    const markerPath = "sei-git-frame-v1";
    fs.writeFileSync(path.join(root, markerPath), "marker\n", "utf8");
    runGit(root, ["add", "--all"]);
    runGit(root, ["commit", "--quiet", "-m", "marker path"]);
    for (let index = 1; index < 258; index += 1) {
      fs.writeFileSync(path.join(root, "history.txt"), `${index}\n`, "utf8");
      runGit(root, ["add", "--all"]);
      runGit(root, ["commit", "--quiet", "-m", `history ${index}`]);
    }
    return { root, markerPath, revision: runGit(root, ["rev-parse", "HEAD"]), commitCount: 258 };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function createBufferFallbackFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-git-batch-buffer-"));
  try {
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.email", "buffer@example.test"]);
    runGit(root, ["config", "user.name", "SEI Buffer Fixture"]);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    for (let index = 1; index <= 3; index += 1) {
      fs.writeFileSync(path.join(root, "src", `file-${index}.js`), `export const value${index} = ${index};\n`, "utf8");
      runGit(root, ["add", "--all"]);
      runGit(root, ["commit", "--quiet", "-m", `file ${index}`]);
    }
    return { root, revision: runGit(root, ["rev-parse", "HEAD"]) };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test("real Git gold fixture preserves binary, rename, delete, merge, revert, and exact window evidence", (context) => {
  const fixture = createGitGoldFixture();
  context.after(() => removeGitGoldFixture(fixture));

  const evidence = collectGitEvidence({
    repo_root: fixture.root,
    repository_revision: fixture.revisions.revert,
    history_window: { kind: "revision-range", start: fixture.revisions.seed, end: fixture.revisions.revert },
    generated_path_patterns: [],
  });

  assert.equal(evidence.collectors[0].status, "degraded");
  assert.match(evidence.collectors[0].reason, /merge_conflict_resolution_churn_unattributed/);
  assert.equal(evidence.aggregates.commit_count, fixture.expected.history_window_commit_count);
  assert.equal(evidence.aggregates.merge_commit_count, 1);
  assert.ok(evidence.metrics.every((metric) => metric.window.start === fixture.revisions.seed));
  assert.equal(evidence.aggregates.observed_non_merge_commit_count, 7);
  assert.equal(evidence.aggregates.observed_commit_coverage, 7 / 8);
  assert.equal(evidence.aggregates.unattributed_merge_commit_count, 1);
  assert.equal(evidence.aggregates.binary_file_change_exclusion_count, 1);
  assert.ok(evidence.metrics.every((metric) => metric.window.end === fixture.revisions.revert));

  const binary = evidence.files.find((file) => file.path === fixture.expected.binary_file);
  assert.equal(binary.binary_change, true);
  assert.equal(binary.churn, null);
  assert.equal(binary.change_frequency, 1);
  assert.deepEqual(binary.authors, [{ author: "gold@example.test", touches: 1 }]);
  assert.deepEqual(binary.observed_revisions, [fixture.revisions.binary]);
  const binaryChurn = evidence.metrics.find((metric) => metric.metric_id === `git.churn:${fixture.expected.binary_file}`);
  assert.equal(binaryChurn.value, null);
  assert.equal(binaryChurn.measurement.status, "unverifiable");

  const renamed = evidence.files.find((file) => file.path === fixture.expected.rename_target);
  assert.deepEqual(renamed.change_kinds, ["rename"]);
  assert.deepEqual(renamed.rename_sources, [fixture.expected.rename_source]);
  const deleted = evidence.files.find((file) => file.path === fixture.expected.deleted_file);
  assert.deepEqual(deleted.change_kinds, ["delete"]);
  const reverted = evidence.files.find((file) => file.path === fixture.expected.revert_file);
  assert.equal(reverted.change_frequency, 2);
  assert.deepEqual(reverted.change_kinds, ["add", "delete"]);
  assert.ok(!evidence.relationships.some((edge) => edge.source === fixture.expected.rename_source && edge.target === fixture.expected.rename_target));
  assert.deepEqual(
    evidence.relationships.map(({ source, target }) => [source, target]),
    fixture.expected.relationships,
  );
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.churn").value, null);
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.churn").measurement.status, "unverifiable");
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.observed_text_churn").value, evidence.aggregates.observed_text_churn);
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.observed_co_change_pair_count").value, evidence.relationships.length);
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.observed_touch_ownership_concentration").value, 1);
  assert.match(evidence.metrics.find((metric) => metric.metric_id === "git.age_days").measurement.reason, /observed-history-window/i);
});

test("async Git saturation 1, 2, 4, and auto are byte-identical to the synchronous public gold oracle", async (context) => {
  const fixture = createGitGoldFixture();
  context.after(() => removeGitGoldFixture(fixture));
  const input = {
    repo_root: fixture.root,
    repository_revision: fixture.revisions.revert,
    history_window: { kind: "revision-range", start: fixture.revisions.seed, end: fixture.revisions.revert },
    generated_path_patterns: [],
  };

  const expected = collectGitEvidence(input);
  const results = await Promise.all([1, 2, 4, "auto"].map(async (saturation) => ({
    saturation,
    evidence: await collectGitEvidenceAsync(input, { saturation }),
  })));
  for (const result of results) {
    assert.equal(JSON.stringify(result.evidence), JSON.stringify(expected), `saturation ${result.saturation}`);
  }
});

test("async Git preserves supplied copy records byte-for-byte through the public seam", async () => {
  const revision = "c".repeat(40);
  const input = {
    repository_revision: revision,
    generated_path_patterns: [],
    commits: [{
      revision,
      timestamp: "2026-08-01T00:00:00Z",
      author: "copy@example.test",
      is_merge: false,
      files: [{
        path: "src/copied.js",
        previous_path: "src/original.js",
        change_kind: "copy",
        added: 1,
        deleted: 0,
      }],
    }],
  };

  const expected = collectGitEvidence(input);
  const actual = await collectGitEvidenceAsync(input, { saturation: 4 });
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.deepEqual(actual.files[0].change_kinds, ["copy"]);
  assert.deepEqual(actual.files[0].rename_sources, ["src/original.js"]);
});

test("local Git batching preserves the gold fixture's public evidence and reports revision batches", (context) => {
  const fixture = createGitGoldFixture();
  context.after(() => removeGitGoldFixture(fixture));

  const evidence = collectGitEvidence({
    repo_root: fixture.root,
    repository_revision: fixture.revisions.revert,
    history_window: { kind: "revision-range", start: fixture.revisions.seed, end: fixture.revisions.revert },
    generated_path_patterns: [],
  });

  const command = evidence.metrics.find((metric) => metric.metric_id === "git.change_frequency").source.command;
  assert.match(command, /git show/);
  assert.match(command, /revision-batch/);
  assert.equal(evidence.aggregates.commit_count, fixture.expected.history_window_commit_count);
  assert.equal(evidence.aggregates.merge_commit_count, 1);
  assert.equal(evidence.aggregates.observed_non_merge_commit_count, 7);
  assert.equal(evidence.aggregates.observed_commit_coverage, 7 / 8);
  assert.equal(evidence.aggregates.unattributed_merge_commit_count, 1);
  assert.equal(evidence.aggregates.binary_file_change_exclusion_count, 1);
  assert.equal(evidence.aggregates.generated_vendor_file_change_exclusion_count, 0);
  assert.equal(evidence.files.find((file) => file.path === fixture.expected.binary_file).churn, null);
  assert.deepEqual(
    evidence.files.find((file) => file.path === fixture.expected.rename_target).rename_sources,
    [fixture.expected.rename_source],
  );
  assert.equal(evidence.collectors[0].status, "degraded");
  assert.match(evidence.collectors[0].reason, /merge_conflict_resolution_churn_unattributed/);
});

test("local Git batches over 256 revisions without mistaking a marker-named path for a frame", (context) => {
  const fixture = createLargeBatchMarkerFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const evidence = collectGitEvidence({
    repo_root: fixture.root,
    repository_revision: fixture.revision,
    generated_path_patterns: [],
  });

  assert.equal(evidence.collectors[0].status, "available");
  assert.equal(evidence.aggregates.commit_count, fixture.commitCount);
  assert.equal(evidence.files.find((file) => file.path === fixture.markerPath).change_frequency, 1);
  const command = evidence.metrics.find((metric) => metric.metric_id === "git.change_frequency").source.command;
  assert.match(command, /git show/);
  assert.match(command, /revision-batch:256/);
});

test("local Git falls back to smaller batches when a valid batch exceeds the process buffer", async (context) => {
  const fixture = createBufferFallbackFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const events = [];

  const evidence = collectGitEvidence({
    repo_root: fixture.root,
    repository_revision: fixture.revision,
    generated_path_patterns: [],
    git_max_buffer_bytes: 192,
    git_observer: (event) => events.push(event),
  });

  assert.equal(evidence.collectors[0].status, "available");
  assert.equal(evidence.aggregates.commit_count, 3);
  assert.ok(events.filter((event) => event.command[0] === "show").length > 2);

  const asyncEvents = [];
  const asyncEvidence = await collectGitEvidenceAsync({
    repo_root: fixture.root,
    repository_revision: fixture.revision,
    generated_path_patterns: [],
    git_max_buffer_bytes: 192,
    git_observer: (event) => asyncEvents.push(event),
  }, { saturation: 2 });
  assert.equal(JSON.stringify(asyncEvidence), JSON.stringify(evidence));
  assert.ok(asyncEvents.filter((event) => event.command[0] === "show").length > 2);
});

test("a real conflict-resolving merge retains commit frequency but never claims complete churn or behavioral aggregates", (context) => {
  const fixture = createConflictMergeGoldFixture();
  context.after(() => removeGitGoldFixture(fixture));

  const evidence = collectGitEvidence({
    repo_root: fixture.root,
    repository_revision: fixture.revisions.merge,
    history_window: { kind: "revision-range", start: fixture.revisions.seed, end: fixture.revisions.merge },
    generated_path_patterns: [],
  });

  assert.equal(evidence.collectors[0].status, "degraded");
  assert.match(evidence.collectors[0].reason, /merge_conflict_resolution_churn_unattributed/);
  assert.equal(evidence.metrics.find((metric) => metric.metric_id === "git.change_frequency").value, fixture.expected.history_window_commit_count);
  assert.equal(evidence.aggregates.observed_non_merge_commit_count, 2);
  assert.equal(evidence.aggregates.observed_commit_coverage, 2 / 3);
  assert.equal(evidence.aggregates.observed_text_churn, 4);
  assert.equal(evidence.aggregates.observed_touch_ownership_concentration, 1);
  assert.equal(evidence.aggregates.observed_co_change_pair_count, 0);
  for (const metricId of ["git.churn", "git.ownership_concentration", "git.co_change_pair_count"]) {
    const metric = evidence.metrics.find((entry) => entry.metric_id === metricId);
    assert.equal(metric.value, null, metricId);
    assert.equal(metric.measurement.status, "unverifiable", metricId);
    assert.match(metric.measurement.reason, /merge_conflict_resolution_churn_unattributed/, metricId);
  }
  const conflictFile = evidence.files.find((file) => file.path === fixture.expected.conflict_file);
  assert.equal(conflictFile.churn, null);
  assert.deepEqual(conflictFile.observed_revisions, [fixture.revisions.feature, fixture.revisions.primary].sort());
  const fileChurn = evidence.metrics.find((metric) => metric.metric_id === `git.churn:${fixture.expected.conflict_file}`);
  assert.equal(fileChurn.measurement.status, "unverifiable");
  assert.match(fileChurn.measurement.reason, /merge_conflict_resolution_churn_unattributed/);
  const observedFileChurn = evidence.metrics.find((metric) => metric.metric_id === `git.observed_text_churn:${fixture.expected.conflict_file}`);
  assert.equal(observedFileChurn.value, 4);
  assert.equal(observedFileChurn.measurement.completeness, 2 / 3);
  assert.match(observedFileChurn.measurement.reason, /observed-subset.*not a full-history metric/i);
  const observedFileOwnership = evidence.metrics.find((metric) => metric.metric_id === `git.observed_touch_ownership_concentration:${fixture.expected.conflict_file}`);
  assert.equal(observedFileOwnership.value, 1);
  assert.equal(observedFileOwnership.measurement.completeness, 2 / 3);
  assert.equal(
    evidence.metrics.find((metric) => metric.metric_id === `git.change_frequency:${fixture.expected.conflict_file}`).measurement.completeness,
    2 / 3,
  );
});

test("the standalone CLI materializes a canonical binary-aware snapshot from the gold fixture", async (context) => {
  const fixture = createGitGoldFixture();
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-gold-cli-"));
  context.after(() => removeGitGoldFixture(fixture));
  context.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const configPath = path.join(outputRoot, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    generated_path_patterns: [],
    history_window: { kind: "revision-range", start: fixture.revisions.seed },
  })}\n`, "utf8");

  const receipt = await execute(["--repo", fixture.root, "--config", configPath, "--out", path.join(outputRoot, "out")]);
  const snapshot = JSON.parse(fs.readFileSync(receipt.snapshot_path, "utf8"));

  assert.equal(snapshot.repository.revision, fixture.revisions.revert);
  assert.equal(snapshot.snapshot_id, receipt.snapshot_id);
  assert.equal(snapshot.measurements.find((metric) => metric.metric_id === "git.churn").measurement.status, "unverifiable");
  assert.ok(snapshot.risk_models.some((model) => model.risk_model_id === "temporal-coupling-pressure-v1"));
});
