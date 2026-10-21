"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const nativeFilesystem = require("./predictive-native-fs.js");
const nativePrivate = nativeFilesystem[Symbol.for("sei.predictive-native-fs.private.v1")];

test("predictive native filesystem loads only through its closed private seam", () => {
  assert.deepEqual(Object.keys(nativeFilesystem), []);
  assert.equal(typeof nativePrivate, "object");
  assert.deepEqual(Object.keys(nativePrivate).sort(), [
    "PREDICTIVE_NATIVE_FS_VERSION",
    "helperIdentity",
    "openRoot",
  ]);
  assert.equal(nativePrivate.PREDICTIVE_NATIVE_FS_VERSION, "sei.predictive-native-fs@1");
  assert.equal(typeof nativePrivate.openRoot, "function");
  assert.deepEqual(Object.keys(nativePrivate.helperIdentity).sort(), [
    "abi_version",
    "architecture",
    "binary_sha256",
    "loader_sha256",
    "loader_version",
    "platform",
    "source_sha256",
    "version",
  ]);
  assert.equal(nativePrivate.helperIdentity.abi_version, 1);
  assert.equal(nativePrivate.helperIdentity.architecture, process.arch);
  assert.match(nativePrivate.helperIdentity.binary_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    nativePrivate.helperIdentity.loader_sha256,
    digest(fs.readFileSync(path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_bootstrap.node"))),
  );
  assert.equal(nativePrivate.helperIdentity.loader_version, "sei.predictive-native-bootstrap@2");
  assert.equal(
    nativePrivate.helperIdentity.source_sha256,
    digest(Buffer.from(
      fs.readFileSync(path.join(__dirname, "native", "predictive_native_fs.cc"), "utf8").replace(/\r\n?/g, "\n"),
      "utf8",
    )),
  );
  assert.equal(nativePrivate.helperIdentity.platform, process.platform);
  assert.equal(nativePrivate.helperIdentity.version, nativePrivate.PREDICTIVE_NATIVE_FS_VERSION);
});

test("helper source identity is stable across LF and CRLF checkouts", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-eol-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, "predictive-native-fs.js"), path.join(fixture, "predictive-native-fs.js"));
  const nativeDirectory = path.join(fixture, "native");
  const binaryDirectory = path.join(nativeDirectory, "bin", "win32-x64");
  fs.mkdirSync(binaryDirectory, { recursive: true });
  const source = fs.readFileSync(path.join(__dirname, "native", "predictive_native_fs.cc"), "utf8")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "\r\n");
  fs.writeFileSync(path.join(nativeDirectory, "predictive_native_fs.cc"), source, "utf8");
  fs.copyFileSync(
    path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_fs.node"),
    path.join(binaryDirectory, "predictive_native_fs.node"),
  );
  fs.copyFileSync(
    path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_bootstrap.node"),
    path.join(binaryDirectory, "predictive_native_bootstrap.node"),
  );
  const child = spawnSync(process.execPath, [
    "-e",
    "const p=require(process.argv[1])[Symbol.for('sei.predictive-native-fs.private.v1')];if(!p.helperIdentity)process.exitCode=1;",
    path.join(fixture, "predictive-native-fs.js"),
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the loaded helper image stays bound to the exact locked file across cache eviction", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-image-binding-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, "predictive-native-fs.js"), path.join(fixture, "predictive-native-fs.js"));
  const nativeDirectory = path.join(fixture, "native");
  const binaryDirectory = path.join(nativeDirectory, "bin", "win32-x64");
  fs.mkdirSync(binaryDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "native", "predictive_native_fs.cc"),
    path.join(nativeDirectory, "predictive_native_fs.cc"),
  );
  fs.copyFileSync(
    path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_fs.node"),
    path.join(binaryDirectory, "predictive_native_fs.node"),
  );
  fs.copyFileSync(
    path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_bootstrap.node"),
    path.join(binaryDirectory, "predictive_native_bootstrap.node"),
  );
  const child = spawnSync(process.execPath, [
    "-e",
    String.raw`
      const fs = require("node:fs");
      const path = require("node:path");
      const loaderPath = process.argv[1];
      const candidate = path.join(path.dirname(loaderPath), "native", "bin", "win32-x64", "predictive_native_fs.node");
      const displaced = candidate + ".loaded";
      const symbol = Symbol.for("sei.predictive-native-fs.private.v1");
      const first = require(loaderPath)[symbol];
      if (first.helperIdentity === null) throw new Error("first helper load failed");
      try {
        fs.renameSync(candidate, displaced);
      } catch (error) {
        if (!["EACCES", "EBUSY", "EPERM"].includes(error && error.code)) throw error;
        process.exit(0);
      }
      fs.copyFileSync(displaced, candidate);
      fs.appendFileSync(candidate, Buffer.from("replacement-image", "utf8"));
      delete require.cache[require.resolve(loaderPath)];
      const second = require(loaderPath)[symbol];
      if (second.helperIdentity !== null) {
        process.stderr.write("replacement pathname bytes were bound to a cached executed image\n");
        process.exit(42);
      }
    `,
    path.join(fixture, "predictive-native-fs.js"),
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the trusted bootstrap pins the candidate before its N-API entry executes", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-bootstrap-barrier-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const candidate = path.join(fixture, "candidate.node");
  fs.copyFileSync(
    path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_fs.node"),
    candidate,
  );
  const child = spawnSync(process.execPath, [
    "-e",
    String.raw`
      const assert = require("node:assert/strict");
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      const bootstrap = require(process.argv[1]);
      const candidate = process.argv[2];
      const displaced = candidate + ".displaced";
      const expected = "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
      let reached = false;
      const verified = bootstrap.loadVerified(candidate, () => {
        reached = true;
        for (const mutation of [
          () => fs.renameSync(candidate, displaced),
          () => fs.writeFileSync(candidate, "replacement", "utf8"),
        ]) {
          assert.throws(mutation, (error) => ["EACCES", "EBUSY", "EPERM"].includes(error && error.code));
        }
      });
      assert.equal(reached, true);
      assert.equal(verified.binaryDigest, expected);
      assert.equal(typeof verified.fileIdentity, "string");
      assert.equal(typeof verified.binding.openRoot, "function");
    `,
    path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_bootstrap.node"),
    candidate,
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the trusted bootstrap refuses an OS-loader cache crossing to a replaced helper file", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-os-cache-crossing-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const candidate = path.join(fixture, "candidate.node");
  const displaced = path.join(fixture, "displaced.node");
  fs.copyFileSync(
    path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_fs.node"),
    candidate,
  );
  const child = spawnSync(process.execPath, [
    "-e",
    String.raw`
      const assert = require("node:assert/strict");
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      const bootstrap = require(process.argv[1]);
      const candidate = process.argv[2];
      const displaced = process.argv[3];
      const sha = (bytes) => "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
      const oldDigest = sha(fs.readFileSync(candidate));
      require(candidate);
      fs.renameSync(candidate, displaced);
      fs.copyFileSync(displaced, candidate);
      fs.appendFileSync(candidate, Buffer.from("replacement-image", "utf8"));
      const replacementDigest = sha(fs.readFileSync(candidate));
      assert.notEqual(replacementDigest, oldDigest);
      try {
        const verified = bootstrap.loadVerified(candidate);
        assert.equal(verified.binaryDigest, replacementDigest);
        assert.notEqual(verified.binaryDigest, oldDigest);
      } catch (error) {
        assert.equal(error && error.code, "FAIL-PREDICTIVE-NATIVE-LOADER");
        assert.equal(error && error.reason, "LOADED_IMAGE_MISMATCH");
      }
    `,
    path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_bootstrap.node"),
    candidate,
    displaced,
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the production dlopen path pins and self-digests the exact bootstrap image", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-bootstrap-self-binding-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const candidate = path.join(fixture, "bootstrap.node");
  fs.copyFileSync(
    path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_bootstrap.node"),
    candidate,
  );
  const child = spawnSync(process.execPath, [
    "-e",
    String.raw`
      const assert = require("node:assert/strict");
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      const candidate = process.argv[1];
      const expected = "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
      const nativeModule = { exports: {}, filename: candidate };
      process.dlopen(nativeModule, candidate);
      assert.equal(nativeModule.exports.imageDigest, expected);
      for (const mutation of [
        () => fs.renameSync(candidate, candidate + ".displaced"),
        () => fs.writeFileSync(candidate, "replacement", "utf8"),
      ]) {
        assert.throws(mutation, (error) => ["EACCES", "EBUSY", "EPERM"].includes(error && error.code));
      }
    `,
    candidate,
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("a preloaded native require-cache entry cannot substitute helper execution", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-cache-substitution-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, "predictive-native-fs.js"), path.join(fixture, "predictive-native-fs.js"));
  const nativeDirectory = path.join(fixture, "native");
  const binaryDirectory = path.join(nativeDirectory, "bin", "win32-x64");
  fs.mkdirSync(binaryDirectory, { recursive: true });
  for (const filename of ["predictive_native_fs.node", "predictive_native_bootstrap.node"]) {
    fs.copyFileSync(
      path.join(__dirname, "native", "bin", "win32-x64", filename),
      path.join(binaryDirectory, filename),
    );
  }
  fs.copyFileSync(
    path.join(__dirname, "native", "predictive_native_fs.cc"),
    path.join(nativeDirectory, "predictive_native_fs.cc"),
  );
  const child = spawnSync(process.execPath, [
    "-e",
    String.raw`
      const assert = require("node:assert/strict");
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      const path = require("node:path");
      const loaderPath = process.argv[1];
      const stateRoot = process.argv[2];
      const candidate = path.join(path.dirname(loaderPath), "native", "bin", "win32-x64", "predictive_native_fs.node");
      const expectedDigest = "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
      const real = require(candidate);
      require.cache[require.resolve(candidate)].exports = Object.freeze({
        ...real,
        openRoot() { throw new Error("poison-cache-executed"); },
      });
      const helper = require(loaderPath)[Symbol.for("sei.predictive-native-fs.private.v1")];
      if (helper.helperIdentity === null) {
        assert.throws(() => helper.openRoot(stateRoot), /FAIL-PREDICTIVE-FILESYSTEM/);
      } else {
        assert.equal(helper.helperIdentity.binary_sha256, expectedDigest);
        assert.equal(typeof helper.openRoot(stateRoot).identity, "string");
      }
    `,
    path.join(fixture, "predictive-native-fs.js"),
    fixture,
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("a forged require-cache entry cannot substitute the trusted bootstrap", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-bootstrap-cache-substitution-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, "predictive-native-fs.js"), path.join(fixture, "predictive-native-fs.js"));
  const nativeDirectory = path.join(fixture, "native");
  const binaryDirectory = path.join(nativeDirectory, "bin", "win32-x64");
  fs.mkdirSync(binaryDirectory, { recursive: true });
  for (const filename of ["predictive_native_fs.node", "predictive_native_bootstrap.node"]) {
    fs.copyFileSync(
      path.join(__dirname, "native", "bin", "win32-x64", filename),
      path.join(binaryDirectory, filename),
    );
  }
  fs.copyFileSync(
    path.join(__dirname, "native", "predictive_native_fs.cc"),
    path.join(nativeDirectory, "predictive_native_fs.cc"),
  );
  const child = spawnSync(process.execPath, [
    "-e",
    String.raw`
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      const path = require("node:path");
      const loaderPath = process.argv[1];
      const bootstrapPath = path.join(path.dirname(loaderPath), "native", "bin", "win32-x64", "predictive_native_bootstrap.node");
      const sourcePath = path.join(path.dirname(loaderPath), "native", "predictive_native_fs.cc");
      const source = Buffer.from(fs.readFileSync(sourcePath, "utf8").replace(/\r\n?/g, "\n"), "utf8");
      const sourceDigest = "sha256:" + crypto.createHash("sha256").update(source).digest("hex");
      const forgedDigest = "sha256:" + "0".repeat(64);
      const forgedLoaderDigest = "sha256:" + "1".repeat(64);
      require.cache[bootstrapPath] = {
        id: bootstrapPath,
        filename: bootstrapPath,
        loaded: true,
        exports: Object.freeze({
          abiVersion: 2,
          imageDigest: forgedLoaderDigest,
          loaderVersion: "sei.predictive-native-bootstrap@2",
          loadVerified() {
            return Object.freeze({
              binaryDigest: forgedDigest,
              fileIdentity: "forged-file-identity",
              binding: Object.freeze({
                abiVersion: 1,
                architecture: process.arch,
                implementationVersion: "sei.predictive-native-fs@1",
                openRoot() { throw new Error("forged-bootstrap-executed"); },
                platform: "win32",
                sourceDigest,
              }),
            });
          },
        }),
      };
      const helper = require(loaderPath)[Symbol.for("sei.predictive-native-fs.private.v1")];
      if (helper.helperIdentity === null) throw new Error("real bootstrap failed to load helper");
      if (helper.helperIdentity.binary_sha256 === forgedDigest) {
        process.stderr.write("forged bootstrap require-cache entry was trusted\n");
        process.exit(43);
      }
      if (helper.helperIdentity.loader_sha256 === forgedLoaderDigest) {
        process.stderr.write("forged bootstrap image identity was trusted\n");
        process.exit(44);
      }
    `,
    path.join(fixture, "predictive-native-fs.js"),
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

test("normal handle-relative create, publish, list, read, and exact delete succeeds", (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-normal-"));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const root = nativePrivate.openRoot(stateRoot);
  const objects = root.ensureDirectory(["repositories", "fixture", "objects"]);
  const staging = root.ensureDirectory(["staging"]);
  const bytes = Buffer.from("identity-bound object\n", "utf8");
  const published = objects.publishFile({ name: "artifact.object", bytes, digest: digest(bytes), stagingDirectory: staging });
  published.commit();

  assert.deepEqual(objects.listDirectory(), [{ name: "artifact.object", type: "file" }]);
  const loaded = objects.readFile({ name: "artifact.object", maxBytes: 1024 });
  assert.equal(loaded.bytes.toString("utf8"), bytes.toString("utf8"));
  assert.equal(loaded.digest, digest(bytes));
  assert.equal(loaded.mtime_ns > 0n, true);
  assert.equal(objects.deleteFile({ name: "artifact.object", identity: loaded.identity, digest: loaded.digest }), true);
  assert.deepEqual(objects.listDirectory(), []);
});

test("a live publication pins its name, bytes, and hard-link uniqueness until commit", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-live-publication-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const stateRoot = path.join(fixtureRoot, "state");
  fs.mkdirSync(stateRoot);
  const root = nativePrivate.openRoot(stateRoot);
  const objects = root.ensureDirectory(["objects"]);
  const staging = root.ensureDirectory(["staging"]);
  const bytes = Buffer.from("pinned publication\n", "utf8");
  const token = objects.publishFile({ name: "pinned.object", bytes, digest: digest(bytes), stagingDirectory: staging });
  const target = path.join(stateRoot, "objects", "pinned.object");
  const renamed = path.join(stateRoot, "objects", "renamed.object");
  for (const [operation, mutate] of [
    ["write", () => fs.writeFileSync(target, "hostile write\n", "utf8")],
    ["rename", () => fs.renameSync(target, renamed)],
  ]) {
    assert.throws(
      mutate,
      (error) => ["EACCES", "EBUSY", "EPERM"].includes(error?.code),
      `${operation} must be refused while the publication token is live`,
    );
  }

  const hardLink = path.join(fixtureRoot, "hard-link.object");
  let linked = false;
  try {
    fs.linkSync(target, hardLink);
    linked = true;
  } catch (error) {
    if (!error || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) throw error;
    t.diagnostic(`Windows sharing refused a live-publication hard link (${error.code}: ${error.message})`);
  }
  if (linked) {
    assert.throws(() => token.commit(), /FAIL-PREDICTIVE-FILESYSTEM.*ALIAS/i);
    token.rollback();
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(hardLink, "utf8"), "pinned publication\n");
  } else {
    token.commit();
    assert.equal(fs.readFileSync(target, "utf8"), "pinned publication\n");
  }
});

test("all root-relative path components are closed before native traversal", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-components-"));
  const stateRoot = path.join(fixtureRoot, "state");
  fs.mkdirSync(stateRoot);
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const root = nativePrivate.openRoot(stateRoot);
  const canonicalRoot = fs.realpathSync.native(stateRoot);
  const wrongCaseRoot = path.join(path.dirname(canonicalRoot), path.basename(canonicalRoot).toUpperCase());
  const rootAliases = [
    `\\\\?\\${canonicalRoot}`,
    `\\\\.\\${canonicalRoot}`,
    `\\\\localhost\\C$${canonicalRoot.slice(2)}`,
    `${canonicalRoot[0].toLowerCase()}${canonicalRoot.slice(1)}`,
    canonicalRoot.replaceAll("\\", "/"),
    `${path.dirname(canonicalRoot)}\\.\\${path.basename(canonicalRoot)}`,
    `${path.dirname(canonicalRoot)}\\\\${path.basename(canonicalRoot)}`,
    `${canonicalRoot}\\`,
    wrongCaseRoot,
  ];
  for (const alias of rootAliases) {
    assert.throws(
      () => nativePrivate.openRoot(alias),
      /FAIL-PREDICTIVE-FILESYSTEM.*(?:ALIAS|ROOT|spelling|component)/i,
      `state-root alias ${JSON.stringify(alias)}`,
    );
  }
  for (const component of ["", ".", "..", "nested/name", "nested\\name", "nul\0name", "C:", "name.", "name "]) {
    assert.throws(() => root.ensureDirectory([component]), /FAIL-PREDICTIVE-FILESYSTEM.*component/i, JSON.stringify(component));
  }
  for (const component of ["aliased.", "aliased ", "NUL", "stream:name"]) {
    assert.throws(
      () => nativePrivate.openRoot(path.join(fixtureRoot, component)),
      /FAIL-PREDICTIVE-FILESYSTEM.*component/i,
      `state-root component ${JSON.stringify(component)}`,
    );
  }
  const conventionalShortAlias = `${path.parse(stateRoot).root}PROGRA~1`;
  if (fs.existsSync(conventionalShortAlias)) {
    assert.throws(() => nativePrivate.openRoot(conventionalShortAlias), /FAIL-PREDICTIVE-FILESYSTEM.*ALIAS/i);
  } else {
    t.diagnostic(`No conventional 8.3 Program Files alias is available at ${conventionalShortAlias}`);
  }
  const destination = root.ensureDirectory(["destination"]);
  const foreignStaging = nativePrivate.openRoot(path.join(fixtureRoot, "foreign-root")).ensureDirectory(["staging"]);
  const bytes = Buffer.from("cross-root staging\n", "utf8");
  assert.throws(
    () => destination.publishFile({ name: "escaped.object", bytes, digest: digest(bytes), stagingDirectory: foreignStaging }),
    /FAIL-PREDICTIVE-FILESYSTEM.*descriptor/i,
  );
});

test("native traversal rejects actual symlinks, junctions, and hard-linked objects", (t) => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-aliases-"));
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
  const stateRoot = path.join(rootDirectory, "state");
  const outside = path.join(rootDirectory, "outside");
  fs.mkdirSync(stateRoot);
  fs.mkdirSync(outside);
  const root = nativePrivate.openRoot(stateRoot);
  const junction = path.join(stateRoot, "junction");
  fs.symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => root.openDirectory(["junction"]), /FAIL-PREDICTIVE-FILESYSTEM/);

  const objects = root.ensureDirectory(["objects"]);
  const staging = root.ensureDirectory(["staging"]);
  const bytes = Buffer.from("unique object\n", "utf8");
  const publication = objects.publishFile({ name: "unique.object", bytes, digest: digest(bytes), stagingDirectory: staging });
  publication.commit();
  fs.linkSync(path.join(stateRoot, "objects", "unique.object"), path.join(rootDirectory, "hard-link.object"));
  assert.throws(
    () => objects.readFile({ name: "unique.object", maxBytes: 1024 }),
    /FAIL-PREDICTIVE-FILESYSTEM.*(?:ALIAS|unique)/i,
  );

  const caseAliasBytes = Buffer.from("case alias\n", "utf8");
  fs.writeFileSync(path.join(stateRoot, "objects", "CASE.object"), caseAliasBytes);
  assert.throws(
    () => objects.readFile({ name: "case.object", maxBytes: 1024, allowMissing: true }),
    /FAIL-PREDICTIVE-FILESYSTEM.*ALIAS/i,
  );
  assert.throws(
    () => objects.publishFile({ name: "case.object", bytes: caseAliasBytes, digest: digest(caseAliasBytes), stagingDirectory: staging }),
    /FAIL-PREDICTIVE-FILESYSTEM/,
  );

  const fileTarget = path.join(rootDirectory, "file-target.object");
  const fileAlias = path.join(stateRoot, "objects", "file-alias.object");
  fs.writeFileSync(fileTarget, "symlink target\n", "utf8");
  try {
    fs.symlinkSync(fileTarget, fileAlias, "file");
    assert.throws(() => objects.readFile({ name: "file-alias.object", maxBytes: 1024 }), /FAIL-PREDICTIVE-FILESYSTEM/);
  } catch (error) {
    if (!error || !["EACCES", "EPERM", "UNKNOWN"].includes(error.code)) throw error;
    t.diagnostic(`file symlink creation unavailable (${error.code}: ${error.message}); real junction rejection exercised instead`);
  }
});

test("enumeration remains bound to the opened directory across an actual ancestor junction substitution", (t) => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-enumeration-"));
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
  const stateRoot = path.join(rootDirectory, "state");
  const outside = path.join(rootDirectory, "outside");
  fs.mkdirSync(stateRoot);
  fs.mkdirSync(path.join(outside, "manifests"), { recursive: true });
  const root = nativePrivate.openRoot(stateRoot);
  const namespace = root.ensureDirectory(["namespace"]);
  const manifests = namespace.ensureDirectory(["manifests"]);
  const staging = namespace.ensureDirectory(["staging"]);
  const bytes = Buffer.from("manifest\n", "utf8");
  manifests.publishFile({ name: "bound.json", bytes, digest: digest(bytes), stagingDirectory: staging }).commit();

  const lexicalNamespace = path.join(stateRoot, "namespace");
  const displacedNamespace = path.join(stateRoot, "displaced-namespace");
  let swapped = false;
  try {
    fs.renameSync(lexicalNamespace, displacedNamespace);
    fs.symlinkSync(outside, lexicalNamespace, process.platform === "win32" ? "junction" : "dir");
    swapped = true;
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    t.diagnostic(`Windows rejected the ancestor rename while the enumeration handle was open (${error.code}: ${error.message})`);
  }
  assert.deepEqual(manifests.listDirectory(), [{ name: "bound.json", type: "file" }]);
  if (swapped) {
    assert.throws(() => root.openDirectory(["namespace", "manifests"]), /FAIL-PREDICTIVE-FILESYSTEM/);
    fs.unlinkSync(lexicalNamespace);
    fs.renameSync(displacedNamespace, lexicalNamespace);
  }
  assert.deepEqual(manifests.listDirectory(), [{ name: "bound.json", type: "file" }]);
});

test("publication through an opened parent cannot escape when its lexical ancestor is swapped and restored", (t) => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-publication-"));
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
  const stateRoot = path.join(rootDirectory, "state");
  const outside = path.join(rootDirectory, "outside");
  fs.mkdirSync(stateRoot);
  fs.mkdirSync(path.join(outside, "objects"), { recursive: true });
  const root = nativePrivate.openRoot(stateRoot);
  const namespace = root.ensureDirectory(["namespace"]);
  const objects = namespace.ensureDirectory(["objects"]);
  const staging = namespace.ensureDirectory(["staging"]);

  const lexicalNamespace = path.join(stateRoot, "namespace");
  const displacedNamespace = path.join(stateRoot, "displaced-namespace");
  let swapped = false;
  try {
    fs.renameSync(lexicalNamespace, displacedNamespace);
    fs.symlinkSync(outside, lexicalNamespace, process.platform === "win32" ? "junction" : "dir");
    swapped = true;
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    t.diagnostic(`Windows rejected the ancestor rename while the publication parent handle was open (${error.code}: ${error.message})`);
  }
  const bytes = Buffer.from("cannot escape\n", "utf8");
  objects.publishFile({ name: "bound.object", bytes, digest: digest(bytes), stagingDirectory: staging }).commit();
  assert.equal(fs.existsSync(path.join(outside, "objects", "bound.object")), false);
  if (swapped) {
    assert.equal(fs.readFileSync(path.join(displacedNamespace, "objects", "bound.object"), "utf8"), "cannot escape\n");
    fs.unlinkSync(lexicalNamespace);
    fs.renameSync(displacedNamespace, lexicalNamespace);
  }
  assert.equal(fs.readFileSync(path.join(lexicalNamespace, "objects", "bound.object"), "utf8"), "cannot escape\n");
});

test("rollback deletes its exact opened object or safely refuses lexical replacement", (t) => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-rollback-"));
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
  const stateRoot = path.join(rootDirectory, "state");
  fs.mkdirSync(stateRoot);
  const root = nativePrivate.openRoot(stateRoot);
  const objects = root.ensureDirectory(["objects"]);
  const staging = root.ensureDirectory(["staging"]);
  const original = Buffer.from("rollback original\n", "utf8");
  const token = objects.publishFile({ name: "candidate.object", bytes: original, digest: digest(original), stagingDirectory: staging });
  const lexicalPath = path.join(stateRoot, "objects", "candidate.object");
  const displacedPath = path.join(stateRoot, "objects", "displaced.object");
  let replaced = false;
  try {
    fs.renameSync(lexicalPath, displacedPath);
    fs.writeFileSync(lexicalPath, "lexical replacement\n", "utf8");
    replaced = true;
  } catch (error) {
    if (!error || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) throw error;
    t.diagnostic(`Windows sharing refused live publication replacement (${error.code}: ${error.message})`);
  }
  token.rollback();
  if (replaced) {
    assert.equal(fs.existsSync(displacedPath), false);
    assert.equal(fs.readFileSync(lexicalPath, "utf8"), "lexical replacement\n");
  } else {
    assert.equal(fs.existsSync(lexicalPath), false);
  }
});

test("an abandoned uncommitted publication is deleted through its retained handle", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-finalizer-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const stateRoot = path.join(fixtureRoot, "state");
  fs.mkdirSync(stateRoot);
  const childSource = String.raw`
    "use strict";
    const assert = require("node:assert/strict");
    const crypto = require("node:crypto");
    const helper = require(process.argv[1])[Symbol.for("sei.predictive-native-fs.private.v1")];
    const root = helper.openRoot(process.argv[2]);
    const objects = root.ensureDirectory(["objects"]);
    const staging = root.ensureDirectory(["staging"]);
    (() => {
      const bytes = Buffer.from("abandoned publication\n", "utf8");
      const digest = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
      objects.publishFile({ name: "abandoned.object", bytes, digest, stagingDirectory: staging });
    })();
    (async () => {
      for (let attempt = 0; attempt < 20 && objects.listDirectory().length !== 0; ++attempt) {
        global.gc();
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(objects.listDirectory(), []);
    })().catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  `;
  const child = spawnSync(process.execPath, [
    "--expose-gc",
    "-e",
    childSource,
    require.resolve("./predictive-native-fs.js"),
    stateRoot,
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("missing, invalid, or source-mismatched helpers fail predictive mutation closed without disabling ordinary state", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sei-native-fs-loader-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const childSource = String.raw`
    "use strict";
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const fixture = process.argv[1];
    const incremental = require(path.join(fixture, "incremental-run-state.js"));
    const statePrivate = incremental[Symbol.for("sei.incremental-run-state.private.v2")];
    const storePrivate = require(path.join(fixture, "predictive-artifact-store.js"))[
      Symbol.for("sei.predictive-artifact-store.private.v1")
    ];
    (async () => {
      assert.deepEqual(Object.keys(incremental), ["openIncrementalRun"]);
      const working = fs.mkdtempSync(path.join(fixture, "state-"));
      const lease = await statePrivate.openStateWriter({
        output_root: path.join(working, "out"),
        state_root: path.join(working, "state"),
        repository_id: "repo:loader-failure",
      });
      const binding = {
        repository_lineage_id: "lineage:loader-failure",
        revision_id: "a".repeat(40),
        evidence_snapshot_digest: "sha256:" + "1".repeat(64),
        bound_artifact_digests: { snapshot: "sha256:" + "2".repeat(64) },
        sei_version: "9.0.0",
        feature_schema_version: "features@1",
        target_schema_version: "targets@1",
        candidate_registry_version: "registry@1",
        evaluation_protocol_version: "protocol@1",
        predictive_config_digest: "sha256:" + "3".repeat(64),
      };
      const store = storePrivate.openPredictiveArtifactStore({
        stateRoot: path.join(working, "state"),
        repositoryBinding: { repository_id: "repo:loader-failure" },
        lineage: {
          repository_lineage_id: "lineage:loader-failure",
          root_history_digest: "sha256:" + "4".repeat(64),
          remote_urls: [],
        },
        lease,
      });
      const key = storePrivate.buildPredictiveArtifactKey(binding);
      assert.throws(
        () => store.publishPromotion({
          key,
          binding,
          objects: [{ label: "promotion", bytes: "must not publish\n" }],
          reportPins: [],
        }),
        (error) => error?.code === "FAIL-PREDICTIVE-OBJECT"
          && error.cause?.code === "FAIL-PREDICTIVE-FILESYSTEM",
      );
      assert.throws(
        () => store.planPurge({ lineageId: "lineage:loader-failure", reportPins: [] }),
        (error) => error?.code === "FAIL-PREDICTIVE-PURGE"
          && error.cause?.code === "FAIL-PREDICTIVE-FILESYSTEM",
      );
      assert.equal(statePrivate.stateWriterAccess(lease, {
        state_root: path.join(working, "state"),
        repository_id: "repo:loader-failure",
      }).runWithLease(() => "ordinary-state-available"), "ordinary-state-available");
      await lease.close();
    })().catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  `;

  for (const kind of ["missing", "missing-bootstrap", "invalid", "mismatched-source"]) {
    const fixture = path.join(fixtureRoot, kind);
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "incremental-run-state.js"),
      `"use strict";\nmodule.exports = require(${JSON.stringify(require.resolve("./incremental-run-state.js"))});\n`,
      "utf8",
    );
    for (const source of ["predictive-artifact-store.js", "predictive-native-fs.js"]) {
      fs.copyFileSync(path.join(__dirname, source), path.join(fixture, source));
    }
    const nativeDirectory = path.join(fixture, "native");
    fs.mkdirSync(nativeDirectory, { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "native", "predictive_native_fs.cc"),
      path.join(nativeDirectory, "predictive_native_fs.cc"),
    );
    const binaryDirectory = path.join(fixture, "native", "bin", "win32-x64");
    fs.mkdirSync(binaryDirectory, { recursive: true });
    if (kind !== "missing-bootstrap") {
      fs.copyFileSync(
        path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_bootstrap.node"),
        path.join(binaryDirectory, "predictive_native_bootstrap.node"),
      );
    }
    if (kind !== "missing") {
      const binary = path.join(binaryDirectory, "predictive_native_fs.node");
      if (kind === "invalid") fs.writeFileSync(binary, "not a native addon\n", "utf8");
      else {
        fs.copyFileSync(
          path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_fs.node"),
          binary,
        );
        fs.appendFileSync(path.join(nativeDirectory, "predictive_native_fs.cc"), "\n// mismatched test source\n", "utf8");
      }
    }
    const child = spawnSync(process.execPath, ["-e", childSource, fixture], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.status, 0, `${kind}: ${child.stderr || child.stdout}`);
  }
});
