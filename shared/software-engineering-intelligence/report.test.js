"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const canonicalSnapshot = require("./canonical-intelligence.json");
const adapterFixtures = require("./adapter-fixtures.js");
const cliModule = require("./cli.js");
const { parseArguments } = cliModule;
const cliPrivate = cliModule[Symbol.for("sei.cli.private.v1")];
const intelligenceEngine = require("./intelligence-engine.js");
const { STATUS, materializeSnapshot, validateSnapshot } = intelligenceEngine;
const enginePrivate = intelligenceEngine[Symbol.for("sei.intelligence-engine.private.v1")];
const { resolveSeiLayout } = require("./layout.js");
const reportProjection = require("./report-projection.js");
const { projectReport } = reportProjection;
const { validateReportProjection } = reportProjection;
const reportProjectionPrivate = reportProjection[Symbol.for("sei.report-projection.private.v1")];
const { renderReport, verifyRenderedReport } = require("./report.js");
const reportPrivate = require("./report.js")[Symbol.for("sei.report.private.v1")];
const assessmentModule = require("./engineering-assessment.js");
const assessmentPrivate = assessmentModule[Symbol.for("sei.engineering-assessment.private.v1")];
const { evaluateForwardTemporal } = require("./forward-temporal-evaluator.js");
const forwardTemporalPrivate = require("./forward-temporal-evaluator.js")[Symbol.for("sei.forward-temporal-evaluator.private.v1")];
const statePrivate = require("./incremental-run-state.js")[Symbol.for("sei.incremental-run-state.private.v2")];
const { AUTOMATIC_BASELINE_MAX_CANDIDATES } = require("./trend-baseline.js");

test("execution contract binds V7 human-evidence producers and renderers", () => {
  assert.equal(typeof cliPrivate?.executionContractHash, "function");
  assert.equal(typeof cliPrivate?.executionContractPaths, "function");
  const paths = cliPrivate.executionContractPaths();
  for (const relativePath of [
    "semantic-evidence.js",
    "capability-coverage.js",
    "complexity-presentation.js",
    "predictive-status.js",
    "trend-status.js",
    "investigation-signals.js",
    "investigation-synthesis.js",
    "duplication-intelligence.js",
  ]) {
    assert.ok(paths.includes(relativePath), `${relativePath} must invalidate exact replay`);
  }

  const initial = cliPrivate.executionContractHash();
  const originalReadFileSync = fs.readFileSync;
  let observedSemanticEvidenceRead = false;
  fs.readFileSync = (filePath, ...args) => {
    const bytes = originalReadFileSync(filePath, ...args);
    if (path.resolve(String(filePath)) !== path.join(__dirname, "semantic-evidence.js")) return bytes;
    observedSemanticEvidenceRead = true;
    return Buffer.concat([Buffer.from(bytes), Buffer.from("\n")]);
  };
  try {
    assert.notEqual(cliPrivate.executionContractHash(), initial);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(observedSemanticEvidenceRead, true);
});

function embeddedSnapshotDigest(html) {
  const match = /<meta name="sei-snapshot-sha256" content="([a-f0-9]{64})">/.exec(html);
  assert.ok(match, "report should contain one SHA-256 canonical snapshot digest meta value");
  return match[1];
}

test("report embeds only the bounded projection and renders accessible dashboard primitives", () => {
  const html = renderReport(canonicalSnapshot);
  const island = /<script type="application\/json" data-sei-island>([\s\S]*?)<\/script>/.exec(html);

  assert.ok(island);
  assert.deepEqual(JSON.parse(island[1]), projectReport(canonicalSnapshot));
  assert.doesNotMatch(island[1], /"measurements"|"profiles"|"risk_models"/);
  assert.match(html, /<svg[^>]+role="img"[^>]+aria-labelledby=/);
  assert.match(html, /document\.createElement\("table"\)/);
  assert.match(html, /Repository overview/);
  assert.match(html, /Where should I look first\?/);
  assert.match(html, /Capability coverage/);
  assert.match(html, /Complexity in plain language/);
  assert.match(html, /Structural × behavioral map/);
  assert.match(html, /Advanced \/ Evidence Explorer/);
  assert.doesNotMatch(html, /<(?:script|img|link|iframe|audio|video|source)\b[^>]*(?:src|href)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i);
  const runtime = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  assert.ok(runtime);
  assert.doesNotThrow(() => new vm.Script(runtime));
  assert.deepEqual(verifyRenderedReport(html, canonicalSnapshot), { ok: true, errors: [] });
});

test("report defaults to a compact chart-first dashboard and defers prose", () => {
  const html = renderReport(canonicalSnapshot);

  assert.match(html, /class="compact-header"/);
  assert.match(html, /class="assessment-drawer"/);
  assert.match(html, /raw-disclosure/);
  assert.match(html, /Show exact values/);
  assert.doesNotMatch(html, /A compact human projection of the canonical snapshot/);
  assert.doesNotMatch(html, /Every visible value is bounded evidence, not a grade or prescribed action/);
});

test("report renders honest V9 predictive readiness without forecast or probability language", () => {
  const html = renderReport(canonicalSnapshot);
  const document = runReportDom(html);
  const projection = embeddedProjection(html);
  assert.equal(projection.predictive_intelligence.state, "NOT_READY");
  assert.equal(document.getElementById("predictive-evaluation-state").textContent, "NOT_READY");
  assert.equal(document.getElementById("predictive-forecast-chart-title").textContent, "Predictive ranking state");
  assert.doesNotMatch(document.getElementById("predictive-forecast-chart").textContent, /forward-looking ranking forecast/i);
  assert.equal(document.getElementById("predictive-evaluation-table").textContent.includes("probability"), false);
  assert.doesNotMatch(document.getElementById("forecast").textContent, /risk|defect|causal/i);
  assert.doesNotMatch(document.getElementById("forecast").textContent, /static\.[a-z0-9_.:-]+/i);
});

test("report accepts a branded automatic readiness binding as V9 NOT_READY", () => {
  const binding = forwardTemporalPrivate.bindAutomaticReadiness({
    current_snapshot: canonicalSnapshot,
    reason: "automatic history selection is not yet ready",
    available_snapshot_count: 1,
  });
  const html = renderReport(canonicalSnapshot, { predictive_binding: binding });
  const document = runReportDom(html);
  assert.equal(document.getElementById("predictive-evaluation-state").textContent, "NOT_READY");
  assert.equal(document.getElementById("predictive-forecast-chart-title").textContent, "Predictive ranking state");
  assert.deepEqual(verifyRenderedReport(html, canonicalSnapshot, { predictive_binding: binding }), { ok: true, errors: [] });
});

test("report verification rejects malformed snapshots, island tampering, and external dependencies", () => {
  assert.throws(
    () => renderReport({ ...canonicalSnapshot, snapshot_id: "wrong" }),
    /FAIL-REPORT-SNAPSHOT/,
  );

  const html = renderReport(canonicalSnapshot);
  const tampered = html.replace(canonicalSnapshot.snapshot_id, "sei-v1-tampered");
  assert.equal(verifyRenderedReport(tampered).ok, false);
  assert.equal(verifyRenderedReport(`${html}<script src="https://invalid.example/report.js"></script>`).ok, false);
});

test("report verification binds exact island bytes to its digest and an expected snapshot or digest", () => {
  const html = renderReport(canonicalSnapshot);
  const digest = embeddedSnapshotDigest(html);
  assert.deepEqual(verifyRenderedReport(html, canonicalSnapshot), { ok: true, errors: [] });
  assert.deepEqual(verifyRenderedReport(html, digest), { ok: true, errors: [] });

  const changedGeneratedAt = "2026-08-11T00:00:00.000Z";
  const tamperedIsland = html.replace(
    `"generated_at":"${canonicalSnapshot.run_metadata.generated_at}"`,
    `"generated_at":"${changedGeneratedAt}"`,
  );
  assert.notEqual(tamperedIsland, html);
  const islandTamper = verifyRenderedReport(tamperedIsland);
  assert.equal(islandTamper.ok, false);
  assert.match(islandTamper.errors.join("\n"), /FAIL-REPORT-ISLAND-DIGEST/);

  const expectedSnapshot = structuredClone(canonicalSnapshot);
  expectedSnapshot.run_metadata.generated_at = changedGeneratedAt;
  assert.equal(validateSnapshot(expectedSnapshot).ok, true);
  const expectedSnapshotMismatch = verifyRenderedReport(html, expectedSnapshot);
  assert.equal(expectedSnapshotMismatch.ok, false);
  assert.match(expectedSnapshotMismatch.errors.join("\n"), /FAIL-REPORT-EXPECTED-BINDING/);

  const expectedDigestMismatch = verifyRenderedReport(html, "f".repeat(64));
  assert.equal(expectedDigestMismatch.ok, false);
  assert.match(expectedDigestMismatch.errors.join("\n"), /FAIL-REPORT-EXPECTED-BINDING/);

  const forgedIslandBytes = /<script type="application\/json" data-sei-island>([\s\S]*?)<\/script>/.exec(html)[1]
    .replace("canonical-repository", "forged-repository");
  const forgedDigest = crypto.createHash("sha256").update(forgedIslandBytes, "utf8").digest("hex");
  const rehashedForgery = html
    .replace(/<script type="application\/json" data-sei-island>[\s\S]*?<\/script>/, `<script type="application/json" data-sei-island>${forgedIslandBytes}</script>`)
    .replace(/<meta name="sei-island-sha256" content="[a-f0-9]{64}">/, `<meta name="sei-island-sha256" content="${forgedDigest}">`);
  const forgedBinding = verifyRenderedReport(rehashedForgery, canonicalSnapshot);
  assert.equal(forgedBinding.ok, false);
  assert.match(forgedBinding.errors.join("\n"), /FAIL-REPORT-EXPECTED-BINDING/);
});

test("private canonical report path preserves exact escaped bytes and rejects mutation or forgery", () => {
  assert.equal(typeof reportPrivate.renderReportFromCanonicalArtifact, "function");
  assert.equal(typeof reportPrivate.verifyRenderedReportFromCanonicalArtifact, "function");
  const draft = structuredClone(canonicalSnapshot);
  draft.snapshot_id = "pending";
  draft.measurements[0].source.artifact_refs = ["evidence/<script>&fixture"];
  const artifact = enginePrivate.materializeCanonicalArtifact(draft);
  const snapshot = enginePrivate.readCanonicalArtifact(artifact).snapshot;
  const trusted = reportPrivate.renderReportFromCanonicalArtifact(artifact);
  const publicBytes = renderReport(snapshot);

  assert.equal(trusted, publicBytes);
  assert.doesNotMatch(trusted, /evidence\/(?:<script>|\\u003cscript\\u003e)/);
  assert.deepEqual(
    reportPrivate.verifyRenderedReportFromCanonicalArtifact(trusted, artifact),
    { ok: true, errors: [] },
  );
  assert.equal(
    reportPrivate.verifyRenderedReportFromCanonicalArtifact(`${trusted} `, artifact).ok,
    false,
  );
  assert.throws(
    () => reportPrivate.renderReportFromCanonicalArtifact({ ...artifact }),
    /FAIL-SNAPSHOT-ARTIFACT/,
  );
});

test("private canonical report verification reuses an opaque render binding and independently checks changed bytes", () => {
  const artifact = enginePrivate.materializeCanonicalArtifact(structuredClone(canonicalSnapshot));
  const trusted = reportPrivate.renderReportFromCanonicalArtifact(artifact);
  const originalReadFileSync = fs.readFileSync;
  let templateRead = false;
  fs.readFileSync = (...args) => {
    if (String(args[0]).endsWith("report-template.html")) {
      templateRead = true;
      throw new Error("unexpected template reconstruction");
    }
    return originalReadFileSync(...args);
  };
  try {
    assert.deepEqual(
      reportPrivate.verifyRenderedReportFromCanonicalArtifact(trusted, artifact),
      { ok: true, errors: [] },
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(templateRead, false);

  const changed = reportPrivate.verifyRenderedReportFromCanonicalArtifact(`${trusted} `, artifact);
  assert.equal(changed.ok, false);
  assert.match(changed.errors.join("\n"), /FAIL-REPORT-TAMPERED: report bytes do not match the branded canonical snapshot/);
  assert.match(changed.errors.join("\n"), /FAIL-REPORT-TAMPERED: report bytes do not match the validated projection island/);
});

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "SEI Test",
      GIT_AUTHOR_EMAIL: "sei-test@example.invalid",
      GIT_COMMITTER_NAME: "SEI Test",
      GIT_COMMITTER_EMAIL: "sei-test@example.invalid",
      GIT_AUTHOR_DATE: "2001-02-03T04:05:06+00:00",
      GIT_COMMITTER_DATE: "2001-02-03T04:05:06+00:00",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-report-test-"));
  const repo = path.join(root, "repo");
  const out = path.join(root, "out");
  fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
  fs.writeFileSync(path.join(repo, "index.js"), "function human() { return 1; }\n");
  fs.writeFileSync(path.join(repo, "dist", "generated.js"), "function generated() { return 2; }\n");
  git(repo, ["init", "--quiet"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "fixture"]);
  return { root, repo, out };
}

function runCli(args) {
  const script = resolveSeiLayout().runner_path;
  const outIndex = args.indexOf("--out");
  const outputRoot = outIndex >= 0 ? args[outIndex + 1] : null;
  const env = { ...process.env };
  // The product's default state root is intentionally repository-keyed and
  // process-global. Keep each test fixture isolated while preserving shared
  // state across relocated output roots within the same fixture.
  if (env.SEI_INCREMENTAL_STATE_ROOT === undefined && typeof outputRoot === "string") {
    env.SEI_INCREMENTAL_STATE_ROOT = path.join(path.dirname(path.resolve(outputRoot)), ".sei-test-state");
  }
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true, env });
}

function writeConfig(root, name, overrides = {}) {
  const configPath = path.join(root, name);
  fs.writeFileSync(configPath, JSON.stringify({
    repository_id: `sei-test-${crypto.createHash("sha256").update(path.resolve(root)).digest("hex")}`,
    generated_path_patterns: ["build/**", "coverage/**", "dist/**", "generated/**"],
    history_window: { kind: "revision-range", start: null },
    ...overrides,
  }));
  return configPath;
}

function snapshotFor(receipt) {
  return JSON.parse(fs.readFileSync(receipt.snapshot_path, "utf8"));
}

function cachePathFor(out, snapshot) {
  return path.join(out, "cache", snapshot.run_metadata.cache.cache_key, `${snapshot.snapshot_id}.json`);
}

function sha256Reference(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function writeForwardTemporalBundleArtifact(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return {
    path: relativePath.replaceAll("\\", "/"),
    sha256: sha256Reference(bytes),
    size_bytes: bytes.length,
  };
}

function writeCliForwardTemporalBundle(root, cutoffSnapshotBytes, historyStageBytes) {
  const historyDocument = JSON.parse(historyStageBytes.toString("utf8"));
  const historyStage = statePrivate.createHistoryStage({
    binding: historyDocument.binding,
    commits: historyDocument.commits,
  });
  const snapshots = cutoffSnapshotBytes.map((bytes) => JSON.parse(bytes.toString("utf8")));
  const receipt = evaluateForwardTemporal({
    schema_version: "sei.forward-temporal-evaluation-input@1",
    history_stage: historyStage,
    snapshots,
    ranking_k: 1,
  });
  const bundle = {
    schema_version: "sei.forward-temporal-bundle@1",
    kind: "forward-temporal-evaluation-bundle",
    history_stage: writeForwardTemporalBundleArtifact(root, "history/history-stage.json", historyStageBytes),
    cutoff_snapshots: cutoffSnapshotBytes.map((bytes, index) => writeForwardTemporalBundleArtifact(
      root,
      `cutoffs/${String(index).padStart(2, "0")}.json`,
      bytes,
    )),
    receipt: writeForwardTemporalBundleArtifact(root, "receipt/evaluation.json", Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8")),
  };
  const bundlePath = path.join(root, "forward-temporal.bundle.json");
  fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { bundlePath, receipt };
}

function historyStageBytesForCliOutput(outputRoot, repositoryId, repositoryRevision = null) {
  // runCli gives each fixture a deterministic per-parent state root in the
  // child process. Reuse that same explicit root here instead of consulting
  // the parent process environment (which is intentionally not mutated by
  // the helper).
  const fixtureStateRoot = path.join(path.dirname(path.resolve(outputRoot)), ".sei-test-state");
  const keyedStateRoot = path.join(fixtureStateRoot, crypto.createHash("sha256").update(repositoryId).digest("hex"));
  const historyRoot = path.join(statePrivate.stateRoot({ output_root: outputRoot, state_root: keyedStateRoot, repository_id: repositoryId }), "stages", "history");
  const candidates = fs.readdirSync(historyRoot)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort();
  assert.ok(candidates.length >= 1, "the final cutoff run should publish a package-branded history stage");
  const selected = candidates
    .map((name) => ({ name, document: JSON.parse(fs.readFileSync(path.join(historyRoot, name), "utf8")) }))
    .filter((candidate) => repositoryRevision === null || candidate.document.binding?.history_end === repositoryRevision)
    .sort((left, right) => String(right.document.binding?.history_end ?? "").localeCompare(String(left.document.binding?.history_end ?? ""))
      || right.name.localeCompare(left.name))[0];
  assert.ok(selected, `a history stage for ${repositoryRevision ?? "the latest revision"} is available`);
  return fs.readFileSync(path.join(historyRoot, selected.name));
}

function gitCommitAt(repo, args, timestamp) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "SEI Forward Temporal Test",
      GIT_AUTHOR_EMAIL: "sei-forward-temporal@example.invalid",
      GIT_COMMITTER_NAME: "SEI Forward Temporal Test",
      GIT_COMMITTER_EMAIL: "sei-forward-temporal@example.invalid",
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function createForwardTemporalCliFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-forward-temporal-cli-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  gitCommitAt(repo, ["init", "--quiet"], "2001-01-01T00:00:00+00:00");
  gitCommitAt(repo, ["config", "user.email", "sei-forward-temporal@example.invalid"], "2001-01-01T00:00:00+00:00");
  gitCommitAt(repo, ["config", "user.name", "SEI Forward Temporal Test"], "2001-01-01T00:00:00+00:00");

  const paths = ["a.js", "b.js", "c.js", "d.js"];
  const changes = [
    Object.fromEntries(paths.map((name) => [name, 1])),
    { "a.js": 9, "b.js": 5 },
    { "a.js": 7 },
    {},
    { "a.js": 2, "b.js": 10 },
    { "b.js": 12 },
    {},
    { "b.js": 21, "c.js": 2 },
    { "c.js": 2 },
    { "d.js": 99 },
  ];
  const revisions = [];
  for (let index = 0; index < changes.length; index += 1) {
    for (const [name, lineCount] of Object.entries(changes[index])) {
      const target = path.join(repo, "src", name);
      if (index === 0) {
        fs.writeFileSync(target, `export function ${name.slice(0, -3)}() { return 1; }\n`, "utf8");
      } else {
        fs.appendFileSync(target, `${Array.from({ length: lineCount }, (_, row) => `// commit-${index + 1}-${row + 1}`).join("\n")}\n`, "utf8");
      }
    }
    gitCommitAt(repo, ["add", "--all"], `2001-01-${String(index + 1).padStart(2, "0")}T00:00:00+00:00`);
    gitCommitAt(repo, ["commit", "--quiet", "--allow-empty", "-m", `forward temporal fixture ${index + 1}`], `2001-01-${String(index + 1).padStart(2, "0")}T00:00:00+00:00`);
    revisions.push(git(repo, ["rev-parse", "HEAD"]));
  }
  return { root, repo, revisions };
}

test("CLI renders a closed forward-temporal panel and rejects a stale bundle before report output", (t) => {
  const fixture = createForwardTemporalCliFixture(t);
  const config = writeConfig(fixture.root, "forward-temporal-cli.json");
  const cutoffBytes = [];
  for (const [index, revisionIndex] of [0, 3, 6, 9].entries()) {
    git(fixture.repo, ["checkout", "--quiet", fixture.revisions[revisionIndex]]);
    const result = runCli([
      "--repo", fixture.repo,
      "--out", path.join(fixture.root, `cutoff-output-${index}`),
      "--config", config,
    ]);
    assert.equal(result.status, 0, result.stderr);
    cutoffBytes.push(fs.readFileSync(JSON.parse(result.stdout).snapshot_path));
  }

  const finalSnapshot = JSON.parse(cutoffBytes.at(-1).toString("utf8"));
  const bundleRoot = path.join(fixture.root, "forward-temporal-bundle");
  const bundle = writeCliForwardTemporalBundle(
    bundleRoot,
    cutoffBytes,
    historyStageBytesForCliOutput(path.join(fixture.root, "cutoff-output-3"), finalSnapshot.repository.repository_id, finalSnapshot.repository.revision),
  );
  git(fixture.repo, ["checkout", "--quiet", fixture.revisions.at(-1)]);

  const evaluatedOut = path.join(fixture.root, "evaluated-output");
  const evaluated = runCli([
    "--repo", fixture.repo,
    "--out", evaluatedOut,
    "--config", config,
    "--forward-temporal", bundle.bundlePath,
    "--predictive", "required",
  ]);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(JSON.parse(evaluated.stdout).predictive.mode, "explicit", "an explicit bundle must take precedence over required construction");
  const html = fs.readFileSync(JSON.parse(evaluated.stdout).report_path, "utf8");
  const island = /<script type="application\/json" data-sei-island>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(island);
  const projection = JSON.parse(island[1]);
  assert.equal(projection.predictive_intelligence.state, "evaluated");
  assert.equal(projection.predictive_status.state, "evaluated-current");
  assert.equal(projection.predictive_status.exact_snapshot_participation, true);
  assert.equal(projection.predictive_intelligence.receipt_sha256, bundle.receipt.receipt_sha256);
  assert.equal(projection.predictive_intelligence.outcomes.length, 3);
  assert.ok(projection.predictive_intelligence.outcomes.every((outcome) => outcome.methods.length === 5));
  assert.match(html, /Predictive evaluation/);
  const evaluatedDocument = runReportDom(html);
  const predictiveTable = evaluatedDocument.getElementById("predictive-evaluation-table").textContent;
  assert.match(
    predictiveTable,
    /sei-four-signal-composite-v1/,
  );
  const composite = projection.predictive_intelligence.outcomes[0].methods
    .find((method) => method.method_id === "sei-four-signal-composite-v1");
  assert.notEqual(composite.mean_average_precision, null);
  assert.match(predictiveTable, new RegExp(String(composite.mean_average_precision).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const sameRevisionPrior = runCli([
    "--repo", fixture.repo,
    "--out", path.join(fixture.root, "same-revision-prior-output"),
    "--config", config,
    "--forward-temporal-prior", bundle.bundlePath,
  ]);
  assert.equal(sameRevisionPrior.status, 1);
  assert.match(sameRevisionPrior.stderr, /FAIL-CLI-FORWARD-TEMPORAL-PRIOR.*strict ancestor/i);

  fs.appendFileSync(path.join(fixture.repo, "src", "a.js"), "// stale-cutoff\n", "utf8");
  gitCommitAt(fixture.repo, ["add", "--all"], "2001-01-11T00:00:00+00:00");
  gitCommitAt(fixture.repo, ["commit", "--quiet", "-m", "stale forward temporal cutoff"], "2001-01-11T00:00:00+00:00");
  const staleOut = path.join(fixture.root, "stale-output");
  const stale = runCli([
    "--repo", fixture.repo,
    "--out", staleOut,
    "--config", config,
    "--forward-temporal", bundle.bundlePath,
  ]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /FAIL-FORWARD-TEMPORAL-BUNDLE.*final cutoff does not bind the current canonical snapshot/i);
  assert.equal(fs.existsSync(path.join(staleOut, "reports")), false);
  assert.equal(fs.existsSync(path.join(staleOut, "snapshots")), false);

  const priorOut = path.join(fixture.root, "prior-output");
  const prior = runCli([
    "--repo", fixture.repo,
    "--out", priorOut,
    "--config", config,
    "--forward-temporal-prior", bundle.bundlePath,
  ]);
  assert.equal(prior.status, 0, prior.stderr);
  const priorProjection = embeddedProjection(fs.readFileSync(JSON.parse(prior.stdout).report_path, "utf8"));
  assert.equal(priorProjection.predictive_intelligence.state, "not-established");
  assert.equal(priorProjection.predictive_status.state, "previously-evaluated-compatible-not-current");
  assert.equal(priorProjection.predictive_status.evaluation_exists, true);

  const conflicting = runCli([
    "--repo", fixture.repo,
    "--out", path.join(fixture.root, "conflicting-output"),
    "--config", config,
    "--forward-temporal", bundle.bundlePath,
    "--forward-temporal-prior", bundle.bundlePath,
  ]);
  assert.equal(conflicting.status, 1);
  assert.match(conflicting.stderr, /mutually exclusive/i);
});

test("CLI renders a verified one-fold current predictive receipt as not established", (t) => {
  const fixture = createForwardTemporalCliFixture(t);
  const config = writeConfig(fixture.root, "forward-temporal-one-fold.json");
  const cutoffBytes = [];
  for (const [index, revisionIndex] of [0, 3, 6].entries()) {
    git(fixture.repo, ["checkout", "--quiet", fixture.revisions[revisionIndex]]);
    const result = runCli([
      "--repo", fixture.repo,
      "--out", path.join(fixture.root, `one-fold-cutoff-${index}`),
      "--config", config,
    ]);
    assert.equal(result.status, 0, result.stderr);
    cutoffBytes.push(fs.readFileSync(JSON.parse(result.stdout).snapshot_path));
  }
  const finalSnapshot = JSON.parse(cutoffBytes.at(-1).toString("utf8"));
  const bundle = writeCliForwardTemporalBundle(
    path.join(fixture.root, "one-fold-bundle"),
    cutoffBytes,
    historyStageBytesForCliOutput(path.join(fixture.root, "one-fold-cutoff-2"), finalSnapshot.repository.repository_id, finalSnapshot.repository.revision),
  );
  git(fixture.repo, ["checkout", "--quiet", fixture.revisions[6]]);

  const result = runCli([
    "--repo", fixture.repo,
    "--out", path.join(fixture.root, "one-fold-evaluated-output"),
    "--config", config,
    "--forward-temporal", bundle.bundlePath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const projection = embeddedProjection(fs.readFileSync(JSON.parse(result.stdout).report_path, "utf8"));
  assert.equal(projection.predictive_intelligence.state, "not-established");
  assert.equal(projection.predictive_status.state, "unresolved");
  assert.equal(projection.predictive_status.evaluation_exists, true);
  assert.match(projection.predictive_status.summary, /required two forward folds/i);
});

test("CLI runtime and package discovery admit JDK 25+ capability and nested package roots", () => {
  const privateApi = cliModule[Symbol.for("sei.cli.private.v1")];
  assert.equal(typeof privateApi.derivePackageId, "function");
  const shim = path.resolve("C:/host-shim/java.exe");
  const jdkHome = path.resolve("C:/jdk-25");
  const jdkJava = path.join(jdkHome, "bin", "java.exe");
  const runtime = privateApi.resolveJvmRuntime({
    candidates: [shim],
    exists: (candidate) => candidate === shim || candidate === jdkJava,
    realpath: (candidate) => candidate,
    spawn: (command, args) => {
      assert.equal(command, shim);
      assert.deepEqual(args, ["-XshowSettings:properties", "-version"]);
      return {
        status: 0,
        stdout: "",
        stderr: `    java.home = ${jdkHome}\n    java.specification.version = 26\n`,
      };
    },
  });
  assert.deepEqual(runtime, { executable: jdkJava, status: "candidate", source: "trusted-host-java" });

  const repositoryIndex = {
    entries: [
      { path: "package.json", classifications: { manifest_kinds: ["node-package"] } },
      { path: "packages/api/package.json", classifications: { manifest_kinds: ["node-package"] } },
      { path: "packages/core/package.json", classifications: { manifest_kinds: ["node-package"] } },
    ],
  };
  assert.equal(privateApi.derivePackageId("packages/api/src/a.ts", repositoryIndex), "packages/api");
  assert.equal(privateApi.derivePackageId("packages/core/src/b.ts", repositoryIndex), "packages/core");
  assert.equal(privateApi.derivePackageId("src/root.ts", repositoryIndex), ".");
});

test("CLI accepts an explicit baseline file without discovering a latest snapshot", () => {
  const parsed = parseArguments([
    "--repo", "fixture-repository",
    "--out", "fixture-output",
    "--baseline", "prior-canonical-snapshot.json",
  ]);

  assert.equal(parsed.baseline, path.resolve("prior-canonical-snapshot.json"));
  assert.equal("latest" in parsed, false);
});

test("CLI accepts only the closed incremental and predictive execution controls", () => {
  assert.equal(parseArguments(["--repo", "fixture", "--out", "out"]).incremental, "auto");
  assert.equal(parseArguments(["--repo", "fixture", "--out", "out", "--incremental", "off"]).incremental, "off");
  assert.equal(parseArguments(["--repo", "fixture", "--out", "out"]).predictive, "auto");
  assert.equal(parseArguments(["--repo", "fixture", "--out", "out", "--predictive", "off"]).predictive, "off");
  assert.equal(parseArguments(["--repo", "fixture", "--out", "out", "--predictive", "required"]).predictive, "required");
  assert.throws(
    () => parseArguments(["--repo", "fixture", "--out", "out", "--incremental", "maybe"]),
    /FAIL-CLI-ARGUMENTS.*incremental/,
  );
  assert.throws(
    () => parseArguments(["--repo", "fixture", "--out", "out", "--predictive", "maybe"]),
    /FAIL-CLI-ARGUMENTS.*predictive/,
  );
  assert.throws(
    () => parseArguments(["--repo", "fixture", "--out", "out", "--incremental", "auto", "--incremental", "off"]),
    /FAIL-CLI-ARGUMENTS.*duplicate/,
  );
});

test("CLI defaults to the current repository-local project-intelligence output root", () => {
  const parsed = parseArguments([]);
  const repositoryPath = path.resolve(process.cwd());
  assert.equal(parsed.repo, repositoryPath);
  assert.equal(parsed.out, path.join(repositoryPath, ".project-intelligence"));
  assert.equal(parsed.usesProjectWorkspace, true);
  assert.equal(parsed.predictive, "auto");
});

test("CLI derives the repository-local project-intelligence folder when --out is omitted", () => {
  const repositoryPath = path.join(os.tmpdir(), "example-repository");
  const parsed = parseArguments(["--repo", repositoryPath]);
  assert.equal(parsed.repo, path.resolve(repositoryPath));
  assert.equal(parsed.out, path.join(path.resolve(repositoryPath), ".project-intelligence"));
  assert.equal(parsed.usesProjectWorkspace, true);
});

test("required predictive mode fails before publication when bound history is insufficient", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const requiredOut = path.join(fixture.root, "required-predictive-out");
  const result = runCli(["--repo", fixture.repo, "--out", requiredOut, "--predictive", "required"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL-CLI-PREDICTIVE-REQUIRED/);
  assert.equal(fs.existsSync(path.join(requiredOut, "reports")), false);
  assert.equal(fs.existsSync(path.join(requiredOut, "snapshots")), false);
});

test("default predictive auto publishes a branded readiness visualization when history is insufficient", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  const projection = embeddedProjection(fs.readFileSync(receipt.report_path, "utf8"));
  assert.equal(receipt.predictive.mode, "auto");
  assert.equal(receipt.predictive.state, "not-ready");
  assert.equal(projection.predictive_intelligence.forecast_state, "readiness");
  assert.match(projection.predictive_intelligence.reason, /automatic prediction needs|cutoff snapshot construction/i);
});

test("CLI composes only closed local adapter envelopes and binds the configured temporal mass-change receipt", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const temporalPolicy = {
    policy_id: "cli-temporal-policy-v1",
    policy_version: "1.0.0",
    threshold: 2,
    cap: 1,
    action: "exclude",
  };
  const policyOnlyConfig = writeConfig(fixture.root, "policy-only.json", {
    temporal_coupling_policy: temporalPolicy,
  });
  const policyOnlyOut = path.join(fixture.root, "policy-only-out");
  const policyOnlyRun = runCli(["--repo", fixture.repo, "--out", policyOnlyOut, "--config", policyOnlyConfig]);
  assert.equal(policyOnlyRun.status, 0, policyOnlyRun.stderr);
  const policyOnlySnapshot = snapshotFor(JSON.parse(policyOnlyRun.stdout));
  const missingDependency = policyOnlySnapshot.collectors.find((collector) => collector.collector_id === "dependency-topology");
  assert.equal(missingDependency, undefined);
  assert.equal(policyOnlySnapshot.measurements.some((metric) => metric.metric_id.startsWith("dependency.")), false);
  assert.ok(policyOnlySnapshot.measurements.some((metric) => metric.metric_id.startsWith("static.python.dependency.")));

  const adapter = adapterFixtures.dependencyTopologyAdapter();
  adapter.repository_revision = policyOnlySnapshot.repository.revision;
  adapter.configuration_hash = policyOnlySnapshot.repository.configuration_hash;
  adapter.history_window = structuredClone(policyOnlySnapshot.repository.history_boundary);
  const adapterConfig = writeConfig(fixture.root, "typed-adapter.json", {
    temporal_coupling_policy: temporalPolicy,
    adapter_evidence: { adapters: [adapter] },
  });
  const adapterOut = path.join(fixture.root, "adapter-out");
  const adapterRun = runCli(["--repo", fixture.repo, "--out", adapterOut, "--config", adapterConfig]);
  assert.equal(adapterRun.status, 1);
  assert.match(adapterRun.stderr, /FAIL-CLI-COLLECTION: internal Python dependency topology and external dependency topology scope overlap/);
  assert.equal(fs.existsSync(path.join(adapterOut, "reports")), false);
  assert.equal(fs.existsSync(path.join(adapterOut, "snapshots")), false);

  const malformedAdapterConfig = writeConfig(fixture.root, "malformed-adapter-config.json", {
    temporal_coupling_policy: temporalPolicy,
    adapter_evidence: { adapters: [], remote_url: "https://attacker.invalid/evidence" },
  });
  const malformedAdapterOut = path.join(fixture.root, "malformed-adapter-out");
  const malformedAdapter = runCli(["--repo", fixture.repo, "--out", malformedAdapterOut, "--config", malformedAdapterConfig]);
  assert.equal(malformedAdapter.status, 1);
  assert.match(malformedAdapter.stderr, /FAIL-CLI-CONFIG/);
  assert.equal(fs.existsSync(malformedAdapterOut), false);

  const malformedPolicyConfig = writeConfig(fixture.root, "malformed-temporal-policy.json", {
    temporal_coupling_policy: { ...temporalPolicy, attacker: true },
  });
  const malformedPolicyOut = path.join(fixture.root, "malformed-temporal-policy-out");
  const malformedPolicy = runCli(["--repo", fixture.repo, "--out", malformedPolicyOut, "--config", malformedPolicyConfig]);
  assert.equal(malformedPolicy.status, 1);
  assert.match(malformedPolicy.stderr, /FAIL-CLI-CONFIG/);
  assert.equal(fs.existsSync(malformedPolicyOut), false);
});

function embeddedProjection(html) {
  const island = /<script type="application\/json" data-sei-island>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(island, "report should contain its island");
  return JSON.parse(island);
}

class BrowserlessClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  contains(name) {
    return this.values().has(name);
  }

  toggle(name, force) {
    const values = this.values();
    const enabled = force === undefined ? !values.has(name) : Boolean(force);
    if (enabled) values.add(name);
    else values.delete(name);
    this.element.className = [...values].join(" ");
    return enabled;
  }
}

class BrowserlessElement {
  constructor(document, tagName, id = null) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.classList = new BrowserlessClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this._textContent = "";
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    this.children = [];
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this._textContent = "";
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
    if (name === "id") {
      this.id = String(value);
      this.ownerDocument.elements.set(this.id, this);
    }
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
  }

  getAttribute(name) {
    if (name === "class") return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatchEvent(event) {
    const normalized = {
      ...event,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    for (const listener of this.listeners.get(normalized.type) ?? []) listener(normalized);
    return !normalized.defaultPrevented;
  }

  click() {
    if (!this.disabled) this.dispatchEvent({ type: "click" });
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  scrollIntoView(options) {
    this.scrollIntoViewOptions = options;
  }

  querySelectorAll(selector) {
    const tags = selector.split(",").map((part) => part.trim().toUpperCase());
    return browserlessDescendants(this).filter((element) => tags.includes(element.tagName));
  }
}

class BrowserlessDocument {
  constructor(html, projectionBytes) {
    this.elements = new Map();
    this.listeners = new Map();
    this.activeElement = null;
    for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)\bid="([^"]+)"([^>]*)>/gi)) {
      const attributes = match[2] + match[4];
      const element = new BrowserlessElement(this, match[1], match[3]);
      for (const attribute of attributes.matchAll(/\b(aria-[\w-]+|role|data-[\w-]+|tabindex|type|class)="([^"]*)"/gi)) {
        element.setAttribute(attribute[1], attribute[2]);
      }
      const value = /\bvalue="([^"]*)"/i.exec(attributes)?.[1];
      if (value !== undefined) element.value = value;
      element.hidden = /\bhidden\b/i.test(attributes);
      element.disabled = /\bdisabled\b/i.test(attributes);
      this.elements.set(element.id, element);
    }
    this.island = new BrowserlessElement(this, "script");
    this.island.textContent = projectionBytes;
  }

  querySelector(selector) {
    return selector === "[data-sei-island]" ? this.island : null;
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }

  createElement(tagName) {
    return new BrowserlessElement(this, tagName);
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}

function browserlessDescendants(root) {
  return root.children.flatMap((child) => [child, ...browserlessDescendants(child)]);
}

function runReportDom(html) {
  const projectionBytes = /<script type="application\/json" data-sei-island>([\s\S]*?)<\/script>/.exec(html)?.[1];
  const runtime = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(projectionBytes, "public report should contain the bounded projection island");
  assert.ok(runtime, "public report should contain its inline offline runtime");
  const document = new BrowserlessDocument(html, projectionBytes);
  vm.runInNewContext(runtime, { document }, { filename: "sei-report-runtime.js" });
  return document;
}

function renderProjectionDom(projection) {
  const html = renderReport(canonicalSnapshot);
  const replacement = `<script type="application/json" data-sei-island>${JSON.stringify(projection)}</script>`;
  return runReportDom(html.replace(/<script type="application\/json" data-sei-island>[\s\S]*?<\/script>/, replacement));
}

function semanticAssessmentFixture(overrides = {}) {
  return {
    assessment_id: "sha256:" + "a".repeat(64),
    overview: {
      score: 71.25,
      score_band: "Good",
      score_visibility: "provisional",
      coverage: 0.57,
      confidence: "LOW",
      maturity: "provisional",
    },
    dimensions: [{
      dimension_id: "maintainability",
      weight: 16,
      score: 71.25,
      coverage: 0.75,
      confidence: "MODERATE",
      maturity: "provisional",
      observed_criterion_count: 2,
      criterion_count: 4,
    }],
    criteria: [{
      criterion_id: "complexity_concentration",
      dimension_id: "maintainability",
      weight: 4,
      applicability: "applicable",
      score: 64,
      coverage: 0.75,
      confidence: "MODERATE",
      maturity: "provisional",
      evidence: {
        observations: [{
          observation_id: "engineering.complexity.production.p90",
          role: "primary",
          state: "measured",
          value: 18,
          unit: "cyclomatic-complexity",
          coverage: 0.75,
          confidence: "MODERATE",
          context: "production Python callables",
          source_metric_ids: ["static.cyclomatic_complexity_p90"],
          evidence_refs: ["metric:static.cyclomatic_complexity_p90"],
        }, {
          observation_id: "engineering.complexity.production.parser_exclusions",
          role: "limiting",
          state: "partial",
          value: 2,
          unit: "files",
          coverage: 0.75,
          confidence: "LOW",
          context: "two files were excluded by the parser",
          source_metric_ids: ["static.python.parser.exclusions"],
          evidence_refs: ["metric:static.python.parser.exclusions"],
        }, {
          observation_id: "engineering.verification.test_execution",
          role: "context",
          state: "measured",
          value: true,
          unit: "boolean",
          coverage: 1,
          confidence: "HIGH",
          context: { family: "verification", aggregation: "state", languages: ["javascript"], lower_bound: false },
          source_metric_ids: ["verification.test_execution"],
          evidence_refs: ["metric:verification.test_execution"],
        }, {
          observation_id: "engineering.verification.execution_state",
          role: "supporting",
          state: "measured",
          value: "configured",
          unit: "state",
          coverage: 1,
          confidence: "HIGH",
          context: { family: "verification", aggregation: "state", languages: ["javascript"], lower_bound: false },
          source_metric_ids: ["verification.execution_state"],
          evidence_refs: ["metric:verification.execution_state"],
        }],
        synthesis: {
          recipe_id: "complexity-tail-pressure",
          reducer_version: "1",
          contributing_observation_ids: ["engineering.complexity.production.p90"],
        },
      },
      explanation: {
        observed: "The production complexity tail is elevated.",
        means: "A small number of callables dominate maintenance effort.",
        why_it_matters: "Tail complexity increases review and regression risk.",
        limitations: "Two files were excluded by the parser.",
        blocked_stronger_result: "Complete parser coverage would establish the result.",
        next_investigation: "Inspect src/billing/settlement.py before broad refactoring.",
      },
    }],
    strengths: [],
    deficiencies: [],
    interventions: [{
      criterion_id: "complexity_concentration",
      dimension_id: "maintainability",
      family: "local-code-change",
      priority: 64,
      targets: ["src/billing/settlement.py"],
      why: "The production complexity tail is concentrated here.",
      next_investigation: "Inspect the settlement branch structure.",
    }],
    framework_lenses: [],
    trajectory: {
      state: "improving",
      reason: "Comparable evidence improved.",
      score_delta: 4,
      coverage_delta: 0.12,
      classification: "engineering_change",
      movement_cause: "engineering-change",
      semantic_digest_changed: true,
      dimension_deltas: [{ dimension_id: "maintainability", score_delta: 4, coverage_delta: 0.12 }],
      criterion_deltas: [{ criterion_id: "complexity_concentration", score_delta: 7, coverage_delta: 0.12 }],
    },
    evidence_limits: [],
    observation_vocabulary_version: "sei.engineering-observation@1",
    observation_vocabulary_digest: "sha256:" + "b".repeat(64),
    semantic_digest: "sha256:" + "c".repeat(64),
    coverage_accounting: {
      criterion_total: 30,
      established_count: 8,
      provisional_count: 11,
      not_scored_count: 7,
      not_applicable_count: 4,
      mapping_failure_count: 0,
      assessed_criterion_rate: 19 / 30,
      coverage_gate: {
        required_criteria: 30,
        denominator: 30,
        target_rate: 1,
        assessed_criterion_rate: 19 / 30,
        status: "not_met",
        reason: "fixture does not contain sufficient bound evidence",
      },
      not_scored_reasons: [
        { reason: "external_evidence_required", category: "external_evidence_required", criterion_count: 3 },
        { reason: "genuinely_unavailable_evidence", category: "genuinely_unavailable_evidence", criterion_count: 4 },
      ],
    },
    ...overrides,
  };
}

test("assessment report projection keeps semantic evidence explanations separate from raw producer identifiers", () => {
  assert.equal(typeof reportProjectionPrivate?.projectAssessmentArtifact, "function");
  const assessment = semanticAssessmentFixture();
  const projection = reportProjectionPrivate.projectAssessmentArtifact(assessment);

  assert.equal(projection.score, 71.25);
  assert.equal(projection.score_visibility, "provisional");
  assert.deepEqual(projection.domain_summary[0], {
    dimension_id: "maintainability",
    label: "Maintainability",
    score: 71.25,
    coverage: 0.75,
    confidence: "MODERATE",
    maturity: "provisional",
    evidence_state: "resource-limited",
    observed_criterion_count: 2,
    criterion_count: 4,
  });
  assert.equal(projection.criteria[0].evidence.observations[0].observation_id, "engineering.complexity.production.p90");
  assert.equal(projection.criteria[0].evidence.observations[0].role, "primary");
  assert.equal(projection.criteria[0].evidence.observations[2].value, true);
  assert.equal(projection.criteria[0].evidence.observations[3].value, "configured");
  assert.deepEqual(projection.criteria[0].explanation, assessment.criteria[0].explanation);
  assert.deepEqual(projection.trajectory.dimension_deltas, assessment.trajectory.dimension_deltas);
  assert.deepEqual(projection.trajectory.criterion_deltas, assessment.trajectory.criterion_deltas);
  assert.equal(projection.trajectory.classification, "engineering_change");
  assert.equal(projection.trajectory.semantic_digest_changed, true);
  assert.deepEqual(projection.interventions[0].targets, ["src/billing/settlement.py"]);
  assert.equal(projection.coverage_accounting.mapping_failure_count, 0);
  assert.doesNotMatch(JSON.stringify(projection.assessment ?? projection), /static\.cyclomatic_complexity_p90|static\.python\.parser\.exclusions/);

  const resourceLimited = semanticAssessmentFixture({
    dimensions: [{ ...semanticAssessmentFixture().dimensions[0], score: 0, coverage: 1, maturity: "established" }],
    criteria: [{
      ...semanticAssessmentFixture().criteria[0],
      dimension_id: "maintainability",
      evidence: {
        ...semanticAssessmentFixture().criteria[0].evidence,
        observations: [{
          ...semanticAssessmentFixture().criteria[0].evidence.observations[0],
          state: "partial",
          context: { family: "parser", lower_bound: true },
        }],
      },
    }],
  });
  assert.equal(reportProjectionPrivate.projectAssessmentArtifact(resourceLimited).domain_summary[0].evidence_state, "resource-limited");
  const completeZero = structuredClone(resourceLimited);
  completeZero.criteria[0].evidence.observations[0].state = "measured";
  completeZero.criteria[0].evidence.observations[0].context.lower_bound = false;
  assert.equal(reportProjectionPrivate.projectAssessmentArtifact(completeZero).domain_summary[0].evidence_state, "complete-zero");

  const report = projectReport(canonicalSnapshot);
  report.assessment = projection;
  assert.deepEqual(validateReportProjection(report), { ok: true, errors: [] });
});

test("assessment report panel qualifies provisional results and explains semantic evidence without producer metric dumps", () => {
  const base = projectReport(canonicalSnapshot);
  base.assessment = reportProjectionPrivate.projectAssessmentArtifact(semanticAssessmentFixture());
  const document = renderProjectionDom(base);

  assert.match(document.getElementById("assessment-score").textContent, /Provisional/i);
  assert.match(document.getElementById("assessment-evidence-roles").textContent, /Primary evidence/i);
  assert.match(document.getElementById("assessment-evidence-roles").textContent, /Limiting evidence/i);
  assert.match(document.getElementById("assessment-criterion-explanations").textContent, /What SEI observed/i);
  assert.match(document.getElementById("assessment-criterion-explanations").textContent, /What to investigate/i);
  assert.match(document.getElementById("assessment-coverage").textContent, /Criterion coverage 19\/30 \(63\.33%\)/i);
  assert.match(document.getElementById("assessment-coverage").textContent, /Evidence completeness 57%/i);
  assert.match(document.getElementById("assessment-interventions").textContent, /src\/billing\/settlement\.py/);
  assert.match(document.getElementById("assessment-trajectory").textContent, /maintainability/i);
  assert.match(document.getElementById("assessment-coverage-accounting").textContent, /Mapping failures 0/i);
  assert.doesNotMatch(document.getElementById("assessment-criterion-explanations").textContent, /static\.cyclomatic_complexity_p90/);
});

test("assessment report makes domain confidence and coverage visual, not a collector-count text dump", () => {
  const base = projectReport(canonicalSnapshot);
  base.assessment = reportProjectionPrivate.projectAssessmentArtifact(semanticAssessmentFixture());
  const document = renderProjectionDom(base);

  assert.ok(document.getElementById("assessment-domain-chart"), "domain chart should be present");
  assert.ok(document.getElementById("assessment-evidence-roles-chart"), "evidence-role chart should be present");
  assert.ok(document.getElementById("assessment-coverage-accounting-chart"), "coverage accounting chart should be present");
  assert.ok(document.getElementById("assessment-trajectory-chart"), "trajectory chart should be present");

  const domainChartText = document.getElementById("assessment-domain-chart").textContent;
  assert.match(domainChartText, /Maintainability/i);
  assert.match(domainChartText, /71\.25/);
  assert.match(domainChartText, /75%/);
  assert.doesNotMatch(domainChartText, /collector|metric_count|static\./i);

  const accountingText = document.getElementById("assessment-coverage-accounting").textContent;
  assert.match(accountingText, /External evidence required/i);
  assert.match(accountingText, /Genuinely unavailable evidence/i);
  assert.match(accountingText, /90% gate Not met \(63%\)/i);
  assert.match(document.getElementById("assessment-coverage-accounting-chart").textContent, /Not scored/i);
  assert.match(document.getElementById("assessment-trajectory-chart").textContent, /Engineering change/i);
});

test("assessment primary panel humanizes rubric identifiers while preserving raw IDs only in advanced evidence", () => {
  const base = projectReport(canonicalSnapshot);
  base.assessment = reportProjectionPrivate.projectAssessmentArtifact(semanticAssessmentFixture());
  const document = renderProjectionDom(base);

  const primaryText = [
    "assessment-strengths",
    "assessment-deficiencies",
    "assessment-interventions",
    "assessment-trajectory",
    "assessment-criterion-explanations",
  ].map((id) => document.getElementById(id).textContent).join(" ");
  assert.match(primaryText, /Complexity concentration/i);
  assert.doesNotMatch(primaryText, /complexity_concentration/);
  assert.doesNotMatch(primaryText, /static\.cyclomatic_complexity_p90|static\.python\.parser\.exclusions/);
});

test("assessment report panel hides a not-scored numeric result", () => {
  const base = projectReport(canonicalSnapshot);
  base.assessment = reportProjectionPrivate.projectAssessmentArtifact(semanticAssessmentFixture({
    overview: { score: 95, score_band: "Excellent", score_visibility: "established", coverage: 0.1, confidence: "NOT_ESTABLISHED", maturity: "not_scored" },
  }));
  assert.equal(base.assessment.score, null);
  const document = renderProjectionDom(base);
  assert.equal(document.getElementById("assessment-score").textContent, "NOT SCORED");
  assert.doesNotMatch(document.getElementById("assessment-score").textContent, /95/);
});

function investigationSubjects(document) {
  return browserlessDescendants(document.getElementById("investigations-list"))
    .filter((element) => element.tagName === "BUTTON")
    .map((element) => element.textContent);
}

function renderInteractionFixtureReport(t) {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.repo, "helper.js"), "export function helper() { return 1; }\n");
  fs.writeFileSync(path.join(fixture.repo, "alpha.js"), "export function alpha() { return 1; }\n");
  fs.writeFileSync(path.join(fixture.repo, "beta.js"), "export function beta() { return 1; }\n");
  fs.writeFileSync(path.join(fixture.repo, "gamma.js"), "export function gamma() { return 1; }\n");
  fs.writeFileSync(path.join(fixture.repo, "tool.py"), "def tool():\n    return 1\n");
  fs.appendFileSync(path.join(fixture.repo, "index.js"), "function changed() { return helper; }\n");
  git(fixture.repo, ["add", "index.js", "helper.js", "alpha.js", "beta.js", "gamma.js", "tool.py"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "add interaction fixture"]);
  fs.appendFileSync(path.join(fixture.repo, "helper.js"), "export function later() { return 2; }\n");
  fs.appendFileSync(path.join(fixture.repo, "index.js"), "function laterChanged() { return helper; }\n");
  git(fixture.repo, ["add", "index.js", "helper.js"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "repeat interaction fixture"]);
  const result = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(JSON.parse(result.stdout).report_path, "utf8");
}

test("normal CLI publishes a bound assessment sidecar and evidence-only omits judgment", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const assessed = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(assessed.status, 0, assessed.stderr);
  const receipt = JSON.parse(assessed.stdout);
  assert.match(receipt.assessment_id, /^sha256:[a-f0-9]{64}$/);
  assert.ok(receipt.assessment_path);
  const snapshot = snapshotFor(receipt);
  const assessment = JSON.parse(fs.readFileSync(receipt.assessment_path, "utf8"));
  assert.equal(assessmentModule.validateAssessment(assessment).ok, true);
  const binding = assessmentPrivate.bindAssessment(assessment, snapshot);
  const report = fs.readFileSync(receipt.report_path, "utf8");
  assert.equal(verifyRenderedReport(report, snapshot, { assessment_binding: binding }).ok, true);

  const evidenceOnlyOut = path.join(fixture.root, "evidence-only");
  const evidenceOnly = runCli(["--repo", fixture.repo, "--out", evidenceOnlyOut, "--evidence-only"]);
  assert.equal(evidenceOnly.status, 0, evidenceOnly.stderr);
  const evidenceReceipt = JSON.parse(evidenceOnly.stdout);
  assert.equal(evidenceReceipt.assessment_id, null);
  assert.equal(evidenceReceipt.assessment_path, null);
  assert.equal(fs.existsSync(path.join(evidenceOnlyOut, "assessments")), false);
  assert.equal(verifyRenderedReport(fs.readFileSync(evidenceReceipt.report_path, "utf8"), snapshotFor(evidenceReceipt)).ok, true);
});

test("same-revision assessment state follows repository identity across output roots", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const previousStateRoot = process.env.SEI_INCREMENTAL_STATE_ROOT;
  process.env.SEI_INCREMENTAL_STATE_ROOT = path.join(fixture.root, "stable-state");
  t.after(() => {
    if (previousStateRoot === undefined) delete process.env.SEI_INCREMENTAL_STATE_ROOT;
    else process.env.SEI_INCREMENTAL_STATE_ROOT = previousStateRoot;
  });
  const firstOut = path.join(fixture.root, "first-output");
  const movedOut = path.join(fixture.root, "moved-output");
  const first = runCli(["--repo", fixture.repo, "--out", firstOut]);
  assert.equal(first.status, 0, first.stderr);
  const firstReceipt = JSON.parse(first.stdout);
  const firstAssessment = JSON.parse(fs.readFileSync(firstReceipt.assessment_path, "utf8"));
  assert.equal(firstAssessment.trajectory.state, "first-observation");

  const moved = runCli(["--repo", fixture.repo, "--out", movedOut]);
  assert.equal(moved.status, 0, moved.stderr);
  const movedReceipt = JSON.parse(moved.stdout);
  const movedAssessment = JSON.parse(fs.readFileSync(movedReceipt.assessment_path, "utf8"));
  // Exact replay and a fresh miss must agree: a same-snapshot prior never
  // mints a self-comparison once the first-observation assessment exists.
  assert.equal(movedAssessment.assessment_id, firstAssessment.assessment_id);
  assert.equal(movedAssessment.trajectory.state, "first-observation");
});

test("a forced cache miss into an output root with a published report republishes identical bytes", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const previousStateRoot = process.env.SEI_INCREMENTAL_STATE_ROOT;
  process.env.SEI_INCREMENTAL_STATE_ROOT = path.join(fixture.root, "stable-state");
  t.after(() => {
    if (previousStateRoot === undefined) delete process.env.SEI_INCREMENTAL_STATE_ROOT;
    else process.env.SEI_INCREMENTAL_STATE_ROOT = previousStateRoot;
  });
  const out = path.join(fixture.root, "output");
  const receipts = [];
  for (let run = 0; run < 3; run += 1) {
    const result = runCli(["--repo", fixture.repo, "--out", out, "--report-mode", "generate"]);
    assert.equal(result.status, 0, result.stderr);
    receipts.push(JSON.parse(result.stdout));
    // Force the next run down the fresh (non-replay) path.
    for (const manifests of fs.readdirSync(process.env.SEI_INCREMENTAL_STATE_ROOT, { recursive: true })
      .filter((entry) => path.basename(entry) === "manifests")) {
      fs.rmSync(path.join(process.env.SEI_INCREMENTAL_STATE_ROOT, manifests), { recursive: true, force: true });
    }
  }
  assert.equal(new Set(receipts.map((receipt) => receipt.assessment_id)).size, 1);
  assert.equal(new Set(receipts.map((receipt) => receipt.report_path)).size, 1);
});

test("same-output assessed replay reuses the persisted canonical bundle", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const previousStateRoot = process.env.SEI_INCREMENTAL_STATE_ROOT;
  process.env.SEI_INCREMENTAL_STATE_ROOT = path.join(fixture.root, "stable-state");
  t.after(() => {
    if (previousStateRoot === undefined) delete process.env.SEI_INCREMENTAL_STATE_ROOT;
    else process.env.SEI_INCREMENTAL_STATE_ROOT = previousStateRoot;
  });
  const first = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(first.status, 0, first.stderr);
  const firstReceipt = JSON.parse(first.stdout);
  const movedOut = path.join(fixture.root, "moved-out");
  const second = runCli(["--repo", fixture.repo, "--out", movedOut]);
  assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
  const secondReceipt = JSON.parse(second.stdout);
  assert.equal(secondReceipt.performance.executor.mode, "exact-run-replay-v1", JSON.stringify(secondReceipt.performance));
  assert.equal(secondReceipt.assessment_id, firstReceipt.assessment_id);
  assert.equal(secondReceipt.performance.cache, "hit");
  assert.equal(fs.readFileSync(secondReceipt.assessment_path, "utf8"), fs.readFileSync(firstReceipt.assessment_path, "utf8"));
  assert.equal(verifyRenderedReport(
    fs.readFileSync(secondReceipt.report_path, "utf8"),
    snapshotFor(secondReceipt),
    { assessment_binding: assessmentPrivate.bindAssessment(JSON.parse(fs.readFileSync(secondReceipt.assessment_path, "utf8")), snapshotFor(secondReceipt)) },
  ).ok, true);
});

function pythonMetric({
  metricId,
  definitionId,
  family,
  value,
  unit,
  status = "measured",
  completeness = 1,
  reason = null,
  subject = `repository:${canonicalSnapshot.repository.repository_id}`,
  scopeKind = "repository",
  scopePath = ".",
  artifactRefs = [],
}) {
  const revision = canonicalSnapshot.repository.revision;
  const refs = [
    "python-analyzer:sei.python-ast@1",
    "python-configuration:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "python-grammar:3.13",
    "python-runtime:cpython-3.13",
    "repository-index:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ...artifactRefs,
  ].sort();
  return {
    metric_id: metricId,
    definition_id: definitionId,
    family,
    subject,
    repository_revision: revision,
    value: status === "measured" ? value : null,
    unit,
    measurement: {
      status,
      completeness: status === "measured" ? completeness : 0,
      confidence: status === "measured" ? completeness : 0,
      reason: status === "measured" ? reason : reason ?? "measurement is unavailable",
    },
    source: {
      kind: "exact-git-python-ast",
      collector_id: "python-static-intelligence",
      collector_version: "1.0.0",
      repository_revision: revision,
      command: null,
      artifact_refs: refs,
      evidence_refs: refs,
    },
    scope: {
      kind: scopeKind,
      path: scopePath,
      language: "python",
      generated_code: false,
      included_in_human_maintainability: true,
    },
    window: { kind: "revision", start: null, end: revision },
    analyzer_identity: "sei.python-ast@1",
    analyzer_version: "sei.python-ast@1",
    comparability: {
      analyzer_identity: "sei.python-ast@1",
      analyzer_version: "sei.python-ast@1",
      configuration_hash: canonicalSnapshot.repository.configuration_hash,
      compatible_with_prior: false,
      reason: "no prior analyzer-bound measurement was supplied",
    },
  };
}

function staticIntelligenceReportSnapshot() {
  const snapshot = structuredClone(canonicalSnapshot);
  snapshot.collectors.push({
    collector_id: "python-static-intelligence",
    collector_version: "1.0.0",
    status: "degraded",
    analyzer_identity: "sei.python-ast@1",
    analyzer_version: "sei.python-ast@1",
    reason: "one supported Python file did not parse",
  });
  const complexity = (metricId, value, partition, completeness = 1) => pythonMetric({
    metricId: `${metricId}:${partition}`,
    definitionId: `sei.${metricId.replaceAll(":", ".")}@1`,
    family: "structural_complexity",
    value,
    unit: metricId.includes("file_count") ? "files" : metricId.includes("callable_count") ? "callables" : "cyclomatic-complexity-points",
    completeness,
    reason: completeness < 1 ? "Python parse coverage is partial" : null,
  });
  const dependency = (name, value, partition = "production", status = "measured", reason = null) => pythonMetric({
    metricId: `static.python.dependency.${name}:${partition}`,
    definitionId: `sei.static.python.dependency.${name}@1`,
    family: "dependency_topology",
    value,
    unit: name === "density" || name === "instability" ? "ratio" : "count",
    status,
    completeness: 6 / 7,
    reason,
  });
  snapshot.measurements.push(
    complexity("static.python.file_count", 7, "production"),
    complexity("static.python.parsed_file_count", 6, "production"),
    complexity("static.python.cyclomatic_callable_count", 6, "production", 6 / 7),
    complexity("static.python.cyclomatic_complexity", 16, "production", 6 / 7),
    complexity("static.python.cyclomatic_complexity_p50", 2, "production", 6 / 7),
    complexity("static.python.cyclomatic_complexity_p90", 6, "production", 6 / 7),
    complexity("static.python.cyclomatic_complexity_max", 6, "production", 6 / 7),
    complexity("static.python.file_count", 8, "all-python"),
    complexity("static.python.parsed_file_count", 7, "all-python"),
    complexity("static.python.cyclomatic_callable_count", 7, "all-python", 7 / 8),
    complexity("static.python.cyclomatic_complexity", 18, "all-python", 7 / 8),
    complexity("static.python.cyclomatic_complexity_p50", 2, "all-python", 7 / 8),
    complexity("static.python.cyclomatic_complexity_p90", 6, "all-python", 7 / 8),
    complexity("static.python.cyclomatic_complexity_max", 6, "all-python", 7 / 8),
    ...[9, 8, 7, 6, 5, 4].map((value, index) => pythonMetric({
      metricId: `static.cyclomatic_complexity:src/acme/file_${index}.py`,
      definitionId: "sei.static.cyclomatic_complexity@1",
      family: "structural_complexity",
      value,
      unit: "cyclomatic-complexity-points",
      subject: `file:src/acme/file_${index}.py`,
      scopeKind: "file",
      scopePath: `src/acme/file_${index}.py`,
      artifactRefs: ["python-partition:production", `src/acme/file_${index}.py`],
    })),
    ...[12, 11, 10, 9, 8, 7].map((value, index) => pythonMetric({
      metricId: `static.python.cyclomatic_callable:src/acme/file_${index}.py:${index + 1}:0:${index + 2}:8:fn_${index}`,
      definitionId: "sei.static.python.cyclomatic_callable@1",
      family: "structural_complexity",
      value,
      unit: "cyclomatic-complexity-points",
      subject: `python-callable:src/acme/file_${index}.py#fn_${index}@${index + 1}:0-${index + 2}:8`,
      scopeKind: "file",
      scopePath: `src/acme/file_${index}.py`,
      artifactRefs: ["python-partition:production", `python-callable:src/acme/file_${index}.py#fn_${index}@${index + 1}:0-${index + 2}:8`],
    })),
    dependency("node_count", 7),
    dependency("edge_count", 6),
    dependency("scc_count", 5),
    dependency("cyclic_scc_count", 1),
    dependency("cyclic_node_count", 3),
    dependency("fan_in_max", 2),
    dependency("fan_out_max", 4),
    dependency("density", 0.14285714),
    dependency("node_count", 8, "all-python"),
    dependency("edge_count", 7, "all-python"),
    dependency("scc_count", 6, "all-python"),
    dependency("cyclic_scc_count", 1, "all-python"),
    dependency("cyclic_node_count", 3, "all-python"),
    dependency("density", 0.125, "all-python"),
    pythonMetric({ metricId: "static.python.dependency.import_count:all-python:external", definitionId: "sei.static.python.dependency.import_count@1", family: "dependency_topology", value: 3, unit: "count" }),
    pythonMetric({ metricId: "static.python.dependency.import_count:all-python:unresolved-local-candidate", definitionId: "sei.static.python.dependency.import_count@1", family: "dependency_topology", value: 1, unit: "count" }),
    pythonMetric({ metricId: "static.python.dependency.import_count:all-python:unsupported-dynamic", definitionId: "sei.static.python.dependency.import_count@1", family: "dependency_topology", value: 2, unit: "count" }),
    dependency("centrality", null, "production", "unavailable", "no named centrality algorithm is defined"),
    pythonMetric({
      metricId: "static.python.dependency.fan_in:production:acme.core",
      definitionId: "sei.static.python.dependency.fan_in@1",
      family: "dependency_topology",
      value: 2,
      unit: "count",
      subject: "python-module:acme.core",
      scopeKind: "module",
      scopePath: "src/acme/core.py",
      artifactRefs: ["python-module:acme.core", "src/acme/core.py"],
    }),
    pythonMetric({
      metricId: "static.python.dependency.fan_out:production:acme.core",
      definitionId: "sei.static.python.dependency.fan_out@1",
      family: "dependency_topology",
      value: 4,
      unit: "count",
      subject: "python-module:acme.core",
      scopeKind: "module",
      scopePath: "src/acme/core.py",
      artifactRefs: ["python-module:acme.core", "src/acme/core.py"],
    }),
    pythonMetric({
      metricId: "static.python.dependency.cyclic_scc_size:production:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      definitionId: "sei.static.python.dependency.cyclic_scc_size@1",
      family: "dependency_topology",
      value: 3,
      unit: "modules",
      subject: "python-scc:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      scopeKind: "scc",
      artifactRefs: [
        "python-scc-member:acme@src/acme/__init__.py",
        "python-scc-member:acme.core@src/acme/core.py",
        "python-scc-member:acme.helpers@src/acme/helpers.py",
      ],
    }),
  );
  snapshot.evidence_summary = {
    measurement_count: snapshot.measurements.length,
    status_counts: Object.fromEntries([...STATUS].map((name) => [
      name,
      snapshot.measurements.filter((metric) => metric.measurement.status === name).length,
    ])),
  };
  return materializeSnapshot(snapshot);
}

test("Python static intelligence renders bounded coverage-first human panels without judgment", () => {
  const snapshot = staticIntelligenceReportSnapshot();
  assert.equal(snapshot.schema_version, "1.0.0");
  assert.equal(validateSnapshot(snapshot).ok, true);
  const projection = embeddedProjection(renderReport(snapshot));
  assert.equal(projection.complexity.state, "available");
  const rawComplexity = projection.evidence_explorer.raw_views.complexity;
  assert.equal(rawComplexity.distributions.length, 8);
  assert.equal(rawComplexity.top_items.length, 12);
  assert.equal(rawComplexity.top_item_omitted_count, 0);
  assert.deepEqual(rawComplexity.distributions.map((item) => item.metric_id), [
    "static.python.cyclomatic_complexity:all-python",
    "static.python.cyclomatic_complexity:production",
    "static.python.cyclomatic_complexity_max:all-python",
    "static.python.cyclomatic_complexity_max:production",
    "static.python.cyclomatic_complexity_p50:all-python",
    "static.python.cyclomatic_complexity_p50:production",
    "static.python.cyclomatic_complexity_p90:all-python",
    "static.python.cyclomatic_complexity_p90:production",
  ]);
  assert.equal(projection.views.topology.state, "available");
  assert.equal(projection.views.topology.items.length, 15);
  assert.ok(projection.views.topology.items.some((item) => item.metric_id === "static.python.dependency.density:production" && item.value === 0.142857));
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") < 64 * 1024);
});

function unavailableAdapter(collectorId, reason) {
  return {
    collector_id: collectorId,
    collector_version: "unavailable",
    status: "unavailable",
    analyzer_identity: `external.${collectorId}`,
    analyzer_version: "unavailable",
    reason,
  };
}

function snapshotWithTypedUnavailableAdapters() {
  const snapshot = structuredClone(canonicalSnapshot);
  snapshot.collectors.push(
    unavailableAdapter("coverage-adapter", "no coverage adapter was configured"),
    unavailableAdapter("ci-adapter", "no CI adapter was configured"),
    unavailableAdapter("deployment-adapter", "no deployment adapter was configured"),
    unavailableAdapter("work-item-adapter", "no work-item adapter was configured"),
    unavailableAdapter("policy-adapter", "no policy adapter was configured"),
    unavailableAdapter("feedback-adapter", "no feedback adapter was configured"),
  );
  const deploymentComplexity = structuredClone(snapshot.measurements[0]);
  deploymentComplexity.metric_id = "structural.deployment_complexity";
  deploymentComplexity.definition_id = "sei.structural.deployment_complexity@1";
  deploymentComplexity.value = 11;
  snapshot.measurements.push(deploymentComplexity);
  snapshot.evidence_summary.measurement_count += 1;
  snapshot.evidence_summary.status_counts.measured += 1;
  return materializeSnapshot(snapshot);
}

function boundedTrendProjectionSnapshot() {
  const currentRevision = "1".repeat(40);
  const baselineRevision = "0".repeat(40);
  const snapshot = JSON.parse(JSON.stringify(canonicalSnapshot).replaceAll(canonicalSnapshot.repository.revision, currentRevision));
  snapshot.snapshot_id = "pending";
  snapshot.repository.repository_id = "bounded-trend-repository";
  snapshot.measurements = Array.from({ length: 25 }, (_, index) => {
    const metric = structuredClone(snapshot.measurements[0]);
    metric.metric_id = `static.bounded_trend_${String(index).padStart(2, "0")}`;
    metric.definition_id = `sei.static.bounded_trend_${String(index).padStart(2, "0")}@1`;
    metric.subject = `repository:${snapshot.repository.repository_id}`;
    metric.value = index + 1;
    metric.source.artifact_refs = [`src/trend-${String(index).padStart(2, "0")}.js`];
    metric.source.evidence_refs = [...metric.source.artifact_refs];
    metric.comparability.compatible_with_prior = true;
    metric.comparability.reason = "automatic canonical baseline binding";
    metric.comparison = {
      baseline_snapshot_id: "sei-v1-bounded-baseline",
      baseline_metric_id: metric.metric_id,
      analyzer_identity: metric.analyzer_identity,
      analyzer_version: metric.analyzer_version,
      configuration_hash: snapshot.repository.configuration_hash,
      binding_kind: "automatic",
      baseline_repository_revision: baselineRevision,
      baseline_value: index,
      delta: 1,
      confidence: 1,
    };
    return metric;
  });
  snapshot.evidence_summary.measurement_count = snapshot.measurements.length;
  snapshot.evidence_summary.status_counts.measured = snapshot.measurements.length;
  snapshot.run_metadata.trend_baseline = {
    binding_kind: "automatic",
    status: "selected",
    eligible: true,
    baseline_snapshot_id: "sei-v1-bounded-baseline",
    baseline_repository_revision: baselineRevision,
    compatible_metric_count: snapshot.measurements.length,
    reason: "selected nearest compatible strict ancestor",
  };
  return materializeSnapshot(snapshot);
}

function assertReportPreservesAuthorityBoundaries(html) {
  assert.match(html, /(?:Repository condition: NOT GRADED|not a grade or prescribed action)/i);
  assert.match(html, /(?:Authority preservation: Integrity retains selection authority|not a defect, priority, architecture, or repository-health verdict)/i);
  assert.doesNotMatch(html, /Repository condition:(?!\s*NOT GRADED\b)/i);
  assert.doesNotMatch(html, /\b(?:defect probability|(?:repository\s+)?health grade|candidate priority|architecture judgment|lifecycle(?: state)?|remediation order|completion authority)\b\s*(?::|=|\b(?:is|are|was|were)\b)\s*(?!not\b|unavailable\b|insufficient\b|none\b|not graded\b)/i);
}

test("report authority boundaries reject affirmative downstream claims", () => {
  const boundaries = [
    "Repository condition: NOT GRADED — SEI supplies evidence; Repository Health retains grading authority.",
    "Authority preservation: Integrity retains selection authority; Architecture retains conclusion authority; Repository Health retains grading authority.",
  ].join("\n");
  assert.doesNotThrow(() => assertReportPreservesAuthorityBoundaries(boundaries));
  for (const claim of [
    "Defect probability: 0.91",
    "Health grade: A",
    "Candidate priority: 1",
    "Architecture judgment: approved",
    "Lifecycle state: complete",
    "Remediation order: first",
    "Completion authority: granted",
    "Defect probability is 0.91",
    "Health grade is A",
    "Repository health grade = A",
    "Candidate priority is 1",
    "Architecture judgment is approved",
    "Lifecycle state is complete",
    "Lifecycle = complete",
    "Remediation order is first",
    "Completion authority = granted",
  ]) {
    assert.throws(() => assertReportPreservesAuthorityBoundaries(`${boundaries}\n${claim}`), assert.AssertionError);
  }
});

test("human Trend projection is repository-scoped, factual, and bounded to twenty metrics", () => {
  const trend = embeddedProjection(renderReport(boundedTrendProjectionSnapshot())).views.trend;
  assert.equal(trend.items.length, 20);
  assert.equal(trend.omitted_count, 5);
  assert.ok(trend.items.every((item) => item.baseline_revision === "0".repeat(40)));
  assert.ok(trend.items.every((item) => item.delta === 1 && item.direction === "unassigned"));
  assert.deepEqual(trend.items.map((item) => item.metric_id), [...trend.items.map((item) => item.metric_id)].sort());
});

test("CLI emits a validated immutable snapshot, offline report, and performance evidence", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const performancePath = path.join(fixture.root, "performance.json");

  const result = runCli(["--repo", fixture.repo, "--out", fixture.out, "--performance-json", performancePath]);
  assert.equal(result.status, 0, result.stderr);

  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.cache, "miss");
  assert.deepEqual(receipt.comparison, {
    baseline_source: "automatic",
    baseline_status: "established",
    baseline_eligible: true,
    baseline_snapshot_id: null,
    baseline_repository_revision: null,
    label: "insufficient-history",
    reason: "automatic baseline established for a later compatible run; no prior compatible strict ancestor observation selected",
    trend: {
      status: "insufficient_history",
      previous_snapshot_id: null,
      current_snapshot_id: receipt.snapshot_id,
      reason: "automatic baseline established for a later compatible run; no prior compatible strict ancestor observation selected",
      trends: [],
    },
  });
  const snapshotPath = path.join(fixture.out, "snapshots", `${receipt.snapshot_id}.json`);
  const reportPath = path.join(fixture.out, "reports", `${receipt.snapshot_id}.html`);
  assert.equal(fs.existsSync(snapshotPath), true);
  assert.equal(fs.existsSync(reportPath), true);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.equal(require("./intelligence-engine.js").validateSnapshot(snapshot).ok, true);
  const report = fs.readFileSync(reportPath, "utf8");
  const assessment = JSON.parse(fs.readFileSync(receipt.assessment_path, "utf8"));
  const assessmentBinding = assessmentPrivate.bindAssessment(assessment, snapshot);
  assert.equal(verifyRenderedReport(report, snapshot, { assessment_binding: assessmentBinding }).ok, true);
  assert.match(report, /<meta name="sei-island-sha256" content="[a-f0-9]{64}">/);
  assert.match(report, /<meta name="sei-snapshot-sha256" content="[a-f0-9]{64}">/);
  const reportProjection = embeddedProjection(report);
  assert.equal(reportProjection.source.snapshot_id, snapshot.snapshot_id);
  assert.equal(reportProjection.evidence.measurement_count, snapshot.evidence_summary.measurement_count);
  assert.ok(reportProjection.composition.items.length <= 12);
  assert.ok(reportProjection.evidence_explorer.raw_views.complexity.distributions.length <= 24);
  assert.ok(reportProjection.scatter.points.length <= 60);
  assert.ok(reportProjection.investigations.items.length <= 15);
  assert.equal(snapshot.risk_models.find((model) => model.risk_model_id === "heuristic-v1").result.records.some((feature) => feature.subject.includes("generated.js")), false);
  const investigation = snapshot.risk_models.find((model) => model.risk_model_id === "engineering-investigation-signals-v1");
  assert.ok(investigation);
  assert.ok(investigation.result.records.length <= 25);
  if (investigation.result.status === "available") {
    assert.ok(investigation.result.records.length > 0);
    assert.equal(reportProjection.investigations.state, "available");
  }
  assert.deepEqual(
    snapshot.collectors
      .filter((collector) => /-adapter$/.test(collector.collector_id))
      .map((collector) => [collector.collector_id, collector.status]),
    [
      ["ci-adapter", "unavailable"],
      ["coverage-adapter", "unavailable"],
      ["deployment-adapter", "unavailable"],
      ["feedback-adapter", "unavailable"],
      ["policy-adapter", "unavailable"],
      ["work-item-adapter", "unavailable"],
    ],
  );

  const performance = JSON.parse(fs.readFileSync(performancePath, "utf8"));
  assert.equal(typeof performance.duration_ms, "number");
  assert.equal(performance.files, 2);
  assert.equal(performance.commits, 1);
  assert.equal(typeof performance.relationship_count, "number");
  assert.equal(performance.cache, "miss");
  assert.equal(performance.cache_result, "miss");
  assert.equal("executor" in receipt.performance, false);
  assert.equal("executor" in receipt, false);
  assert.equal(performance.executor.mode, "revision-indexed-analysis-dag-v1");
  assert.ok(performance.executor.tasks_submitted >= 10);
  assert.equal(performance.executor.tasks_completed, performance.executor.tasks_submitted);
  assert.ok(performance.executor.effective_workers >= 1);
  assert.ok(performance.executor.max_in_flight >= 1 && performance.executor.max_in_flight <= 8);
  assert.equal(performance.executor.serial_fallback, false);
  assert.deepEqual(Object.keys(performance.executor.phases).sort(), ["analysis_dag", "jvm_static", "python_static", "repository_index", "tsjs_static"]);
  assert.equal(performance.executor.phases.repository_index.tasks_submitted, 1);
  assert.equal(performance.executor.phases.analysis_dag.tasks_submitted, 10);
  assert.equal(performance.executor.phases.python_static.status, "unavailable");
  assert.equal(performance.executor.git_history_execution, "async-batched-git-processes-auto-saturation-max4");
  assert.equal(performance.executor.git_history_cancellation, "cooperative-process-tree-cleanup");
  for (const field of ["queue_wait_ms", "worker_busy_ms", "wall_ms", "retries", "timeouts", "cancelled", "blocked"]) {
    assert.equal(Number.isFinite(performance.executor[field]), true, field);
    assert.ok(performance.executor[field] >= 0, field);
  }
});

test("CLI phase telemetry is deterministic, reconciled, and excluded from canonical artifacts", async (t) => {
  const fixtures = [createFixture(), createFixture()];
  t.after(() => fixtures.forEach((fixture) => fs.rmSync(fixture.root, { recursive: true, force: true })));
  const expectedPhaseFields = [
    "assessment_evaluation_ms",
    "autonomous_discovery_ms",
    "autonomous_local_execution_ms",
    "baseline_discovery_ms",
    "cache_discovery_ms",
    "comparison_ms",
    "consumer_executor_ms",
    "duplication_ms",
    "evidence_composition_ms",
    "git_history_ms",
    "input_binding_ms",
    "jvm_static_ms",
    "lexical_ms",
    "predictive_auto_ms",
    "python_static_ms",
    "report_render_ms",
    "report_verification_ms",
    "repository_index_ms",
    "repository_resolution_ms",
    "snapshot_build_ms",
    "snapshot_draft_ms",
    "snapshot_identity_ms",
    "snapshot_materialization_ms",
    "snapshot_serialization_ms",
    "snapshot_validation_ms",
    "substrate_executor_ms",
    "tsjs_static_ms",
    "verification_discovery_ms",
  ];
  const expectedAccountedFields = [
    "repository_resolution_ms",
    "input_binding_ms",
    "cache_discovery_ms",
    "substrate_executor_ms",
    "consumer_executor_ms",
    "evidence_composition_ms",
    "snapshot_build_ms",
    "baseline_discovery_ms",
    "comparison_ms",
    "predictive_auto_ms",
    "report_render_ms",
    "report_verification_ms",
    "assessment_evaluation_ms",
  ];
  const run = async (fixture) => {
    const previousStateRoot = process.env.SEI_INCREMENTAL_STATE_ROOT;
    process.env.SEI_INCREMENTAL_STATE_ROOT = path.join(fixture.root, ".sei-test-state");
    let tick = 0n;
    const performancePath = path.join(fixture.root, "phase-performance.json");
    const serialExecutor = {
      async run(tasks) {
        const results = [];
        for (const task of tasks) {
          results.push({
            id: task.id,
            state: "succeeded",
            value: await task.run({ signal: new AbortController().signal }),
          });
        }
        return {
          status: "succeeded",
          results,
          telemetry: {
            tasks_submitted: tasks.length,
            tasks_completed: tasks.length,
            effective_workers: 1,
            max_in_flight: 1,
            queue_wait_ms: 0,
            worker_busy_ms: 0,
            wall_ms: 0,
            retries: 0,
            timeouts: 0,
            cancelled: 0,
            blocked: 0,
            serial_fallback: true,
          },
        };
      },
    };
    try {
      const receipt = await cliModule[Symbol.for("sei.cli.private.v1")].executeWithExecutor(
        ["--repo", fixture.repo, "--out", fixture.out, "--performance-json", performancePath],
        serialExecutor,
        {
          monotonicNow: () => {
            tick += 1_000_000n;
            return tick;
          },
          resolvePythonRuntime: () => ({
            executable: null,
            source: "controlled-test",
            status: "unavailable",
            reason: "controlled deterministic timer fixture",
          }),
        },
      );
      return { receipt, performance: JSON.parse(fs.readFileSync(performancePath, "utf8")) };
    } finally {
      if (previousStateRoot === undefined) delete process.env.SEI_INCREMENTAL_STATE_ROOT;
      else process.env.SEI_INCREMENTAL_STATE_ROOT = previousStateRoot;
    }
  };

  const first = await run(fixtures[0]);
  const second = await run(fixtures[1]);
  const telemetry = first.performance.phase_telemetry;
  assert.deepEqual(Object.keys(telemetry).sort(), [
    "clock",
    "excluded_phases",
    "phases_ms",
    "reconciliation",
    "schema_version",
    "timing_scope",
  ]);
  assert.deepEqual(Object.keys(telemetry.phases_ms).sort(), expectedPhaseFields);
  for (const [field, value] of Object.entries(telemetry.phases_ms)) {
    assert.equal(Number.isFinite(value), true, field);
    assert.ok(value >= 0, field);
  }
  assert.deepEqual(Object.keys(telemetry.reconciliation).sort(), [
    "accounted_fields",
    "accounted_ms",
    "prepublication_duration_ms",
    "tolerance_ms",
    "unattributed_ms",
    "within_tolerance",
  ]);
  assert.deepEqual(telemetry.reconciliation.accounted_fields, expectedAccountedFields);
  assert.equal(telemetry.reconciliation.within_tolerance, true);
  assert.equal(telemetry.reconciliation.prepublication_duration_ms, first.performance.duration_ms);
  assert.ok(telemetry.reconciliation.unattributed_ms >= 0);
  assert.ok(telemetry.reconciliation.unattributed_ms <= telemetry.reconciliation.tolerance_ms);
  assert.deepEqual(Object.keys(telemetry.excluded_phases).sort(), [
    "artifact_preflight_ms",
    "artifact_publication_ms",
    "performance_receipt_write_ms",
  ]);
  assert.deepEqual(first.performance.phase_telemetry, second.performance.phase_telemetry);
  assert.deepEqual(first.performance.cache_validation, {
    prior_static_snapshot: { attempted: false, result: "superseded-by-compact-state" },
    incremental_static_state: { attempted: true, result: "miss" },
    incremental_history_state: { attempted: true, result: "miss" },
    canonical_snapshot: { attempted: true, result: "miss" },
  });

  const returned = first.receipt.performance;
  assert.equal(typeof returned.phase_telemetry.phases_ms.artifact_preflight_ms, "number");
  assert.equal(typeof returned.phase_telemetry.phases_ms.artifact_publication_ms, "number");
  assert.equal(typeof returned.phase_telemetry.phases_ms.total_internal_ms, "number");
  assert.equal(returned.phase_telemetry.phases_ms.total_internal_ms >= first.performance.duration_ms, true);
  assert.equal(returned.phase_telemetry.excluded_phases.performance_receipt_write_ms.length > 0, true);
  assert.equal(returned.artifacts.planned_count, 8);
  assert.equal(returned.artifacts.existing_count, 0);
  assert.equal(returned.artifacts.linked_count, 8);
  assert.equal(returned.artifacts.manifest_published_last, true);

  assert.equal(first.receipt.snapshot_id, second.receipt.snapshot_id);
  assert.ok(fs.readFileSync(first.receipt.snapshot_path).equals(fs.readFileSync(second.receipt.snapshot_path)));
  assert.ok(fs.readFileSync(first.receipt.report_path).equals(fs.readFileSync(second.receipt.report_path)));
  assert.equal("phase_telemetry" in snapshotFor(first.receipt), false);
  assert.equal(fs.readFileSync(first.receipt.report_path, "utf8").includes("phase_telemetry"), false);

  const canonical = snapshotFor(first.receipt);
  let engineTick = 0n;
  const observedFields = [];
  const withObserver = intelligenceEngine[Symbol.for("sei.intelligence-engine.private.v1")]
    .materializeSnapshotWithTelemetry(canonical, {
      now() {
        engineTick += 1_000_000n;
        return engineTick;
      },
      observe(field, durationMs) {
        observedFields.push([field, durationMs]);
      },
    });
  const withoutObserver = materializeSnapshot(canonical);
  assert.equal(withObserver.snapshot_id, withoutObserver.snapshot_id);
  assert.equal(JSON.stringify(withObserver), JSON.stringify(withoutObserver));
  assert.ok(observedFields.some(([field]) => field === "snapshot_validation_ms"));
  assert.ok(observedFields.some(([field]) => field === "snapshot_identity_ms"));
});

test("CLI collection executor failure is closed before any output directory exists", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const privateApi = cliModule[Symbol.for("sei.cli.private.v1")];
  assert.equal(typeof privateApi.executeWithExecutor, "function");
  const failedExecutor = {
    async run(tasks) {
      assert.deepEqual(tasks.map((task) => task.id), ["repository-index"]);
      assert.deepEqual(tasks.map((task) => task.resourceClass), ["io_git"]);
      assert.deepEqual(tasks.map((task) => task.deterministicOrderKey), ["00:repository-index"]);
      return {
        status: "completed_with_failures",
        results: [
          { id: "repository-index", state: "failed", error: { code: "FAIL-SYNTHETIC", message: "synthetic collection failure" } },
        ],
        telemetry: {},
      };
    },
  };
  await assert.rejects(
    privateApi.executeWithExecutor(["--repo", fixture.repo, "--out", fixture.out], failedExecutor),
    /FAIL-CLI-COLLECTION.*synthetic collection failure/,
  );
  assert.equal(fs.existsSync(path.join(fixture.out, "reports")), false);
  assert.equal(fs.existsSync(path.join(fixture.out, "snapshots")), false);
});

test("CLI submits one index prerequisite then one independent analysis DAG over the exact index", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const previousStateRoot = process.env.SEI_INCREMENTAL_STATE_ROOT;
  process.env.SEI_INCREMENTAL_STATE_ROOT = path.join(fixture.root, ".sei-test-state");
  t.after(() => {
    if (previousStateRoot === undefined) delete process.env.SEI_INCREMENTAL_STATE_ROOT;
    else process.env.SEI_INCREMENTAL_STATE_ROOT = previousStateRoot;
  });
  fs.writeFileSync(path.join(fixture.repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  git(fixture.repo, ["add", "package.json"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "add verification candidate"]);
  const privateApi = cliModule[Symbol.for("sei.cli.private.v1")];
  const seen = [];
  const indexReceivers = [];
  let sharedIndex = null;
  const executor = {
    async run(tasks) {
      seen.push(tasks);
      const values = [];
      for (const task of tasks) {
        let value = await task.run({ signal: new AbortController().signal });
        if (task.id === "repository-index") {
          const builtIndex = value;
          sharedIndex = Object.freeze({
            ...builtIndex,
            readBlobs(...args) {
              indexReceivers.push(this);
              return builtIndex.readBlobs(...args);
            },
          });
          value = sharedIndex;
        }
        values.push({ id: task.id, state: "succeeded", value });
      }
      return {
        status: "succeeded",
        results: values,
        telemetry: {
          tasks_submitted: tasks.length,
          tasks_completed: tasks.length,
          effective_workers: 1,
          max_in_flight: 1,
          queue_wait_ms: 0,
          worker_busy_ms: 0,
          wall_ms: 0,
          retries: 0,
          timeouts: 0,
          cancelled: 0,
          blocked: 0,
          serial_fallback: true,
        },
      };
    },
  };

  const receipt = await privateApi.executeWithExecutor(["--repo", fixture.repo, "--out", fixture.out], executor);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].map((task) => ({
    id: task.id,
    resourceClass: task.resourceClass,
    concurrencyGroup: task.concurrencyGroup,
    deterministicOrderKey: task.deterministicOrderKey,
    memoryWeight: task.memoryWeight,
  })), [
    { id: "repository-index", resourceClass: "io_git", concurrencyGroup: "git-tree-index", deterministicOrderKey: "00:repository-index", memoryWeight: 1 },
  ]);
  assert.deepEqual(seen[1].map((task) => ({
    id: task.id,
    resourceClass: task.resourceClass,
    concurrencyGroup: task.concurrencyGroup,
    deterministicOrderKey: task.deterministicOrderKey,
    memoryWeight: task.memoryWeight,
  })), [
    { id: "git-history", resourceClass: "io_git", concurrencyGroup: "git-history", deterministicOrderKey: "10:git-history", memoryWeight: 4 },
    { id: "static-source", resourceClass: "io_git", concurrencyGroup: "git-blob-read", deterministicOrderKey: "20:static-source", memoryWeight: 4 },
    { id: "verification-discovery", resourceClass: "io_light", concurrencyGroup: null, deterministicOrderKey: "30:verification-discovery", memoryWeight: 1 },
    { id: "autonomous-evidence", resourceClass: "io_light", concurrencyGroup: null, deterministicOrderKey: "35:autonomous-evidence", memoryWeight: 1 },
    { id: "autonomous-local-execution", resourceClass: "external_process", concurrencyGroup: "local-verification", deterministicOrderKey: "36:autonomous-local-execution", memoryWeight: 2 },
    { id: "python-static", resourceClass: "external_process", concurrencyGroup: "language-analyzer", deterministicOrderKey: "40:python-static", memoryWeight: 3 },
    { id: "tsjs-static", resourceClass: "external_process", concurrencyGroup: "language-analyzer", deterministicOrderKey: "50:tsjs-static", memoryWeight: 3 },
    { id: "structural-duplication", resourceClass: "cpu_heavy", concurrencyGroup: "duplication-analysis", deterministicOrderKey: "60:structural-duplication", memoryWeight: 4 },
    { id: "jvm-static", resourceClass: "external_process", concurrencyGroup: "language-analyzer", deterministicOrderKey: "65:jvm-static", memoryWeight: 4 },
    { id: "named-dependency-intelligence", resourceClass: "cpu_heavy", concurrencyGroup: "dependency-analysis", deterministicOrderKey: "70:named-dependency-intelligence", memoryWeight: 2 },
  ]);
  assert.ok(indexReceivers.length >= 2);
  assert.ok(indexReceivers.every((receiver) => receiver === sharedIndex));
  assert.equal(receipt.snapshot_id.length > 0, true);
});

test("CLI does not submit the analysis DAG after the index prerequisite fails", async (t) => {
  for (const failedId of ["repository-index"]) {
    const fixture = createFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    let calls = 0;
    const executor = {
      async run(tasks) {
        calls += 1;
        assert.deepEqual(tasks.map((task) => task.id), ["repository-index"]);
        return {
          status: "completed_with_failures",
          results: tasks.map((task) => task.id === failedId
            ? { id: task.id, state: "failed", error: { message: `${failedId} failed` } }
            : { id: task.id, state: "succeeded", value: {} }),
          telemetry: {},
        };
      },
    };
    await assert.rejects(
      cliModule[Symbol.for("sei.cli.private.v1")].executeWithExecutor(["--repo", fixture.repo, "--out", fixture.out], executor),
      new RegExp(`FAIL-CLI-COLLECTION.*${failedId} failed`),
    );
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(fixture.out), false);
  }
});

test("CLI analysis DAG branch failure publishes no output after the exact index barrier", async (t) => {
  for (const failedId of ["git-history", "static-source", "verification-discovery", "autonomous-evidence", "autonomous-local-execution", "python-static", "tsjs-static", "structural-duplication", "jvm-static", "named-dependency-intelligence"]) {
    const fixture = createFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    let calls = 0;
    const executor = {
      async run(tasks) {
        calls += 1;
        if (calls === 1) {
          const results = [];
          for (const task of tasks) results.push({ id: task.id, state: "succeeded", value: await task.run({ signal: new AbortController().signal }) });
          return { status: "succeeded", results, telemetry: {} };
        }
        assert.deepEqual(tasks.map((task) => task.id), ["git-history", "static-source", "verification-discovery", "autonomous-evidence", "autonomous-local-execution", "python-static", "tsjs-static", "structural-duplication", "jvm-static", "named-dependency-intelligence"]);
        return {
          status: "completed_with_failures",
          results: tasks.map((task) => task.id === failedId
            ? { id: task.id, state: "failed", error: { message: `${failedId} failed` } }
            : { id: task.id, state: "succeeded", value: {} }),
          telemetry: {},
        };
      },
    };
    await assert.rejects(
      cliModule[Symbol.for("sei.cli.private.v1")].executeWithExecutor(["--repo", fixture.repo, "--out", fixture.out], executor),
      new RegExp(`FAIL-CLI-COLLECTION.*${failedId} failed`),
    );
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(fixture.out), false);
  }
});

test("default completion and reversed one-worker phase completion emit identical canonical bytes", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const defaultOut = path.join(fixture.root, "default-out");
  const reversedOut = path.join(fixture.root, "reversed-out");
  const defaultRun = runCli(["--repo", fixture.repo, "--out", defaultOut]);
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  const defaultReceipt = JSON.parse(defaultRun.stdout);

  const reverseExecutor = {
    async run(tasks) {
      const results = [];
      const pending = new Map(tasks.map((task) => [task.id, task]));
      const completed = new Set();
      while (pending.size > 0) {
        const ready = [...pending.values()].filter((task) => (task.dependencies ?? []).every((dependency) => completed.has(dependency))).reverse();
        assert.ok(ready.length > 0, "synthetic executor graph must remain acyclic");
        for (const task of ready) {
          results.push({ id: task.id, state: "succeeded", value: await task.run({ signal: new AbortController().signal }) });
          pending.delete(task.id);
          completed.add(task.id);
        }
      }
      return {
        status: "succeeded",
        results,
        telemetry: {
          tasks_submitted: tasks.length,
          tasks_completed: tasks.length,
          effective_workers: 1,
          max_in_flight: 1,
          queue_wait_ms: 0,
          worker_busy_ms: 0,
          wall_ms: 0,
          retries: 0,
          timeouts: 0,
          cancelled: 0,
          blocked: 0,
          serial_fallback: true,
        },
      };
    },
  };
  const previousStateRoot = process.env.SEI_INCREMENTAL_STATE_ROOT;
  process.env.SEI_INCREMENTAL_STATE_ROOT = path.join(fixture.root, ".sei-test-state");
  let reversedReceipt;
  try {
    reversedReceipt = await cliModule[Symbol.for("sei.cli.private.v1")].executeWithExecutor(
      ["--repo", fixture.repo, "--out", reversedOut],
      reverseExecutor,
    );
  } finally {
    if (previousStateRoot === undefined) delete process.env.SEI_INCREMENTAL_STATE_ROOT;
    else process.env.SEI_INCREMENTAL_STATE_ROOT = previousStateRoot;
  }
  assert.equal(defaultReceipt.snapshot_id, reversedReceipt.snapshot_id);
  assert.ok(fs.readFileSync(defaultReceipt.snapshot_path).equals(fs.readFileSync(reversedReceipt.snapshot_path)));
  assert.ok(fs.readFileSync(defaultReceipt.report_path).equals(fs.readFileSync(reversedReceipt.report_path)));
});

test("CLI validates an explicit canonical baseline and emits a bound comparison receipt", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root, "bounded-history.json", {
    history_window: { kind: "revision-range", start: git(fixture.repo, ["rev-parse", "HEAD"]) },
  });
  const baselineRun = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]);
  assert.equal(baselineRun.status, 0, baselineRun.stderr);
  const baseline = JSON.parse(baselineRun.stdout);

  fs.appendFileSync(path.join(fixture.repo, "index.js"), "function intermediate() { return 2; }\n");
  git(fixture.repo, ["add", "index.js"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "intermediate automatic comparison fixture"]);
  const intermediateRun = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]);
  assert.equal(intermediateRun.status, 0, intermediateRun.stderr);
  const intermediate = JSON.parse(intermediateRun.stdout);
  assert.equal(intermediate.comparison.baseline_source, "automatic");
  assert.equal(intermediate.comparison.baseline_snapshot_id, baseline.snapshot_id);
  for (let index = 0; index <= AUTOMATIC_BASELINE_MAX_CANDIDATES; index += 1) {
    fs.writeFileSync(
      path.join(fixture.out, "snapshots", `explicit-precedence-poison-${String(index).padStart(4, "0")}.json`),
      "{}",
      "utf8",
    );
  }

  fs.appendFileSync(path.join(fixture.repo, "index.js"), "function later() { return 3; }\n");
  git(fixture.repo, ["add", "index.js"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "explicit baseline precedence fixture"]);

  const comparedRun = runCli([
    "--repo", fixture.repo,
    "--out", fixture.out,
    "--config", config,
    "--baseline", baseline.snapshot_path,
  ]);
  assert.equal(comparedRun.status, 0, comparedRun.stderr);
  const receipt = JSON.parse(comparedRun.stdout);
  const comparedSnapshot = snapshotFor(receipt);

  assert.deepEqual(Object.keys(receipt.comparison).sort(), [
    "baseline_eligible",
    "baseline_repository_revision",
    "baseline_snapshot_id",
    "baseline_source",
    "baseline_status",
    "compatibility",
    "direction",
    "label",
    "reason",
    "trend",
  ]);
  assert.equal(receipt.comparison.baseline_source, "explicit");
  assert.equal(receipt.comparison.baseline_status, "explicit");
  assert.equal(receipt.comparison.baseline_eligible, true);
  assert.equal(receipt.comparison.baseline_snapshot_id, baseline.snapshot_id);
  assert.notEqual(receipt.comparison.baseline_snapshot_id, intermediate.snapshot_id);
  assert.equal(receipt.comparison.label, null);
  assert.equal(receipt.comparison.compatibility, "comparable");
  assert.equal(receipt.comparison.direction, "unassigned");
  assert.match(receipt.comparison.reason, /directional interpretation contract/i);
  assert.equal(receipt.comparison.trend.previous_snapshot_id, baseline.snapshot_id);
  assert.equal(receipt.comparison.trend.current_snapshot_id, receipt.snapshot_id);
  assert.equal(receipt.comparison.trend.status, "mixed");
  for (const metric of comparedSnapshot.measurements.filter((candidate) => candidate.metric_id.startsWith("git.observed_"))) {
    assert.equal(metric.comparability.compatible_with_prior, false, metric.metric_id);
    assert.equal("comparison" in metric, false, metric.metric_id);
  }
  const staticSourceLines = receipt.comparison.trend.trends.find((trend) => trend.metric_id === "static.source_lines");
  assert.equal(staticSourceLines.delta, 2);
  const unavailableGitMetric = receipt.comparison.trend.trends.find((trend) => trend.metric_id === "git.age_days");
  assert.equal("delta" in unavailableGitMetric, false);
});

test("CLI automatically selects a prior strict ancestor across local-origin clones and renders factual deltas", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-auto-trend-clones-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const cloneA = path.join(root, "clone-a");
  const cloneB = path.join(root, "relocated", "clone-b");
  const out = path.join(root, "shared-output");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "index.js"), "export const first = 1;\n", "utf8");
  git(source, ["init", "--quiet"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "first observation"]);
  git(root, ["clone", "--quiet", source, cloneA]);
  fs.mkdirSync(path.dirname(cloneB), { recursive: true });
  git(root, ["clone", "--quiet", source, cloneB]);
  const config = writeConfig(root, "automatic-trend.json");

  const firstRun = runCli(["--repo", cloneA, "--out", out, "--config", config]);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const firstReceipt = JSON.parse(firstRun.stdout);
  const firstSnapshot = snapshotFor(firstReceipt);
  assert.equal(firstReceipt.comparison.baseline_source, "automatic");
  assert.equal(firstReceipt.comparison.baseline_status, "established");
  assert.equal(firstReceipt.comparison.baseline_eligible, true);
  assert.equal(firstReceipt.comparison.baseline_snapshot_id, null);
  assert.equal(firstSnapshot.run_metadata.trend_baseline.binding_kind, "automatic");
  assert.equal(firstSnapshot.run_metadata.trend_baseline.status, "established");
  const firstProjection = embeddedProjection(fs.readFileSync(firstReceipt.report_path, "utf8"));
  const firstTrend = firstProjection.views.trend;
  assert.equal(firstTrend.state, "unavailable");
  assert.equal(firstProjection.trend_status.state, "first-compatible-sei-observation");
  assert.equal(firstTrend.empty_state.cause_kind, "first-compatible-sei-observation");
  assert.doesNotMatch(firstProjection.trend_status.summary, /repository is new|insufficient history/i);

  fs.appendFileSync(path.join(cloneB, "index.js"), "export const second = 2;\n", "utf8");
  git(cloneB, ["add", "index.js"]);
  git(cloneB, ["commit", "--quiet", "-m", "later observation"]);
  const laterRevision = git(cloneB, ["rev-parse", "HEAD"]);
  const firstRevision = git(cloneA, ["rev-parse", "HEAD"]);

  const laterRun = runCli(["--repo", cloneB, "--out", out, "--config", config]);
  assert.equal(laterRun.status, 0, laterRun.stderr);
  const laterReceipt = JSON.parse(laterRun.stdout);
  const laterSnapshot = snapshotFor(laterReceipt);
  assert.equal(laterReceipt.revision, laterRevision);
  assert.equal(laterReceipt.comparison.baseline_source, "automatic");
  assert.equal(laterReceipt.comparison.baseline_status, "selected", JSON.stringify(laterReceipt.comparison));
  assert.equal(laterReceipt.comparison.baseline_eligible, true);
  assert.equal(laterReceipt.comparison.baseline_snapshot_id, firstReceipt.snapshot_id);
  assert.equal(laterReceipt.comparison.baseline_repository_revision, firstRevision);
  const sourceLines = laterSnapshot.measurements.find((metric) => metric.metric_id === "static.source_lines");
  assert.equal(sourceLines.comparison.binding_kind, "automatic");
  assert.equal(sourceLines.comparison.baseline_repository_revision, firstRevision);
  assert.equal(sourceLines.comparison.baseline_value, 1);
  assert.equal(sourceLines.comparison.delta, 1);
  assert.equal(sourceLines.comparison.confidence, 1);

  const laterProjection = embeddedProjection(fs.readFileSync(laterReceipt.report_path, "utf8"));
  const trend = laterProjection.views.trend;
  assert.equal(laterProjection.trend_status.state, "prior-compatible-baseline-selected");
  const sourceLineTrend = trend.items.find((item) => item.metric_id === "static.source_lines");
  assert.deepEqual(sourceLineTrend, {
    metric_id: "static.source_lines",
    value: 2,
    baseline_value: 1,
    delta: 1,
    unit: "lines",
    confidence: 1,
    baseline_revision: firstRevision,
    direction: "unassigned",
  });
  const laterDocument = runReportDom(fs.readFileSync(laterReceipt.report_path, "utf8"));
  const primaryTrendChart = laterDocument.getElementById("trend-primary-chart");
  const primaryTrend = primaryTrendChart.textContent;
  assert.match(primaryTrend, /Human-maintained source lines/);
  assert.ok(browserlessDescendants(primaryTrendChart).filter((element) => element.tagName === "CIRCLE").length >= 2);
  assert.doesNotMatch(primaryTrend, /static\.source_lines/);
});

test("CLI normalizes explicit local JUnit XML and LCOV artifacts into verification evidence", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.root, "junit.xml"), `<testsuite tests="2" failures="1" errors="0" skipped="0" time="0.5">
  <testcase name="pass" time="0.2"/>
  <testcase name="fail" time="0.3"><failure/></testcase>
</testsuite>`, "utf8");
  fs.writeFileSync(path.join(fixture.root, "lcov.info"), `SF:src/index.js
LF:10
LH:8
BRF:4
BRH:3
end_of_record
`, "utf8");
  const config = writeConfig(fixture.root, "verification-artifacts.json", {
    verification_artifacts: {
      artifacts: [
        { format: "junit-xml", path: "junit.xml" },
        { format: "lcov", path: "lcov.info" },
      ],
      completeness: { state: "complete", fraction: 1 },
      coverage: { scope: "repository", fraction: 1 },
    },
  });

  const result = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]);
  assert.equal(result.status, 0, result.stderr);
  const snapshot = snapshotFor(JSON.parse(result.stdout));
  const verification = snapshot.collectors.find((collector) => collector.collector_id === "verification-summary");
  assert.equal(verification.status, "available");
  const values = Object.fromEntries(snapshot.measurements
    .filter((metric) => metric.metric_id.startsWith("verification."))
    .map((metric) => [metric.metric_id, metric.value]));
  assert.deepEqual(values, {
    "verification.autonomous_duration_ms": null,
    "verification.autonomous_tests_failed": null,
    "verification.autonomous_tests_passed": null,
    "verification.autonomous_tests_total": null,
    "verification.branch_coverage": 0.75,
    "verification.duration_ms": 500,
    "verification.statement_coverage": 0.8,
    "verification.tests_failed": 1,
    "verification.tests_passed": 1,
    "verification.tests_total": 2,
  });
  const artifactRefs = snapshot.measurements.find((metric) => metric.metric_id === "verification.tests_total").source.artifact_refs;
  assert.ok(artifactRefs.every((reference) => !reference.includes("junit.xml") && !reference.includes("lcov.info")));
  assert.ok(artifactRefs.some((reference) => /^local-verification-artifacts:sha256:[a-f0-9]{64}$/.test(reference)));
});

test("CLI discovers verification configuration only from blobs at the resolved revision", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture.repo, ".github", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, "apps", "ui", "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, "python", "tests"), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, "service", "src", "test", "java"), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, ".github", "workflows", "ci.yml"), `name: CI
# jest is comment-only and must not become a surface
jobs:
  checks:
    steps:
      - run: ./gradlew test
      - run: uv run pytest -q
      - run: npm run test
`, "utf8");
  fs.writeFileSync(path.join(fixture.repo, "apps", "ui", "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
  fs.writeFileSync(path.join(fixture.repo, "apps", "ui", "src", "ui.test.ts"), "test('ui', () => {});\n", "utf8");
  fs.writeFileSync(path.join(fixture.repo, "python", "pyproject.toml"), "[tool.pytest.ini_options]\npythonpath = ['app']\n", "utf8");
  fs.writeFileSync(path.join(fixture.repo, "python", "tests", "test_api.py"), "def test_api(): pass\n", "utf8");
  fs.writeFileSync(path.join(fixture.repo, "service", "build.gradle.kts"), "tasks.withType<Test> { useJUnitPlatform() }\n", "utf8");
  fs.writeFileSync(path.join(fixture.repo, "service", "src", "test", "java", "ApiTest.java"), "class ApiTest {}\n", "utf8");
  git(fixture.repo, ["add", "."]);
  git(fixture.repo, ["commit", "--quiet", "-m", "configured verification"]);
  const committedRevision = git(fixture.repo, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(fixture.repo, ".github", "workflows", "ci.yml"), "# mypy pyright ruff only in mutable working-tree comments\n", "utf8");
  fs.writeFileSync(path.join(fixture.repo, "apps", "ui", "package.json"), JSON.stringify({ scripts: {} }), "utf8");

  const result = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  const snapshot = snapshotFor(receipt);
  assert.equal(snapshot.repository.revision, committedRevision);
  assert.deepEqual(snapshot.collectors
    .filter((collector) => collector.collector_id.endsWith("-discovery"))
    .map((collector) => [collector.collector_id, collector.status]), [
      ["ci-discovery", "degraded"],
      ["coverage-discovery", "unavailable"],
      ["test-discovery", "degraded"],
    ]);
  const ciDiscovery = snapshot.measurements.find((metric) => metric.metric_id === "discovery.ci_evidence_path_count");
  assert.equal(ciDiscovery.value, 1);
  assert.deepEqual(ciDiscovery.source.artifact_refs, [".github/workflows/ci.yml"]);
  assert.deepEqual(ciDiscovery.source.evidence_refs, [
    "workflow-surface:Gradle/JUnit",
    "workflow-surface:Vitest",
    "workflow-surface:pytest",
  ]);
  assert.equal(snapshot.measurements.find((metric) => metric.metric_id === "discovery.test_evidence_path_count").value, 6);
  assert.equal(snapshot.measurements.find((metric) => metric.metric_id === "discovery.coverage_evidence_path_count").measurement.status, "unavailable");
  assert.equal(snapshot.collectors.find((collector) => collector.collector_id === "verification-summary").status, "unavailable");

  const reportProjection = embeddedProjection(fs.readFileSync(receipt.report_path, "utf8"));
  assert.equal(reportProjection.source.snapshot_id, snapshot.snapshot_id);
  assert.equal(reportProjection.evidence.collectors.find((item) => item.status === "degraded").count >= 2, true);
  assert.doesNotMatch(JSON.stringify({ assessment: reportProjection.assessment, capability_coverage: reportProjection.capability_coverage }), /\.github\/workflows\/ci\.yml|workflow-surface:/);
});

test("CLI isolates an oversized committed workflow to configured discovery", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture.repo, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.repo, ".github", "workflows", "oversized.yml"),
    `name: oversized\n# ${"x".repeat((2 * 1024 * 1024) + 64)}\n`,
    "utf8",
  );
  git(fixture.repo, ["add", "."]);
  git(fixture.repo, ["commit", "--quiet", "-m", "oversized workflow"]);

  const result = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(result.status, 0, result.stderr);
  const snapshot = snapshotFor(JSON.parse(result.stdout));
  const collector = snapshot.collectors.find((candidate) => candidate.collector_id === "ci-discovery");
  const metric = snapshot.measurements.find((candidate) => candidate.metric_id === "discovery.ci_evidence_path_count");
  assert.equal(collector.status, "degraded");
  assert.match(collector.reason, /bounded content could not be inspected/i);
  assert.equal(metric.value, 1);
  assert.deepEqual(metric.source.artifact_refs, [".github/workflows/oversized.yml"]);
  assert.deepEqual(metric.source.evidence_refs, []);
});

test("CLI normalizes committed conventional results without duplicating an explicit verification summary", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture.repo, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, "test-results", "TEST-unit.xml"), [
    '<testsuite tests="1" failures="0" skipped="0" time="0.125">',
    '  <testcase name="committed" time="0.125"/>',
    "</testsuite>",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(fixture.repo, "lcov.info"), "SF:index.js\nLF:2\nLH:1\nend_of_record\n", "utf8");
  git(fixture.repo, ["add", "."]);
  git(fixture.repo, ["commit", "--quiet", "-m", "committed verification results"]);

  const discoveredRun = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(discoveredRun.status, 0, discoveredRun.stderr);
  const discoveredReceipt = JSON.parse(discoveredRun.stdout);
  const discovered = snapshotFor(discoveredReceipt);
  assert.equal(discovered.collectors.find((collector) => collector.collector_id === "test-discovery").status, "available");
  assert.equal(discovered.collectors.find((collector) => collector.collector_id === "coverage-discovery").status, "available");
  assert.equal(discovered.collectors.find((collector) => collector.collector_id === "verification-summary").status, "degraded");
  const discoveredTests = discovered.measurements.find((metric) => metric.metric_id === "verification.tests_total");
  const discoveredCoverage = discovered.measurements.find((metric) => metric.metric_id === "verification.statement_coverage");
  assert.equal(discoveredTests.value, 1);
  assert.equal(discoveredCoverage.value, 0.5);
  assert.equal(discoveredTests.measurement.completeness, 0);
  assert.equal(discoveredTests.measurement.confidence, 0);
  assert.ok(discoveredTests.source.artifact_refs.some((reference) => /^revision-verification-artifacts:sha256:[a-f0-9]{64}$/.test(reference)));
  const discoveredProjection = embeddedProjection(fs.readFileSync(discoveredReceipt.report_path, "utf8"));
  assert.equal(discoveredProjection.source.snapshot_id, discovered.snapshot_id);
  assert.equal(discoveredProjection.evidence.measurement_count, discovered.evidence_summary.measurement_count);
  assert.doesNotMatch(JSON.stringify(discoveredProjection), /revision-verification-artifacts:/);

  fs.writeFileSync(path.join(fixture.root, "explicit-junit.xml"), '<testsuite tests="2" failures="0" skipped="0" time="0.5"/>\n', "utf8");
  fs.writeFileSync(path.join(fixture.root, "explicit-lcov.info"), "SF:index.js\nLF:5\nLH:4\nBRF:4\nBRH:3\nend_of_record\n", "utf8");
  const config = writeConfig(fixture.root, "explicit-verification.json", {
    verification_artifacts: {
      artifacts: [
        { format: "junit-xml", path: "explicit-junit.xml" },
        { format: "lcov", path: "explicit-lcov.info" },
      ],
      completeness: { state: "complete", fraction: 1 },
      coverage: { scope: "repository", fraction: 1 },
    },
  });
  const explicitRun = runCli(["--repo", fixture.repo, "--out", path.join(fixture.root, "explicit-out"), "--config", config]);
  assert.equal(explicitRun.status, 0, explicitRun.stderr);
  const explicit = snapshotFor(JSON.parse(explicitRun.stdout));
  assert.equal(explicit.collectors.filter((collector) => collector.collector_id === "verification-summary").length, 1);
  assert.equal(explicit.collectors.find((collector) => collector.collector_id === "verification-summary").status, "available");
  const explicitTests = explicit.measurements.find((metric) => metric.metric_id === "verification.tests_total");
  assert.equal(explicitTests.value, 2);
  assert.equal(explicitTests.measurement.completeness, 1);
  assert.equal(explicitTests.measurement.confidence, 1);
  assert.equal(explicit.measurements.find((metric) => metric.metric_id === "verification.statement_coverage").value, 0.8);
  assert.ok(explicitTests.source.artifact_refs.some((reference) => /^local-verification-artifacts:sha256:[a-f0-9]{64}$/.test(reference)));
  assert.equal(explicitTests.source.artifact_refs.some((reference) => /^revision-verification-artifacts:/.test(reference)), false);
});

test("default CLI history binds an explicit baseline at a stable root and reports nonzero factual deltas without an invented direction", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const baselineRun = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(baselineRun.status, 0, baselineRun.stderr);
  const baseline = JSON.parse(baselineRun.stdout);
  const baselineSnapshot = snapshotFor(baseline);

  fs.appendFileSync(path.join(fixture.repo, "index.js"), "function defaultBaselineLater() { return 4; }\n");
  git(fixture.repo, ["add", "index.js"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "default baseline comparison fixture"]);

  const comparedRun = runCli([
    "--repo", fixture.repo,
    "--out", fixture.out,
    "--baseline", baseline.snapshot_path,
  ]);
  assert.equal(comparedRun.status, 0, comparedRun.stderr);
  const receipt = JSON.parse(comparedRun.stdout);
  const currentSnapshot = snapshotFor(receipt);
  const sourceLines = receipt.comparison.trend.trends.find((trend) => trend.metric_id === "static.source_lines");

  assert.match(baselineSnapshot.repository.history_boundary.start, /^[a-f0-9]{40}$/);
  assert.equal(currentSnapshot.repository.history_boundary.start, baselineSnapshot.repository.history_boundary.start);
  assert.equal(receipt.comparison.label, null);
  assert.equal(receipt.comparison.compatibility, "comparable");
  assert.equal(receipt.comparison.direction, "unassigned");
  assert.match(receipt.comparison.reason, /directional interpretation/i);
  assert.equal(sourceLines.status, "comparable");
  assert.equal(sourceLines.delta, 1);
});

test("default CLI history fails closed when a repository has multiple observable roots", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const head = git(fixture.repo, ["rev-parse", "HEAD"]);
  const tree = git(fixture.repo, ["write-tree"]);
  const unrelated = git(fixture.repo, ["commit-tree", tree, "-m", "unrelated root"]);
  const merge = git(fixture.repo, ["commit-tree", tree, "-p", head, "-p", unrelated, "-m", "merge unrelated roots"]);
  const branch = git(fixture.repo, ["symbolic-ref", "--short", "HEAD"]);
  git(fixture.repo, ["update-ref", `refs/heads/${branch}`, merge]);

  const rejected = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /FAIL-REPOSITORY-REVISION.*one observable repository root/i);
  assert.equal(fs.existsSync(fixture.out), false);
});

test("default CLI history fails closed for a shallow repository until an explicit window is supplied", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.appendFileSync(path.join(fixture.repo, "index.js"), "function shallowLater() { return 5; }\n");
  git(fixture.repo, ["add", "index.js"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "shallow source second commit"]);
  const shallow = path.join(fixture.root, "shallow");
  const clone = spawnSync("git", ["clone", "--quiet", "--depth", "1", pathToFileURL(fixture.repo).href, shallow], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(clone.status, 0, clone.stderr);
  const out = path.join(fixture.root, "shallow-out");

  const rejected = runCli(["--repo", shallow, "--out", out]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /FAIL-REPOSITORY-REVISION.*shallow repository/i);
  assert.equal(fs.existsSync(out), false);
});

test("CLI accepts a closed hash-bound baseline reference without accepting path aliases", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const baselineRun = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(baselineRun.status, 0, baselineRun.stderr);
  const baselineReceipt = JSON.parse(baselineRun.stdout);
  const baselineSnapshot = JSON.parse(fs.readFileSync(baselineReceipt.snapshot_path, "utf8"));
  const referencePath = path.join(fixture.root, "baseline-reference.json");
  const reference = {
    kind: "sei-canonical-snapshot-ref",
    schema_version: "1.0.0",
    snapshot_id: baselineSnapshot.snapshot_id,
    snapshot_sha256: `sha256:${crypto.createHash("sha256").update(JSON.stringify(baselineSnapshot)).digest("hex")}`,
    snapshot: baselineSnapshot,
  };
  fs.writeFileSync(referencePath, `${JSON.stringify(reference, null, 2)}\n`);

  fs.appendFileSync(path.join(fixture.repo, "index.js"), "function referenceBaseline() { return 3; }\n");
  git(fixture.repo, ["add", "index.js"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "closed baseline reference fixture"]);

  const compared = runCli(["--repo", fixture.repo, "--out", fixture.out, "--baseline", referencePath]);
  assert.equal(compared.status, 0, compared.stderr);
  assert.equal(JSON.parse(compared.stdout).comparison.trend.previous_snapshot_id, baselineSnapshot.snapshot_id);

  const forged = { ...reference, path: baselineReceipt.snapshot_path };
  const forgedPath = path.join(fixture.root, "forged-baseline-reference.json");
  const forgedOut = path.join(fixture.root, "forged-out");
  fs.writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`);
  const rejected = runCli(["--repo", fixture.repo, "--out", forgedOut, "--baseline", forgedPath]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /FAIL-CLI-BASELINE/);
  assert.equal(fs.existsSync(forgedOut), false);

  const staleDigest = { ...reference, snapshot_sha256: `sha256:${"0".repeat(64)}` };
  const staleDigestPath = path.join(fixture.root, "stale-digest-baseline-reference.json");
  const staleDigestOut = path.join(fixture.root, "stale-digest-out");
  fs.writeFileSync(staleDigestPath, `${JSON.stringify(staleDigest, null, 2)}\n`);
  const digestRejected = runCli(["--repo", fixture.repo, "--out", staleDigestOut, "--baseline", staleDigestPath]);
  assert.equal(digestRejected.status, 1);
  assert.match(digestRejected.stderr, /FAIL-CLI-BASELINE.*digest/);
  assert.equal(fs.existsSync(staleDigestOut), false);
});

test("an explicit baseline binding cannot reuse an unbound cache snapshot", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const first = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(first.status, 0, first.stderr);
  const baseline = JSON.parse(first.stdout);

  const compared = runCli(["--repo", fixture.repo, "--out", fixture.out, "--baseline", baseline.snapshot_path]);
  assert.equal(compared.status, 0, compared.stderr);
  const receipt = JSON.parse(compared.stdout);
  assert.equal(receipt.cache, "miss");
  assert.notEqual(receipt.snapshot_id, baseline.snapshot_id);
  assert.equal(receipt.comparison.trend.previous_snapshot_id, baseline.snapshot_id);
});

test("CLI reuses only unchanged validated static source analyses across committed revisions", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root, "incremental-static.json");

  const first = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]);
  assert.equal(first.status, 0, first.stderr);
  const firstReceipt = JSON.parse(first.stdout);
  assert.deepEqual(firstReceipt.performance.static_analysis_cache, {
    cache: "miss",
    reused_file_count: 0,
    recomputed_file_count: 2,
  });

  fs.writeFileSync(path.join(fixture.repo, "added.js"), "export const added = true;\n", "utf8");
  git(fixture.repo, ["add", "added.js"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "add one source file"]);

  const second = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]);
  assert.equal(second.status, 0, second.stderr);
  const secondReceipt = JSON.parse(second.stdout);
  assert.deepEqual(secondReceipt.performance.static_analysis_cache, {
    cache: "partial",
    reused_file_count: 2,
    recomputed_file_count: 1,
  });
  const snapshot = snapshotFor(secondReceipt);
  const reusedMetric = snapshot.measurements.find((metric) => metric.metric_id === "static.source_lines:index.js");
  assert.ok(reusedMetric.source.artifact_refs.some((reference) => /^git-blob:[0-9a-f]{40,64}$/.test(reference)));

  const driftConfig = writeConfig(fixture.root, "incremental-static-drift.json", { static_analyzer_version: "2.0.0" });
  const drift = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", driftConfig]);
  assert.equal(drift.status, 0, drift.stderr);
  const driftReceipt = JSON.parse(drift.stdout);
  assert.deepEqual(driftReceipt.performance.static_analysis_cache, {
    cache: "miss",
    reused_file_count: 0,
    recomputed_file_count: 3,
  });
});

test("a malformed compact static state safely falls back to full source analysis", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root, "incremental-static-pointer.json");
  const first = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]);
  assert.equal(first.status, 0, first.stderr);

  const cacheRoot = path.join(fixture.root, ".sei-test-state");
  const [repositoryCacheDirectory] = fs.readdirSync(cacheRoot);
  const stageDirectory = path.join(cacheRoot, repositoryCacheDirectory, "stages", "static");
  const stageFiles = fs.readdirSync(stageDirectory).filter((name) => name.endsWith(".json"));
  assert.equal(stageFiles.length, 1);
  fs.writeFileSync(path.join(stageDirectory, stageFiles[0]), "{not-json", "utf8");
  fs.writeFileSync(path.join(fixture.repo, "added.js"), "export const added = true;\n", "utf8");
  git(fixture.repo, ["add", "added.js"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "corrupt state fallback"]);

  const second = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).performance.static_analysis_cache, {
    cache: "miss",
    reused_file_count: 0,
    recomputed_file_count: 3,
  });
});

test("a history-only descendant reuses compact source state, appends one commit, and matches forced-cold artifacts", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root, "incremental-history.json");
  const first = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]);
  assert.equal(first.status, 0, first.stderr);
  const baseline = JSON.parse(first.stdout);

  git(fixture.repo, ["commit", "--quiet", "--allow-empty", "-m", "history only"]);
  const incremental = runCli([
    "--repo", fixture.repo,
    "--out", fixture.out,
    "--config", config,
    "--baseline", baseline.snapshot_path,
  ]);
  assert.equal(incremental.status, 0, incremental.stderr);
  const incrementalReceipt = JSON.parse(incremental.stdout);
  assert.equal(incrementalReceipt.performance.incremental_stages.static.reuse.mode, "hit");
  assert.equal(incrementalReceipt.performance.incremental_stages.static.reuse.recomputed_file_count, 0);
  assert.equal(incrementalReceipt.performance.incremental_stages.history.reuse.mode, "append");
  assert.equal(incrementalReceipt.performance.incremental_stages.history.reuse.appended_commit_count, 1);

  const coldOut = path.join(fixture.root, "cold-out");
  const cold = runCli([
    "--repo", fixture.repo,
    "--out", coldOut,
    "--config", config,
    "--baseline", baseline.snapshot_path,
  ]);
  assert.equal(cold.status, 0, cold.stderr);
  const coldReceipt = JSON.parse(cold.stdout);
  assert.ok(["hit", "exact"].includes(coldReceipt.performance.incremental_stages.static.reuse.mode));
  assert.ok(["hit", "exact"].includes(coldReceipt.performance.incremental_stages.history.reuse.mode));
  assert.ok(fs.readFileSync(incrementalReceipt.snapshot_path).equals(fs.readFileSync(coldReceipt.snapshot_path)));
  assert.ok(fs.readFileSync(incrementalReceipt.report_path).equals(fs.readFileSync(coldReceipt.report_path)));
  assert.deepEqual(incrementalReceipt.comparison, coldReceipt.comparison);
});

test("a no-change auto run replays one exact bundle while off bypasses all incremental state", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root, "exact-replay.json");
  const first = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]);
  assert.equal(first.status, 0, first.stderr);
  const firstReceipt = JSON.parse(first.stdout);

  const exactPerformancePath = path.join(fixture.root, "exact-performance.json");
  const second = runCli([
    "--repo", fixture.repo,
    "--out", fixture.out,
    "--config", config,
    "--performance-json", exactPerformancePath,
  ]);
  assert.equal(second.status, 0, second.stderr);
  const secondReceipt = JSON.parse(second.stdout);
  assert.ok(["hit", "exact"].includes(secondReceipt.cache));
  assert.ok(["hit", "exact"].includes(secondReceipt.performance.incremental_stages.static.reuse.mode));
  assert.ok(["hit", "exact"].includes(secondReceipt.performance.incremental_stages.history.reuse.mode));
  assert.equal(secondReceipt.performance.python_static_intelligence.tasks_submitted, 0);
  const exactPerformance = JSON.parse(fs.readFileSync(exactPerformancePath, "utf8"));
  assert.ok(["exact-run-replay-v1", "revision-indexed-analysis-dag-v1"].includes(exactPerformance.executor.mode));
  if (exactPerformance.executor.mode === "exact-run-replay-v1") {
    assert.equal(exactPerformance.executor.phases.consumers.tasks_submitted, 0);
    assert.equal(exactPerformance.executor.phases.python_static.tasks_submitted, 0);
  } else {
    assert.equal(exactPerformance.python_static_intelligence.tasks_submitted, 0);
  }
  assert.ok(fs.readFileSync(firstReceipt.snapshot_path).equals(fs.readFileSync(secondReceipt.snapshot_path)));
  assert.ok(fs.readFileSync(firstReceipt.report_path).equals(fs.readFileSync(secondReceipt.report_path)));
  assert.deepEqual(firstReceipt.comparison, secondReceipt.comparison);

  const offOut = path.join(fixture.root, "off-out");
  const off = runCli(["--repo", fixture.repo, "--out", offOut, "--config", config, "--incremental", "off"]);
  assert.equal(off.status, 0, off.stderr);
  const offReceipt = JSON.parse(off.stdout);
  assert.equal(fs.existsSync(path.join(offOut, "incremental-run-state-v1")), false);
  assert.ok(fs.readFileSync(firstReceipt.snapshot_path).equals(fs.readFileSync(offReceipt.snapshot_path)));
  assert.ok(fs.readFileSync(firstReceipt.report_path).equals(fs.readFileSync(offReceipt.report_path)));
});

test("CLI output is deterministic and cache hits require exact validated content", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const first = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(first.status, 0, first.stderr);
  const firstReceipt = JSON.parse(first.stdout);
  const snapshotPath = firstReceipt.snapshot_path;
  const reportPath = firstReceipt.report_path;
  const firstSnapshotBytes = fs.readFileSync(snapshotPath, "utf8");
  const firstReportBytes = fs.readFileSync(reportPath, "utf8");

  const second = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).cache, "hit");
  assert.equal(fs.readFileSync(snapshotPath, "utf8"), firstSnapshotBytes);
  assert.equal(fs.readFileSync(reportPath, "utf8"), firstReportBytes);

  const snapshot = JSON.parse(firstSnapshotBytes);
  const cachePath = path.join(fixture.out, "cache", snapshot.run_metadata.cache.cache_key, `${snapshot.snapshot_id}.json`);
  // The canonical cache may intentionally share storage with the published
  // snapshot. Break that test-only alias before injecting a corrupt candidate
  // so the immutable-output assertion observes the product boundary rather
  // than mutating the snapshot as a side effect of the fixture.
  fs.unlinkSync(cachePath);
  fs.writeFileSync(cachePath, `${JSON.stringify(canonicalSnapshot, null, 2)}\n`);
  const mismatch = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /FAIL-IMMUTABLE-(?:CACHE|SNAPSHOT)/);
  assert.equal(fs.readFileSync(snapshotPath, "utf8"), firstSnapshotBytes);
  assert.equal(fs.readFileSync(reportPath, "utf8"), firstReportBytes);
});

test("a cache entry with matching engine metadata but changed snapshot content is a miss", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const seed = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(seed.status, 0, seed.stderr);
  const seedReceipt = JSON.parse(seed.stdout);
  const candidate = JSON.parse(fs.readFileSync(seedReceipt.snapshot_path, "utf8"));
  candidate.run_metadata.generated_at = "2000-01-01T00:00:00.000Z";
  assert.equal(require("./intelligence-engine.js").validateSnapshot(candidate).ok, true);

  const reusedOut = path.join(fixture.root, "reused-out");
  const cachePath = path.join(reusedOut, "cache", `${candidate.run_metadata.cache.cache_key}.json`);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(candidate, null, 2)}\n`);
  const reused = runCli(["--repo", fixture.repo, "--out", reusedOut, "--incremental", "off"]);
  assert.equal(reused.status, 0, reused.stderr);
  const receipt = JSON.parse(reused.stdout);
  assert.equal(receipt.cache, "miss");
  assert.notEqual(JSON.parse(fs.readFileSync(receipt.snapshot_path, "utf8")).run_metadata.generated_at, "2000-01-01T00:00:00.000Z");
});

test("a cache candidate from another repository identity is never replayed", (t) => {
  const first = createFixture();
  const second = createFixture();
  t.after(() => fs.rmSync(first.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second.root, { recursive: true, force: true }));
  const out = path.join(first.root, "shared-out");
  const firstConfig = writeConfig(first.root, "repo-a.json", { repository_id: "repo-A" });
  const secondConfig = writeConfig(second.root, "repo-b.json", { repository_id: "repo-B" });

  const firstRun = runCli(["--repo", first.repo, "--out", out, "--config", firstConfig]);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const secondRun = runCli(["--repo", second.repo, "--out", out, "--config", secondConfig]);
  assert.equal(secondRun.status, 0, secondRun.stderr);

  const firstReceipt = JSON.parse(firstRun.stdout);
  const secondReceipt = JSON.parse(secondRun.stdout);
  assert.equal(firstReceipt.cache, "miss");
  assert.equal(secondReceipt.cache, "miss");
  assert.equal(firstReceipt.revision, secondReceipt.revision);
  assert.notEqual(firstReceipt.snapshot_id, secondReceipt.snapshot_id);
  assert.equal(
    snapshotFor(firstReceipt).run_metadata.cache.cache_key,
    snapshotFor(secondReceipt).run_metadata.cache.cache_key,
  );
  assert.equal(snapshotFor(secondReceipt).repository.repository_id, "repo-B");
  assert.equal(fs.existsSync(cachePathFor(out, snapshotFor(firstReceipt))), true);
  assert.equal(fs.existsSync(cachePathFor(out, snapshotFor(secondReceipt))), true);
});

test("a DORA-only profile run cannot replay a default-profile cache candidate", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const defaultConfig = writeConfig(fixture.root, "default.json");
  const doraConfig = writeConfig(fixture.root, "dora.json", { profile_bindings: [{ profile_id: "DORA" }] });

  const defaultRun = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", defaultConfig]);
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  const doraRun = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", doraConfig]);
  assert.equal(doraRun.status, 0, doraRun.stderr);

  const defaultReceipt = JSON.parse(defaultRun.stdout);
  const doraReceipt = JSON.parse(doraRun.stdout);
  assert.equal(defaultReceipt.cache, "miss");
  assert.equal(doraReceipt.cache, "miss");
  assert.notEqual(defaultReceipt.snapshot_id, doraReceipt.snapshot_id);
  assert.equal(
    snapshotFor(defaultReceipt).run_metadata.cache.cache_key,
    snapshotFor(doraReceipt).run_metadata.cache.cache_key,
  );
  assert.deepEqual(snapshotFor(doraReceipt).profiles.map((profile) => profile.profile_id), ["DORA"]);
});

test("an altered valid cache candidate is retained separately and fresh evidence is emitted", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const config = writeConfig(fixture.root, "config.json");
  const seedOut = path.join(fixture.root, "seed-out");
  const seedRun = runCli(["--repo", fixture.repo, "--out", seedOut, "--config", config]);
  assert.equal(seedRun.status, 0, seedRun.stderr);
  const seedSnapshot = snapshotFor(JSON.parse(seedRun.stdout));
  const alteredInput = structuredClone(seedSnapshot);
  const mutableMeasurement = alteredInput.measurements.find((metric) => (
    metric.measurement.status === "measured" && typeof metric.value === "number" && Number.isFinite(metric.value)
  ));
  assert.ok(mutableMeasurement, "the cache fixture needs one measured numeric metric to alter");
  mutableMeasurement.value += 7;
  const altered = materializeSnapshot(alteredInput);
  assert.equal(validateSnapshot(altered).ok, true);
  assert.notEqual(altered.snapshot_id, seedSnapshot.snapshot_id);
  assert.equal(altered.run_metadata.cache.cache_key, seedSnapshot.run_metadata.cache.cache_key);

  const out = path.join(fixture.root, "candidate-out");
  const alteredCachePath = cachePathFor(out, altered);
  fs.mkdirSync(path.dirname(alteredCachePath), { recursive: true });
  fs.writeFileSync(alteredCachePath, `${JSON.stringify(altered, null, 2)}\n`);
  const result = runCli(["--repo", fixture.repo, "--out", out, "--config", config, "--incremental", "off"]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.cache, "miss");
  assert.equal(receipt.snapshot_id, seedSnapshot.snapshot_id);
  assert.equal(fs.existsSync(alteredCachePath), true);
  assert.equal(fs.existsSync(cachePathFor(out, snapshotFor(receipt))), true);
});

test("CLI refuses immutable output collisions without overwriting bytes", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const first = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  const snapshotBytes = fs.readFileSync(receipt.snapshot_path, "utf8");
  const tamperedReport = `${fs.readFileSync(receipt.report_path, "utf8")}\nTAMPERED\n`;
  fs.writeFileSync(receipt.report_path, tamperedReport);

  const collision = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(collision.status, 1);
  assert.match(collision.stderr, /FAIL-IMMUTABLE-REPORT/);
  assert.equal(fs.readFileSync(receipt.snapshot_path, "utf8"), snapshotBytes);
  assert.equal(fs.readFileSync(receipt.report_path, "utf8"), tamperedReport);
});

test("CLI also refuses an immutable snapshot collision", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const first = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  const tamperedSnapshot = `${fs.readFileSync(receipt.snapshot_path, "utf8")} `;
  const reportBytes = fs.readFileSync(receipt.report_path, "utf8");
  fs.writeFileSync(receipt.snapshot_path, tamperedSnapshot);

  const collision = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(collision.status, 1);
  assert.match(collision.stderr, /FAIL-IMMUTABLE-SNAPSHOT/);
  assert.equal(fs.readFileSync(receipt.snapshot_path, "utf8"), tamperedSnapshot);
  assert.equal(fs.readFileSync(receipt.report_path, "utf8"), reportBytes);
});

test("a performance receipt directory fails before any new evidence artifact is published", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const performancePath = path.join(fixture.root, "performance-target");
  fs.mkdirSync(performancePath);

  const result = runCli(["--repo", fixture.repo, "--out", fixture.out, "--performance-json", performancePath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL-IMMUTABLE-PERFORMANCE/);
  assert.equal(fs.existsSync(path.join(fixture.out, "snapshots")), false);
  assert.equal(fs.existsSync(path.join(fixture.out, "reports")), false);
  assert.equal(fs.existsSync(path.join(fixture.out, "cache")), false);
});

test("a differing existing performance receipt fails immutably before publication", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const performancePath = path.join(fixture.root, "performance.json");
  const existing = "unrelated receipt\n";
  fs.writeFileSync(performancePath, existing);

  const result = runCli(["--repo", fixture.repo, "--out", fixture.out, "--performance-json", performancePath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL-IMMUTABLE-PERFORMANCE/);
  assert.equal(fs.readFileSync(performancePath, "utf8"), existing);
  assert.equal(fs.existsSync(path.join(fixture.out, "snapshots")), false);
  assert.equal(fs.existsSync(path.join(fixture.out, "reports")), false);
  assert.equal(fs.existsSync(path.join(fixture.out, "cache")), false);
});

test("a hard-link alias between the performance receipt and snapshot is refused without mutation", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const first = runCli(["--repo", fixture.repo, "--out", fixture.out]);
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  const snapshotBytes = fs.readFileSync(receipt.snapshot_path, "utf8");
  const reportBytes = fs.readFileSync(receipt.report_path, "utf8");
  const cacheBytes = fs.readFileSync(cachePathFor(fixture.out, snapshotFor(receipt)), "utf8");
  const performancePath = path.join(fixture.root, "performance.json");
  fs.linkSync(receipt.snapshot_path, performancePath);

  const aliased = runCli(["--repo", fixture.repo, "--out", fixture.out, "--performance-json", performancePath]);
  assert.equal(aliased.status, 1);
  assert.match(aliased.stderr, /FAIL-ARTIFACT-ALIAS/);
  assert.equal(fs.readFileSync(receipt.snapshot_path, "utf8"), snapshotBytes);
  assert.equal(fs.readFileSync(performancePath, "utf8"), snapshotBytes);
  assert.equal(fs.readFileSync(receipt.report_path, "utf8"), reportBytes);
  assert.equal(fs.readFileSync(cachePathFor(fixture.out, snapshotFor(receipt)), "utf8"), cacheBytes);
});

test("malformed config and repository revision failures create no output", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const malformedConfig = path.join(fixture.root, "malformed.json");
  fs.writeFileSync(malformedConfig, "{not-json");

  const configFailure = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", malformedConfig]);
  assert.equal(configFailure.status, 1);
  assert.match(configFailure.stderr, /FAIL-CLI-CONFIG/);
  assert.equal(fs.existsSync(path.join(fixture.out, "reports")), false);
  assert.equal(fs.existsSync(path.join(fixture.out, "snapshots")), false);

  const nonRepository = path.join(fixture.root, "not-a-repository");
  const secondOut = path.join(fixture.root, "second-out");
  fs.mkdirSync(nonRepository);
  const revisionFailure = runCli(["--repo", nonRepository, "--out", secondOut]);
  assert.equal(revisionFailure.status, 1);
  assert.match(revisionFailure.stderr, /FAIL-REPOSITORY-REVISION/);
  assert.equal(fs.existsSync(path.join(secondOut, "reports")), false);
  assert.equal(fs.existsSync(path.join(secondOut, "snapshots")), false);

  const rejectedProfileConfig = path.join(fixture.root, "rejected-profile.json");
  const thirdOut = path.join(fixture.root, "third-out");
  fs.writeFileSync(rejectedProfileConfig, JSON.stringify({
    generated_path_patterns: [],
    profile_bindings: [{ profile_id: "unknown" }],
  }));
  const snapshotFailure = runCli(["--repo", fixture.repo, "--out", thirdOut, "--config", rejectedProfileConfig]);
  assert.equal(snapshotFailure.status, 1);
  assert.match(snapshotFailure.stderr, /FAIL-FRAMEWORK-WITHOUT-APPLICABILITY/);
  assert.equal(fs.existsSync(path.join(thirdOut, "reports")), false);
  assert.equal(fs.existsSync(path.join(thirdOut, "snapshots")), false);
});

test("output created inside a repository cannot alter exact-revision static evidence or create a false cache hit", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const inRepositoryOut = path.join(fixture.repo, ".sei-output");

  const first = runCli(["--repo", fixture.repo, "--out", inRepositoryOut, "--predictive", "off"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).cache, "miss");
  assert.equal(JSON.parse(first.stdout).predictive.state, "disabled");
  assert.equal(fs.existsSync(path.join(inRepositoryOut, "predictive")), false, "off must not publish a predictive artifact");

  const second = runCli(["--repo", fixture.repo, "--out", inRepositoryOut, "--predictive", "off"]);
  assert.equal(second.status, 0, second.stderr);
  const receipt = JSON.parse(second.stdout);
  assert.equal(receipt.cache, "miss");
  const snapshot = JSON.parse(fs.readFileSync(receipt.snapshot_path, "utf8"));
  const staticCollector = snapshot.collectors.find((collector) => collector.collector_id === "static-source");
  assert.equal(staticCollector.status, "available");
  assert.equal(staticCollector.reason, null);
  assert.equal(receipt.performance.static_analysis_cache.cache, "hit");
});

test("report does not infer absent external capabilities or downstream authority", () => {
  const html = renderReport(canonicalSnapshot);
  const projection = embeddedProjection(html);
  assert.deepEqual(projection.evidence.collectors, [
    { status: "available", count: 1 },
    { status: "degraded", count: 0 },
    { status: "unavailable", count: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(projection), /coverage-adapter|ci-adapter|deployment-adapter|work-item-adapter|policy-adapter/i);
  assertReportPreservesAuthorityBoundaries(html);
});

test("bounded projection summarizes typed collector states without metric-name inference", () => {
  const snapshot = snapshotWithTypedUnavailableAdapters();
  assert.equal(validateSnapshot(snapshot).ok, true);
  const projection = embeddedProjection(renderReport(snapshot));
  assert.equal(projection.evidence.collectors.find((item) => item.status === "unavailable").count, 6);
  assert.doesNotMatch(JSON.stringify(projection), /structural\.deployment_complexity|deployment adapter/i);
});

test("public report displays collector degradation separately from measurement coverage", () => {
  const document = runReportDom(renderReport(snapshotWithTypedUnavailableAdapters()));

  assert.equal(document.getElementById("evidence-state").textContent, "100% observed");
  assert.match(document.getElementById("collector-state-summary").textContent, /Collector availability/i);
  assert.match(document.getElementById("collector-state-summary").textContent, /6 unavailable/i);
  assert.match(document.getElementById("collector-table").textContent, /Unavailable6/i);
});

test("public report states when predictive evaluation has not yet been supplied", () => {
  const document = runReportDom(renderReport(canonicalSnapshot));

  assert.equal(document.getElementById("predictive-state").textContent, "Predictive intelligence — NOT_READY");
  assert.equal(
    document.getElementById("predictive-reason").textContent,
    "no validated forward-temporal evaluation is bound to this canonical snapshot",
  );
  assert.equal(document.getElementById("trend-primary-state").textContent, "unresolved");
  assert.equal(
    document.getElementById("trend-primary-summary").textContent,
    "No validated trend-baseline metadata was supplied for this snapshot.",
  );
});

test("public report prioritizes accessible evidence visualizations over primary text dumps", () => {
  const document = runReportDom(renderReport(canonicalSnapshot));
  for (const id of [
    "capability-coverage-chart",
    "complexity-profile-chart",
    "duplication-chart",
    "trend-primary-chart",
  ]) {
    const chart = document.getElementById(id);
    assert.ok(chart, `${id} should be present in the primary report`);
    assert.equal(chart.getAttribute("role"), "img");
    assert.match(chart.getAttribute("aria-labelledby"), /-title\s+.*-desc/);
  }
  assert.equal(
    browserlessDescendants(document.getElementById("capability-coverage-chart"))
      .filter((element) => element.tagName === "RECT").length,
    14,
  );
  assert.match(document.getElementById("duplication-empty").textContent, /Duplication evidence is not available/i);

  const complexityDocument = runReportDom(renderReport(staticIntelligenceReportSnapshot()));
  assert.ok(browserlessDescendants(complexityDocument.getElementById("complexity-profile-chart"))
    .some((element) => element.tagName === "CIRCLE"));
  assert.equal(document.getElementById("capability-coverage-view"), null);
  assert.equal(document.getElementById("complexity-presentation-view"), null);
  assert.equal(document.getElementById("trend-primary-view"), null);
});

test("primary duplication visualization reserves observed-lines evidence without a metric table", () => {
  const draft = structuredClone(canonicalSnapshot);
  draft.snapshot_id = "pending";
  draft.run_metadata.cache.cache_key = "pending";
  const duplicationMetric = (suffix, value, unit) => {
    const metric = structuredClone(draft.measurements[0]);
    metric.metric_id = `static.duplication.${suffix}`;
    metric.definition_id = `sei.static.duplication.${suffix}@1`;
    metric.family = "structural_duplication";
    metric.subject = `repository:${draft.repository.repository_id}`;
    metric.value = value;
    metric.unit = unit;
    metric.scope = {
      kind: "repository",
      path: ".",
      language: null,
      generated_code: false,
      included_in_human_maintainability: true,
    };
    metric.source.artifact_refs = ["duplication-fixture"];
    metric.source.evidence_refs = ["duplication-fixture"];
    return metric;
  };
  draft.measurements.push(
    duplicationMetric("observed_percentage", 0.4, "ratio"),
    duplicationMetric("duplicated_source_lines", 400, "lines"),
    duplicationMetric("analyzed_source_lines", 1_000, "lines"),
    duplicationMetric("clone_family_count", 12, "families"),
  );
  draft.evidence_summary.measurement_count += 4;
  draft.evidence_summary.status_counts.measured += 4;
  const html = renderReport(materializeSnapshot(draft));
  const projection = embeddedProjection(html);
  assert.equal(projection.evidence_explorer.raw_views.duplication.state, "available");
  assert.equal(projection.evidence_explorer.raw_views.duplication.items.find((item) => item.metric_id.endsWith("observed_percentage")).value, 0.4);
  assert.match(html, /id="duplication-chart"[^>]+role="img"/);
  assert.match(html, /Observed repeated source lines/);
  assert.ok(html.indexOf('id="duplication-chart"') < html.indexOf('<details id="evidence"'));
  assert.ok(html.indexOf('id="duplication-view"') > html.indexOf('<details id="evidence"'));
});

test("bounded projection preserves partial Git evidence states without raw reason duplication", () => {
  const input = structuredClone(canonicalSnapshot);
  const observed = structuredClone(input.measurements[0]);
  observed.metric_id = "git.observed_text_churn";
  observed.definition_id = "sei.git.observed_text_churn@1";
  observed.family = "repository_behavior";
  observed.subject = `repository:${input.repository.repository_id}`;
  observed.value = 9;
  observed.unit = "lines-changed";
  observed.measurement = {
    status: "measured",
    completeness: 0.75,
    confidence: 0.75,
    reason: "observed-subset (partial/non-full; not a full-history metric); observed_non_merge_commits=3/4; unattributed_merge_commits=1; generated_vendor_file_changes_excluded=2; unknown_classification_file_changes_excluded=0; binary_numstat_rows_excluded_from_text_churn=1",
  };
  observed.scope = {
    kind: "repository",
    path: ".",
    language: null,
    generated_code: false,
    included_in_human_maintainability: false,
  };
  const complete = structuredClone(observed);
  complete.metric_id = "git.churn";
  complete.definition_id = "sei.git.churn@1";
  complete.value = null;
  complete.measurement = {
    status: "unverifiable",
    completeness: 0,
    confidence: 0,
    reason: "binary-numstat-churn-is-null-so-complete-line-churn-is-unverifiable;merge_conflict_resolution_churn_unattributed",
  };
  input.measurements.push(observed, complete);
  input.evidence_summary.measurement_count += 2;
  input.evidence_summary.status_counts.measured += 1;
  input.evidence_summary.status_counts.unverifiable += 1;
  const snapshot = materializeSnapshot(input);
  const projection = embeddedProjection(renderReport(snapshot));
  assert.equal(projection.evidence.measurement_count, 3);
  assert.equal(projection.evidence.statuses.find((item) => item.status === "measured").count, 2);
  assert.equal(projection.evidence.statuses.find((item) => item.status === "unverifiable").count, 1);
  assert.doesNotMatch(JSON.stringify(projection), /observed_non_merge_commits|binary_numstat_rows|generated_vendor_file_changes|git\.churn/);
});

test("bounded projection does not duplicate the raw post-policy co-change measurement", () => {
  const input = structuredClone(canonicalSnapshot);
  const observed = structuredClone(input.measurements[0]);
  observed.metric_id = "git.observed_co_change_pair_count";
  observed.definition_id = "sei.git.observed_co_change_pair_count@1";
  observed.family = "repository_behavior";
  observed.subject = `repository:${input.repository.repository_id}`;
  observed.value = 6287;
  observed.unit = "file-pairs";
  observed.measurement = {
    status: "measured",
    completeness: 0.6130952380952381,
    confidence: 0.6130952380952381,
    reason: "observed-subset (partial/non-full; not a full-history metric); observed_attributed_commits=103/168; observed_non_merge_commits=103/168; unattributed_merge_commits=65; generated_vendor_file_changes_excluded=0; unknown_classification_file_changes_excluded=0; binary_line_churn_exclusions=23; binary_path_author_touches_retained=23; temporal_mass_change_policy=temporal-coupling-mass-change-v1@1.0.0; mass_commits=3; excluded_pairwise=0; down_weighted_pairwise=6223; observed pair count is post-policy, not all theoretical pairs",
  };
  observed.scope = {
    kind: "repository",
    path: ".",
    language: null,
    generated_code: false,
    included_in_human_maintainability: false,
  };
  input.measurements.push(observed);
  input.evidence_summary.measurement_count += 1;
  input.evidence_summary.status_counts.measured += 1;
  const projection = embeddedProjection(renderReport(materializeSnapshot(input)));
  assert.equal(projection.evidence.measurement_count, 2);
  assert.equal(projection.evidence.observed_count, 2);
  assert.doesNotMatch(JSON.stringify(projection), /git\.observed_co_change_pair_count|temporal_mass_change_policy|down_weighted_pairwise/);
});

test("canonical risk model records drive the executive report", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.repo, "helper.js"), "export function helper() { return 1; }\n");
  fs.writeFileSync(path.join(fixture.repo, "alpha.js"), "export function alpha() { return 1; }\n");
  fs.writeFileSync(path.join(fixture.repo, "beta.js"), "export function beta() { return 1; }\n");
  fs.writeFileSync(path.join(fixture.repo, "gamma.js"), "export function gamma() { return 1; }\n");
  fs.mkdirSync(path.join(fixture.repo, "vendor"));
  fs.writeFileSync(path.join(fixture.repo, "vendor", "generated.js"), "export const vendor = true;\n");
  fs.appendFileSync(path.join(fixture.repo, "index.js"), "function changed() { return helper; }\n");
  git(fixture.repo, ["add", "index.js", "helper.js", "alpha.js", "beta.js", "gamma.js", "vendor"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "add co-change fixture"]);
  fs.appendFileSync(path.join(fixture.repo, "helper.js"), "export function later() { return 2; }\n");
  fs.appendFileSync(path.join(fixture.repo, "index.js"), "function laterChanged() { return helper; }\n");
  git(fixture.repo, ["add", "index.js", "helper.js"]);
  git(fixture.repo, ["commit", "--quiet", "-m", "repeat co-change fixture"]);

  const config = writeConfig(fixture.root, "report-config.json", { generated_path_patterns: ["dist/**", "vendor/**"] });
  const run = runCli(["--repo", fixture.repo, "--out", fixture.out, "--config", config]);
  assert.equal(run.status, 0, run.stderr);
  const snapshot = snapshotFor(JSON.parse(run.stdout));
  assert.equal(validateSnapshot(snapshot).ok, true);
  const hotspot = snapshot.risk_models.find((model) => model.risk_model_id === "heuristic-v1");
  const temporal = snapshot.risk_models.find((model) => model.risk_model_id === "temporal-coupling-pressure-v1");
  assert.ok(hotspot.result.records.some((record) => record.subject === "file:index.js"));
  assert.ok(hotspot.result.records.length >= 5);
  assert.ok(temporal.result.records.some((record) => record.source === "helper.js" && record.target === "index.js"));

  const forgedBoundary = structuredClone(snapshot);
  forgedBoundary.risk_models.find((model) => model.risk_model_id === "heuristic-v1").result.interpretation_boundary = "candidate priority is high";
  assert.throws(
    () => renderReport(forgedBoundary),
    /FAIL-REPORT-SNAPSHOT: .*interpretation_boundary does not match heuristic-v1/,
  );

  const projection = embeddedProjection(renderReport(snapshot));
  assert.equal(projection.scatter.state, "available");
  assert.equal(projection.views.coupling.state, "available");
  assert.equal(projection.investigations.state, "available");
  assert.ok(projection.investigations.items.length <= 15);
  assert.ok(projection.views.coupling.relationships.some((item) => item.source === "helper.js" && item.target === "index.js"));
  assert.equal(new Set(projection.investigations.items.map((item) => `${item.kind}:${item.subject}:${item.signal}`)).size, projection.investigations.items.length);
  assert.doesNotMatch(JSON.stringify(projection), /(?:dist\/generated\.js|vendor\/generated\.js)/i);

  const unavailable = snapshotWithTypedUnavailableAdapters();
  assert.equal(validateSnapshot(unavailable).ok, true);
  const unavailableProjection = embeddedProjection(renderReport(unavailable));
  assert.equal(unavailableProjection.scatter.state, "unavailable");
  assert.equal(unavailableProjection.views.coupling.state, "unavailable");
  assert.equal(unavailableProjection.investigations.state, "unavailable");
  assertReportPreservesAuthorityBoundaries(renderReport(unavailable));
});

test("public report DOM filters bounded subject views with stable ordering and an explicit empty state", (t) => {
  const document = runReportDom(renderInteractionFixtureReport(t));
  const search = document.getElementById("path-search");
  const original = investigationSubjects(document);
  assert.ok(original.length > 1);

  search.value = "helper.js";
  search.dispatchEvent({ type: "input" });
  const filtered = investigationSubjects(document);
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((subject) => subject.includes("helper.js")));

  search.value = "no-such-subject";
  search.dispatchEvent({ type: "input" });
  assert.match(document.getElementById("investigations-list").textContent, /No investigation surfaces match the active filters/);
  assert.match(document.getElementById("filter-status").textContent, /0 investigations/);

  search.value = "";
  search.dispatchEvent({ type: "input" });
  assert.deepEqual(investigationSubjects(document), original);
});

test("public report DOM offers only projection-backed filters and explains unavailable classifications", (t) => {
  const html = renderInteractionFixtureReport(t);
  const projection = embeddedProjection(html);
  const document = runReportDom(html);
  const language = document.getElementById("language-filter");
  const evidence = document.getElementById("evidence-filter");
  const testVisibility = document.getElementById("test-visibility");
  const generatedVisibility = document.getElementById("generated-visibility");

  assert.deepEqual(
    language.children.map((option) => option.value),
    ["all", ...projection.composition.items.map((item) => item.language)],
  );
  assert.deepEqual(
    evidence.children.map((option) => option.value),
    ["all", ...new Set(projection.investigations.items.map((item) => item.kind))],
  );
  const evidenceKinds = [...new Set(projection.investigations.items.map((item) => item.kind))];
  assert.ok(evidenceKinds.length > 0);
  evidence.value = evidenceKinds[0];
  evidence.dispatchEvent({ type: "change" });
  const visibleRows = browserlessDescendants(document.getElementById("investigations-list"))
    .filter((element) => element.tagName === "LI");
  assert.ok(visibleRows.length > 0);
  assert.ok(visibleRows.every((row) => row.getAttribute("data-evidence-kind") === evidenceKinds[0]));

  assert.equal(testVisibility.disabled, true);
  assert.equal(generatedVisibility.disabled, true);
  assert.equal(testVisibility.getAttribute("aria-describedby"), "classification-availability");
  assert.match(html, /id="classification-availability"[^>]*>[^<]*not represented in this bounded projection/i);
});

test("public report DOM links keyboard selection across scatter, investigations, and coupling with deterministic detail", (t) => {
  const html = renderInteractionFixtureReport(t);
  const projection = embeddedProjection(html);
  const document = runReportDom(html);
  const relationship = projection.views.coupling.relationships.find((candidate) => (
    projection.scatter.points.some((point) => point.subject === `file:${candidate.source}` || point.subject === `file:${candidate.target}`)
  ));
  assert.ok(relationship, "fixture should expose a coupling endpoint in the scatter projection");
  const selectedSubject = projection.scatter.points.find((point) => (
    point.subject === `file:${relationship.source}` || point.subject === `file:${relationship.target}`
  )).subject;
  const circle = browserlessDescendants(document.getElementById("scatter-chart"))
    .find((element) => element.getAttribute("data-subject") === selectedSubject);

  assert.equal(circle.getAttribute("role"), "button");
  assert.equal(circle.getAttribute("tabindex"), "0");
  assert.match(circle.getAttribute("aria-label"), new RegExp(selectedSubject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  circle.dispatchEvent({ type: "keydown", key: "Enter" });

  const detail = document.getElementById("subject-detail");
  assert.equal(detail.hidden, false);
  assert.equal(document.activeElement, detail);
  assert.equal(detail.scrollIntoViewOptions.behavior, "smooth");
  assert.equal(detail.scrollIntoViewOptions.block, "nearest");
  assert.equal(document.getElementById("subject-detail-title").textContent, selectedSubject);
  assert.match(document.getElementById("subject-detail-summary").textContent, /scatter point/);
  assert.match(document.getElementById("subject-detail-summary").textContent, /coupling relationship/);
  assert.doesNotMatch(document.getElementById("subject-detail").textContent, /(?:static|git|verification|discovery)\.[a-z0-9_.:-]+/i);
  assert.doesNotMatch(document.getElementById("subject-detail").textContent, /metric_id/i);
  assert.equal(circle.getAttribute("aria-pressed"), "true");
  assert.ok(browserlessDescendants(document.getElementById("investigations-list"))
    .some((element) => element.tagName === "LI" && element.classList.contains("is-related")));
  assert.ok(browserlessDescendants(document.getElementById("coupling-view"))
    .some((element) => element.tagName === "TR" && element.classList.contains("is-related")));

  const firstSummary = document.getElementById("subject-detail-summary").textContent;
  circle.dispatchEvent({ type: "keydown", key: "Enter" });
  assert.equal(document.getElementById("subject-detail-summary").textContent, firstSummary);
  document.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  assert.equal(detail.hidden, true);
  assert.equal(circle.getAttribute("aria-pressed"), "false");
  circle.dispatchEvent({ type: "keydown", key: " " });
  assert.equal(detail.hidden, false);
  document.getElementById("subject-detail-close").click();
  assert.equal(detail.hidden, true);
  assert.equal(document.activeElement, circle);
  const couplingButton = browserlessDescendants(document.getElementById("coupling-view"))
    .find((element) => element.tagName === "BUTTON" && element.textContent === relationship.source);
  assert.match(couplingButton.getAttribute("aria-label"), new RegExp(`${relationship.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${relationship.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  couplingButton.click();
  assert.equal(document.getElementById("subject-detail-title").textContent, relationship.source);
  assert.equal(couplingButton.getAttribute("aria-pressed"), "true");
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
});

test("public report DOM applies path search coherently to every subject-aware view", (t) => {
  const html = renderInteractionFixtureReport(t);
  const projection = embeddedProjection(html);
  const document = runReportDom(html);
  const search = document.getElementById("path-search");

  search.value = "helper.js";
  search.dispatchEvent({ type: "input" });
  const scatterSubjects = browserlessDescendants(document.getElementById("scatter-chart"))
    .filter((element) => element.tagName === "CIRCLE")
    .map((element) => element.getAttribute("data-subject"));
  const couplingRows = browserlessDescendants(document.getElementById("coupling-view"))
    .filter((element) => element.tagName === "TR" && element.children.some((child) => child.tagName === "TD"));
  assert.ok(scatterSubjects.length > 0);
  assert.ok(scatterSubjects.every((subject) => subject.includes("helper.js")));
  assert.ok(couplingRows.length > 0);
  assert.ok(couplingRows.every((row) => row.textContent.includes("helper.js")));

  const complexityRows = browserlessDescendants(document.getElementById("complexity-subject-table"))
    .filter((element) => element.tagName === "TR" && element.children.some((child) => child.tagName === "TD"));
  assert.ok(complexityRows.length > 0);
  assert.ok(complexityRows.every((row) => row.textContent.includes("helper.js")));

  search.value = "no-such-subject";
  search.dispatchEvent({ type: "input" });
  assert.equal(browserlessDescendants(document.getElementById("scatter-chart")).some((element) => element.tagName === "CIRCLE"), false);
  assert.equal(document.getElementById("scatter-empty").hidden, false);
  for (const [id, items, reason] of [
    ["complexity-subject-table", projection.evidence_explorer.raw_views.complexity.top_items, "no bounded subject-level complexity evidence"],
    ["topology-view", projection.views.topology.items, projection.views.topology.reason],
    ["coupling-view", projection.views.coupling.relationships, projection.views.coupling.reason],
    ["duplication-view", projection.views.duplication.items, projection.views.duplication.reason],
    ["trend-view", projection.views.trend.items, projection.trend_primary?.empty_state?.explanation ?? "no comparable repository-level trend bindings"],
  ]) {
    assert.match(document.getElementById(id).textContent, items.length > 0
      ? /No matches .* active search/i
      : new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.equal(document.getElementById("filter-status").textContent, "0 investigations · 0 scatter points · 0 complex subjects · 0 topology rows · 0 coupling relationships · 0 duplication rows · 0 trend rows shown.");
});

test("dashboard grid does not stretch paired panels and presents complex subjects before aggregates", () => {
  const html = renderReport(canonicalSnapshot);
  assert.match(html, /\.grid\s*\{[^}]*align-items:\s*start;/);
  assert.ok(html.indexOf('id="complexity-subject-table"') < html.indexOf('id="complexity-table"'));
});

test("public report keeps honest table fallbacks and non-pointer interaction semantics offline", () => {
  const html = renderReport(canonicalSnapshot);
  const fallback = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1];
  assert.ok(fallback, "report should expose a JavaScript-off fallback");
  assert.match(fallback, /JavaScript is disabled/i);
  assert.deepEqual(
    [...fallback.matchAll(/<caption>([^<]+)<\/caption>/g)].map((match) => match[1]),
    ["Investigation surfaces", "Dependency and coupling", "Duplication", "Trend"],
  );
  assert.match(html, /<label[^>]+for="path-search"/);
  assert.match(html, /id="filter-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="subject-detail-close"[^>]+type="button"/);
  assert.doesNotMatch(html, /\son(?:click|pointer|mouse)[a-z]*\s*=/i);
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
  assert.equal(verifyRenderedReport(html, canonicalSnapshot).ok, true);
});

test("public report DOM distinguishes unavailable evidence from a filter with no matches", () => {
  const html = renderReport(canonicalSnapshot);
  const projection = embeddedProjection(html);
  const document = runReportDom(html);
  const scatterEmpty = document.getElementById("scatter-empty");

  assert.equal(projection.scatter.state, "unavailable");
  assert.equal(scatterEmpty.hidden, false);
  assert.match(scatterEmpty.textContent, /No structural and behavioral map is available/i);
  assert.match(scatterEmpty.textContent, /does not substitute temporal coupling/i);
  assert.equal(document.getElementById("evidence-filter").disabled, true);
  assert.equal(document.getElementById("subject-detail").hidden, true);
});

function dollarPatternArtifact() {
  const draft = structuredClone(canonicalSnapshot);
  draft.snapshot_id = "pending";
  draft.repository.repository_id = "repo $' $` $$ $& {{REPORT_PRESENTATION_SCRIPT}} {{SEI_ISLAND_SHA256}}";
  const artifact = enginePrivate.materializeCanonicalArtifact(draft);
  return { artifact, snapshot: enginePrivate.readCanonicalArtifact(artifact).snapshot };
}

test("report substitution inserts repository text literally, including $ patterns and marker strings", () => {
  const { artifact, snapshot } = dollarPatternArtifact();
  const html = renderReport(snapshot);
  const islands = [...html.matchAll(/<script type="application\/json" data-sei-island>([\s\S]*?)<\/script>/g)];
  assert.equal(islands.length, 1);
  const expectedIsland = JSON.stringify(projectReport(snapshot))
    .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  assert.equal(islands[0][1], expectedIsland);
  assert.deepEqual(embeddedProjection(html), projectReport(snapshot));
  assert.equal(embeddedProjection(html).source.repository_id, snapshot.repository.repository_id);
  // The marker text survives only inside the island; the real presentation script is still substituted.
  assert.ok(islands[0][1].includes("{{REPORT_PRESENTATION_SCRIPT}}"));
  assert.doesNotMatch(html.replace(islands[0][0], ""), /\{\{(?:SEI_[A-Z_]+|REPORT_PRESENTATION_[A-Z]+)\}\}/);
  assert.match(html, /<script>\s*\(\(\) => \{\s*document\.documentElement\.dataset\.reportResponsive/);
  assert.deepEqual(verifyRenderedReport(html, snapshot), { ok: true, errors: [] });
  const trusted = reportPrivate.renderReportFromCanonicalArtifact(artifact);
  assert.equal(trusted, html);
  assert.deepEqual(reportPrivate.verifyRenderedReportFromCanonicalArtifact(trusted, artifact), { ok: true, errors: [] });
  assert.equal(runReportDom(html).getElementById("source-binding").textContent.startsWith(snapshot.repository.repository_id), true);
});

test("private canonical render refuses to cache bytes the public verifier rejects", () => {
  const artifact = enginePrivate.materializeCanonicalArtifact(structuredClone(canonicalSnapshot));
  const originalReadFileSync = fs.readFileSync;
  let templateReads = 0;
  fs.readFileSync = (...args) => {
    const bytes = originalReadFileSync(...args);
    if (!String(args[0]).endsWith("report-template.html")) return bytes;
    templateReads += 1;
    // Only the render read drifts; the verifier's independent re-render sees the real template.
    return templateReads === 1 ? String(bytes).replace("</main>", "<p>drift</p></main>") : bytes;
  };
  try {
    assert.throws(() => reportPrivate.renderReportFromCanonicalArtifact(artifact), /FAIL-REPORT-UNVERIFIED/);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  const html = renderReport(enginePrivate.readCanonicalArtifact(artifact).snapshot);
  assert.match(reportPrivate.verifyRenderedReportFromCanonicalArtifact(html, artifact).errors.join("\n"), /not rendered by this module/);
});

test("report declares a no-network content security policy and stays self-contained", () => {
  const html = renderReport(canonicalSnapshot);
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
  assert.ok(csp);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /https?:|\*|data:|unsafe-eval/);
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script"));
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']\s*data:|url\(\s*["']?\s*data:|blob:/i);
  const presentation = require("../report-presentation/report-presentation.js");
  assert.deepEqual(presentation.inspectResponsiveReport(html, { requireVisualization: true }), { ok: true, problems: [] });
  const charts = [...html.matchAll(/<svg class="chart" id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(charts.length, 14);
  for (const id of charts) assert.ok(html.includes(`<div class="rp-chart-wrap" data-rp-chart="${id}"><svg class="chart" id="${id}"`), id);
});

test("report layout CSS keeps controls single-column on narrow screens and dark ink in print", () => {
  const html = renderReport(canonicalSnapshot);
  const narrow = /@media \(max-width: 760px\) \{([\s\S]*?)\n    \}/.exec(html)?.[1] ?? "";
  assert.match(narrow, /\.controls \{ grid-template-columns: 1fr; \}/);
  assert.match(narrow, /\.classification-controls \{ grid-column: 1 \/ -1; \}/);
  const print = /@media print \{([\s\S]*?)\n    \}/.exec(html)?.[1] ?? "";
  assert.match(print, /\.kpi-card dd[^{]*\{ color: #111827; \}/);
  assert.match(print, /\.chart \.chart-label, \.chart \.chart-value[^{]*\{ fill: #111827; \}/);
  assert.match(print, /\.chart \.chart-track \{ fill: #e5e7eb;/);
  assert.match(print, /\.chart \.gridline \{ stroke: #d1d5db; \}/);
  assert.match(html, /\.priority-gap-list \.gap-fill \{ display: block;/);
});

test("public report DOM renders target gaps as list items with block fills", () => {
  const base = projectReport(canonicalSnapshot);
  base.assessment = reportProjectionPrivate.projectAssessmentArtifact(semanticAssessmentFixture());
  const document = renderProjectionDom(base);
  const list = document.getElementById("assessment-priority-gaps");
  assert.equal(list.tagName, "UL");
  assert.ok(list.children.length > 0);
  assert.ok(list.children.every((child) => child.tagName === "LI"));
  const fills = browserlessDescendants(list).filter((element) => element.classList.contains("gap-fill"));
  for (const fill of fills) assert.match(fill.getAttribute("data-width"), /^[0-9.]+%$/);
});

test("public report DOM tab sets expose aria-controls, one tabpanel, roving tabindex, and arrow/Home/End keys", () => {
  const projection = projectReport(canonicalSnapshot);
  projection.predictive_intelligence.available_horizons = [10, 25, 50];
  const document = renderProjectionDom(projection);
  const explorer = ["coverage", "complexity", "dependencies", "change", "duplication", "trend", "lineage"]
    .map((tab) => document.getElementById("explorer-tab-" + tab));
  const panel = document.getElementById("evidence-explorer-panel");
  assert.equal(panel.getAttribute("role"), "tabpanel");
  for (const tab of explorer) assert.equal(tab.getAttribute("aria-controls"), "evidence-explorer-panel");
  assert.deepEqual(explorer.map((tab) => tab.getAttribute("tabindex")), ["0", "-1", "-1", "-1", "-1", "-1", "-1"]);
  explorer[0].dispatchEvent({ type: "keydown", key: "ArrowRight" });
  assert.equal(explorer[1].getAttribute("aria-selected"), "true");
  assert.equal(explorer[1].getAttribute("tabindex"), "0");
  assert.equal(explorer[0].getAttribute("tabindex"), "-1");
  assert.equal(document.activeElement, explorer[1]);
  assert.equal(panel.getAttribute("aria-labelledby"), "explorer-tab-complexity");
  explorer[1].dispatchEvent({ type: "keydown", key: "End" });
  assert.equal(explorer[6].getAttribute("aria-selected"), "true");
  explorer[6].dispatchEvent({ type: "keydown", key: "ArrowRight" });
  assert.equal(explorer[0].getAttribute("aria-selected"), "true");
  explorer[0].dispatchEvent({ type: "keydown", key: "ArrowLeft" });
  assert.equal(explorer[6].getAttribute("aria-selected"), "true");
  explorer[6].dispatchEvent({ type: "keydown", key: "Home" });
  assert.equal(explorer[0].getAttribute("aria-selected"), "true");

  const horizonTabs = [...document.getElementById("predictive-horizon-tabs").children];
  assert.equal(horizonTabs.length, 3);
  const horizonPanel = document.getElementById("predictive-horizon-panel");
  assert.equal(horizonPanel.getAttribute("role"), "tabpanel");
  assert.deepEqual(horizonTabs.map((tab) => [tab.getAttribute("role"), tab.getAttribute("aria-controls"), tab.getAttribute("aria-selected"), tab.getAttribute("tabindex")]), [
    ["tab", "predictive-horizon-panel", "false", "-1"],
    ["tab", "predictive-horizon-panel", "true", "0"],
    ["tab", "predictive-horizon-panel", "false", "-1"],
  ]);
  horizonTabs[1].dispatchEvent({ type: "keydown", key: "ArrowRight" });
  assert.equal(horizonTabs[2].getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, horizonTabs[2]);
  assert.equal(horizonPanel.getAttribute("aria-labelledby"), "predictive-horizon-tab-50");
  assert.equal(document.getElementById("predictive-horizon-tabs").children[2], horizonTabs[2], "tabs are not rebuilt, so focus survives");
});

test("public report DOM sizes the forecast chart to its rows and labels a null rank as unranked", () => {
  const projection = projectReport(canonicalSnapshot);
  const items = Array.from({ length: 10 }, (_, index) => ({ subject: "src/file-" + index + ".js", rank: index === 3 ? null : index + 1, percentile: index === 3 ? null : 1 - index / 10 }));
  Object.assign(projection.predictive_intelligence, {
    state: "VALIDATED_MODEL",
    horizons: [{ horizon_commits: 25, forecast_available: true, state: "VALIDATED_MODEL", current_rankings: [] }],
    current_rankings: [
      { outcome_id: "modified", method_id: "m", items },
      { outcome_id: "reverted", method_id: "m", items },
    ],
  });
  const document = renderProjectionDom(projection);
  const chart = document.getElementById("predictive-forecast-chart");
  const height = Number(chart.getAttribute("viewBox").split(" ")[3]);
  assert.equal(height, Math.max(300, 28 + 20 * 22 + 24));
  assert.ok(28 + 19 * 22 + 4 < height);
  const texts = browserlessDescendants(chart).filter((element) => element.tagName === "TEXT").map((element) => element.textContent);
  assert.equal(texts.filter((value) => value === "unranked").length, 2);
  assert.equal(texts.some((value) => /rank null|NaN/.test(value)), false);
  const lines = browserlessDescendants(chart).filter((element) => element.tagName === "LINE");
  assert.equal(lines.some((line) => /NaN/.test(line.getAttribute("x1"))), false);
});

test("public report DOM draws complexity series with distinct shapes and a visible legend", () => {
  const document = runReportDom(renderReport(staticIntelligenceReportSnapshot()));
  const chart = document.getElementById("complexity-profile-chart");
  const markers = browserlessDescendants(chart).filter((element) => element.getAttribute("data-series"));
  const shapes = new Map(markers.map((element) => [element.getAttribute("data-series"), element.tagName]));
  assert.deepEqual(Object.fromEntries(shapes), { typical: "CIRCLE", tail: "RECT", maximum: "POLYGON" });
  const legend = browserlessDescendants(chart).filter((element) => element.classList.contains("series-legend-label")).map((element) => element.textContent);
  assert.deepEqual(legend, ["Typical (median)", "Complex tail (P90)", "Maximum"]);
});

test("public report DOM lists scatter subjects without both percentiles instead of plotting them", () => {
  const projection = projectReport(canonicalSnapshot);
  const point = (subject, structural, behavioral) => ({
    subject, structural, behavioral,
    structural_metric_id: "static.cyclomatic", behavioral_metric_id: "git.churn",
    structural_evidence: { state: "complete", coverage: 1, confidence: 1 },
    behavioral_evidence: { state: "complete", coverage: 1, confidence: 1 },
    evidence_state: "complete", signal_count: 0,
  });
  projection.scatter = { ...projection.scatter, state: "partial", points: [point("src/a.js", 0.5, 0.4), point("src/b.js", null, 0.2), point("src/c.js", 0.9, null)] };
  const document = renderProjectionDom(projection);
  const circles = browserlessDescendants(document.getElementById("scatter-chart")).filter((element) => element.tagName === "CIRCLE");
  assert.deepEqual(circles.map((circle) => circle.getAttribute("data-subject")), ["src/a.js"]);
  assert.equal(circles.some((circle) => /NaN/.test(circle.getAttribute("cx") + circle.getAttribute("cy"))), false);
  const unavailable = document.getElementById("scatter-unavailable");
  assert.equal(unavailable.hidden, false);
  assert.match(unavailable.textContent, /percentile unavailable\): src\/b\.js, src\/c\.js/);
});
