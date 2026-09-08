"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { canonicalBytes } = require("./engineering-intelligence.js");
const test = require("node:test");

const RIA_ROOT = __dirname;
const SEI_ROOT = path.resolve(RIA_ROOT, "..", "shared", "software-engineering-intelligence");
const CANONICAL_SNAPSHOT = JSON.parse(fs.readFileSync(path.join(SEI_ROOT, "canonical-intelligence.json"), "utf8"));
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SCOPE_HASH = "b".repeat(64);

function clone(value) {
  return structuredClone(value);
}

function snapshotFor(revision = REVISION) {
  return JSON.parse(JSON.stringify(CANONICAL_SNAPSHOT).replaceAll(REVISION, revision));
}

function baselineRef({ artifactId = "baseline:assessment-1", sha256 = "a".repeat(64), repositoryRevision = REVISION } = {}) {
  return { artifact_id: artifactId, sha256, repository_revision: repositoryRevision };
}

function temporaryRepository(context) {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ria-engineering-intelligence-"));
  const init = childProcess.spawnSync("git", ["-C", repositoryRoot, "init", "--quiet"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  return repositoryRoot;
}

function writer() {
  return require("./engineering-intelligence-writer.js");
}

function reader() {
  return require("./engineering-intelligence-reader.js");
}

function artifactPath(repositoryRoot, sha256) {
  return path.join(repositoryRoot, ".project-intelligence", "evidence", "engineering-intelligence", `${sha256}.json`);
}

function baselineIndexDirectory(repositoryRoot) {
  return path.join(repositoryRoot, ".project-intelligence", "evidence", "engineering-intelligence", "baseline-index");
}

function baselineIndexPath(repositoryRoot) {
  const files = fs.readdirSync(baselineIndexDirectory(repositoryRoot)).filter((entry) => entry.endsWith(".json"));
  assert.equal(files.length, 1, "one immutable index must bind this established baseline");
  return path.join(baselineIndexDirectory(repositoryRoot), files[0]);
}

function baselinePinDirectory(repositoryRoot) {
  return path.join(repositoryRoot, ".project-intelligence", "evidence", "engineering-intelligence", "baseline-pin");
}

function baselinePinPath(repositoryRoot) {
  const files = fs.readdirSync(baselinePinDirectory(repositoryRoot)).filter((entry) => entry.endsWith(".json"));
  assert.equal(files.length, 1, "one immutable pin must bind this established baseline");
  return path.join(baselinePinDirectory(repositoryRoot), files[0]);
}

function snapshotWithGeneratedAt(generatedAt) {
  const snapshot = snapshotFor();
  snapshot.run_metadata.generated_at = generatedAt;
  return snapshot;
}

function expectedBinding(baseline = baselineRef()) {
  return {
    baseline_ref: baseline,
    repository_revision: baseline.repository_revision,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
  };
}

test("RIA writes one immutable, content-addressed M2-valid engineering-intelligence artifact", (context) => {
  const repositoryRoot = temporaryRepository(context);
  const baseline = baselineRef();
  let computeCalls = 0;
  const ref = writer().writeEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: ({ baseline_ref }) => {
      computeCalls += 1;
      assert.deepEqual(baseline_ref, baseline);
      return snapshotFor();
    },
  });

  assert.equal(computeCalls, 1);
  assert.deepEqual(Object.keys(ref).sort(), [
    "artifact_id",
    "baseline_binding",
    "kind",
    "mission_id",
    "owner",
    "repository_revision",
    "schema_version",
    "scope_hash",
    "sha256",
  ]);
  assert.equal(ref.owner, "repository-improvement-assessment");
  assert.equal(ref.kind, "engineering-intelligence");
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  assert.equal(ref.artifact_id, `engineering-intelligence:${ref.sha256}`);
  assert.ok(fs.existsSync(artifactPath(repositoryRoot, ref.sha256)));

  const resolved = reader().readEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    engineering_intelligence_ref: ref,
    expected: expectedBinding(baseline),
  });
  assert.equal(resolved.engineering_intelligence.repository.revision, REVISION);
  assert.match(resolved.engineering_intelligence.snapshot_id, /^sei-v1-/);
});

test("RIA pins the first valid intelligence artifact for an established baseline before any later compute", (context) => {
  const repositoryRoot = temporaryRepository(context);
  const baseline = baselineRef();
  let computeCalls = 0;
  const write = (generatedAt) => writer().writeEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => {
      computeCalls += 1;
      return snapshotWithGeneratedAt(generatedAt);
    },
  });

  const first = write("2026-08-10T00:00:00.000Z");
  const second = write("2026-08-10T00:01:00.000Z");

  assert.equal(computeCalls, 1, "a matching established baseline must reuse before compute");
  assert.deepEqual(second, first);
  assert.ok(fs.existsSync(baselineIndexPath(repositoryRoot)));
  assert.ok(fs.existsSync(baselinePinPath(repositoryRoot)));
  assert.equal(fs.readdirSync(path.dirname(artifactPath(repositoryRoot, first.sha256))).filter((entry) => entry.endsWith(".json")).length, 1);
});

test("RIA rejects a coordinated valid baseline-index replacement against its independent first-minted pin", (context) => {
  const firstRepositoryRoot = temporaryRepository(context);
  const secondRepositoryRoot = temporaryRepository(context);
  const baseline = baselineRef();
  const write = (repositoryRoot, generatedAt) => writer().writeEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => snapshotWithGeneratedAt(generatedAt),
  });

  const first = write(firstRepositoryRoot, "2026-08-10T00:00:00.000Z");
  const substituted = write(secondRepositoryRoot, "2026-08-10T00:01:00.000Z");
  assert.notEqual(substituted.sha256, first.sha256, "different generated_at values create distinct valid artifacts");

  fs.copyFileSync(
    artifactPath(secondRepositoryRoot, substituted.sha256),
    artifactPath(firstRepositoryRoot, substituted.sha256),
  );
  const indexPath = baselineIndexPath(firstRepositoryRoot);
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  index.engineering_intelligence_ref = substituted;
  index.first_minted_artifact_id = substituted.artifact_id;
  index.first_minted_sha256 = substituted.sha256;
  fs.writeFileSync(indexPath, canonicalBytes(index));

  let computeCalls = 0;
  assert.throws(
    () => writer().writeEngineeringIntelligenceArtifact({
      repository_root: firstRepositoryRoot,
      baseline_ref: baseline,
      mission_id: "mission-m7-test",
      scope_hash: SCOPE_HASH,
      compute_snapshot: () => {
        computeCalls += 1;
        return snapshotWithGeneratedAt("2026-08-10T00:02:00.000Z");
      },
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-PIN-INDEX-MISMATCH/,
  );
  assert.equal(computeCalls, 0, "a valid-but-substituted index must fail before compute");
});

test("RIA fails closed without recomputing when an established baseline pin is missing", (context) => {
  const repositoryRoot = temporaryRepository(context);
  const baseline = baselineRef();
  writer().writeEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => snapshotFor(),
  });
  fs.unlinkSync(baselinePinPath(repositoryRoot));

  let computeCalls = 0;
  assert.throws(
    () => writer().writeEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      baseline_ref: baseline,
      mission_id: "mission-m7-test",
      scope_hash: SCOPE_HASH,
      compute_snapshot: () => {
        computeCalls += 1;
        return snapshotFor();
      },
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-PIN-INDEX-INCOMPLETE/,
  );
  assert.equal(computeCalls, 0);
});

test("RIA fails closed without recomputing when an established baseline pin is corrupt", (context) => {
  const repositoryRoot = temporaryRepository(context);
  const baseline = baselineRef();
  writer().writeEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => snapshotFor(),
  });
  fs.writeFileSync(baselinePinPath(repositoryRoot), "{\"corrupt\":true}\n", "utf8");

  let computeCalls = 0;
  assert.throws(
    () => writer().writeEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      baseline_ref: baseline,
      mission_id: "mission-m7-test",
      scope_hash: SCOPE_HASH,
      compute_snapshot: () => {
        computeCalls += 1;
        return snapshotFor();
      },
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-PIN-SCHEMA/,
  );
  assert.equal(computeCalls, 0);
});

test("RIA fails closed without recomputing when an established baseline index is corrupt or mismatched", (context) => {
  const repositoryRoot = temporaryRepository(context);
  const baseline = baselineRef();
  const write = () => writer().writeEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => snapshotFor(),
  });
  write();
  const indexPath = baselineIndexPath(repositoryRoot);
  fs.writeFileSync(indexPath, "{\"corrupt\":true}\n", "utf8");
  let corruptComputeCalls = 0;
  assert.throws(
    () => writer().writeEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      baseline_ref: baseline,
      mission_id: "mission-m7-test",
      scope_hash: SCOPE_HASH,
      compute_snapshot: () => {
        corruptComputeCalls += 1;
        return snapshotFor();
      },
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-INDEX-/,
  );
  assert.equal(corruptComputeCalls, 0);

  const mismatchRoot = temporaryRepository(context);
  writer().writeEngineeringIntelligenceArtifact({
    repository_root: mismatchRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => snapshotFor(),
  });
  const mismatchPath = baselineIndexPath(mismatchRoot);
  const mismatched = JSON.parse(fs.readFileSync(mismatchPath, "utf8"));
  mismatched.repository_revision = "f".repeat(40);
  fs.writeFileSync(mismatchPath, canonicalBytes(mismatched));
  let mismatchComputeCalls = 0;
  assert.throws(
    () => writer().writeEngineeringIntelligenceArtifact({
      repository_root: mismatchRoot,
      baseline_ref: baseline,
      mission_id: "mission-m7-test",
      scope_hash: SCOPE_HASH,
      compute_snapshot: () => {
        mismatchComputeCalls += 1;
        return snapshotFor();
      },
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-INDEX-BINDING-MISMATCH/,
  );
  assert.equal(mismatchComputeCalls, 0);
});

test("RIA revalidates the indexed artifact before reuse and never recomputes a corrupted binding", (context) => {
  const repositoryRoot = temporaryRepository(context);
  const baseline = baselineRef();
  const ref = writer().writeEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => snapshotFor(),
  });
  fs.writeFileSync(artifactPath(repositoryRoot, ref.sha256), "{\"corrupt\":true}\n", "utf8");

  let computeCalls = 0;
  assert.throws(
    () => writer().writeEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      baseline_ref: baseline,
      mission_id: "mission-m7-test",
      scope_hash: SCOPE_HASH,
      compute_snapshot: () => {
        computeCalls += 1;
        return snapshotFor();
      },
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-HASH-MISMATCH/,
  );
  assert.equal(computeCalls, 0);
});

test("RIA rejects ref paths, aliases, stale bindings, and cross-baseline evidence before resolving storage", (context) => {
  const repositoryRoot = temporaryRepository(context);
  const firstBaseline = baselineRef();
  const ref = writer().writeEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    baseline_ref: firstBaseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => snapshotFor(),
  });

  assert.throws(
    () => reader().readEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      engineering_intelligence_ref: { ...ref, path: "../../outside.json" },
      expected: expectedBinding(firstBaseline),
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-REF-SCHEMA/,
  );
  assert.throws(
    () => reader().readEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      engineering_intelligence_ref: { ...ref, payload: {} },
      expected: expectedBinding(firstBaseline),
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-REF-SCHEMA/,
  );
  for (const forbidden of [
    "health",
    "candidate",
    "score",
    "recommendation",
    "graph",
    "lifecycle",
    "verification",
    "publish",
    "snapshot",
    "engineering_intelligence",
  ]) {
    assert.throws(
      () => reader().readEngineeringIntelligenceArtifact({
        repository_root: repositoryRoot,
        engineering_intelligence_ref: { ...ref, [forbidden]: {} },
        expected: expectedBinding(firstBaseline),
      }),
      /FAIL-ENGINEERING-INTELLIGENCE-REF-SCHEMA/,
      `${forbidden} must not become an evidence-ref alias or authority field`,
    );
  }
  assert.throws(
    () => reader().readEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      engineering_intelligence_ref: ref,
      expected: expectedBinding(baselineRef({ artifactId: "baseline:assessment-2", sha256: "c".repeat(64) })),
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-BINDING-MISMATCH/,
  );
  assert.throws(
    () => reader().readEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      engineering_intelligence_ref: ref,
      expected: expectedBinding(baselineRef({
        artifactId: "baseline:stale-revision",
        sha256: "d".repeat(64),
        repositoryRevision: "f".repeat(40),
      })),
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-BINDING-MISMATCH/,
  );
});

test("RIA reader rehashes bytes and rejects a closed-artifact authority injection", (context) => {
  const repositoryRoot = temporaryRepository(context);
  const baseline = baselineRef();
  const ref = writer().writeEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => snapshotFor(),
  });
  const storedPath = artifactPath(repositoryRoot, ref.sha256);
  const originalBytes = fs.readFileSync(storedPath);

  fs.writeFileSync(storedPath, "{\"tampered\":true}\n", "utf8");
  assert.throws(
    () => reader().readEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      engineering_intelligence_ref: ref,
      expected: expectedBinding(baseline),
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-HASH-MISMATCH/,
  );

  const injected = {
    schema_version: "1.0.0",
    owner: "repository-improvement-assessment",
    kind: "engineering-intelligence",
    repository_revision: REVISION,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    baseline_binding: baseline,
    engineering_intelligence: snapshotFor(),
    health_grade: "A",
  };
  const injectedBytes = canonicalBytes(injected);
  const injectedHash = crypto.createHash("sha256").update(injectedBytes).digest("hex");
  fs.writeFileSync(artifactPath(repositoryRoot, injectedHash), injectedBytes);
  const injectedRef = {
    ...ref,
    artifact_id: `engineering-intelligence:${injectedHash}`,
    sha256: injectedHash,
  };
  assert.throws(
    () => reader().readEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      engineering_intelligence_ref: injectedRef,
      expected: expectedBinding(baseline),
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-SCHEMA/,
  );

  const nonCanonicalArtifact = JSON.parse(originalBytes.toString("utf8"));
  const nonCanonicalBytes = Buffer.from(`${JSON.stringify(nonCanonicalArtifact, null, 2)}\n`, "utf8");
  const nonCanonicalHash = crypto.createHash("sha256").update(nonCanonicalBytes).digest("hex");
  fs.writeFileSync(artifactPath(repositoryRoot, nonCanonicalHash), nonCanonicalBytes);
  assert.throws(
    () => reader().readEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      engineering_intelligence_ref: {
        ...ref,
        artifact_id: `engineering-intelligence:${nonCanonicalHash}`,
        sha256: nonCanonicalHash,
      },
      expected: expectedBinding(baseline),
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-ARTIFACT-CANONICAL/,
  );
});

test("RIA writer fails closed if the indexed content-addressed artifact has different bytes", (context) => {
  const repositoryRoot = temporaryRepository(context);
  const baseline = baselineRef();
  const ref = writer().writeEngineeringIntelligenceArtifact({
    repository_root: repositoryRoot,
    baseline_ref: baseline,
    mission_id: "mission-m7-test",
    scope_hash: SCOPE_HASH,
    compute_snapshot: () => snapshotFor(),
  });
  fs.writeFileSync(artifactPath(repositoryRoot, ref.sha256), "not the original immutable artifact\n", "utf8");

  assert.throws(
    () => writer().writeEngineeringIntelligenceArtifact({
      repository_root: repositoryRoot,
      baseline_ref: baseline,
      mission_id: "mission-m7-test",
      scope_hash: SCOPE_HASH,
      compute_snapshot: () => snapshotFor(),
    }),
    /FAIL-ENGINEERING-INTELLIGENCE-HASH-MISMATCH/,
  );
});
