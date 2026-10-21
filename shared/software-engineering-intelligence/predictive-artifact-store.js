"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const incrementalStatePrivate = require("./incremental-run-state.js")[Symbol.for("sei.incremental-run-state.private.v2")];
const nativeFilesystemPrivate = require("./predictive-native-fs.js")[Symbol.for("sei.predictive-native-fs.private.v1")];

const PREDICTIVE_ARTIFACT_STORE_VERSION = "sei.predictive-artifact-store@1";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const KEY_FIELDS = Object.freeze([
  "repository_lineage_id",
  "revision_id",
  "evidence_snapshot_digest",
  "bound_artifact_digests",
  "sei_version",
  "feature_schema_version",
  "target_schema_version",
  "candidate_registry_version",
  "evaluation_protocol_version",
  "predictive_config_digest",
]);
const LINEAGE_FIELDS = Object.freeze(["repository_lineage_id", "root_history_digest", "remote_urls"]);
const REPOSITORY_BINDING_FIELDS = Object.freeze(["repository_id"]);
const MANIFEST_FIELDS = Object.freeze([
  "schema_version",
  "key",
  "binding",
  "repository_binding",
  "lineage",
  "filesystem_helper",
  "objects",
  "report_pins",
  "manifest_sha256",
]);
const FILESYSTEM_HELPER_FIELDS = Object.freeze([
  "abi_version",
  "architecture",
  "binary_sha256",
  "loader_sha256",
  "loader_version",
  "platform",
  "source_sha256",
  "version",
]);
const OBJECT_BINDING_FIELDS = Object.freeze(["label", "digest", "size"]);
const REPORT_PIN_FIELDS = Object.freeze(["report_digest", "object_digests"]);
const MAX_OBJECTS = 64;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_REPORT_PINS = 64;
const manifestBrand = new WeakSet();
const hitBrand = new WeakSet();

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function prettyJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function fail(code, detail, cause = undefined) {
  const error = cause === undefined ? new Error(`${code}: ${detail}`) : new Error(`${code}: ${detail}`, { cause });
  error.code = code;
  throw error;
}

function isClosedRecord(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function normalizeKeyBinding(fields) {
  if (!isClosedRecord(fields, KEY_FIELDS)) fail("FAIL-PREDICTIVE-ARTIFACT-KEY", "predictive key fields are not closed");
  const stringFields = [
    "repository_lineage_id",
    "revision_id",
    "sei_version",
    "feature_schema_version",
    "target_schema_version",
    "candidate_registry_version",
    "evaluation_protocol_version",
  ];
  if (stringFields.some((field) => !nonempty(fields[field]))) {
    fail("FAIL-PREDICTIVE-ARTIFACT-KEY", "predictive key string field is invalid");
  }
  if (!SHA256.test(fields.evidence_snapshot_digest) || !SHA256.test(fields.predictive_config_digest)) {
    fail("FAIL-PREDICTIVE-ARTIFACT-KEY", "predictive key digest field is invalid");
  }
  const digests = fields.bound_artifact_digests;
  if (!digests || typeof digests !== "object" || Array.isArray(digests) || Object.keys(digests).length === 0
      || Object.entries(digests).some(([label, digest]) => !nonempty(label) || !SHA256.test(digest))) {
    fail("FAIL-PREDICTIVE-ARTIFACT-KEY", "bound artifact digests are invalid");
  }
  return canonicalValue(fields);
}

function buildPredictiveArtifactKey(fields) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(normalizeKeyBinding(fields))).digest("hex")}`;
}

function normalizeLineage(value) {
  if (!isClosedRecord(value, LINEAGE_FIELDS)) fail("FAIL-PREDICTIVE-LINEAGE", "lineage descriptor is not closed");
  if (!nonempty(value.repository_lineage_id) || !SHA256.test(value.root_history_digest)
      || !Array.isArray(value.remote_urls) || value.remote_urls.some((remote) => !nonempty(remote))) {
    fail("FAIL-PREDICTIVE-LINEAGE", "lineage descriptor is invalid");
  }
  return canonicalValue(value);
}

function classifyRepositoryLineage(prior, current) {
  const normalizedPrior = normalizeLineage(prior);
  const normalizedCurrent = normalizeLineage(current);
  if (normalizedPrior.repository_lineage_id === normalizedCurrent.repository_lineage_id
      && normalizedPrior.root_history_digest === normalizedCurrent.root_history_digest) return "SAME_LINEAGE";
  if (normalizedPrior.root_history_digest === normalizedCurrent.root_history_digest) return "RELATED_LINEAGE";
  return "UNKNOWN_LINEAGE";
}

function normalizeRepositoryBinding(value) {
  if (!isClosedRecord(value, REPOSITORY_BINDING_FIELDS) || !nonempty(value.repository_id)) {
    fail("FAIL-PREDICTIVE-BINDING", "repository binding is not a closed valid record");
  }
  return canonicalValue(value);
}

function normalizeReportPins(values, availableDigests = null) {
  if (!Array.isArray(values) || values.length > MAX_REPORT_PINS) {
    fail("FAIL-PREDICTIVE-BINDING", "report pins exceed the closed bound");
  }
  const seen = new Set();
  return values.map((value, index) => {
    if (!isClosedRecord(value, REPORT_PIN_FIELDS) || !SHA256.test(value.report_digest)
        || !Array.isArray(value.object_digests) || value.object_digests.length === 0
        || value.object_digests.some((digest) => !SHA256.test(digest))) {
      fail("FAIL-PREDICTIVE-BINDING", `report pin ${index} is invalid`);
    }
    const objectDigests = [...new Set(value.object_digests)].sort();
    if (objectDigests.length !== value.object_digests.length
        || (availableDigests !== null && objectDigests.some((digest) => !availableDigests.has(digest)))) {
      fail("FAIL-PREDICTIVE-BINDING", `report pin ${index} is not bound to the promotion objects`);
    }
    const normalized = { report_digest: value.report_digest, object_digests: objectDigests };
    const identity = canonicalJson(normalized);
    if (seen.has(identity)) fail("FAIL-PREDICTIVE-BINDING", "report pins contain a duplicate");
    seen.add(identity);
    return normalized;
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function normalizeObjectInputs(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_OBJECTS) {
    fail("FAIL-PREDICTIVE-OBJECT", "promotion objects exceed the closed bound");
  }
  const labels = new Set();
  const digests = new Set();
  return values.map((value, index) => {
    if (!isClosedRecord(value, ["label", "bytes"]) || !nonempty(value.label) || typeof value.bytes !== "string") {
      fail("FAIL-PREDICTIVE-OBJECT", `promotion object ${index} is invalid`);
    }
    const size = Buffer.byteLength(value.bytes);
    const digest = sha256(Buffer.from(value.bytes, "utf8"));
    if (size <= 0 || size > MAX_OBJECT_BYTES) fail("FAIL-PREDICTIVE-OBJECT", `promotion object ${index} exceeds the byte bound`);
    if (labels.has(value.label) || digests.has(digest)) fail("FAIL-PREDICTIVE-OBJECT", "promotion objects contain an alias");
    labels.add(value.label);
    digests.add(digest);
    return { label: value.label, bytes: value.bytes, digest, size };
  }).sort((left, right) => left.label.localeCompare(right.label));
}

function normalizeObjectBindings(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_OBJECTS) {
    fail("FAIL-PREDICTIVE-MANIFEST", "manifest object bindings exceed the closed bound");
  }
  const labels = new Set();
  const digests = new Set();
  return values.map((value, index) => {
    if (!isClosedRecord(value, OBJECT_BINDING_FIELDS) || !nonempty(value.label) || !SHA256.test(value.digest)
        || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_OBJECT_BYTES) {
      fail("FAIL-PREDICTIVE-MANIFEST", `manifest object binding ${index} is invalid`);
    }
    if (labels.has(value.label) || digests.has(value.digest)) fail("FAIL-PREDICTIVE-MANIFEST", "manifest object bindings contain an alias");
    labels.add(value.label);
    digests.add(value.digest);
    return canonicalValue(value);
  }).sort((left, right) => left.label.localeCompare(right.label));
}

function lineageNamespaceComponents(repositoryId, lineageId, helperIdentity) {
  const repositoryKey = crypto.createHash("sha256").update(repositoryId).digest("hex");
  const lineageKey = crypto.createHash("sha256").update(lineageId).digest("hex");
  const helperKey = crypto.createHash("sha256").update(canonicalJson(helperIdentity)).digest("hex");
  return [
    "predictive-artifacts-v1",
    "helpers",
    helperKey,
    "repositories",
    repositoryKey,
    "lineages",
    lineageKey,
  ];
}

function manifestName(key) {
  return `${key.slice("sha256:".length)}.json`;
}

function objectName(digest) {
  return `${digest.slice("sha256:".length)}.object`;
}

function normalizeFilesystemHelper(value, code = "FAIL-PREDICTIVE-FILESYSTEM") {
  if (!isClosedRecord(value, FILESYSTEM_HELPER_FIELDS)
      || value.version !== nativeFilesystemPrivate.PREDICTIVE_NATIVE_FS_VERSION
      || value.abi_version !== 1
      || value.platform !== process.platform
      || value.architecture !== process.arch
      || !SHA256.test(value.binary_sha256)
      || !SHA256.test(value.loader_sha256)
      || value.loader_version !== "sei.predictive-native-bootstrap@2"
      || !SHA256.test(value.source_sha256)) {
    fail(code, "predictive filesystem helper identity is invalid");
  }
  return canonicalValue(value);
}

function validateManifestDocument(document, bytes, expected) {
  if (!isClosedRecord(document, MANIFEST_FIELDS) || document.schema_version !== PREDICTIVE_ARTIFACT_STORE_VERSION
      || !SHA256.test(document.key) || !SHA256.test(document.manifest_sha256)) {
    fail("FAIL-PREDICTIVE-MANIFEST", "manifest is not a closed supported document");
  }
  const binding = normalizeKeyBinding(document.binding);
  const repositoryBinding = normalizeRepositoryBinding(document.repository_binding);
  const lineage = normalizeLineage(document.lineage);
  const filesystemHelper = normalizeFilesystemHelper(document.filesystem_helper, "FAIL-PREDICTIVE-MANIFEST");
  const objects = normalizeObjectBindings(document.objects);
  const reportPins = normalizeReportPins(document.report_pins, new Set(objects.map((object) => object.digest)));
  const body = canonicalValue({
    schema_version: document.schema_version,
    key: document.key,
    binding,
    repository_binding: repositoryBinding,
    lineage,
    filesystem_helper: filesystemHelper,
    objects,
    report_pins: reportPins,
  });
  const canonical = canonicalValue({ ...body, manifest_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")) });
  if (document.key !== buildPredictiveArtifactKey(binding)
      || document.manifest_sha256 !== canonical.manifest_sha256
      || bytes.toString("utf8") !== prettyJson(canonical)) {
    fail("FAIL-PREDICTIVE-MANIFEST", "manifest digest or canonical bytes are invalid");
  }
  if (expected.key !== document.key || canonicalJson(expected.binding) !== canonicalJson(binding)) {
    fail("FAIL-PREDICTIVE-ARTIFACT-KEY", "manifest does not match the expected predictive key");
  }
  if (canonicalJson(expected.repositoryBinding) !== canonicalJson(repositoryBinding)) {
    fail("FAIL-PREDICTIVE-BINDING", "manifest repository binding does not match");
  }
  if (canonicalJson(expected.filesystemHelper) !== canonicalJson(filesystemHelper)) {
    fail("FAIL-PREDICTIVE-MANIFEST", "manifest filesystem helper identity does not match the opened store");
  }
  const classification = classifyRepositoryLineage(lineage, expected.lineage);
  if (classification !== "SAME_LINEAGE") fail("FAIL-PREDICTIVE-LINEAGE", `manifest classified as ${classification}`);
  return canonical;
}

/**
 * Opens the package-private predictive cache under an already leased repository state root.
 *
 * Object inputs are closed `{label, bytes}` UTF-8 records and are stored at their raw-byte
 * SHA-256 address. Manifests are canonical closed records containing schema/version, exact
 * predictive key binding, repository binding, lineage descriptor, `{label,digest,size}` object
 * bindings, closed `{report_digest,object_digests}` pins, and a body digest. Paths are never
 * returned. The namespace is bound to the canonical helper-and-loader identity digest, then
 * hashed by repository identity and lineage. Every operation is relative to retained no-alias directory handles;
 * reuse binds bytes/digest/size and identity to opened object handles before returning a hit.
 */
function openPredictiveArtifactStore({ stateRoot, repositoryBinding, lineage, lease, signal } = {}) {
  if (!nonempty(stateRoot) || !path.isAbsolute(stateRoot)) fail("FAIL-PREDICTIVE-BINDING", "stateRoot must be an absolute path");
  const normalizedRepositoryBinding = normalizeRepositoryBinding(repositoryBinding);
  const normalizedLineage = normalizeLineage(lineage);
  let writer;
  try {
    writer = incrementalStatePrivate.stateWriterAccess(lease, {
      state_root: stateRoot,
      repository_id: normalizedRepositoryBinding.repository_id,
    });
  } catch (error) {
    fail("FAIL-PREDICTIVE-BINDING", `state writer lease is incompatible (${error?.code ?? error?.message ?? "unknown failure"})`);
  }
  const normalizedStateRoot = writer.state_root;
  const checkSignal = (code, operation) => {
    if (signal !== undefined && (signal === null || typeof signal !== "object" || typeof signal.aborted !== "boolean")) {
      fail("FAIL-PREDICTIVE-BINDING", "signal must be an AbortSignal");
    }
    if (signal?.aborted) {
      const reason = signal.reason;
      const detail = reason instanceof Error ? reason.message : String(reason ?? "no reason supplied");
      fail(code, `${operation} was cancelled (${detail})`, reason);
    }
  };

  let rootCapability = null;
  let namespaceCapability = null;
  let objectsCapability = null;
  let manifestsCapability = null;
  let stagingCapability = null;
  if (nativeFilesystemPrivate.helperIdentity !== null) {
    try {
      normalizeFilesystemHelper(nativeFilesystemPrivate.helperIdentity, "FAIL-PREDICTIVE-BINDING");
      rootCapability = writer.runWithLease((leasedRoot) => leasedRoot ?? nativeFilesystemPrivate.openRoot(normalizedStateRoot));
    } catch (error) {
      if (error?.code === "FAIL-PREDICTIVE-BINDING") throw error;
      fail("FAIL-PREDICTIVE-BINDING", "physical state root is not a native no-alias directory capability", error);
    }
  }

  function withFilesystem(code, operation, callback) {
    checkSignal(code, operation);
    try {
      return writer.runWithLease(() => {
        if (rootCapability === null) rootCapability = nativeFilesystemPrivate.openRoot(normalizedStateRoot);
        const filesystemHelper = normalizeFilesystemHelper(nativeFilesystemPrivate.helperIdentity, code);
        return callback(filesystemHelper);
      });
    } catch (error) {
      if (error?.code === code || (String(error?.code ?? "").startsWith("FAIL-PREDICTIVE-")
          && error?.code !== "FAIL-PREDICTIVE-FILESYSTEM")) throw error;
      const detail = error?.code ?? error?.message ?? "unknown native helper failure";
      fail(code, `${operation} failed through the native filesystem helper (${detail})`, error);
    }
  }

  function namespaceDirectory(create, filesystemHelper) {
    if (namespaceCapability !== null) return namespaceCapability;
    const components = lineageNamespaceComponents(
      normalizedRepositoryBinding.repository_id,
      normalizedLineage.repository_lineage_id,
      filesystemHelper,
    );
    namespaceCapability = create
      ? rootCapability.ensureDirectory(components)
      : rootCapability.openDirectory(components);
    return namespaceCapability;
  }

  function artifactDirectory(kind, create, filesystemHelper) {
    if (kind === "objects" && objectsCapability !== null) return objectsCapability;
    if (kind === "manifests" && manifestsCapability !== null) return manifestsCapability;
    if (kind === "staging" && stagingCapability !== null) return stagingCapability;
    const namespace = namespaceDirectory(create, filesystemHelper);
    if (namespace === null) return null;
    const opened = create ? namespace.ensureDirectory([kind]) : namespace.openDirectory([kind]);
    if (kind === "objects") objectsCapability = opened;
    else if (kind === "manifests") manifestsCapability = opened;
    else stagingCapability = opened;
    return opened;
  }

  function validateReadRequest(key, expectedBinding) {
    const binding = normalizeKeyBinding(expectedBinding);
    if (!SHA256.test(key) || buildPredictiveArtifactKey(binding) !== key) {
      fail("FAIL-PREDICTIVE-ARTIFACT-KEY", "requested key does not match the expected binding");
    }
    if (binding.repository_lineage_id !== normalizedLineage.repository_lineage_id) {
      fail("FAIL-PREDICTIVE-LINEAGE", "requested key belongs to another lineage");
    }
    return binding;
  }

  function readPromotionCore(key, binding, filesystemHelper) {
    const manifestDirectory = artifactDirectory("manifests", false, filesystemHelper);
    if (manifestDirectory === null) return null;
    const loadedManifest = manifestDirectory.readFile({
      name: manifestName(key),
      maxBytes: MAX_MANIFEST_BYTES,
      allowMissing: true,
    });
    if (loadedManifest === null) return null;
    let document;
    try { document = JSON.parse(loadedManifest.bytes.toString("utf8")); } catch { fail("FAIL-PREDICTIVE-MANIFEST", "manifest is not JSON"); }
    const manifest = validateManifestDocument(document, loadedManifest.bytes, {
      key,
      binding,
      repositoryBinding: normalizedRepositoryBinding,
      lineage: normalizedLineage,
      filesystemHelper,
    });
    const identities = new Set([loadedManifest.identity]);
    const objectDirectory = artifactDirectory("objects", false, filesystemHelper);
    if (objectDirectory === null) fail("FAIL-PREDICTIVE-OBJECT", "bound object namespace is unavailable");
    const objects = manifest.objects.map((object) => {
      const loaded = objectDirectory.readFile({ name: objectName(object.digest), maxBytes: MAX_OBJECT_BYTES });
      if (identities.has(loaded.identity)) fail("FAIL-PREDICTIVE-OBJECT", "bound object aliases another cache artifact");
      identities.add(loaded.identity);
      if (loaded.size !== object.size || loaded.digest !== object.digest) {
        fail("FAIL-PREDICTIVE-OBJECT", "bound object size or digest is invalid");
      }
      return { ...object, bytes: loaded.bytes.toString("utf8") };
    });
    const frozenManifest = deepFreeze(manifest);
    manifestBrand.add(frozenManifest);
    const hit = deepFreeze({ manifest: frozenManifest, objects });
    hitBrand.add(hit);
    return hit;
  }

  function readPromotion({ key, expectedBinding } = {}) {
    const binding = validateReadRequest(key, expectedBinding);
    return withFilesystem("FAIL-PREDICTIVE-OBJECT", "predictive read", (filesystemHelper) => (
      readPromotionCore(key, binding, filesystemHelper)
    ));
  }

  function publishPromotion({ key, binding, objects, reportPins } = {}) {
    const normalizedBinding = normalizeKeyBinding(binding);
    if (!SHA256.test(key) || key !== buildPredictiveArtifactKey(normalizedBinding)) {
      fail("FAIL-PREDICTIVE-ARTIFACT-KEY", "publication key does not match its binding");
    }
    if (normalizedBinding.repository_lineage_id !== normalizedLineage.repository_lineage_id) {
      fail("FAIL-PREDICTIVE-LINEAGE", "publication key belongs to another lineage");
    }
    const normalizedObjects = normalizeObjectInputs(objects);
    const objectBindings = normalizedObjects.map(({ label, digest, size }) => ({ label, digest, size }));
    const normalizedPins = normalizeReportPins(reportPins, new Set(objectBindings.map((object) => object.digest)));
    return withFilesystem("FAIL-PREDICTIVE-OBJECT", "predictive publication", (filesystemHelper) => {
      const body = canonicalValue({
        schema_version: PREDICTIVE_ARTIFACT_STORE_VERSION,
        key,
        binding: normalizedBinding,
        repository_binding: normalizedRepositoryBinding,
        lineage: { ...normalizedLineage, remote_urls: [] },
        filesystem_helper: filesystemHelper,
        objects: objectBindings,
        report_pins: normalizedPins,
      });
      const manifest = canonicalValue({ ...body, manifest_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")) });
      const manifestBytes = Buffer.from(prettyJson(manifest), "utf8");
      if (manifestBytes.length > MAX_MANIFEST_BYTES) fail("FAIL-PREDICTIVE-MANIFEST", "manifest exceeds the byte bound");
      const objectDirectory = artifactDirectory("objects", true, filesystemHelper);
      const manifestDirectory = artifactDirectory("manifests", true, filesystemHelper);
      const stagingDirectory = artifactDirectory("staging", true, filesystemHelper);
      const objectDescriptors = normalizedObjects.map((object) => ({
          code: "FAIL-PREDICTIVE-OBJECT",
          directory: objectDirectory,
          name: objectName(object.digest),
          bytes: Buffer.from(object.bytes, "utf8"),
          digest: object.digest,
        }));
      const manifestDescriptor = {
        code: "FAIL-PREDICTIVE-MANIFEST",
        directory: manifestDirectory,
        name: manifestName(key),
        bytes: manifestBytes,
        digest: sha256(manifestBytes),
      };
      const descriptors = [...objectDescriptors, manifestDescriptor];
      const identities = new Set();
      const expectedIdentities = new Map();
      const pending = [];
      for (const descriptor of descriptors) {
        let existing;
        try {
          existing = descriptor.directory.readFile({
            name: descriptor.name,
            maxBytes: descriptor.bytes.length,
            allowMissing: true,
          });
        } catch (error) {
          fail(descriptor.code, "immutable publication target is invalid", error);
        }
        if (existing === null) {
          pending.push(descriptor);
          continue;
        }
        if (!existing.bytes.equals(descriptor.bytes) || existing.digest !== descriptor.digest) {
          fail(descriptor.code, "immutable publication target contains conflicting bytes");
        }
        if (identities.has(existing.identity)) fail(descriptor.code, "immutable publication target aliases another artifact");
        identities.add(existing.identity);
        expectedIdentities.set(descriptor, existing.identity);
      }
      const published = [];
      const publishedByDescriptor = new Map();
      const requireExactTarget = (descriptor) => {
        const exact = descriptor.directory.readFile({ name: descriptor.name, maxBytes: descriptor.bytes.length });
        if (!exact.bytes.equals(descriptor.bytes) || exact.digest !== descriptor.digest
            || exact.identity !== expectedIdentities.get(descriptor)) {
          fail(descriptor.code, "published target bytes or identity are not exact");
        }
      };
      try {
        for (const descriptor of pending) {
          let token;
          try {
            token = descriptor.directory.publishFile({
              name: descriptor.name,
              bytes: descriptor.bytes,
              digest: descriptor.digest,
              stagingDirectory,
            });
          } catch (error) {
            fail(descriptor.code, "exclusive immutable publication failed", error);
          }
          if (identities.has(token.identity)) fail(descriptor.code, "published object aliases another artifact");
          identities.add(token.identity);
          expectedIdentities.set(descriptor, token.identity);
          const publication = { descriptor, token, committed: false };
          published.push(publication);
          publishedByDescriptor.set(descriptor, publication);
        }
        for (const descriptor of descriptors) {
          if (!publishedByDescriptor.has(descriptor)) requireExactTarget(descriptor);
        }
        for (const publication of published) {
          if (publication.descriptor === manifestDescriptor) continue;
          publication.token.commit();
          publication.committed = true;
          requireExactTarget(publication.descriptor);
        }
        const manifestPublication = publishedByDescriptor.get(manifestDescriptor);
        if (manifestPublication !== undefined) {
          manifestPublication.token.commit();
          manifestPublication.committed = true;
        }
      } catch (error) {
        const rollbackFailures = [];
        for (const { token, committed } of published.reverse()) {
          if (committed) continue;
          try { token.rollback(); } catch (rollbackError) { rollbackFailures.push(rollbackError); }
        }
        if (rollbackFailures.length > 0) {
          fail("FAIL-PREDICTIVE-OBJECT", `native publication rollback refused (${rollbackFailures[0].message})`, error);
        }
        throw error;
      }
      const frozen = deepFreeze(manifest);
      manifestBrand.add(frozen);
      return frozen;
    });
  }

  function requireLineageId(lineageId, code) {
    if (!nonempty(lineageId) || lineageId !== normalizedLineage.repository_lineage_id) {
      fail(code, "requested lineage does not match the opened store");
    }
  }

  function scanManifests(filesystemHelper) {
    const directory = artifactDirectory("manifests", false, filesystemHelper);
    if (directory === null) return [];
    return directory.listDirectory().map((entry) => {
      if (entry.type !== "file" || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
        fail("FAIL-PREDICTIVE-RETENTION", "manifest namespace contains an uncertain entry");
      }
      const loaded = directory.readFile({ name: entry.name, maxBytes: MAX_MANIFEST_BYTES });
      let preliminary;
      try { preliminary = JSON.parse(loaded.bytes.toString("utf8")); } catch { fail("FAIL-PREDICTIVE-MANIFEST", "manifest is not JSON"); }
      if (!preliminary || typeof preliminary !== "object" || Array.isArray(preliminary)) {
        fail("FAIL-PREDICTIVE-MANIFEST", "manifest is not an object");
      }
      if (!SHA256.test(preliminary.key) || entry.name !== `${preliminary.key.slice("sha256:".length)}.json`) {
        fail("FAIL-PREDICTIVE-MANIFEST", "manifest filename is not bound to its predictive key");
      }
      const binding = validateReadRequest(preliminary.key, preliminary.binding);
      const hit = readPromotionCore(preliminary.key, binding, filesystemHelper);
      if (!hitBrand.has(hit) || !manifestBrand.has(hit.manifest)) {
        fail("FAIL-PREDICTIVE-MANIFEST", "manifest scan did not produce a branded exact hit");
      }
      return {
        key: hit.manifest.key,
        manifest_sha256: hit.manifest.manifest_sha256,
        objects: hit.manifest.objects,
        report_pins: hit.manifest.report_pins,
        mtime_ns: loaded.mtime_ns,
      };
    });
  }

  function scanObjects(filesystemHelper) {
    const directory = artifactDirectory("objects", false, filesystemHelper);
    if (directory === null) return [];
    return directory.listDirectory().map((entry) => {
      if (entry.type !== "file" || !/^[0-9a-f]{64}\.object$/.test(entry.name)) {
        fail("FAIL-PREDICTIVE-RETENTION", "object namespace contains an uncertain entry");
      }
      const digest = `sha256:${entry.name.slice(0, 64)}`;
      const loaded = directory.readFile({ name: entry.name, maxBytes: MAX_OBJECT_BYTES });
      if (loaded.digest !== digest) fail("FAIL-PREDICTIVE-OBJECT", "content-addressed object digest is invalid");
      return { digest, size: loaded.size };
    });
  }

  function inspect({ lineageId } = {}) {
    requireLineageId(lineageId, "FAIL-PREDICTIVE-LINEAGE");
    return withFilesystem("FAIL-PREDICTIVE-RETENTION", "predictive inspection", (filesystemHelper) => {
      const manifests = scanManifests(filesystemHelper);
      const objects = scanObjects(filesystemHelper);
      const document = {
        schema_version: "sei.predictive-artifact-inspection@1",
        lineage_id: lineageId,
        manifest_count: manifests.length,
        object_count: objects.length,
        manifests: manifests.map((manifest) => ({
          key: manifest.key,
          manifest_sha256: manifest.manifest_sha256,
          object_digests: manifest.objects.map((object) => object.digest).sort(),
          report_pins: manifest.report_pins,
        })).sort((left, right) => left.key.localeCompare(right.key)),
        objects: objects.sort((left, right) => left.digest.localeCompare(right.digest)),
      };
      return deepFreeze(document);
    });
  }

  function planPurge({ lineageId, reportPins } = {}) {
    requireLineageId(lineageId, "FAIL-PREDICTIVE-PURGE");
    const activePins = normalizeReportPins(reportPins);
    const activePinKeys = new Set(activePins.map(canonicalJson));
    return withFilesystem("FAIL-PREDICTIVE-PURGE", "predictive purge planning", (filesystemHelper) => {
      const manifests = scanManifests(filesystemHelper).sort((left, right) => {
        if (left.mtime_ns !== right.mtime_ns) return left.mtime_ns > right.mtime_ns ? -1 : 1;
        return right.key.localeCompare(left.key);
      });
      const retainedKeys = new Set(manifests.slice(0, 2).map((manifest) => manifest.key));
      for (const manifest of manifests) {
        if (manifest.report_pins.some((pin) => activePinKeys.has(canonicalJson(pin)))) retainedKeys.add(manifest.key);
      }
      const retainedManifests = manifests.filter((manifest) => retainedKeys.has(manifest.key));
      const purgeManifests = manifests.filter((manifest) => !retainedKeys.has(manifest.key));
      const retainedDigests = new Set(retainedManifests.flatMap((manifest) => manifest.objects.map((object) => object.digest)));
      const objects = scanObjects(filesystemHelper);
      return deepFreeze({
        schema_version: "sei.predictive-artifact-purge-plan@1",
        lineage_id: lineageId,
        dry_run: true,
        retained_manifest_keys: [...retainedKeys].sort(),
        purge_manifest_keys: purgeManifests.map((manifest) => manifest.key).sort(),
        retained_object_digests: [...retainedDigests].sort(),
        purge_object_digests: objects.map((object) => object.digest).filter((digest) => !retainedDigests.has(digest)).sort(),
      });
    });
  }

  return Object.freeze({
    readPromotion,
    publishPromotion,
    inspect,
    planPurge,
  });
}

module.exports = {};
Object.defineProperty(module.exports, Symbol.for("sei.predictive-artifact-store.private.v1"), {
  value: Object.freeze({
    PREDICTIVE_ARTIFACT_STORE_VERSION,
    buildPredictiveArtifactKey,
    classifyRepositoryLineage,
    openPredictiveArtifactStore,
  }),
});
