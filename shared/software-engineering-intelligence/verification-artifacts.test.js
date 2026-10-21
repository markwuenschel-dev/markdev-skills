"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const { collectAdapterEvidence } = require("./evidence-adapters.js");

const {
  buildVerificationArtifactEnvelope,
  discoverRevisionBoundVerificationEvidence,
  discoverRevisionBoundVerificationEvidenceFromIndex,
  parseJUnitXml,
  parseLcov,
} = require("./verification-artifacts.js");
const { buildRepositoryIndex } = require("./repository-index.js");

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

const INDEXED_REVISION = "9".repeat(40);

function indexedEntry(blobPath, contents = "", options = {}) {
  const bytes = Buffer.from(contents, "utf8");
  return {
    path: blobPath,
    mode: "100644",
    byte_size: options.byte_size ?? bytes.length,
    classifications: {
      source: options.source ?? false,
      test_source: options.test_source ?? false,
      generated: "human",
      vendor: "not-vendor",
      manifest_kinds: options.manifest_kinds ?? [],
      artifact_candidate_kinds: options.artifact_candidate_kinds ?? [],
    },
    bytes,
  };
}

function syntheticIndex(entries, readBlobs) {
  return {
    binding: { repository_revision: INDEXED_REVISION },
    entries,
    readBlobs: readBlobs ?? (async (requested) => new Map(requested.map((entry) => [entry.path, entry.bytes]))),
  };
}

function indexedDiscoveryInput(repositoryIndex, overrides = {}) {
  return {
    repository_revision: INDEXED_REVISION,
    configuration_hash: "8".repeat(64),
    history_window: { kind: "revision", start: null, end: INDEXED_REVISION },
    repository_index: repositoryIndex,
    ...overrides,
  };
}

test("index-backed revision discovery is byte-identical to the reader compatibility seam", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-verification-index-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "verification@example.test"]);
  git(root, ["config", "user.name", "SEI Verification Test"]);
  const entries = {
    ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: npm test\n",
    "package.json": JSON.stringify({ scripts: { test: "vitest run", coverage: "vitest run --coverage" }, devDependencies: { vitest: "1.0.0" } }),
    "tests/example.test.js": "test('example', () => {});\n",
    "ui/vitest.config.ts": "export default {};\n",
    "web/jest.config.js": "module.exports = {};\n",
    "build/test-results/TEST-unit.xml": "<testsuite tests=\"1\"><testcase name=\"pass\"/></testsuite>\n",
    "coverage/lcov.info": "SF:index.js\nLF:1\nLH:1\nend_of_record\n",
  };
  for (const [relativePath, content] of Object.entries(entries)) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content, "utf8");
  }
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "verification fixture"]);
  const revision = git(root, ["rev-parse", "HEAD"]);
  const input = {
    repository_revision: revision,
    configuration_hash: "a".repeat(64),
    history_window: { kind: "revision", start: null, end: revision },
  };
  const legacy = discoverRevisionBoundVerificationEvidence({
    ...input,
    listRevisionPaths: () => Object.keys(entries),
    readRevisionBlob: (relativePath) => Buffer.from(entries[relativePath], "utf8"),
  });
  const repositoryIndex = await buildRepositoryIndex({
    repository_root: root,
    repository_revision: revision,
    generated_path_patterns: [],
  });
  const indexed = await discoverRevisionBoundVerificationEvidenceFromIndex({
    ...input,
    repository_index: repositoryIndex,
    signal: new AbortController().signal,
  });
  assert.equal(JSON.stringify(indexed), JSON.stringify(legacy));
});

test("indexed discovery admits exactly 100000 classified paths and fails closed above the path bound", async () => {
  const entries = Array.from({ length: 100_000 }, (_, index) => indexedEntry(`docs/${String(index).padStart(6, "0")}.txt`));
  let reads = 0;
  const index = syntheticIndex(entries, async () => { reads += 1; return new Map(); });
  const admitted = await discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(index));
  assert.deepEqual(admitted.collectors.map((collector) => collector.collector_id), ["ci-discovery", "coverage-discovery", "test-discovery"]);
  assert.equal(reads, 0);

  const rejected = await discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(syntheticIndex([
    ...entries,
    indexedEntry("docs/overflow.txt"),
  ])));
  assert.ok(rejected.collectors.every((collector) => collector.status === "unavailable"));
  assert.match(rejected.collectors[0].reason, /100000-path bound/);
});

test("indexed discovery reads only the first 512 configuration candidates in legacy category order", async () => {
  const entries = Array.from({ length: 513 }, (_, index) => indexedEntry(
    `.github/workflows/${String(index).padStart(3, "0")}.yml`,
    "jobs:\n  tests:\n    steps:\n      - run: npm test\n",
    { artifact_candidate_kinds: ["ci-config"] },
  ));
  const reads = [];
  const index = syntheticIndex(entries, async (requested) => {
    reads.push(...requested.map((entry) => entry.path));
    return new Map(requested.map((entry) => [entry.path, entry.bytes]));
  });
  const discovered = await discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(index));
  assert.deepEqual(reads, entries.slice(0, 512).map((entry) => entry.path));
  const ci = discovered.collectors.find((collector) => collector.collector_id === "ci-discovery");
  assert.equal(ci.status, "degraded");
  assert.match(ci.reason, /bounded content could not be inspected/);
});

test("indexed discovery admits 32 supported results and reads none when their combined count exceeds the bound", async () => {
  const boundedEntries = Array.from({ length: 32 }, (_, index) => indexedEntry(
    `results/TEST-${String(index).padStart(2, "0")}.xml`,
    `<testsuite name=\"suite-${index}\" tests=\"1\"><testcase name=\"pass-${index}\"/></testsuite>`,
    { artifact_candidate_kinds: ["junit-result"] },
  ));
  const boundedReads = [];
  const bounded = await discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(syntheticIndex(
    boundedEntries,
    async (requested) => {
      boundedReads.push(...requested.map((entry) => entry.path));
      return new Map(requested.map((entry) => [entry.path, entry.bytes]));
    },
  )));
  assert.equal(boundedReads.length, 32);
  assert.ok(bounded.verification_summary);
  assert.equal(bounded.collectors.find((collector) => collector.collector_id === "test-discovery").status, "available");

  let overflowReads = 0;
  const overflow = await discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(syntheticIndex(
    [...boundedEntries, indexedEntry("results/TEST-32.xml", "<testsuite tests=\"0\"/>", { artifact_candidate_kinds: ["junit-result"] })],
    async () => { overflowReads += 1; return new Map(); },
  )));
  assert.equal(overflowReads, 0);
  assert.equal(overflow.verification_summary, null);
  assert.match(overflow.collectors.find((collector) => collector.collector_id === "test-discovery").reason, /32-artifact bound/);
});

test("indexed discovery preclassifies oversized candidates and isolates one unreadable blob from its peers", async () => {
  let oversizedReads = 0;
  const oversizedEntry = indexedEntry("PIPELINES/CI.YML", "jobs: {}\n", {
    byte_size: (2 * 1024 * 1024) + 1,
    artifact_candidate_kinds: ["ci-config"],
  });
  const oversized = await discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(syntheticIndex(
    [oversizedEntry],
    async () => { oversizedReads += 1; return new Map(); },
  )));
  assert.equal(oversizedReads, 0);
  assert.equal(oversized.collectors.find((collector) => collector.collector_id === "ci-discovery").status, "degraded");

  const bad = indexedEntry("a/package.json", "{", {
    manifest_kinds: ["node-package"],
    artifact_candidate_kinds: ["coverage-config", "test-config"],
  });
  const good = indexedEntry("b/package.json", JSON.stringify({ scripts: { test: "vitest run" } }), {
    manifest_kinds: ["node-package"],
    artifact_candidate_kinds: ["coverage-config", "test-config"],
  });
  const attempts = [];
  const isolated = await discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(syntheticIndex(
    [bad, good],
    async (requested) => {
      attempts.push(requested.map((entry) => entry.path));
      if (requested.some((entry) => entry.path === bad.path)) throw new Error("synthetic unreadable blob");
      return new Map(requested.map((entry) => [entry.path, entry.bytes]));
    },
  )));
  assert.deepEqual(attempts, [[bad.path, good.path], [bad.path], [good.path]]);
  const tests = isolated.collectors.find((collector) => collector.collector_id === "test-discovery");
  assert.equal(tests.status, "degraded");
  assert.match(tests.reason, /some bounded candidate configuration content could not be inspected/);
  assert.ok(isolated.metrics.find((metric) => metric.metric_id === "discovery.test_evidence_path_count").source.evidence_refs.includes("workflow-surface:Vitest"));
});

test("indexed discovery uses classifications for case-varied paths while isolating malformed JUnit from valid LCOV", async () => {
  const entries = [
    indexedEntry("PIPELINES/CI.YML", "jobs:\n  tests:\n    steps:\n      - run: pytest -q\n", { artifact_candidate_kinds: ["ci-config"] }),
    indexedEntry("RESULTS/TEST-BAD.XML", "<testsuite tests=\"1\"><testcase>", { artifact_candidate_kinds: ["junit-result"] }),
    indexedEntry("RESULTS/LCOV.INFO", "SF:index.js\nLF:4\nLH:3\nend_of_record\n", { artifact_candidate_kinds: ["lcov-result"] }),
  ];
  const discovered = await discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(syntheticIndex(entries)));
  const ciMetric = discovered.metrics.find((metric) => metric.metric_id === "discovery.ci_evidence_path_count");
  assert.deepEqual(ciMetric.source.artifact_refs, ["PIPELINES/CI.YML"]);
  assert.ok(ciMetric.source.evidence_refs.includes("workflow-surface:pytest"));
  assert.match(discovered.collectors.find((collector) => collector.collector_id === "test-discovery").reason, /JUnit.*malformed/i);
  assert.equal(discovered.collectors.find((collector) => collector.collector_id === "coverage-discovery").status, "available");
  assert.deepEqual(discovered.verification_summary.payload, { coverage: { statements: { covered: 3, total: 4 } } });
});

test("indexed discovery isolates a malformed result from valid peers of the same format", async () => {
  const entries = [
    indexedEntry("results/TEST-BAD.xml", '<testsuite tests="1"><testcase>', { artifact_candidate_kinds: ["junit-result"] }),
    indexedEntry("results/TEST-GOOD.xml", '<testsuite tests="1"><testcase name="pass"/></testsuite>', { artifact_candidate_kinds: ["junit-result"] }),
  ];
  const discovered = await discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(syntheticIndex(entries)));
  const tests = discovered.collectors.find((collector) => collector.collector_id === "test-discovery");
  const testsMetric = discovered.metrics.find((metric) => metric.metric_id === "discovery.test_evidence_path_count");

  assert.equal(tests.status, "available");
  assert.match(testsMetric.measurement.reason, /JUnit.*1 malformed.*artifact/);
  assert.deepEqual(discovered.verification_summary.payload.tests, {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    duration_ms: 0,
  });
});

test("reader compatibility discovery isolates a thrown blob read from valid result peers", () => {
  const badPath = "results/TEST-BAD.xml";
  const goodPath = "results/TEST-GOOD.xml";
  const discovered = discoverRevisionBoundVerificationEvidence({
    repository_revision: INDEXED_REVISION,
    configuration_hash: "8".repeat(64),
    history_window: { kind: "revision", start: null, end: INDEXED_REVISION },
    listRevisionPaths: () => [badPath, goodPath],
    readRevisionBlob: (blobPath) => {
      if (blobPath === badPath) throw new Error("synthetic unreadable Git blob");
      return Buffer.from('<testsuite tests="1"><testcase name="pass"/></testsuite>', "utf8");
    },
  });

  assert.equal(discovered.collectors.find((collector) => collector.collector_id === "test-discovery").status, "available");
  assert.equal(discovered.verification_summary.payload.tests.total, 1);
});

test("indexed discovery rejects revision drift and propagates pre-abort and in-flight cancellation", async () => {
  const entry = indexedEntry("package.json", JSON.stringify({ scripts: { test: "node --test" } }), {
    manifest_kinds: ["node-package"],
    artifact_candidate_kinds: ["coverage-config", "test-config"],
  });
  const index = syntheticIndex([entry]);
  await assert.rejects(
    discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(index, { repository_revision: "7".repeat(40), history_window: { kind: "revision", start: null, end: "7".repeat(40) } })),
    /repository index revision does not match discovery input/,
  );

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(index, { signal: preAborted.signal })),
    /FAIL-REPOSITORY-INDEX-CANCELLED/,
  );

  const inFlight = new AbortController();
  const pending = discoverRevisionBoundVerificationEvidenceFromIndex(indexedDiscoveryInput(syntheticIndex([entry], (requested, options) => (
    new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("FAIL-REPOSITORY-INDEX-CANCELLED: synthetic in-flight abort")), { once: true }))
  )), { signal: inFlight.signal }));
  setImmediate(() => inFlight.abort());
  await assert.rejects(pending, /FAIL-REPOSITORY-INDEX-CANCELLED/);
});

function gitBlobFixture(entries) {
  const blobs = new Map(Object.entries(entries).map(([blobPath, contents]) => [blobPath, Buffer.from(contents, "utf8")]));
  const reads = [];
  return {
    reads,
    listRevisionPaths() {
      return [...blobs.keys()].sort();
    },
    readRevisionBlob(blobPath) {
      reads.push(blobPath);
      const bytes = blobs.get(blobPath);
      assert.ok(bytes, `unexpected blob read: ${blobPath}`);
      return bytes;
    },
  };
}

test("revision-bound discovery reports configured CI and tests without inventing execution results", () => {
  const revision = "a".repeat(40);
  const fixture = gitBlobFixture({
    ".github/workflows/ci.yml": `name: CI
# pytest mypy pyright ruff vitest are discussed here but comments are not workflow evidence
jobs:
  java:
    steps:
      - run: ./gradlew cleanTest test
  python:
    steps:
      - run: uv run --frozen ruff check .
      - run: uv run --frozen mypy app
      - run: uv run --frozen pyright app
      - run: uv run --frozen pytest -q
  ui:
    steps:
      - run: npm run test
`,
    "apps/ui/package.json": JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "3.2.6" } }),
    "python/pyproject.toml": `[dependency-groups]
dev = ["pytest>=9", "ruff>=0.15", "mypy>=2", "pyright>=1"]
[tool.pytest.ini_options]
pythonpath = ["app"]
`,
    "service/build.gradle.kts": `dependencies { testImplementation("org.springframework.boot:spring-boot-starter-test") }
tasks.withType<Test> { useJUnitPlatform() }
`,
    "service/src/test/java/example/ExampleTest.java": "class ExampleTest {}\n",
    "python/tests/test_example.py": "def test_example(): pass\n",
    "apps/ui/src/example.test.ts": "test('example', () => {});\n",
  });

  const discovered = discoverRevisionBoundVerificationEvidence({
    repository_revision: revision,
    configuration_hash: "b".repeat(64),
    history_window: { kind: "revision", start: null, end: revision },
    listRevisionPaths: fixture.listRevisionPaths,
    readRevisionBlob: fixture.readRevisionBlob,
  });

  assert.deepEqual(discovered.collectors.map((collector) => [collector.collector_id, collector.status]), [
    ["ci-discovery", "degraded"],
    ["coverage-discovery", "unavailable"],
    ["test-discovery", "degraded"],
  ]);
  const metrics = new Map(discovered.metrics.map((metric) => [metric.metric_id, metric]));
  assert.deepEqual(metrics.get("discovery.ci_evidence_path_count").source, {
    kind: "revision-bound-git-discovery",
    collector_id: "ci-discovery",
    collector_version: "1.0.0",
    repository_revision: revision,
    command: "git ls-tree -r --name-only <revision>; git cat-file blob <revision>:<allowlisted-path>",
    artifact_refs: [".github/workflows/ci.yml"],
    evidence_refs: [
      "workflow-surface:Gradle/JUnit",
      "workflow-surface:mypy",
      "workflow-surface:pyright",
      "workflow-surface:pytest",
      "workflow-surface:Ruff",
      "workflow-surface:Vitest",
    ],
  });
  assert.deepEqual(metrics.get("discovery.test_evidence_path_count").source.artifact_refs, [
    "apps/ui/package.json",
    "apps/ui/src/example.test.ts",
    "python/pyproject.toml",
    "python/tests/test_example.py",
    "service/build.gradle.kts",
    "service/src/test/java/example/ExampleTest.java",
  ]);
  assert.deepEqual(metrics.get("discovery.test_evidence_path_count").source.evidence_refs, [
    "workflow-surface:Gradle/JUnit",
    "workflow-surface:pytest",
    "workflow-surface:Vitest",
  ]);
  assert.equal(metrics.get("discovery.coverage_evidence_path_count").value, null);
  assert.equal(metrics.get("discovery.coverage_evidence_path_count").measurement.status, "unavailable");
  assert.equal(discovered.verification_summary, null);
  assert.deepEqual(fixture.reads, [
    ".github/workflows/ci.yml",
    "apps/ui/package.json",
    "python/pyproject.toml",
    "service/build.gradle.kts",
  ]);
});

test("revision-bound discovery preserves full evidence counts while bounding serialized paths", () => {
  const revision = "c".repeat(40);
  const entries = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
    `tests/test_${String(index).padStart(3, "0")}.py`,
    "def test_example(): pass\n",
  ]));
  const fixture = gitBlobFixture(entries);
  const discovered = discoverRevisionBoundVerificationEvidence({
    repository_revision: revision,
    configuration_hash: "d".repeat(64),
    history_window: { kind: "revision", start: null, end: revision },
    listRevisionPaths: fixture.listRevisionPaths,
    readRevisionBlob: fixture.readRevisionBlob,
  });
  const testMetric = discovered.metrics.find((metric) => metric.metric_id === "discovery.test_evidence_path_count");
  assert.equal(testMetric.value, 300);
  assert.equal(testMetric.source.artifact_refs.length, 256);
  assert.equal(discovered.collectors.find((collector) => collector.collector_id === "test-discovery").status, "degraded");
  assert.deepEqual(fixture.reads, []);
});

test("revision discovery bounds configuration blob inspection without guessing the unread remainder", () => {
  const revision = "d".repeat(40);
  const entries = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [
    `packages/${String(index).padStart(3, "0")}/package.json`,
    index === 512 ? JSON.stringify({ scripts: { test: "vitest run" } }) : "{}",
  ]));
  const fixture = gitBlobFixture(entries);
  const discovered = discoverRevisionBoundVerificationEvidence({
    repository_revision: revision,
    configuration_hash: "c".repeat(64),
    history_window: { kind: "revision", start: null, end: revision },
    listRevisionPaths: fixture.listRevisionPaths,
    readRevisionBlob: fixture.readRevisionBlob,
  });
  const tests = discovered.collectors.find((collector) => collector.collector_id === "test-discovery");
  const coverage = discovered.collectors.find((collector) => collector.collector_id === "coverage-discovery");
  assert.equal(fixture.reads.length, 512);
  assert.equal(tests.status, "unavailable");
  assert.match(tests.reason, /could not be inspected.*bounded/i);
  assert.equal(coverage.status, "unavailable");
  assert.match(coverage.reason, /could not be inspected.*bounded/i);
});

test("an oversized committed workflow remains configured with unknown surfaces instead of aborting discovery", () => {
  const revision = "e".repeat(40);
  const workflowPath = ".github/workflows/ci.yml";
  const discovered = discoverRevisionBoundVerificationEvidence({
    repository_revision: revision,
    configuration_hash: "f".repeat(64),
    history_window: { kind: "revision", start: null, end: revision },
    listRevisionPaths: () => [workflowPath],
    readRevisionBlob: () => Buffer.alloc((2 * 1024 * 1024) + 1, 32),
  });
  const ciCollector = discovered.collectors.find((collector) => collector.collector_id === "ci-discovery");
  const ciMetric = discovered.metrics.find((metric) => metric.metric_id === "discovery.ci_evidence_path_count");
  assert.equal(ciCollector.status, "degraded");
  assert.match(ciCollector.reason, /bounded content could not be inspected/i);
  assert.equal(ciMetric.value, 1);
  assert.deepEqual(ciMetric.source.artifact_refs, [workflowPath]);
  assert.deepEqual(ciMetric.source.evidence_refs, []);
  assert.equal(discovered.verification_summary, null);
});

test("coverage discovery requires an explicit coverage configuration signal", () => {
  const revision = "0".repeat(40);
  const fixture = gitBlobFixture({
    ".coveragerc": "[run]\nbranch = True\n",
    "python/pyproject.toml": "[tool.coverage.run]\nbranch = true\n",
    "ui/vitest.config.ts": "export default { test: { globals: true } };\n",
  });
  const discovered = discoverRevisionBoundVerificationEvidence({
    repository_revision: revision,
    configuration_hash: "9".repeat(64),
    history_window: { kind: "revision", start: null, end: revision },
    listRevisionPaths: fixture.listRevisionPaths,
    readRevisionBlob: fixture.readRevisionBlob,
  });
  const coverageCollector = discovered.collectors.find((collector) => collector.collector_id === "coverage-discovery");
  const coverageMetric = discovered.metrics.find((metric) => metric.metric_id === "discovery.coverage_evidence_path_count");
  assert.equal(coverageCollector.status, "degraded");
  assert.equal(coverageMetric.value, 2);
  assert.deepEqual(coverageMetric.source.artifact_refs, [".coveragerc", "python/pyproject.toml"]);
  assert.equal(discovered.verification_summary, null);
});

test("revision discovery covers common Maven, Python, package, and Gradle test and coverage configuration", () => {
  const revision = "8".repeat(40);
  const fixture = gitBlobFixture({
    "pom.xml": `<project>
<!-- junit and jacoco in comments are not evidence -->
<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency>
<plugin><groupId>org.jacoco</groupId><artifactId>jacoco-maven-plugin</artifactId></plugin>
</project>`,
    "services/child/pom.xml": "<project><plugin><artifactId>maven-surefire-plugin</artifactId></plugin></project>",
    "requirements/dev.txt": "pytest==9.0.2\n",
    "python/requirements-dev.txt": "# pytest in a comment is not enough\npytest>=9\n",
    "python/requirements-docs.txt": "# pytest only\nsphinx>=8\n",
    "python/pyproject.toml": "[tool.coverage.run]\nbranch = true\n",
    "ui/package.json": JSON.stringify({
      scripts: { coverage: "vitest run --coverage" },
      devDependencies: { "@vitest/coverage-v8": "3.2.6", c8: "10.1.3" },
    }),
    "ui/vitest.config.ts": "export default { test: { coverage: { provider: 'v8' } } };\n",
    "service/build.gradle.kts": "plugins { jacoco }\ndependencies { testImplementation(libs.junit) }\n",
    ".coverage": "unparsed coverage.py data",
    "build/reports/jacoco/test/jacocoTestReport.xml": "<report/>",
    "coverage.xml": "<coverage/>",
  });
  const discovered = discoverRevisionBoundVerificationEvidence({
    repository_revision: revision,
    configuration_hash: "7".repeat(64),
    history_window: { kind: "revision", start: null, end: revision },
    listRevisionPaths: fixture.listRevisionPaths,
    readRevisionBlob: fixture.readRevisionBlob,
  });
  const testCollector = discovered.collectors.find((collector) => collector.collector_id === "test-discovery");
  const coverageCollector = discovered.collectors.find((collector) => collector.collector_id === "coverage-discovery");
  const testMetric = discovered.metrics.find((metric) => metric.metric_id === "discovery.test_evidence_path_count");
  const coverageMetric = discovered.metrics.find((metric) => metric.metric_id === "discovery.coverage_evidence_path_count");

  assert.equal(testCollector.status, "degraded");
  assert.deepEqual(testMetric.source.artifact_refs, [
    "pom.xml",
    "python/requirements-dev.txt",
    "requirements/dev.txt",
    "service/build.gradle.kts",
    "services/child/pom.xml",
    "ui/package.json",
    "ui/vitest.config.ts",
  ]);
  assert.deepEqual(testMetric.source.evidence_refs, [
    "workflow-surface:Gradle/JUnit",
    "workflow-surface:Maven/JUnit",
    "workflow-surface:pytest",
    "workflow-surface:Vitest",
  ]);
  assert.equal(coverageCollector.status, "degraded");
  assert.match(coverageCollector.reason, /JaCoCo\/Cobertura\/coverage\.py results were not normalized/i);
  assert.deepEqual(coverageMetric.source.artifact_refs, [
    ".coverage",
    "build/reports/jacoco/test/jacocoTestReport.xml",
    "coverage.xml",
    "pom.xml",
    "python/pyproject.toml",
    "service/build.gradle.kts",
    "ui/package.json",
    "ui/vitest.config.ts",
  ]);
  assert.equal(discovered.verification_summary, null);
  assert.equal(fixture.reads.includes("python/requirements-docs.txt"), false);
});

test("committed conventional results normalize as observed evidence with unknown repository completeness", () => {
  const revision = "1".repeat(40);
  const configurationHash = "2".repeat(64);
  const historyWindow = { kind: "revision", start: null, end: revision };
  const fixture = gitBlobFixture({
    "build/test-results/TEST-unit.xml": `<testsuite tests="2" failures="1" errors="0" skipped="0" time="0.5">
  <testcase name="pass" time="0.2"/><testcase name="fail" time="0.3"><failure/></testcase>
</testsuite>`,
    "coverage/lcov.info": "SF:src/index.js\nLF:10\nLH:8\nBRF:4\nBRH:3\nend_of_record\n",
  });
  const discovered = discoverRevisionBoundVerificationEvidence({
    repository_revision: revision,
    configuration_hash: configurationHash,
    history_window: historyWindow,
    listRevisionPaths: fixture.listRevisionPaths,
    readRevisionBlob: fixture.readRevisionBlob,
  });

  assert.equal(discovered.collectors.find((collector) => collector.collector_id === "test-discovery").status, "available");
  assert.equal(discovered.collectors.find((collector) => collector.collector_id === "coverage-discovery").status, "available");
  assert.match(discovered.verification_summary.artifact_ref, /^revision-verification-artifacts:sha256:[a-f0-9]{64}$/);
  assert.deepEqual(discovered.verification_summary.payload, {
    tests: { total: 2, passed: 1, failed: 1, skipped: 0, duration_ms: 500 },
    coverage: { statements: { covered: 8, total: 10 }, branches: { covered: 3, total: 4 } },
  });
  assert.deepEqual(discovered.verification_summary.completeness, { state: "partial", fraction: 0 });
  assert.deepEqual(discovered.verification_summary.coverage, { scope: "partial", fraction: 0 });
  const normalized = collectAdapterEvidence({
    repository_revision: revision,
    configuration_hash: configurationHash,
    history_window: historyWindow,
    adapters: [discovered.verification_summary],
  });
  assert.equal(normalized.collectors.find((collector) => collector.collector_id === "verification-summary").status, "degraded");
  const testsTotal = normalized.metrics.find((metric) => metric.metric_id === "verification.tests_total");
  assert.equal(testsTotal.value, 2);
  assert.equal(testsTotal.measurement.completeness, 0);
  assert.equal(testsTotal.measurement.confidence, 0);
});

test("result artifact counts beyond the discovery bound remain unobserved instead of aborting", () => {
  const revision = "3".repeat(40);
  const paths = Array.from({ length: 33 }, (_, index) => `build/test-results/TEST-${index}.xml`);
  let reads = 0;
  const discovered = discoverRevisionBoundVerificationEvidence({
    repository_revision: revision,
    configuration_hash: "4".repeat(64),
    history_window: { kind: "revision", start: null, end: revision },
    listRevisionPaths: () => paths,
    readRevisionBlob: () => { reads += 1; return Buffer.from("<testsuite tests=\"0\"/>", "utf8"); },
  });
  const testCollector = discovered.collectors.find((collector) => collector.collector_id === "test-discovery");
  assert.equal(testCollector.status, "unavailable");
  assert.match(testCollector.reason, /32-artifact bound/);
  assert.equal(discovered.verification_summary, null);
  assert.equal(reads, 0);
});

test("malformed committed results remain unobserved only for their affected capability", () => {
  const revision = "5".repeat(40);
  const fixture = gitBlobFixture({
    "build/test-results/TEST-malformed.xml": "<testsuite tests=\"1\"><testcase>",
    "coverage/lcov.info": "SF:src/index.js\nLF:4\nLH:3\nend_of_record\n",
  });
  const discovered = discoverRevisionBoundVerificationEvidence({
    repository_revision: revision,
    configuration_hash: "6".repeat(64),
    history_window: { kind: "revision", start: null, end: revision },
    listRevisionPaths: fixture.listRevisionPaths,
    readRevisionBlob: fixture.readRevisionBlob,
  });

  const tests = discovered.collectors.find((collector) => collector.collector_id === "test-discovery");
  const coverage = discovered.collectors.find((collector) => collector.collector_id === "coverage-discovery");
  assert.equal(tests.status, "unavailable");
  assert.match(tests.reason, /JUnit.*malformed/i);
  assert.equal(coverage.status, "available");
  assert.deepEqual(discovered.verification_summary.payload, {
    coverage: { statements: { covered: 3, total: 4 } },
  });
});

test("JUnit XML parsing preserves test outcomes and duration as raw verification evidence", () => {
  const parsed = parseJUnitXml(Buffer.from(`<?xml version="1.0"?>
<testsuite name="unit" tests="4" failures="1" errors="0" skipped="1" time="1.25">
  <testcase name="passes" time="0.10"/>
  <testcase name="fails" time="0.20"><failure message="expected"/></testcase>
  <testcase name="skips" time="0.30"><skipped/></testcase>
  <testcase name="passes-too" time="0.40"/>
</testsuite>
`, "utf8"));

  assert.deepEqual(parsed, {
    total: 4,
    passed: 2,
    failed: 1,
    skipped: 1,
    duration_ms: 1000,
  });
});

test("LCOV parsing reports only declared statement and branch coverage counts", () => {
  const parsed = parseLcov(Buffer.from(`TN:
SF:src/index.js
DA:1,1
DA:2,0
DA:3,2
LF:3
LH:2
BRDA:2,0,0,1
BRDA:2,0,1,0
BRF:2
BRH:1
end_of_record
`, "utf8"));

  assert.deepEqual(parsed, {
    statements: { covered: 2, total: 3 },
    branches: { covered: 1, total: 2 },
  });
});

test("local JUnit and LCOV artifacts become one closed verification-summary envelope", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-verification-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "junit.xml"), `<testsuite tests="2" failures="1" errors="0" skipped="0" time="0.5">
  <testcase name="pass" time="0.2"/>
  <testcase name="fail" time="0.3"><failure/></testcase>
</testsuite>`, "utf8");
  fs.writeFileSync(path.join(root, "lcov.info"), `SF:src/index.js
LF:10
LH:8
BRF:4
BRH:3
end_of_record
`, "utf8");

  const repositoryRevision = "a".repeat(40);
  const envelope = buildVerificationArtifactEnvelope({
    base_directory: root,
    repository_revision: repositoryRevision,
    configuration_hash: "b".repeat(64),
    history_window: { kind: "revision", start: null, end: repositoryRevision },
    completeness: { state: "complete", fraction: 1 },
    coverage: { scope: "repository", fraction: 1 },
    artifacts: [
      { format: "junit-xml", path: "junit.xml" },
      { format: "lcov", path: "lcov.info" },
    ],
  });

  assert.equal(envelope.adapter_id, "verification-summary");
  assert.equal(envelope.format, "local-verification-summary-v1");
  assert.match(envelope.artifact_ref, /^local-verification-artifacts:sha256:[a-f0-9]{64}$/);
  assert.match(envelope.artifact_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(envelope.payload, {
    tests: { total: 2, passed: 1, failed: 1, skipped: 0, duration_ms: 500 },
    coverage: {
      statements: { covered: 8, total: 10 },
      branches: { covered: 3, total: 4 },
    },
  });
});

test("malformed local verification artifacts fail before a typed envelope can be produced", () => {
  assert.throws(
    () => parseJUnitXml(Buffer.from("<testsuite><testcase>", "utf8")),
    /FAIL-VERIFICATION-ARTIFACT/,
  );
  assert.throws(
    () => parseLcov(Buffer.from("SF:src/index.js\nLF:2\nLH:3\nend_of_record\n", "utf8")),
    /FAIL-VERIFICATION-ARTIFACT/,
  );
});
