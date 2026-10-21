"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  REPOSITORY_INDEX_VERSION,
  CLASSIFICATION_POLICY_VERSION,
  buildRepositoryIndex,
} = require("./repository-index.js");

function git(repositoryRoot, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    input: options.input,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stderr || result.stdout}`);
  return result.stdout;
}

function fixtureMetadata(files) {
  return Object.fromEntries(Object.entries(files).map(([relativePath, content]) => {
    const bytes = Buffer.from(content);
    return [relativePath, Object.freeze({
      byte_size: bytes.length,
      sha256: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
    })];
  }));
}

function createRepository(files = { "src/main.js": "export const answer = 42;\n" }) {
  const metadata = fixtureMetadata(files);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-repository-index-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "sei@example.invalid"]);
  git(root, ["config", "user.name", "SEI Test"]);
  for (const [relativePath, bytes] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  const revision = git(root, ["rev-parse", "HEAD"]).trim();
  return { root, revision, metadata };
}

function addIndexEntry(repositoryRoot, mode, oid, relativePath) {
  git(repositoryRoot, ["update-index", "--add", "--cacheinfo", `${mode},${oid},${relativePath}`]);
}

function runTreePaths(repositoryRoot, revision) {
  const output = git(repositoryRoot, ["ls-tree", "-r", "-z", "--name-only", revision, "--"], { encoding: null });
  return output.length === 0 ? [] : output.subarray(0, -1).toString("utf8").split("\0");
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(target));
    else files.push(target);
  }
  return files;
}

function commitRawTree(repositoryRoot, entries, message) {
  const treeBytes = Buffer.concat(entries.flatMap((entry) => [
    Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"),
    Buffer.from(entry.oid, "hex"),
  ]));
  const treeOid = git(repositoryRoot, ["hash-object", "--literally", "-t", "tree", "-w", "--stdin"], { input: treeBytes }).trim();
  return git(repositoryRoot, ["commit-tree", treeOid, "-m", message]).trim();
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function cacheDigestBinding(binding) {
  const {
    index_version,
    classification_policy_version,
    repository_revision,
    root_tree_oid,
    object_format,
    classification_policy_hash,
    index_key,
    entry_count,
    total_blob_bytes,
    exclusion_count,
  } = binding;
  return {
    index_version,
    classification_policy_version,
    repository_revision,
    root_tree_oid,
    object_format,
    classification_policy_hash,
    index_key,
    entry_count,
    total_blob_bytes,
    exclusion_count,
  };
}

test("buildRepositoryIndex binds canonical entries to one exact committed revision", async () => {
  const repository = createRepository();
  try {
    const index = await buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
    });

    assert.equal(REPOSITORY_INDEX_VERSION, "sei.repository-index@1");
    assert.equal(CLASSIFICATION_POLICY_VERSION, "sei.repository-classification@2");
    assert.equal(index.binding.classification_policy_version, "sei.repository-classification@2");
    assert.equal(index.binding.repository_revision, repository.revision);
    assert.equal(index.binding.entry_count, 1);
    assert.deepEqual(index.entries.map((entry) => entry.path), ["src/main.js"]);
    assert.equal(index.entries[0].mode, "100644");
    assert.equal(index.entries[0].byte_size, repository.metadata["src/main.js"].byte_size);
    const committedBytes = git(repository.root, ["show", `${repository.revision}:src/main.js`], { encoding: null });
    assert.equal(sha256(committedBytes), repository.metadata["src/main.js"].sha256);
    assert.equal(index.entries[0].language, "javascript");
    assert.equal(index.entries[0].classifications.source, true);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("buildRepositoryIndex emits literal orthogonal classifications, modes, exclusions, and immutable identities", async () => {
  const repository = createRepository({
    ".github/workflows/CI.YML": "name: ci\n",
    "TESTS/unit.PY": "def test_ok():\n    assert True\n",
    "build.gradle.kts": "plugins {}\n",
    "coverage/coverage.xml": "<coverage/>\n",
    "coverage/lcov.info": "TN:\n",
    "generated/widget.ts": "export const generated = true;\n",
    "jest.config.js": "module.exports = {};\n",
    "package.json": "{}\n",
    "pyproject.toml": "[project]\nname='fixture'\n",
    "requirements-test.txt": "pytest\n",
    "results/TEST-unit.xml": "<testsuite/>\n",
    "src/Foo.SPEC.TSX": "export const Component = () => null;\n",
    "vendor/lib.py": "value = 1\n",
    "vitest.config.ts": "export default {};\n",
  });
  try {
    const gitlinkOid = repository.revision;
    const symlinkOid = git(repository.root, ["hash-object", "-w", "--stdin"], { input: "../src/Foo.SPEC.TSX" }).trim();
    addIndexEntry(repository.root, "120000", symlinkOid, "links/alias.py");
    addIndexEntry(repository.root, "160000", gitlinkOid, "deps/submodule");
    git(repository.root, ["commit", "--quiet", "-m", "modes"]);
    repository.revision = git(repository.root, ["rev-parse", "HEAD"]).trim();

    const index = await buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: ["generated/**", "coverage/**"],
    });
    const byPath = new Map(index.entries.map((entry) => [entry.path, entry]));

    assert.deepEqual(index.entries.map((entry) => entry.path), [
      ".github/workflows/CI.YML",
      "TESTS/unit.PY",
      "build.gradle.kts",
      "coverage/coverage.xml",
      "coverage/lcov.info",
      "generated/widget.ts",
      "jest.config.js",
      "links/alias.py",
      "package.json",
      "pyproject.toml",
      "requirements-test.txt",
      "results/TEST-unit.xml",
      "src/Foo.SPEC.TSX",
      "vendor/lib.py",
      "vitest.config.ts",
    ]);
    assert.equal(byPath.get("src/Foo.SPEC.TSX").language, "typescript");
    assert.equal(byPath.get("src/Foo.SPEC.TSX").classifications.source, true);
    assert.equal(byPath.get("src/Foo.SPEC.TSX").classifications.test_source, true);
    assert.equal(byPath.get("TESTS/unit.PY").classifications.test_source, true);
    assert.equal(byPath.get("generated/widget.ts").classifications.generated, "generated");
    assert.equal(byPath.get("vendor/lib.py").classifications.vendor, "vendor");
    assert.deepEqual(byPath.get("package.json").classifications.manifest_kinds, ["node-package"]);
    assert.deepEqual(byPath.get("package.json").classifications.artifact_candidate_kinds, ["coverage-config", "test-config"]);
    assert.deepEqual(byPath.get("pyproject.toml").classifications.manifest_kinds, ["python-project"]);
    assert.deepEqual(byPath.get("requirements-test.txt").classifications.manifest_kinds, ["python-requirements"]);
    assert.deepEqual(byPath.get("build.gradle.kts").classifications.manifest_kinds, ["gradle-build"]);
    assert.deepEqual(byPath.get("jest.config.js").classifications.artifact_candidate_kinds, ["coverage-config", "jest-config", "test-config"]);
    assert.deepEqual(byPath.get("vitest.config.ts").classifications.artifact_candidate_kinds, ["coverage-config", "test-config", "vitest-config"]);
    assert.deepEqual(byPath.get(".github/workflows/CI.YML").classifications.artifact_candidate_kinds, ["ci-config"]);
    assert.deepEqual(byPath.get("results/TEST-unit.xml").classifications.artifact_candidate_kinds, ["junit-result"]);
    assert.deepEqual(byPath.get("coverage/lcov.info").classifications.artifact_candidate_kinds, ["lcov-result"]);
    assert.deepEqual(byPath.get("coverage/coverage.xml").classifications.artifact_candidate_kinds, ["unsupported-coverage-result"]);
    assert.equal(byPath.get("links/alias.py").mode, "120000");
    assert.equal(byPath.get("links/alias.py").classifications.source, false);
    assert.deepEqual(index.exclusions, [{
      path: "deps/submodule",
      mode: "160000",
      object_oid: gitlinkOid,
      reason: "gitlink-not-a-blob",
    }]);
    assert.match(index.binding.classification_policy_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(index.binding.index_key, /^sha256:[0-9a-f]{64}$/);
    assert.match(index.binding.index_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(byPath.get("src/Foo.SPEC.TSX").content_key, /^git-blob:sha1:[0-9a-f]{40}$/);
    assert.match(byPath.get("src/Foo.SPEC.TSX").entry_key, /^sha256:[0-9a-f]{64}$/);
    assert.throws(() => index.entries.push({}), TypeError);
    assert.throws(() => { byPath.get("src/Foo.SPEC.TSX").classifications.source = false; }, TypeError);

    const unknownPolicy = await buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: repository.revision,
    });
    assert.ok(unknownPolicy.entries.every((entry) => entry.classifications.generated === "unknown"));
    assert.notEqual(unknownPolicy.binding.classification_policy_hash, index.binding.classification_policy_hash);

    for (const invalidRevision of ["HEAD", repository.revision.slice(0, 12), repository.revision.toUpperCase(), `-${repository.revision}`]) {
      await assert.rejects(buildRepositoryIndex({
        repository_root: repository.root,
        repository_revision: invalidRevision,
      }), /FAIL-REPOSITORY-INDEX-INPUT/);
    }
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("readBlobs reads owned entries by OID under declared bounds and returns fresh canonical buffers", async () => {
  const repository = createRepository({
    "a.js": "same bytes\n",
    "binary/data.bin": Buffer.from([0, 1, 2, 255]),
    "z.js": "same bytes\n",
  });
  const foreign = createRepository({ "foreign.js": "foreign\n" });
  try {
    const index = await buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
    });
    const foreignIndex = await buildRepositoryIndex({
      repository_root: foreign.root,
      repository_revision: foreign.revision,
      generated_path_patterns: [],
    });
    const a = index.entries.find((entry) => entry.path === "a.js");
    const binary = index.entries.find((entry) => entry.path === "binary/data.bin");
    const z = index.entries.find((entry) => entry.path === "z.js");
    assert.equal(a.blob_oid, z.blob_oid, "the fixture must exercise OID deduplication");

    const first = await index.readBlobs([z, binary, a], {
      max_blob_bytes: 32,
      max_total_bytes: 64,
    });
    assert.deepEqual([...first.keys()], ["a.js", "binary/data.bin", "z.js"]);
    assert.equal(first.get("a.js").toString("utf8"), "same bytes\n");
    assert.deepEqual(first.get("binary/data.bin"), Buffer.from([0, 1, 2, 255]));
    assert.notEqual(first.get("a.js"), first.get("z.js"));
    first.get("a.js")[0] = 88;

    const second = await index.readBlobs([a], { max_blob_bytes: 32, max_total_bytes: 32 });
    assert.equal(second.get("a.js").toString("utf8"), "same bytes\n");
    assert.equal(typeof second.set, "undefined");

    await assert.rejects(index.readBlobs([foreignIndex.entries[0]], {
      max_blob_bytes: 32,
      max_total_bytes: 32,
    }), /FAIL-REPOSITORY-INDEX-BLOB.*owned/);
    await assert.rejects(index.readBlobs([a], {
      max_blob_bytes: 4,
      max_total_bytes: 32,
    }), /FAIL-REPOSITORY-INDEX-BLOB.*max_blob_bytes/);
    await assert.rejects(index.readBlobs([a, z], {
      max_blob_bytes: 32,
      max_total_bytes: 16,
    }), /FAIL-REPOSITORY-INDEX-BLOB.*max_total_bytes/);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(foreign.root, { recursive: true, force: true });
  }
});

test("index identity ignores worktree state, clone path, build order, and preserves content identity across rename", async () => {
  const repository = createRepository({ "src/original.js": "export const stable = true;\n" });
  const cloneHost = fs.mkdtempSync(path.join(os.tmpdir(), "sei-repository-index-clone-"));
  const cloneRoot = path.join(cloneHost, "different-path");
  try {
    const input = {
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
    };
    const cold = await buildRepositoryIndex(input);
    fs.writeFileSync(path.join(repository.root, "src", "original.js"), "dirty worktree bytes\n");
    fs.writeFileSync(path.join(repository.root, "untracked.js"), "untracked\n");
    const dirty = await buildRepositoryIndex(input);
    assert.equal(dirty.binding.index_digest, cold.binding.index_digest);
    assert.deepEqual(dirty.entries, cold.entries);

    git(cloneHost, ["clone", "--quiet", repository.root, cloneRoot]);
    const cloned = await buildRepositoryIndex({ ...input, repository_root: cloneRoot });
    assert.equal(cloned.binding.index_digest, cold.binding.index_digest);
    assert.deepEqual(cloned.entries, cold.entries);

    const [left, right] = await Promise.all([buildRepositoryIndex(input), buildRepositoryIndex(input)]);
    assert.equal(left.binding.index_digest, right.binding.index_digest);
    assert.equal(JSON.stringify(left.entries), JSON.stringify(right.entries));

    fs.writeFileSync(path.join(repository.root, "src", "original.js"), "export const stable = true;\n");
    fs.rmSync(path.join(repository.root, "untracked.js"));
    git(repository.root, ["mv", "src/original.js", "src/renamed.js"]);
    git(repository.root, ["commit", "--quiet", "-m", "rename"]);
    const renamedRevision = git(repository.root, ["rev-parse", "HEAD"]).trim();
    const renamed = await buildRepositoryIndex({ ...input, repository_revision: renamedRevision });
    assert.equal(renamed.entries[0].content_key, cold.entries[0].content_key);
    assert.notEqual(renamed.entries[0].entry_key, cold.entries[0].entry_key);
    assert.notEqual(renamed.binding.index_digest, cold.binding.index_digest);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(cloneHost, { recursive: true, force: true });
  }
});

test("immutable cache supports cold, warm, concurrent, corruption recovery, and rejects a valid conflicting artifact", async () => {
  const repository = createRepository({ "src/cache.js": "export const cached = true;\n" });
  const conflictingRepository = createRepository({ "src/other.js": "export const other = true;\n" });
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-repository-index-cache-"));
  const conflictingCacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-repository-index-conflict-"));
  try {
    const input = {
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
      cache_root: cacheRoot,
    };
    const cold = await buildRepositoryIndex(input);
    assert.equal(cold.binding.cache, "miss");
    const cacheFiles = fs.readdirSync(path.join(cacheRoot, "repository-index-v1")).filter((name) => name.endsWith(".json"));
    assert.equal(cacheFiles.length, 1);
    const cachePath = path.join(cacheRoot, "repository-index-v1", cacheFiles[0]);
    const coldBytes = fs.readFileSync(cachePath);

    const warm = await buildRepositoryIndex(input);
    assert.equal(warm.binding.cache, "hit");
    assert.equal(warm.binding.index_digest, cold.binding.index_digest);
    assert.deepEqual(warm.entries, cold.entries);

    fs.rmSync(cacheRoot, { recursive: true, force: true });
    const [concurrentLeft, concurrentRight] = await Promise.all([
      buildRepositoryIndex(input),
      buildRepositoryIndex(input),
    ]);
    assert.equal(concurrentLeft.binding.index_digest, concurrentRight.binding.index_digest);
    const concurrentFiles = fs.readdirSync(path.join(cacheRoot, "repository-index-v1")).filter((name) => name.endsWith(".json"));
    assert.equal(concurrentFiles.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(cacheRoot, "repository-index-v1", concurrentFiles[0])), coldBytes);

    fs.writeFileSync(cachePath, coldBytes.subarray(0, Math.floor(coldBytes.length / 2)));
    const recovered = await buildRepositoryIndex(input);
    assert.equal(recovered.binding.cache, "recovered-corrupt");
    assert.equal(recovered.binding.index_digest, cold.binding.index_digest);
    assert.deepEqual(fs.readFileSync(cachePath), coldBytes);

    await buildRepositoryIndex({
      repository_root: conflictingRepository.root,
      repository_revision: conflictingRepository.revision,
      generated_path_patterns: [],
      cache_root: conflictingCacheRoot,
    });
    const conflictingName = fs.readdirSync(path.join(conflictingCacheRoot, "repository-index-v1")).find((name) => name.endsWith(".json"));
    fs.copyFileSync(path.join(conflictingCacheRoot, "repository-index-v1", conflictingName), cachePath);
    await assert.rejects(buildRepositoryIndex(input), /FAIL-REPOSITORY-INDEX-CACHE.*conflict/);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(conflictingRepository.root, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(conflictingCacheRoot, { recursive: true, force: true });
  }
});

test("classification policy V2 cache identity invalidates a structurally valid V1 artifact", async () => {
  const repository = createRepository({ "jest.config.js": "module.exports = {};\n" });
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-repository-index-policy-v2-"));
  try {
    const input = {
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
      cache_root: cacheRoot,
    };
    const current = await buildRepositoryIndex(input);
    assert.equal(current.binding.classification_policy_version, "sei.repository-classification@2");
    assert.deepEqual(current.entries[0].classifications.artifact_candidate_kinds, ["coverage-config", "jest-config", "test-config"]);

    const cacheDirectory = path.join(cacheRoot, "repository-index-v1");
    const currentCachePath = path.join(cacheDirectory, fs.readdirSync(cacheDirectory).find((name) => name.endsWith(".json")));
    const v1Artifact = JSON.parse(fs.readFileSync(currentCachePath, "utf8"));
    const v1Kinds = ["coverage-config", "test-config"];
    v1Artifact.binding.classification_policy_version = "sei.repository-classification@1";
    v1Artifact.binding.classification_policy_hash = sha256(JSON.stringify({
      version: "sei.repository-classification@1",
      generated_patterns_supplied: true,
      generated_path_patterns: [],
      source_extensions: [
        [".c", "c"], [".cc", "cpp"], [".cpp", "cpp"], [".cs", "csharp"],
        [".go", "go"], [".java", "java"], [".js", "javascript"], [".jsx", "javascript"],
        [".kt", "kotlin"], [".kts", "kotlin"], [".php", "php"], [".py", "python"],
        [".rb", "ruby"], [".rs", "rust"], [".swift", "swift"], [".ts", "typescript"],
        [".tsx", "typescript"],
      ],
      test_rule: "supported-source-in-test-tests-__tests__-src-test-or-js-ts-test-spec-case-insensitive@1",
      vendor_segments: ["external", "node_modules", "third_party", "vendor"],
      manifest_rule: "node-python-requirements-gradle-maven-path-candidates@1",
      artifact_rule: "ci-test-coverage-junit-lcov-unsupported-coverage-path-candidates@1",
    }));
    v1Artifact.binding.index_key = sha256(JSON.stringify({
      index_version: v1Artifact.binding.index_version,
      object_format: v1Artifact.binding.object_format,
      repository_revision: v1Artifact.binding.repository_revision,
      root_tree_oid: v1Artifact.binding.root_tree_oid,
      classification_policy_hash: v1Artifact.binding.classification_policy_hash,
    }));
    const { entry_key: ignoredEntryKey, ...v1Identity } = v1Artifact.entries[0];
    v1Identity.classifications.artifact_candidate_kinds = v1Kinds;
    v1Artifact.entries[0] = {
      ...v1Identity,
      entry_key: sha256(JSON.stringify({
        classification_policy_hash: v1Artifact.binding.classification_policy_hash,
        ...v1Identity,
      })),
    };
    v1Artifact.binding.index_digest = sha256(JSON.stringify({
      binding: cacheDigestBinding(v1Artifact.binding),
      entries: v1Artifact.entries,
      exclusions: v1Artifact.exclusions,
    }));
    const v1CachePath = path.join(cacheDirectory, `${v1Artifact.binding.index_key.slice("sha256:".length)}.json`);
    fs.writeFileSync(v1CachePath, JSON.stringify(v1Artifact));

    const replay = await buildRepositoryIndex(input);
    assert.equal(replay.binding.cache, "hit");
    assert.equal(replay.binding.classification_policy_version, "sei.repository-classification@2");
    assert.deepEqual(replay.entries[0].classifications.artifact_candidate_kinds, ["coverage-config", "jest-config", "test-config"]);
    assert.notEqual(replay.binding.index_key, v1Artifact.binding.index_key);
    assert.equal(fs.existsSync(v1CachePath), true, "the immutable V1 artifact remains separate from V2 cache authority");
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("cache replay recovers an internally valid artifact whose entries do not match the exact bound Git tree", async () => {
  const repository = createRepository({ "src/trusted.js": "export const trusted = true;\n" });
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-repository-index-substitution-"));
  try {
    const input = {
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
      cache_root: cacheRoot,
    };
    const cold = await buildRepositoryIndex(input);
    const cacheDirectory = path.join(cacheRoot, "repository-index-v1");
    const cachePath = path.join(cacheDirectory, fs.readdirSync(cacheDirectory).find((name) => name.endsWith(".json")));
    const artifact = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const substitutedBytes = Buffer.from("print('substituted cache entry')\n", "utf8");
    const substitutedOid = git(repository.root, ["hash-object", "-w", "--stdin"], { input: substitutedBytes }).trim();
    assert.equal(runTreePaths(repository.root, repository.revision).includes("src/substituted.py"), false);

    const substitutedIdentity = {
      path: "src/substituted.py",
      mode: "100755",
      blob_oid: substitutedOid,
      byte_size: substitutedBytes.length,
      content_key: `git-blob:sha1:${substitutedOid}`,
      language: "python",
      classifications: {
        source: true,
        test_source: false,
        generated: "human",
        vendor: "not-vendor",
        manifest_kinds: [],
        artifact_candidate_kinds: [],
      },
    };
    artifact.entries = [{
      ...substitutedIdentity,
      entry_key: sha256(JSON.stringify({
        classification_policy_hash: artifact.binding.classification_policy_hash,
        ...substitutedIdentity,
      })),
    }];
    artifact.binding.entry_count = 1;
    artifact.binding.total_blob_bytes = substitutedBytes.length;
    artifact.binding.exclusion_count = artifact.exclusions.length;
    artifact.binding.index_digest = sha256(JSON.stringify({
      binding: cacheDigestBinding(artifact.binding),
      entries: artifact.entries,
      exclusions: artifact.exclusions,
    }));
    fs.writeFileSync(cachePath, JSON.stringify(artifact));

    const recovered = await buildRepositoryIndex(input);
    assert.equal(recovered.binding.cache, "recovered-corrupt");
    assert.deepEqual(recovered.entries, cold.entries);
    assert.equal(recovered.entries.some((entry) => entry.path === "src/substituted.py"), false);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("pre-aborted and in-flight cancellation settle Git children without partial blob results or late cache publication", async () => {
  const repository = createRepository({ "src/cancel.js": Buffer.alloc(8 * 1024 * 1024, 65) });
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-repository-index-cancel-"));
  try {
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
      cache_root: cacheRoot,
      signal: preAborted.signal,
    }), /FAIL-REPOSITORY-INDEX-CANCELLED/);
    assert.deepEqual(listFiles(cacheRoot), []);

    const inFlightBuild = new AbortController();
    const startedAt = Date.now();
    const pendingBuild = buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
      cache_root: cacheRoot,
      signal: inFlightBuild.signal,
    });
    inFlightBuild.abort();
    await assert.rejects(pendingBuild, /FAIL-REPOSITORY-INDEX-CANCELLED/);
    assert.ok(Date.now() - startedAt < 5_000, "the killed direct Git child must settle promptly");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(listFiles(cacheRoot), []);

    const index = await buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
    });
    const inFlightRead = new AbortController();
    const pendingRead = index.readBlobs(index.entries, {
      max_blob_bytes: 8 * 1024 * 1024,
      max_total_bytes: 8 * 1024 * 1024,
      signal: inFlightRead.signal,
    });
    inFlightRead.abort();
    await assert.rejects(pendingRead, /FAIL-REPOSITORY-INDEX-CANCELLED/);

    const isolatedCancellation = new AbortController();
    const cancelledBuilder = buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
      signal: isolatedCancellation.signal,
    });
    const survivingBuilder = buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
    });
    isolatedCancellation.abort();
    await assert.rejects(cancelledBuilder, /FAIL-REPOSITORY-INDEX-CANCELLED/);
    assert.equal((await survivingBuilder).entries.length, 1, "one caller's cancellation must not abort another build");
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("closed inputs and tightened tree, entry, exclusion, blob, and batch ceilings fail closed", async () => {
  const repository = createRepository({ "a.js": "alpha\n", "b.py": "beta\n" });
  try {
    addIndexEntry(repository.root, "160000", repository.revision, "deps/one");
    addIndexEntry(repository.root, "160000", repository.revision, "deps/two");
    git(repository.root, ["commit", "--quiet", "-m", "gitlinks"]);
    repository.revision = git(repository.root, ["rev-parse", "HEAD"]).trim();
    const base = {
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
    };

    await assert.rejects(buildRepositoryIndex({ ...base, extra: true }), /FAIL-REPOSITORY-INDEX-INPUT.*unexpected/);
    await assert.rejects(buildRepositoryIndex({ ...base, limits: { max_entries: 0 } }), /FAIL-REPOSITORY-INDEX-INPUT.*max_entries/);
    await assert.rejects(buildRepositoryIndex({ ...base, limits: { max_tree_bytes: 1 } }), /FAIL-REPOSITORY-INDEX-TREE.*stdout exceeded/);
    await assert.rejects(buildRepositoryIndex({ ...base, limits: { max_entries: 1 } }), /FAIL-REPOSITORY-INDEX-TREE.*entries exceeded/);
    await assert.rejects(buildRepositoryIndex({ ...base, limits: { max_exclusions: 1 } }), /FAIL-REPOSITORY-INDEX-TREE.*exclusions exceeded/);
    await assert.rejects(buildRepositoryIndex({ ...base, limits: { max_blob_bytes: 4 } }), /FAIL-REPOSITORY-INDEX-TREE.*blob size exceeded/);

    const index = await buildRepositoryIndex(base);
    await assert.rejects(index.readBlobs(index.entries.slice(0, 1), {
      max_blob_bytes: 64 * 1024 * 1024,
      max_total_bytes: (32 * 1024 * 1024) + 1,
    }), /FAIL-REPOSITORY-INDEX-BLOB.*max_total_bytes/);
    assert.equal((await index.readBlobs([], { max_blob_bytes: 1, max_total_bytes: 1 })).size, 0);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("SHA-256 repositories preserve 64-hex binding, identities, and exact blob reads", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-repository-index-sha256-"));
  try {
    const initialized = spawnSync("git", ["init", "--quiet", "--object-format=sha256"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    if (initialized.status !== 0) {
      context.skip("host Git does not support SHA-256 repositories");
      return;
    }
    git(root, ["config", "user.email", "sei@example.invalid"]);
    git(root, ["config", "user.name", "SEI Test"]);
    fs.writeFileSync(path.join(root, "main.py"), "print('sha256')\n");
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "sha256"]);
    const revision = git(root, ["rev-parse", "HEAD"]).trim();
    const index = await buildRepositoryIndex({
      repository_root: root,
      repository_revision: revision,
      generated_path_patterns: [],
    });
    assert.match(index.binding.repository_revision, /^[0-9a-f]{64}$/);
    assert.match(index.binding.root_tree_oid, /^[0-9a-f]{64}$/);
    assert.equal(index.binding.object_format, "sha256");
    assert.match(index.entries[0].content_key, /^git-blob:sha256:[0-9a-f]{64}$/);
    const blobs = await index.readBlobs(index.entries, { max_blob_bytes: 64, max_total_bytes: 64 });
    assert.equal(blobs.get("main.py").toString("utf8"), "print('sha256')\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("UTF-8 spaces remain canonical while unsafe and duplicate Git tree paths fail closed", async () => {
  const repository = createRepository({
    "space dir/naïve file.ts": "export const utf8 = true;\n",
  });
  try {
    const safe = await buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: repository.revision,
      generated_path_patterns: [],
    });
    assert.equal(safe.entries[0].path, "space dir/naïve file.ts");

    const blobOid = git(repository.root, ["hash-object", "-w", "--stdin"], { input: "hostile\n" }).trim();
    const unsafeRevision = commitRawTree(repository.root, [{
      mode: "100644",
      name: "bad\\path.js",
      oid: blobOid,
    }], "unsafe path");
    await assert.rejects(buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: unsafeRevision,
      generated_path_patterns: [],
    }), /FAIL-REPOSITORY-INDEX-TREE.*unsafe repository path/);

    const duplicateRevision = commitRawTree(repository.root, [
      { mode: "100644", name: "duplicate.js", oid: blobOid },
      { mode: "100644", name: "duplicate.js", oid: blobOid },
    ], "duplicate path");
    await assert.rejects(buildRepositoryIndex({
      repository_root: repository.root,
      repository_revision: duplicateRevision,
      generated_path_patterns: [],
    }), /FAIL-REPOSITORY-INDEX-TREE.*duplicate repository path/);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});
