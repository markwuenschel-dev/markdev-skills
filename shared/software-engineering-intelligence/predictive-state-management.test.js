"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const stateManagement = require("./predictive-state-management.js");
const privateApi = stateManagement[Symbol.for("sei.predictive-state-management.private.v1")];
const { parseArguments } = require("./cli.js");
const artifactStore = require("./predictive-artifact-store.js");
const artifactPrivate = artifactStore[Symbol.for("sei.predictive-artifact-store.private.v1")];
const statePrivate = require("./incremental-run-state.js")[Symbol.for("sei.incremental-run-state.private.v2")];
const nativePrivate = require("./predictive-native-fs.js")[Symbol.for("sei.predictive-native-fs.private.v1")];

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function lineage(overrides = {}) {
  return {
    repository_lineage_id: "lineage:state-fixture",
    root_history_digest: digest("state-root-history"),
    remote_urls: [],
    ...overrides,
  };
}

function binding(revision) {
  return {
    repository_lineage_id: "lineage:state-fixture",
    revision_id: revision,
    evidence_snapshot_digest: digest(`snapshot:${revision}`),
    bound_artifact_digests: { history: digest(`history:${revision}`) },
    sei_version: "9.0.0",
    feature_schema_version: "features@1",
    target_schema_version: "targets@1",
    candidate_registry_version: "registry@1",
    evaluation_protocol_version: "protocol@1",
    predictive_config_digest: digest("predictive-config"),
  };
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  }).sort();
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-state-management-"));
  const stateRoot = path.join(root, "state");
  const repositoryId = "repo:state-fixture";
  const lease = await statePrivate.openStateWriter({
    output_root: path.join(root, "out"),
    state_root: stateRoot,
    repository_id: repositoryId,
  });
  const store = artifactPrivate.openPredictiveArtifactStore({
    stateRoot,
    repositoryBinding: { repository_id: repositoryId },
    lineage: lineage(),
    lease,
  });
  t.after(async () => {
    await lease.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, stateRoot, repositoryId, lease, store };
}

async function publishThree(fixtureValue, pinned = false) {
  const publications = [];
  const pinBytes = "first derived state\n";
  for (const [index, bytes] of [
    ["a", pinBytes],
    ["b", "second derived state\n"],
    ["c", "third derived state\n"],
  ]) {
    const currentBinding = binding(index.repeat(40));
    const key = artifactPrivate.buildPredictiveArtifactKey(currentBinding);
    const objects = [{ label: "promotion", bytes }];
    const reportPins = index === "a" && pinned
      ? [{ report_digest: digest("live-report"), object_digests: [digest(Buffer.from(bytes, "utf8"))] }]
      : [];
    publications.push(fixtureValue.store.publishPromotion({ key, binding: currentBinding, objects, reportPins }));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return publications;
}

test("predictive state management remains private and exposes only bounded operations", () => {
  assert.deepEqual(Object.keys(stateManagement), []);
  assert.deepEqual(Object.keys(privateApi).sort(), [
    "buildPurgeConfirmationToken",
    "inspectPredictiveState",
    "purgePredictiveState",
  ]);
});

test("CLI exposes only the closed inspect/purge state surface", () => {
  const inspect = parseArguments([
    "--repo", "repo",
    "--out", "out",
    "--predictive-state", "inspect",
    "--predictive-state-lineage", "lineage.json",
  ]);
  assert.equal(inspect.predictiveState, "inspect");
  assert.equal(inspect.predictiveStateScope, null);
  assert.throws(
    () => parseArguments(["--repo", "repo", "--out", "out", "--predictive-state", "inspect"]),
    /FAIL-CLI-ARGUMENTS.*lineage/,
  );
  assert.throws(
    () => parseArguments([
      "--repo", "repo", "--out", "out", "--predictive-state", "purge",
      "--predictive-state-lineage", "lineage.json", "--predictive-state-scope", "scope.json",
    ]),
    /FAIL-CLI-ARGUMENTS.*confirm/,
  );
  assert.throws(
    () => parseArguments([
      "--repo", "repo", "--out", "out", "--predictive-state", "inspect",
      "--predictive-state-lineage", "lineage.json", "--predictive-state-scope", "scope.json",
    ]),
    /FAIL-CLI-ARGUMENTS.*purge-only/,
  );
});

test("inspection of an absent root or absent namespace performs no writer acquisition or directory creation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-state-empty-"));
  const stateRoot = path.join(root, "missing-state");
  const input = {
    stateRoot,
    repositoryId: "repo:empty-state",
    lineage: lineage(),
    lease: null,
    reportPins: [],
  };
  const absentRoot = privateApi.inspectPredictiveState(input);
  assert.equal(absentRoot.inspection.manifest_count, 0);
  assert.equal(absentRoot.inspection.object_count, 0);
  assert.equal(fs.existsSync(stateRoot), false);
  fs.mkdirSync(stateRoot);
  const absentNamespace = privateApi.inspectPredictiveState(input);
  assert.equal(absentNamespace.inspection.manifest_count, 0);
  assert.equal(absentNamespace.inspection.object_count, 0);
  assert.deepEqual(absentNamespace.purge_scope, absentRoot.purge_scope);
  fs.rmSync(root, { recursive: true, force: true });
});

test("inspection is read-only, bounded, and never returns raw state paths", async (t) => {
  const fixtureValue = await fixture(t);
  await publishThree(fixtureValue);
  const before = listFiles(fixtureValue.stateRoot).map((file) => [file, fs.statSync(file).size]);
  const result = privateApi.inspectPredictiveState({
    stateRoot: fixtureValue.stateRoot,
    repositoryId: fixtureValue.repositoryId,
    lineage: lineage(),
    lease: fixtureValue.lease,
    reportPins: [],
  });
  const after = listFiles(fixtureValue.stateRoot).map((file) => [file, fs.statSync(file).size]);
  assert.deepEqual(after, before);
  assert.equal(result.schema_version, "sei.predictive-state-inspection@1");
  assert.equal(result.inspection.manifest_count, 3);
  assert.equal(result.inspection.object_count, 3);
  assert.match(result.confirmation_token, /^confirm:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /stateRoot|state_root|[A-Za-z]:\\|\/tmp\//i);
  assert.ok(result.purge_scope.purge_object_digests.length > 0);
  assert.equal(result.purge_plan.dry_run, true);
});

test("unconfirmed purge and wrong-lineage purge fail without deleting anything", async (t) => {
  const fixtureValue = await fixture(t);
  await publishThree(fixtureValue);
  const before = listFiles(fixtureValue.stateRoot);
  const inspection = privateApi.inspectPredictiveState({
    stateRoot: fixtureValue.stateRoot,
    repositoryId: fixtureValue.repositoryId,
    lineage: lineage(),
    lease: fixtureValue.lease,
    reportPins: [],
  });
  assert.throws(
    () => privateApi.purgePredictiveState({
      stateRoot: fixtureValue.stateRoot,
      repositoryId: fixtureValue.repositoryId,
      lineage: lineage(),
      lease: fixtureValue.lease,
      reportPins: [],
      purgeScope: inspection.purge_scope,
    }),
    /FAIL-PREDICTIVE-CONFIRMATION/,
  );
  assert.throws(
    () => privateApi.purgePredictiveState({
      stateRoot: fixtureValue.stateRoot,
      repositoryId: fixtureValue.repositoryId,
      lineage: lineage({ repository_lineage_id: "lineage:other" }),
      lease: fixtureValue.lease,
      reportPins: [],
      purgeScope: inspection.purge_scope,
      confirmationToken: inspection.confirmation_token,
    }),
    /FAIL-PREDICTIVE-LINEAGE|FAIL-PREDICTIVE-BINDING/,
  );
  assert.deepEqual(listFiles(fixtureValue.stateRoot), before);
});

test("purge deletes only explicitly unreachable objects and keeps latest manifests", async (t) => {
  const fixtureValue = await fixture(t);
  await publishThree(fixtureValue);
  const inspection = privateApi.inspectPredictiveState({
    stateRoot: fixtureValue.stateRoot,
    repositoryId: fixtureValue.repositoryId,
    lineage: lineage(),
    lease: fixtureValue.lease,
    reportPins: [],
  });
  const result = privateApi.purgePredictiveState({
    stateRoot: fixtureValue.stateRoot,
    repositoryId: fixtureValue.repositoryId,
    lineage: lineage(),
    lease: fixtureValue.lease,
    reportPins: [],
    purgeScope: inspection.purge_scope,
    confirmationToken: inspection.confirmation_token,
  });
  assert.deepEqual(result.deleted.manifest_keys, inspection.purge_scope.purge_manifest_keys);
  assert.deepEqual(result.deleted.object_digests, inspection.purge_scope.purge_object_digests);
  assert.equal(result.remaining.manifest_count, 2);
  assert.equal(result.remaining.object_count, 2);
  const remaining = privateApi.inspectPredictiveState({
    stateRoot: fixtureValue.stateRoot,
    repositoryId: fixtureValue.repositoryId,
    lineage: lineage(),
    lease: fixtureValue.lease,
    reportPins: [],
  });
  assert.deepEqual(remaining.purge_scope.purge_manifest_keys, []);
  assert.deepEqual(remaining.purge_scope.purge_object_digests, []);
});

test("pinned reachability is preserved and cannot be purged by a stale scope", async (t) => {
  const fixtureValue = await fixture(t);
  const publications = await publishThree(fixtureValue, true);
  const livePin = { report_digest: digest("live-report"), object_digests: [digest(Buffer.from("first derived state\n", "utf8"))] };
  const inspection = privateApi.inspectPredictiveState({
    stateRoot: fixtureValue.stateRoot,
    repositoryId: fixtureValue.repositoryId,
    lineage: lineage(),
    lease: fixtureValue.lease,
    reportPins: [livePin],
  });
  assert.equal(inspection.purge_scope.purge_manifest_keys.length, 0);
  assert.equal(inspection.purge_scope.purge_object_digests.length, 0);
  assert.deepEqual(publications[0].report_pins, [livePin]);
  const staleScope = { ...inspection.purge_scope, purge_object_digests: [publications[0].objects[0].digest] };
  assert.throws(
    () => privateApi.purgePredictiveState({
      stateRoot: fixtureValue.stateRoot,
      repositoryId: fixtureValue.repositoryId,
      lineage: lineage(),
      lease: fixtureValue.lease,
      reportPins: [livePin],
      purgeScope: staleScope,
      confirmationToken: inspection.confirmation_token,
    }),
    /FAIL-PREDICTIVE-PURGE|FAIL-PREDICTIVE-CONFIRMATION/,
  );
});

test("alias, corrupt manifest, and cancellation fail closed", async (t) => {
  const fixtureValue = await fixture(t);
  await publishThree(fixtureValue);
  const inspection = privateApi.inspectPredictiveState({
    stateRoot: fixtureValue.stateRoot,
    repositoryId: fixtureValue.repositoryId,
    lineage: lineage(),
    lease: fixtureValue.lease,
    reportPins: [],
  });
  const objectFile = listFiles(fixtureValue.stateRoot).find((file) => file.endsWith(".object"));
  assert.ok(objectFile);
  const alias = path.join(path.dirname(objectFile), "f".repeat(64) + ".object");
  fs.copyFileSync(objectFile, alias);
  assert.throws(
    () => privateApi.purgePredictiveState({
      stateRoot: fixtureValue.stateRoot,
      repositoryId: fixtureValue.repositoryId,
      lineage: lineage(),
      lease: fixtureValue.lease,
      reportPins: [],
      purgeScope: inspection.purge_scope,
      confirmationToken: inspection.confirmation_token,
    }),
    /FAIL-PREDICTIVE-RETENTION|FAIL-PREDICTIVE-OBJECT/,
  );
  fs.unlinkSync(alias);
  const manifestFile = listFiles(fixtureValue.stateRoot).find((file) => file.endsWith(".json"));
  fs.appendFileSync(manifestFile, "corrupt");
  assert.throws(
    () => privateApi.inspectPredictiveState({
      stateRoot: fixtureValue.stateRoot,
      repositoryId: fixtureValue.repositoryId,
      lineage: lineage(),
      lease: fixtureValue.lease,
      reportPins: [],
    }),
    /FAIL-PREDICTIVE-MANIFEST/,
  );
  const controller = new AbortController();
  const reason = new Error("owner cancelled state operation");
  controller.abort(reason);
  assert.throws(
    () => privateApi.inspectPredictiveState({
      stateRoot: fixtureValue.stateRoot,
      repositoryId: fixtureValue.repositoryId,
      lineage: lineage(),
      lease: fixtureValue.lease,
      reportPins: [],
      signal: controller.signal,
    }),
    (error) => error?.code === "FAIL-PREDICTIVE-RETENTION" && error.cause === reason,
  );
});

test("inspection rejects manifest and object namespaces that exceed aggregate bounds", async (t) => {
  for (const suffix of [".json", ".object"]) {
    const fixtureValue = await fixture(t);
    await publishThree(fixtureValue);
    const source = listFiles(fixtureValue.stateRoot).find((file) => file.endsWith(suffix));
    assert.ok(source);
    const directory = path.dirname(source);
    const limit = suffix === ".json" ? 129 : 257;
    for (let index = 0; index < limit; index += 1) {
      const name = `${index.toString(16).padStart(64, "0")}${suffix}`;
      const target = path.join(directory, name);
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    }
    assert.throws(
      () => privateApi.inspectPredictiveState({
        stateRoot: fixtureValue.stateRoot,
        repositoryId: fixtureValue.repositoryId,
        lineage: lineage(),
        lease: fixtureValue.lease,
        reportPins: [],
      }),
      /FAIL-PREDICTIVE-RETENTION.*bound/,
    );
  }
});

test("native read-only inspection opens existing paths without creation and bounds enumeration", { skip: nativePrivate.helperIdentity === null }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-native-read-only-"));
  const missingRoot = path.join(root, "missing-root");
  assert.equal(typeof nativePrivate.openRootReadOnly, "function");
  assert.equal(nativePrivate.openRootReadOnly(missingRoot), null);
  assert.equal(fs.existsSync(missingRoot), false);

  const capability = nativePrivate.openRootReadOnly(root);
  assert.ok(capability);
  assert.equal(capability.openDirectoryReadOnly(["missing-child"]), null);
  assert.equal(fs.existsSync(path.join(root, "missing-child")), false);

  const bounded = path.join(root, "bounded");
  fs.mkdirSync(bounded);
  fs.writeFileSync(path.join(bounded, "one"), "one");
  fs.writeFileSync(path.join(bounded, "two"), "two");
  const boundedCapability = capability.openDirectoryReadOnly(["bounded"]);
  assert.ok(boundedCapability);
  assert.throws(
    () => boundedCapability.listDirectoryBounded(1),
    /ENUMERATION_LIMIT|bound/i,
  );
  assert.equal(boundedCapability.listDirectoryBounded(2).length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});
