"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CACHE_SCHEMA_VERSION = 1;
const inFlight = new Map();

function stableStringify(value) {
  if (value === undefined) return '"__undefined__"';
  if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(String(value));
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Buffer.isBuffer(value)) return JSON.stringify({ type: "Buffer", data: value.toString("base64") });
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : stableStringify(value));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function defaultCacheRoot(env = process.env, platform = process.platform) {
  if (env.REPOSITORY_ANALYSIS_CACHE_DIR) return path.resolve(env.REPOSITORY_ANALYSIS_CACHE_DIR);
  if (platform === "win32") return path.join(env.LOCALAPPDATA || env.TEMP || os.tmpdir(), "repository-analysis-cache");
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, "repository-analysis-cache");
  if (env.HOME) return path.join(env.HOME, ".cache", "repository-analysis-cache");
  return path.join(os.tmpdir(), "repository-analysis-cache");
}

function segment(value) { return sha256(String(value || "unknown")); }

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new Error("CACHE_DESCRIPTOR_INVALID:descriptor");
  const required = [
    "namespace", "repository_key", "lane_id", "contract_version",
    "input_fingerprint", "dependency_fingerprint", "environment_fingerprint",
    "source_revision", "working_tree_fingerprint"
  ];
  for (const field of required) if (typeof descriptor[field] !== "string" || !descriptor[field]) throw new Error("CACHE_DESCRIPTOR_INVALID:" + field);
  return descriptor;
}

function descriptorKey(descriptor) {
  validateDescriptor(descriptor);
  return sha256({
    schema_version: CACHE_SCHEMA_VERSION,
    namespace: descriptor.namespace,
    repository_key: descriptor.repository_key,
    lane_id: descriptor.lane_id,
    contract_version: descriptor.contract_version,
    input_fingerprint: descriptor.input_fingerprint,
    dependency_fingerprint: descriptor.dependency_fingerprint,
    environment_fingerprint: descriptor.environment_fingerprint,
    scope: descriptor.scope || null
  });
}

function classifyReuse(entry, descriptor) {
  validateDescriptor(descriptor);
  if (!entry) return "miss";
  if (entry.schema_version !== CACHE_SCHEMA_VERSION || entry.namespace !== descriptor.namespace || entry.repository_key !== descriptor.repository_key || entry.lane_id !== descriptor.lane_id || entry.contract_version !== descriptor.contract_version) return "miss";
  const stable = entry.input_fingerprint === descriptor.input_fingerprint && entry.dependency_fingerprint === descriptor.dependency_fingerprint && entry.environment_fingerprint === descriptor.environment_fingerprint && stableStringify(entry.scope || null) === stableStringify(descriptor.scope || null);
  if (!stable) return "warm-only";
  return entry.source_revision === descriptor.source_revision && entry.working_tree_fingerprint === descriptor.working_tree_fingerprint ? "exact" : "content-stable";
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) { /* best effort */ }
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === "EPERM"; }
}

class CacheStore {
  constructor(root = defaultCacheRoot()) {
    this.root = path.resolve(root);
  }

  directory(descriptor) {
    validateDescriptor(descriptor);
    return path.join(this.root, "v" + CACHE_SCHEMA_VERSION, segment(descriptor.namespace), segment(descriptor.repository_key), segment(descriptor.lane_id));
  }

  entryPath(descriptor) { return path.join(this.directory(descriptor), descriptorKey(descriptor) + ".json"); }
  latestPath(descriptor) { return path.join(this.directory(descriptor), "latest.json"); }
  lockPath(descriptor) { return this.entryPath(descriptor) + ".lock"; }

  readFile(filePath) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!value || value.schema_version !== CACHE_SCHEMA_VERSION || value.output_sha256 !== sha256(value.payload)) return null;
      return value;
    } catch (_) { return null; }
  }

  lookup(descriptor) {
    validateDescriptor(descriptor);
    const exact = this.readFile(this.entryPath(descriptor));
    if (exact) return { reuse: classifyReuse(exact, descriptor), entry: exact };
    const pointer = this.readFile(this.latestPath(descriptor));
    const entryName = pointer && pointer.payload && pointer.payload.entry_path;
    if (typeof entryName === "string" && entryName === path.basename(entryName) && entryName.endsWith(".json")) {
      const warm = this.readFile(path.join(this.directory(descriptor), entryName));
      if (warm && pointer.payload.key === warm.key) {
        const reuse = classifyReuse(warm, descriptor);
        return reuse === "miss" ? { reuse: "miss", entry: null } : { reuse, entry: warm };
      }
    }
    return { reuse: "miss", entry: null };
  }

  put(descriptor, payload, metadata = {}) {
    validateDescriptor(descriptor);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("CACHE_METADATA_INVALID");
    // Fail before acquiring an output path if the payload cannot be persisted.
    JSON.stringify(payload);
    const key = descriptorKey(descriptor);
    const entry = {
      schema_version: CACHE_SCHEMA_VERSION,
      key,
      namespace: descriptor.namespace,
      repository_key: descriptor.repository_key,
      lane_id: descriptor.lane_id,
      contract_version: descriptor.contract_version,
      input_fingerprint: descriptor.input_fingerprint,
      dependency_fingerprint: descriptor.dependency_fingerprint,
      environment_fingerprint: descriptor.environment_fingerprint,
      source_revision: descriptor.source_revision,
      working_tree_fingerprint: descriptor.working_tree_fingerprint,
      scope: descriptor.scope || null,
      created_at: metadata.created_at || new Date().toISOString(),
      provenance: metadata.provenance || null,
      coverage: metadata.coverage || null,
      payload,
      output_sha256: sha256(payload)
    };
    const entryPath = this.entryPath(descriptor);
    atomicWrite(entryPath, entry);
    const pointerPayload = { key, entry_path: path.basename(entryPath) };
    atomicWrite(this.latestPath(descriptor), {
      schema_version: CACHE_SCHEMA_VERSION,
      namespace: descriptor.namespace,
      repository_key: descriptor.repository_key,
      lane_id: descriptor.lane_id,
      contract_version: descriptor.contract_version,
      payload: pointerPayload,
      output_sha256: sha256(pointerPayload)
    });
    return entry;
  }

  async acquire(descriptor, options = {}) {
    validateDescriptor(descriptor);
    const lockPath = this.lockPath(descriptor);
    const ownerPath = path.join(lockPath, "owner.json");
    const timeoutMs = Number.isFinite(options.timeout_ms) && options.timeout_ms > 0 ? options.timeout_ms : 300000;
    const staleMs = Number.isFinite(options.stale_ms) && options.stale_ms > 0 ? options.stale_ms : 900000;
    const heartbeatMs = Number.isFinite(options.heartbeat_ms) && options.heartbeat_ms > 0 ? options.heartbeat_ms : Math.max(1000, Math.min(30000, Math.floor(staleMs / 3)));
    const started = Date.now();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    while (Date.now() - started <= timeoutMs) {
      try {
        fs.mkdirSync(lockPath);
        const owner = { pid: process.pid, hostname: os.hostname(), created_at: new Date().toISOString() };
        fs.writeFileSync(ownerPath, JSON.stringify(owner), "utf8");
        const heartbeat = setInterval(() => {
          try {
            const now = new Date();
            fs.utimesSync(ownerPath, now, now);
          } catch (_) { /* lock may be releasing */ }
        }, heartbeatMs);
        if (typeof heartbeat.unref === "function") heartbeat.unref();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          let owner = null;
          try { owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); } catch (_) { /* malformed owner */ }
          const statPath = fs.existsSync(ownerPath) ? ownerPath : lockPath;
          const age = Date.now() - fs.statSync(statPath).mtimeMs;
          const liveLocalOwner = owner && owner.hostname === os.hostname() && processAlive(Number(owner.pid));
          if (age > staleMs && !liveLocalOwner) { fs.rmSync(lockPath, { recursive: true, force: true }); continue; }
        } catch (_) { /* retry */ }
        await sleep(20 + Math.floor(Math.random() * 30));
      }
    }
    throw new Error("CACHE_LOCK_TIMEOUT:" + descriptor.lane_id);
  }

  async getOrCompute(descriptor, compute, options = {}) {
    validateDescriptor(descriptor);
    if (typeof compute !== "function") throw new Error("CACHE_COMPUTE_INVALID");
    const lookup = this.lookup(descriptor);
    if (lookup.reuse === "exact" || lookup.reuse === "content-stable") return { ...lookup, cache_hit: true, payload: lookup.entry.payload };
    const key = this.entryPath(descriptor);
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      const release = await this.acquire(descriptor, options);
      try {
        const second = this.lookup(descriptor);
        if (second.reuse === "exact" || second.reuse === "content-stable") return { ...second, cache_hit: true, payload: second.entry.payload };
        const payload = await compute({ warm: second.reuse === "warm-only" ? second.entry && second.entry.payload : null, reuse: second.reuse });
        const entry = this.put(descriptor, payload, options.metadata || {});
        return { reuse: "miss", prior_reuse: second.reuse, cache_hit: false, entry, payload };
      } finally { release(); }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }
}

module.exports = { CACHE_SCHEMA_VERSION, stableStringify, sha256, defaultCacheRoot, validateDescriptor, descriptorKey, classifyReuse, CacheStore };
