"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PREDICTIVE_NATIVE_FS_VERSION = "sei.predictive-native-fs@1";
const PRIVATE_SYMBOL = Symbol.for("sei.predictive-native-fs.private.v1");
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_COMPONENTS = 64;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const directoryBrand = new WeakSet();
const directoryNative = new WeakMap();
const directoryRoot = new WeakMap();
const publicationBrand = new WeakSet();

function nativeFailure(detail, cause = undefined) {
  const error = cause === undefined
    ? new Error(`FAIL-PREDICTIVE-FILESYSTEM: ${detail}`)
    : new Error(`FAIL-PREDICTIVE-FILESYSTEM: ${detail}`, { cause });
  error.code = "FAIL-PREDICTIVE-FILESYSTEM";
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value)
    && JSON.stringify(Reflect.ownKeys(value).filter((key) => typeof key === "string").sort()) === JSON.stringify([...keys].sort());
}

function validateComponent(component) {
  if (typeof component !== "string" || component.length === 0 || component.length > 255
      || component === "." || component === ".." || /[\0/\\]/.test(component)) {
    throw nativeFailure("path component is not closed");
  }
  if (process.platform === "win32") {
    const basename = component.split(".", 1)[0].toUpperCase();
    if (component.includes(":") || /[. ]$/.test(component)
        || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(basename)) {
      throw nativeFailure("path component is a Windows alias");
    }
  }
  return component;
}

function validateComponents(components) {
  if (!Array.isArray(components) || components.length === 0 || components.length > MAX_COMPONENTS) {
    throw nativeFailure("path components exceed the closed bound");
  }
  return components.map(validateComponent);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function binaryPath() {
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  return path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_fs.node");
}

function bootstrapPath() {
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  return path.join(__dirname, "native", "bin", "win32-x64", "predictive_native_bootstrap.node");
}

function loadBinding() {
  const candidate = binaryPath();
  const bootstrapCandidate = bootstrapPath();
  if (candidate === null || bootstrapCandidate === null) {
    throw nativeFailure(`full predictive filesystem containment is unsupported on ${process.platform}/${process.arch}`);
  }
  let sourceBytes;
  try {
    sourceBytes = fs.readFileSync(path.join(__dirname, "native", "predictive_native_fs.cc"));
  } catch (error) {
    throw nativeFailure(`native helper source is unavailable (${error.code ?? error.message})`, error);
  }
  const canonicalSource = Buffer.from(sourceBytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
  const sourceDigest = sha256(canonicalSource);
  let bootstrap;
  try {
    const bootstrapModule = { exports: {}, filename: bootstrapCandidate };
    process.dlopen(bootstrapModule, bootstrapCandidate);
    bootstrap = bootstrapModule.exports;
  } catch (error) {
    throw nativeFailure(`trusted native bootstrap could not be loaded (${error.code ?? error.message})`, error);
  }
  if (!exactKeys(bootstrap, ["abiVersion", "imageDigest", "loaderVersion", "loadVerified"])
      || bootstrap.abiVersion !== 2
      || !SHA256.test(bootstrap.imageDigest)
      || bootstrap.loaderVersion !== "sei.predictive-native-bootstrap@2"
      || typeof bootstrap.loadVerified !== "function") {
    throw nativeFailure("trusted native bootstrap ABI is incompatible");
  }
  let verified;
  try {
    verified = bootstrap.loadVerified(candidate);
  } catch (error) {
    throw nativeFailure(`native helper artifact could not be verified and loaded (${error.code ?? error.message})`, error);
  }
  if (!exactKeys(verified, ["binaryDigest", "binding", "fileIdentity"])
      || !SHA256.test(verified.binaryDigest)
      || typeof verified.fileIdentity !== "string" || verified.fileIdentity.length === 0
      || !isRecord(verified.binding)) {
    throw nativeFailure("trusted native bootstrap returned an incompatible image binding");
  }
  const binding = verified.binding;
  const expectedPlatform = process.platform === "win32" ? "win32" : "posix";
  if (!exactKeys(binding, ["abiVersion", "architecture", "implementationVersion", "openRoot", "openRootReadOnly", "platform", "sourceDigest"])
      || binding.abiVersion !== 1
      || binding.architecture !== process.arch
      || binding.implementationVersion !== PREDICTIVE_NATIVE_FS_VERSION
      || binding.platform !== expectedPlatform
      || binding.sourceDigest !== sourceDigest
      || typeof binding.openRoot !== "function"
      || typeof binding.openRootReadOnly !== "function") {
    throw nativeFailure("native helper ABI or identity is incompatible");
  }
  return {
    binding,
    identity: Object.freeze({
      abi_version: binding.abiVersion,
      architecture: process.arch,
      binary_sha256: verified.binaryDigest,
      loader_sha256: bootstrap.imageDigest,
      loader_version: bootstrap.loaderVersion,
      platform: process.platform,
      source_sha256: sourceDigest,
      version: binding.implementationVersion,
    }),
  };
}

let loaded = null;
let loadFailure = null;
try {
  loaded = loadBinding();
} catch (error) {
  loadFailure = error;
}

function callNative(operation, callback) {
  try {
    return callback();
  } catch (error) {
    if (error?.code === "FAIL-PREDICTIVE-FILESYSTEM") throw error;
    const reason = typeof error?.reason === "string" ? `/${error.reason}` : "";
    throw nativeFailure(`${operation} failed${reason} (${error?.message ?? "unknown native error"})`, error);
  }
}

function wrapPublication(nativePublication) {
  if (!exactKeys(nativePublication, ["commit", "digest", "identity", "rollback", "size"])
      || typeof nativePublication.commit !== "function" || typeof nativePublication.rollback !== "function"
      || typeof nativePublication.identity !== "string" || !SHA256.test(nativePublication.digest)
      || !Number.isSafeInteger(nativePublication.size) || nativePublication.size <= 0 || nativePublication.size > MAX_FILE_BYTES) {
    throw nativeFailure("native publication token is incompatible");
  }
  let complete = false;
  const publication = {
    identity: nativePublication.identity,
    digest: nativePublication.digest,
    size: nativePublication.size,
    commit() {
      if (complete) throw nativeFailure("publication token is already closed");
      callNative("publication commit", () => nativePublication.commit());
      complete = true;
    },
    rollback() {
      if (complete) throw nativeFailure("publication token is already closed");
      callNative("publication rollback", () => nativePublication.rollback());
      complete = true;
    },
  };
  Object.freeze(publication);
  publicationBrand.add(publication);
  return publication;
}

function wrapDirectory(nativeDirectory, rootToken) {
  if (!exactKeys(nativeDirectory, ["delete", "ensure", "identity", "list", "listBounded", "open", "openReadOnly", "publish", "read"])
      || typeof nativeDirectory.identity !== "string"
      || ["delete", "ensure", "list", "listBounded", "open", "openReadOnly", "publish", "read"].some((name) => typeof nativeDirectory[name] !== "function")) {
    throw nativeFailure("native directory capability is incompatible");
  }
  const directory = {
    identity: nativeDirectory.identity,
    openDirectory(components) {
      const opened = callNative("directory open", () => nativeDirectory.open(validateComponents(components)));
      return opened === null ? null : wrapDirectory(opened, rootToken);
    },
    ensureDirectory(components) {
      return wrapDirectory(callNative("directory creation", () => nativeDirectory.ensure(validateComponents(components))), rootToken);
    },
    listDirectory() {
      const entries = callNative("directory enumeration", () => nativeDirectory.list());
      if (!Array.isArray(entries) || entries.some((entry) => !exactKeys(entry, ["name", "type"])
          || typeof entry.name !== "string" || !["directory", "file", "other", "reparse"].includes(entry.type))) {
        throw nativeFailure("native directory enumeration returned an incompatible entry");
      }
      return Object.freeze(entries.map((entry) => Object.freeze({ name: entry.name, type: entry.type })));
    },
    readFile({ name, maxBytes, allowMissing = false } = {}) {
      validateComponent(name);
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_FILE_BYTES || typeof allowMissing !== "boolean") {
        throw nativeFailure("native read bound is invalid");
      }
      const result = callNative("immutable read", () => nativeDirectory.read(name, maxBytes, allowMissing));
      if (result === null) return null;
      if (!exactKeys(result, ["bytes", "digest", "identity", "mtime_ns", "size"])
          || !Buffer.isBuffer(result.bytes) || !SHA256.test(result.digest) || typeof result.identity !== "string"
          || typeof result.mtime_ns !== "bigint" || !Number.isSafeInteger(result.size)
          || result.size !== result.bytes.length || result.size <= 0 || result.size > maxBytes
          || sha256(result.bytes) !== result.digest) {
        throw nativeFailure("native immutable read result is incompatible");
      }
      return Object.freeze({ ...result });
    },
    publishFile({ name, bytes, digest, stagingDirectory } = {}) {
      validateComponent(name);
      if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > MAX_FILE_BYTES
          || !SHA256.test(digest) || sha256(bytes) !== digest
          || !directoryBrand.has(stagingDirectory) || !directoryNative.has(stagingDirectory)
          || directoryRoot.get(stagingDirectory) !== rootToken) {
        throw nativeFailure("native publication descriptor is invalid");
      }
      return wrapPublication(callNative(
        "exclusive publication",
        () => nativeDirectory.publish(name, bytes, digest, directoryNative.get(stagingDirectory)),
      ));
    },
    deleteFile({ name, identity, digest } = {}) {
      validateComponent(name);
      if (typeof identity !== "string" || identity.length === 0 || !SHA256.test(digest)) {
        throw nativeFailure("native delete binding is invalid");
      }
      return callNative("exact deletion", () => nativeDirectory.delete(name, identity, digest));
    },
  };
  Object.defineProperties(directory, {
    openDirectoryReadOnly: {
      enumerable: false,
      value(components) {
        const opened = callNative("read-only directory open", () => nativeDirectory.openReadOnly(validateComponents(components)));
        return opened === null ? null : wrapDirectory(opened, rootToken);
      },
    },
    listDirectoryBounded: {
      enumerable: false,
      value(maxEntries) {
        if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 4096) {
          throw nativeFailure("native directory enumeration bound is invalid");
        }
        const entries = callNative("bounded directory enumeration", () => nativeDirectory.listBounded(maxEntries));
        if (!Array.isArray(entries) || entries.length > maxEntries || entries.some((entry) => !exactKeys(entry, ["name", "type"])
            || typeof entry.name !== "string" || !["directory", "file", "other", "reparse"].includes(entry.type))) {
          throw nativeFailure("native bounded directory enumeration returned an incompatible entry");
        }
        return Object.freeze(entries.map((entry) => Object.freeze({ name: entry.name, type: entry.type })));
      },
    },
  });
  Object.freeze(directory);
  directoryBrand.add(directory);
  directoryNative.set(directory, nativeDirectory);
  directoryRoot.set(directory, rootToken);
  return directory;
}

function openRoot(absolutePath) {
  if (loaded === null) throw nativeFailure("native helper is unavailable", loadFailure);
  if (typeof absolutePath !== "string" || absolutePath.length === 0 || absolutePath.includes("\0") || !path.isAbsolute(absolutePath)) {
    throw nativeFailure("state root must be an absolute NUL-free path");
  }
  return wrapDirectory(callNative("root open", () => loaded.binding.openRoot(absolutePath)), Object.freeze({}));
}

function openRootReadOnly(absolutePath) {
  if (loaded === null) throw nativeFailure("native helper is unavailable", loadFailure);
  if (typeof absolutePath !== "string" || absolutePath.length === 0 || absolutePath.includes("\0") || !path.isAbsolute(absolutePath)) {
    throw nativeFailure("state root must be an absolute NUL-free path");
  }
  const opened = callNative("read-only root open", () => loaded.binding.openRootReadOnly(absolutePath));
  return opened === null ? null : wrapDirectory(opened, Object.freeze({}));
}

module.exports = {};
const privateApi = {
  PREDICTIVE_NATIVE_FS_VERSION,
  helperIdentity: loaded?.identity ?? null,
  openRoot,
};
Object.defineProperty(privateApi, "openRootReadOnly", {
  enumerable: false,
  value: openRootReadOnly,
});
Object.defineProperty(module.exports, PRIVATE_SYMBOL, {
  value: Object.freeze(privateApi),
});
Object.freeze(module.exports);
