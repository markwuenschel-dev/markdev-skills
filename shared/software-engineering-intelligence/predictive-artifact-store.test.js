"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const artifactStore = require("./predictive-artifact-store.js");
const privateApi = artifactStore[Symbol.for("sei.predictive-artifact-store.private.v1")];
const statePrivate = require("./incremental-run-state.js")[Symbol.for("sei.incremental-run-state.private.v2")];
const nativePrivate = require("./predictive-native-fs.js")[Symbol.for("sei.predictive-native-fs.private.v1")];

function keyFields(overrides = {}) {
  return {
    repository_lineage_id: "lineage:fixture",
    revision_id: "a".repeat(40),
    evidence_snapshot_digest: `sha256:${"1".repeat(64)}`,
    bound_artifact_digests: {
      history: `sha256:${"2".repeat(64)}`,
      snapshot: `sha256:${"3".repeat(64)}`,
    },
    sei_version: "9.0.0",
    feature_schema_version: "features@1",
    target_schema_version: "targets@1",
    candidate_registry_version: "registry@1",
    evaluation_protocol_version: "protocol@1",
    predictive_config_digest: `sha256:${"4".repeat(64)}`,
    ...overrides,
  };
}

function lineage(overrides = {}) {
  return {
    repository_lineage_id: "lineage:fixture",
    root_history_digest: `sha256:${"8".repeat(64)}`,
    remote_urls: ["https://example.invalid/repository.git"],
    ...overrides,
  };
}

function rawDigest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function helperNamespaceKey() {
  return rawDigest(JSON.stringify(canonicalValue(nativePrivate.helperIdentity))).slice("sha256:".length);
}

function filesBelow(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  });
}

function lineageDirectory(stateRoot, repositoryId, lineageId = "lineage:fixture") {
  return path.join(
    stateRoot,
    "predictive-artifacts-v1",
    "helpers",
    helperNamespaceKey(),
    "repositories",
    rawDigest(repositoryId).slice("sha256:".length),
    "lineages",
    rawDigest(lineageId).slice("sha256:".length),
  );
}

test("predictive artifact storage is available only through its private seam", () => {
  assert.deepEqual(Object.keys(artifactStore), []);
  assert.equal(typeof privateApi, "object");
  assert.deepEqual(Object.keys(privateApi).sort(), [
    "PREDICTIVE_ARTIFACT_STORE_VERSION",
    "buildPredictiveArtifactKey",
    "classifyRepositoryLineage",
    "openPredictiveArtifactStore",
  ]);
});

test("predictive artifact keys cover every closed semantic field", () => {
  assert.equal(
    privateApi.buildPredictiveArtifactKey(keyFields()),
    "sha256:2fe5deefd7a498ba68a2b1adaf39e632eac7206c333967f7f2f3a4681a3a9edd",
  );
  for (const [field, value] of Object.entries({
    repository_lineage_id: "lineage:other",
    revision_id: "b".repeat(40),
    evidence_snapshot_digest: `sha256:${"5".repeat(64)}`,
    bound_artifact_digests: { history: `sha256:${"6".repeat(64)}` },
    sei_version: "9.0.1",
    feature_schema_version: "features@2",
    target_schema_version: "targets@2",
    candidate_registry_version: "registry@2",
    evaluation_protocol_version: "protocol@2",
    predictive_config_digest: `sha256:${"7".repeat(64)}`,
  })) {
    assert.notEqual(privateApi.buildPredictiveArtifactKey(keyFields({ [field]: value })), privateApi.buildPredictiveArtifactKey(keyFields()), field);
  }
  assert.throws(
    () => privateApi.buildPredictiveArtifactKey({ ...keyFields(), remote_url: "https://example.invalid/repo" }),
    /FAIL-PREDICTIVE-ARTIFACT-KEY.*closed/,
  );
});

test("repository lineage is conservative and remote URLs remain metadata", () => {
  assert.equal(
    privateApi.classifyRepositoryLineage(lineage(), lineage({ remote_urls: ["ssh://moved.invalid/repository.git"] })),
    "SAME_LINEAGE",
  );
  assert.equal(
    privateApi.classifyRepositoryLineage(lineage(), lineage({ repository_lineage_id: "lineage:fork" })),
    "RELATED_LINEAGE",
  );
  assert.equal(
    privateApi.classifyRepositoryLineage(
      lineage(),
      lineage({ repository_lineage_id: "lineage:unknown", root_history_digest: `sha256:${"9".repeat(64)}` }),
    ),
    "UNKNOWN_LINEAGE",
  );
  assert.equal(
    privateApi.classifyRepositoryLineage(
      lineage(),
      lineage({ repository_lineage_id: "lineage:rewritten", root_history_digest: `sha256:${"8".repeat(64)}`, remote_urls: [] }),
    ),
    "RELATED_LINEAGE",
  );
  assert.throws(
    () => privateApi.classifyRepositoryLineage(lineage(), { ...lineage(), checkout_path: "C:/moved" }),
    /FAIL-PREDICTIVE-LINEAGE.*closed/,
  );
});

test("promotion objects publish immutably and a moved checkout reads the same exact hit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-store-"));
  const stateRoot = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstLease = await statePrivate.openStateWriter({
    output_root: path.join(root, "checkout-one", "out"),
    state_root: stateRoot,
    repository_id: "repo:fixture",
  });
  const firstStore = privateApi.openPredictiveArtifactStore({
    stateRoot,
    repositoryBinding: { repository_id: "repo:fixture" },
    lineage: lineage(),
    lease: firstLease,
  });
  const binding = keyFields();
  const key = privateApi.buildPredictiveArtifactKey(binding);
  const published = firstStore.publishPromotion({
    key,
    binding,
    objects: [{ label: "promotion", bytes: "{\"state\":\"VALIDATED_BASELINE\"}\n" }],
    reportPins: [],
  });
  assert.equal(published.key, key);
  assert.deepEqual(published.filesystem_helper, nativePrivate.helperIdentity);
  const expectedLineageDirectory = lineageDirectory(stateRoot, "repo:fixture");
  // The state root is shared: incremental-run-state owns <stateRoot>/locks/*.lock writer leases
  // (incremental-run-state.js:1210-1231), and this test's own openStateWriter setup creates them.
  // Every file the store writes must still live under its lineage directory.
  const leaseLockDirectory = path.join(stateRoot, "locks");
  assert.equal(
    filesBelow(stateRoot).every((file) => (
      file.startsWith(`${expectedLineageDirectory}${path.sep}`)
      || (file.startsWith(`${leaseLockDirectory}${path.sep}`) && file.endsWith(".lock"))
    )),
    true,
  );
  const firstHit = firstStore.readPromotion({ key, expectedBinding: binding });
  assert.equal(firstHit.objects[0].bytes, "{\"state\":\"VALIDATED_BASELINE\"}\n");
  await firstLease.close();

  const movedLease = await statePrivate.openStateWriter({
    output_root: path.join(root, "moved-checkout", "nested", "out"),
    state_root: stateRoot,
    repository_id: "repo:fixture",
  });
  const movedStore = privateApi.openPredictiveArtifactStore({
    stateRoot,
    repositoryBinding: { repository_id: "repo:fixture" },
    lineage: lineage({ remote_urls: ["ssh://new-host.invalid/repository.git"] }),
    lease: movedLease,
  });
  const movedHit = movedStore.readPromotion({ key, expectedBinding: binding });
  assert.equal(movedHit.manifest.manifest_sha256, published.manifest_sha256);
  await movedLease.close();
});

test("retention keeps the latest two manifests plus live report pins and plans purge without deleting", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-retention-"));
  const stateRoot = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = await statePrivate.openStateWriter({ output_root: path.join(root, "out"), state_root: stateRoot, repository_id: "repo:fixture" });
  const store = privateApi.openPredictiveArtifactStore({
    stateRoot,
    repositoryBinding: { repository_id: "repo:fixture" },
    lineage: lineage(),
    lease,
  });
  const firstBytes = "first promotion\n";
  const livePin = { report_digest: `sha256:${"d".repeat(64)}`, object_digests: [rawDigest(firstBytes)] };
  const publications = [];
  for (const [revision, bytes, pins] of [
    ["a".repeat(40), firstBytes, [livePin]],
    ["b".repeat(40), "second promotion\n", []],
    ["c".repeat(40), "third promotion\n", []],
  ]) {
    const binding = keyFields({ revision_id: revision });
    const key = privateApi.buildPredictiveArtifactKey(binding);
    publications.push(store.publishPromotion({ key, binding, objects: [{ label: "promotion", bytes }], reportPins: pins }));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const inspection = store.inspect({ lineageId: "lineage:fixture" });
  assert.equal(inspection.manifest_count, 3);
  assert.equal(inspection.object_count, 3);
  const stalePlan = store.planPurge({
    lineageId: "lineage:fixture",
    reportPins: [{ ...livePin, object_digests: [`sha256:${"e".repeat(64)}`] }],
  });
  assert.equal(stalePlan.dry_run, true);
  assert.deepEqual(stalePlan.purge_manifest_keys, [publications[0].key]);
  assert.deepEqual(stalePlan.purge_object_digests, [publications[0].objects[0].digest]);
  assert.equal(fs.existsSync(stateRoot), true);

  const pinnedPlan = store.planPurge({ lineageId: "lineage:fixture", reportPins: [livePin] });
  assert.deepEqual(pinnedPlan.purge_manifest_keys, []);
  assert.deepEqual(pinnedPlan.purge_object_digests, []);
  await lease.close();
});

test("changed semantic keys miss while related and unknown lineage requests fail closed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-key-lineage-"));
  const stateRoot = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = await statePrivate.openStateWriter({ output_root: path.join(root, "out"), state_root: stateRoot, repository_id: "repo:fixture" });
  const store = privateApi.openPredictiveArtifactStore({ stateRoot, repositoryBinding: { repository_id: "repo:fixture" }, lineage: lineage(), lease });
  const original = keyFields();
  const originalKey = privateApi.buildPredictiveArtifactKey(original);
  store.publishPromotion({ key: originalKey, binding: original, objects: [{ label: "promotion", bytes: "promotion\n" }], reportPins: [] });

  const changed = keyFields({ target_schema_version: "targets@2" });
  assert.equal(store.readPromotion({ key: privateApi.buildPredictiveArtifactKey(changed), expectedBinding: changed }), null);
  for (const repositoryLineageId of ["lineage:related", "lineage:unknown"]) {
    const foreign = keyFields({ repository_lineage_id: repositoryLineageId });
    assert.throws(
      () => store.readPromotion({ key: privateApi.buildPredictiveArtifactKey(foreign), expectedBinding: foreign }),
      /FAIL-PREDICTIVE-LINEAGE/,
    );
  }
  await lease.close();
  assert.throws(
    () => privateApi.openPredictiveArtifactStore({
      stateRoot,
      repositoryBinding: { repository_id: "repo:fixture" },
      lineage: lineage(),
      lease,
    }),
    (error) => error?.code === "FAIL-PREDICTIVE-BINDING" && /closed/.test(error.cause?.message ?? error.message),
  );
});

test("forged, deleted, symlinked, and hard-linked bound objects never produce a cache hit", async (t) => {
  async function corruptedObject(kind) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sei-predictive-${kind}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateRoot = path.join(root, "state");
    const lease = await statePrivate.openStateWriter({ output_root: path.join(root, "out"), state_root: stateRoot, repository_id: `repo:${kind}` });
    const store = privateApi.openPredictiveArtifactStore({ stateRoot, repositoryBinding: { repository_id: `repo:${kind}` }, lineage: lineage(), lease });
    const binding = keyFields();
    const key = privateApi.buildPredictiveArtifactKey(binding);
    store.publishPromotion({ key, binding, objects: [{ label: "promotion", bytes: "trusted promotion\n" }], reportPins: [] });
    const objectFile = filesBelow(stateRoot).find((file) => file.endsWith(".object"));
    assert.ok(objectFile);
    if (kind === "forged") fs.writeFileSync(objectFile, "forged promotion\n", "utf8");
    if (kind === "deleted") fs.unlinkSync(objectFile);
    if (kind === "hardlink") {
      const alias = path.join(root, "alias.object");
      fs.linkSync(objectFile, alias);
    }
    if (kind === "symlink") {
      const target = path.join(root, "target.object");
      fs.copyFileSync(objectFile, target);
      fs.unlinkSync(objectFile);
      fs.symlinkSync(target, objectFile, "file");
    }
    assert.throws(() => store.readPromotion({ key, expectedBinding: binding }), /FAIL-PREDICTIVE-OBJECT/);
    await lease.close();
  }

  for (const kind of ["forged", "deleted", "hardlink", "symlink"]) await corruptedObject(kind);
});

test("cache deletion and deterministic rebuild preserve the semantic promotion", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-rebuild-"));
  const stateRoot = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = keyFields();
  const key = privateApi.buildPredictiveArtifactKey(binding);
  const publication = { key, binding, objects: [{ label: "promotion", bytes: "stable semantic promotion\n" }], reportPins: [] };

  const firstLease = await statePrivate.openStateWriter({ output_root: path.join(root, "first"), state_root: stateRoot, repository_id: "repo:fixture" });
  const firstStore = privateApi.openPredictiveArtifactStore({ stateRoot, repositoryBinding: { repository_id: "repo:fixture" }, lineage: lineage(), lease: firstLease });
  const firstManifest = firstStore.publishPromotion(publication);
  const firstHit = firstStore.readPromotion({ key, expectedBinding: binding });
  await firstLease.close();

  fs.rmSync(stateRoot, { recursive: true, force: true });
  const secondLease = await statePrivate.openStateWriter({ output_root: path.join(root, "second"), state_root: stateRoot, repository_id: "repo:fixture" });
  const secondStore = privateApi.openPredictiveArtifactStore({ stateRoot, repositoryBinding: { repository_id: "repo:fixture" }, lineage: lineage({ remote_urls: [] }), lease: secondLease });
  const secondManifest = secondStore.publishPromotion(publication);
  const secondHit = secondStore.readPromotion({ key, expectedBinding: binding });
  assert.equal(secondManifest.manifest_sha256, firstManifest.manifest_sha256);
  assert.deepEqual(secondHit.objects, firstHit.objects);
  await secondLease.close();
});

test("publication and retention reject pre-existing aliases, symlink ancestors, forged names, and conflicts", async (t) => {
  async function fixture(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sei-predictive-preflight-${label}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateRoot = path.join(root, "state");
    const lease = await statePrivate.openStateWriter({ output_root: path.join(root, "out"), state_root: stateRoot, repository_id: `repo:${label}` });
    const store = privateApi.openPredictiveArtifactStore({ stateRoot, repositoryBinding: { repository_id: `repo:${label}` }, lineage: lineage(), lease });
    return { root, stateRoot, lease, store };
  }

  const bytes = "preflight promotion\n";
  const binding = keyFields();
  const key = privateApi.buildPredictiveArtifactKey(binding);
  const aliased = await fixture("aliased");
  const aliasedObjectDirectory = path.join(lineageDirectory(aliased.stateRoot, "repo:aliased"), "objects");
  fs.mkdirSync(aliasedObjectDirectory, { recursive: true });
  const aliasSource = path.join(aliased.root, "alias-source.object");
  fs.writeFileSync(aliasSource, bytes, "utf8");
  fs.linkSync(aliasSource, path.join(aliasedObjectDirectory, `${rawDigest(bytes).slice("sha256:".length)}.object`));
  assert.throws(
    () => aliased.store.publishPromotion({ key, binding, objects: [{ label: "promotion", bytes }], reportPins: [] }),
    /FAIL-PREDICTIVE-OBJECT/,
  );
  await aliased.lease.close();

  const redirected = await fixture("redirected");
  const repositoryRoot = path.join(
    redirected.stateRoot,
    "predictive-artifacts-v1",
    "helpers",
    helperNamespaceKey(),
    "repositories",
    rawDigest("repo:redirected").slice("sha256:".length),
  );
  const lineagesRoot = path.join(repositoryRoot, "lineages");
  const outside = path.join(redirected.root, "outside");
  fs.mkdirSync(path.join(outside, "objects"), { recursive: true });
  fs.mkdirSync(path.join(outside, "manifests"), { recursive: true });
  fs.mkdirSync(lineagesRoot, { recursive: true });
  fs.symlinkSync(outside, path.join(lineagesRoot, rawDigest("lineage:fixture").slice("sha256:".length)), process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => redirected.store.publishPromotion({ key, binding, objects: [{ label: "promotion", bytes }], reportPins: [] }),
    /FAIL-PREDICTIVE-OBJECT/,
  );
  assert.deepEqual(fs.readdirSync(path.join(outside, "objects")), []);
  await redirected.lease.close();

  const forged = await fixture("forged-name");
  const published = forged.store.publishPromotion({ key, binding, objects: [{ label: "promotion", bytes }], reportPins: [] });
  const canonicalManifest = filesBelow(forged.stateRoot).find((file) => file.endsWith(".json"));
  const forgedManifest = path.join(path.dirname(canonicalManifest), `${"f".repeat(64)}.json`);
  fs.copyFileSync(canonicalManifest, forgedManifest);
  assert.throws(() => forged.store.inspect({ lineageId: "lineage:fixture" }), /FAIL-PREDICTIVE-MANIFEST/);
  fs.unlinkSync(forgedManifest);
  assert.throws(
    () => forged.store.publishPromotion({
      key,
      binding,
      objects: [{ label: "promotion", bytes }],
      reportPins: [{ report_digest: `sha256:${"f".repeat(64)}`, object_digests: [published.objects[0].digest] }],
    }),
    /FAIL-PREDICTIVE-MANIFEST/,
  );
  await forged.lease.close();
});

test("writer opening rejects a state root or ancestor that is a symlink or junction", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-physical-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const kind of ["root", "ancestor"]) {
    const physical = path.join(root, `${kind}-physical`);
    const alias = path.join(root, `${kind}-alias`);
    fs.mkdirSync(physical, { recursive: true });
    fs.symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
    const stateRoot = kind === "root" ? alias : path.join(alias, "nested", "state");
    await assert.rejects(
      statePrivate.openStateWriter({
        output_root: path.join(root, `${kind}-out`),
        state_root: stateRoot,
        repository_id: `repo:${kind}`,
      }),
      (error) => error?.code === "FAIL-INCREMENTAL-STATE"
        && error.cause?.code === "FAIL-PREDICTIVE-FILESYSTEM"
        && /physical native root/.test(error.message),
    );
  }
});

test("a shared configured state root isolates repository identities before lineage", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-repository-scope-"));
  const stateRoot = path.join(root, "shared-state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = keyFields();
  const key = privateApi.buildPredictiveArtifactKey(binding);

  async function opened(repositoryId, outputName) {
    const lease = await statePrivate.openStateWriter({ output_root: path.join(root, outputName), state_root: stateRoot, repository_id: repositoryId });
    const store = privateApi.openPredictiveArtifactStore({
      stateRoot,
      repositoryBinding: { repository_id: repositoryId },
      lineage: lineage(),
      lease,
    });
    return { lease, store };
  }

  const first = await opened("repo:first", "first-out");
  first.store.publishPromotion({ key, binding, objects: [{ label: "promotion", bytes: "first repository\n" }], reportPins: [] });
  await first.lease.close();

  const second = await opened("repo:second", "second-out");
  assert.equal(second.store.readPromotion({ key, expectedBinding: binding }), null);
  second.store.publishPromotion({ key, binding, objects: [{ label: "promotion", bytes: "second repository\n" }], reportPins: [] });
  assert.equal(second.store.readPromotion({ key, expectedBinding: binding }).objects[0].bytes, "second repository\n");
  await second.lease.close();

  const reopenedFirst = await opened("repo:first", "first-moved-out");
  assert.equal(reopenedFirst.store.readPromotion({ key, expectedBinding: binding }).objects[0].bytes, "first repository\n");
  await reopenedFirst.lease.close();
});

test("lease branding, state-root, and repository mismatches use predictive binding failures", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-lease-binding-"));
  const stateRoot = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = await statePrivate.openStateWriter({ output_root: path.join(root, "out"), state_root: stateRoot, repository_id: "repo:fixture" });

  const attempts = [
    { stateRoot, repositoryBinding: { repository_id: "repo:fixture" }, lease: {} },
    { stateRoot: path.join(root, "other-state"), repositoryBinding: { repository_id: "repo:fixture" }, lease },
    { stateRoot: `\\\\?\\${stateRoot}`, repositoryBinding: { repository_id: "repo:fixture" }, lease },
    { stateRoot: path.join(path.dirname(stateRoot), path.basename(stateRoot).toUpperCase()), repositoryBinding: { repository_id: "repo:fixture" }, lease },
    { stateRoot, repositoryBinding: { repository_id: "repo:other" }, lease },
  ];
  for (const attempt of attempts) {
    assert.throws(
      () => privateApi.openPredictiveArtifactStore({ ...attempt, lineage: lineage() }),
      (error) => error?.code === "FAIL-PREDICTIVE-BINDING" && /state writer lease/.test(error.message),
    );
  }
  await lease.close();
});

test("inspection never accepts a substitute empty manifest directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-manifest-directory-"));
  const stateRoot = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = await statePrivate.openStateWriter({ output_root: path.join(root, "out"), state_root: stateRoot, repository_id: "repo:manifest-directory" });
  const store = privateApi.openPredictiveArtifactStore({ stateRoot, repositoryBinding: { repository_id: "repo:manifest-directory" }, lineage: lineage(), lease });
  const binding = keyFields();
  const key = privateApi.buildPredictiveArtifactKey(binding);
  store.publishPromotion({ key, binding, objects: [{ label: "promotion", bytes: "manifest-directory promotion\n" }], reportPins: [] });
  const manifestFile = filesBelow(stateRoot).find((file) => file.endsWith(".json"));
  const manifestDirectory = path.dirname(manifestFile);
  const displacedDirectory = path.join(root, "displaced-manifests");
  const emptyDirectory = path.join(root, "empty-manifests");
  fs.mkdirSync(emptyDirectory);
  let swapped = false;
  try {
    fs.renameSync(manifestDirectory, displacedDirectory);
    fs.symlinkSync(emptyDirectory, manifestDirectory, process.platform === "win32" ? "junction" : "dir");
    swapped = true;
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    t.diagnostic(`Windows rejected the manifest-directory rename while its native handle was open (${error.code}: ${error.message})`);
  }
  const inspection = store.inspect({ lineageId: "lineage:fixture" });
  assert.equal(inspection.manifest_count, 1);
  if (swapped) {
    fs.unlinkSync(manifestDirectory);
    fs.renameSync(displacedDirectory, manifestDirectory);
  }
  await lease.close();
});

test("predictive operations bypass Node path-based filesystem calls after opening the native root", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-native-only-"));
  const stateRoot = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = await statePrivate.openStateWriter({ output_root: path.join(root, "out"), state_root: stateRoot, repository_id: "repo:native-only" });
  const store = privateApi.openPredictiveArtifactStore({ stateRoot, repositoryBinding: { repository_id: "repo:native-only" }, lineage: lineage(), lease });
  const binding = keyFields();
  const key = privateApi.buildPredictiveArtifactKey(binding);
  const originals = new Map();
  for (const name of ["linkSync", "lstatSync", "mkdirSync", "openSync", "opendirSync", "readFileSync", "unlinkSync"]) {
    originals.set(name, fs[name]);
    fs[name] = () => { throw new Error(`Node path filesystem call escaped native containment: ${name}`); };
  }
  try {
    store.publishPromotion({ key, binding, objects: [{ label: "promotion", bytes: "native-only promotion\n" }], reportPins: [] });
    assert.equal(store.readPromotion({ key, expectedBinding: binding }).objects[0].bytes, "native-only promotion\n");
    assert.equal(store.inspect({ lineageId: "lineage:fixture" }).manifest_count, 1);
    assert.equal(store.planPurge({ lineageId: "lineage:fixture", reportPins: [] }).dry_run, true);
  } finally {
    for (const [name, original] of originals) fs[name] = original;
    await lease.close();
  }
});

test("cancellation uses operation-specific predictive failures and preserves the reason as cause", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-cancellation-"));
  const stateRoot = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = await statePrivate.openStateWriter({ output_root: path.join(root, "out"), state_root: stateRoot, repository_id: "repo:cancel" });
  const controller = new AbortController();
  const reason = new Error("owner stopped predictive work");
  controller.abort(reason);
  const store = privateApi.openPredictiveArtifactStore({
    stateRoot,
    repositoryBinding: { repository_id: "repo:cancel" },
    lineage: lineage(),
    lease,
    signal: controller.signal,
  });
  const binding = keyFields();
  const key = privateApi.buildPredictiveArtifactKey(binding);
  const operations = [
    ["FAIL-PREDICTIVE-OBJECT", () => store.readPromotion({ key, expectedBinding: binding })],
    ["FAIL-PREDICTIVE-OBJECT", () => store.publishPromotion({ key, binding, objects: [{ label: "promotion", bytes: "cancelled\n" }], reportPins: [] })],
    ["FAIL-PREDICTIVE-RETENTION", () => store.inspect({ lineageId: "lineage:fixture" })],
    ["FAIL-PREDICTIVE-PURGE", () => store.planPurge({ lineageId: "lineage:fixture", reportPins: [] })],
  ];
  for (const [code, operation] of operations) {
    assert.throws(
      operation,
      (error) => error?.code === code && error?.cause === reason && /owner stopped predictive work/.test(error.message),
    );
  }
  await lease.close();
});
