"use strict";
// architecture.evidence-binding@1 (composite-scoring-v3 §5.2, §6.1–§6.3).
//
// Binds Architecture's evidence to Evidence Recon packet bytes so that RIA can
// derive §6.1 evidence keys for each scored fitness sub-dimension:
//   * evidence_packet_refs[] are structured refs to content-addressed packet files;
//   * every scored fitness dimension cites the claims it used by a packet-qualified
//     ref "evidence-recon:<packet sha256>#<claim_id | negative_claim_id>";
//   * each cited claim must declare it supports that dimension, and every code
//     source it cites must exist at the bound revision inside the assessed scope.
// A valid packet is structure only: quality is capped by epistemic status and
// coverage, provenance survives repackaging (a packet produced by another owner,
// or a claim citing another owner's artifact, stays adopted), and nothing here
// confirms a defect (§7.2 is computed elsewhere, from proofs).
//
// The writer calls this in "write" mode (everything must resolve). RIA calls it in
// "consume" mode on every run, including continue and report-only: tampering,
// dangling refs and binding mismatches still block, while a packet file or
// revision that is legitimately unavailable leaves that evidence missing.

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BINDING_VERSION = "architecture.evidence-binding@1";
const ARCHITECTURE_OWNER = "architecture-improvement-intelligence";
const ROOT_ID = "root-0";
const QUALIFIED_REF = /^evidence-recon:([a-f0-9]{64})#([A-Za-z0-9][A-Za-z0-9._:-]*)$/;
const UNQUALIFIED_CLAIM_REF = /^(?:claim|negative):/;
const PACKET_REF_KEYS = Object.freeze(["kind", "artifact_id", "sha256", "path", "packet_id", "producer_skill", "binding"]);
const PRODUCER_OWNERS = Object.freeze({ "repository-health-assessment": "health", "codebase-integrity-audit-loop": "integrity", "software-engineering-intelligence": "sei", [ARCHITECTURE_OWNER]: "architecture" });
// Source refs naming another owner's artifact mark the claim as adopted from that owner.
const FOREIGN_REF_PREFIXES = Object.freeze([["health-assessment:", "health"], ["health-artifact:", "health"], ["health:", "health"], ["integrity:", "integrity"], ["sei-criterion:", "sei"], ["sei:", "sei"], ["engineering-intelligence:", "sei"]]);
const QUALITY_RANK = Object.freeze({ weak: 1, moderate: 2, strong: 3 });
const SUPPORTABLE_COVERAGE = Object.freeze(["inspected", "sampled"]);

function fail(code, detail) { const error = new Error(`FAIL-ARCHITECTURE-EVIDENCE-${code}: ${detail}`); error.code = `FAIL-ARCHITECTURE-EVIDENCE-${code}`; throw error; }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function minQuality(a, b) { return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b; }
function supportsTag(dimensionId) { return `architecture-fitness:${dimensionId}`; }
function evidenceRecon() { return require(path.resolve(__dirname, "..", "..", "shared", "evidence-recon", "evidence-recon.js")); }
function evidenceModel() { return require(path.resolve(__dirname, "..", "..", "shared", "ria-scoring", "evidence-model.js")); }
function contained(root, candidate) { const relative = path.relative(root, candidate); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); }
function realOrNull(target) { try { return fs.realpathSync(target); } catch { return null; } }

/** The repository binding RIA evidence keys use for this run (§6.1). */
function bindingFromEnvelope(envelope) {
  const baseline = envelope?.baseline_ref;
  if (!nonempty(baseline?.artifact_id) || !nonempty(baseline?.repository_revision)) fail("BINDING-MISMATCH", "the envelope baseline_ref needs artifact_id and repository_revision");
  return { repository_id: baseline.artifact_id, root_id: ROOT_ID, revision: baseline.repository_revision };
}
function sameBinding(a, b) { return object(a) && object(b) && a.repository_id === b.repository_id && a.root_id === b.root_id && a.revision === b.revision && Object.keys(a).length === 3; }

/** Builds the structured ref a candidate set records for one stored packet file. */
function packetRefFor(packetPath, binding) {
  const bytes = fs.readFileSync(packetPath);
  const packet = JSON.parse(bytes.toString("utf8"));
  const digest = sha256(bytes);
  return { kind: "evidence-recon", artifact_id: `evidence-recon:${digest}`, sha256: digest, path: path.resolve(packetPath), packet_id: packet.packet_id, producer_skill: packet.producer?.skill, binding: { repository_id: binding.repository_id, root_id: binding.root_id, revision: binding.revision } };
}

function checkPacketRefShape(ref, index) {
  const at = `evidence_packet_refs[${index}]`;
  if (!object(ref)) fail("PACKET-REF", `${at} must be a structured evidence-recon ref under --ria-envelope, not ${JSON.stringify(ref)}`);
  const unknown = Object.keys(ref).filter(key => !PACKET_REF_KEYS.includes(key));
  if (unknown.length || PACKET_REF_KEYS.some(key => !Object.hasOwn(ref, key))) fail("PACKET-REF", `${at} must have exactly ${PACKET_REF_KEYS.join(", ")}`);
  if (ref.kind !== "evidence-recon" || !/^[a-f0-9]{64}$/.test(String(ref.sha256)) || ref.artifact_id !== `evidence-recon:${ref.sha256}`) fail("PACKET-REF", `${at} needs kind evidence-recon and artifact_id evidence-recon:<sha256>`);
  if (!nonempty(ref.path) || !path.isAbsolute(ref.path) || !nonempty(ref.packet_id) || !nonempty(ref.producer_skill)) fail("PACKET-REF", `${at} needs an absolute path, packet_id and producer_skill`);
}

/** Reads, contains, hashes, parses and validates one packet. Returns
 * { status: "bound", packet } or, in consume mode only, { status: "unavailable" }. */
function loadPacket(ref, index, { allowedRoots, binding, mode }) {
  checkPacketRefShape(ref, index);
  if (!sameBinding(ref.binding, binding)) fail("BINDING-MISMATCH", `${ref.artifact_id} is bound to ${JSON.stringify(ref.binding)}, expected ${JSON.stringify(binding)}`);
  const roots = allowedRoots.map(root => realOrNull(path.resolve(root))).filter(Boolean);
  const lexical = path.resolve(ref.path);
  const parent = realOrNull(path.dirname(lexical));
  const located = parent ? path.join(parent, path.basename(lexical)) : lexical;
  if (!roots.some(root => contained(root, located))) fail("PATH-ESCAPE", `${ref.artifact_id} must live under the repository workspace or the RIA runtime root`);
  if (!fs.existsSync(lexical)) {
    if (mode === "write") fail("PACKET-MISSING", `${ref.artifact_id} not found at ${lexical}`);
    return { status: "unavailable", reason: "packet-file-missing" };
  }
  const real = fs.realpathSync(lexical);
  if (!roots.some(root => contained(root, real))) fail("PATH-ESCAPE", `${ref.artifact_id} resolves outside the allowed roots`);
  const bytes = fs.readFileSync(real);
  if (sha256(bytes) !== ref.sha256) fail("HASH-MISMATCH", `${ref.artifact_id} bytes changed at ${lexical}`);
  let packet;
  try { packet = JSON.parse(bytes.toString("utf8")); } catch (error) { fail("PACKET-INVALID", `${ref.artifact_id} is not JSON: ${error.message}`); }
  const validation = evidenceRecon().validateEvidencePacket(packet);
  if (!validation.ok) fail("PACKET-INVALID", `${ref.artifact_id}: ${validation.problems.map(p => `[${p.code}] ${p.path}`).join("; ")}`);
  if (packet.packet_id !== ref.packet_id || packet.producer.skill !== ref.producer_skill) fail("PACKET-REF", `${ref.artifact_id} packet_id or producer_skill differs from the packet bytes`);
  return { status: "bound", packet };
}

function lineTotal(text) { return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0); }
function isCommit(repositoryRoot, revision) {
  try { childProcess.execFileSync("git", ["-C", repositoryRoot, "cat-file", "-e", `${revision}^{commit}`], { windowsHide: true, stdio: "ignore" }); return true; } catch { return false; }
}
/** Where cited source files are read. A clean single-root baseline names a Git commit;
 * a multi-root baseline or a dirty working tree is bound by a composite fingerprint, so
 * the sources are read from the working tree that fingerprint covers (RIA chooses from the
 * baseline's root record; the writer, which only holds the envelope, from the revision). */
function sourceSnapshotFor(repositoryRoot, revision) {
  return isCommit(repositoryRoot, revision) ? { kind: "git", revision } : { kind: "worktree" };
}
/** Returns lineCount(path) -> { state: "present", lines } | { state: "absent" } | { state: "unavailable" }.
 * Only a regular source file counts as present, with the same meaning in both readers: at a
 * Git revision the path must name a blob of mode 100644 or 100755 (a tree, symlink or
 * submodule is absent); in the working tree it must be a regular file, not a symlink, whose
 * real path stays inside the repository (a directory or a link is absent). */
function revisionReader(repositoryRoot, snapshot) {
  const cache = new Map();
  const gitUsable = snapshot.kind === "git" ? isCommit(repositoryRoot, snapshot.revision) : null;
  return function lineCount(relativePath) {
    if (cache.has(relativePath)) return cache.get(relativePath);
    let result;
    if (snapshot.kind === "worktree") {
      const file = path.resolve(repositoryRoot, relativePath);
      if (!contained(path.resolve(repositoryRoot), file)) result = { state: "absent" };
      else if (!fs.existsSync(repositoryRoot)) result = { state: "unavailable" };
      else {
        try {
          const realRoot = fs.realpathSync(repositoryRoot);
          result = fs.lstatSync(file).isFile() && contained(realRoot, fs.realpathSync(file)) ? { state: "present", lines: lineTotal(fs.readFileSync(file, "utf8")) } : { state: "absent" };
        } catch { result = { state: "absent" }; }
      }
    } else if (!gitUsable) result = { state: "unavailable" };
    else {
      try {
        const git = (args) => childProcess.execFileSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
        const entry = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([^\0]*)\0?$/.exec(git(["ls-tree", "-z", "--full-name", snapshot.revision, "--", relativePath]));
        result = entry && entry[2] === "blob" && ["100644", "100755"].includes(entry[1]) && entry[4] === relativePath
          ? { state: "present", lines: lineTotal(git(["cat-file", "blob", entry[3]])) }
          : { state: "absent" };
      } catch { result = { state: "absent" }; }
    }
    cache.set(relativePath, result);
    return result;
  };
}

function scopeProblem(relativePath, scope) {
  const under = (prefix) => { const p = String(prefix).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""); return p === "" || p === "." || relativePath === p || relativePath.startsWith(`${p}/`); };
  const included = Array.isArray(scope?.included) ? scope.included : [];
  const excluded = Array.isArray(scope?.excluded) ? scope.excluded : [];
  // An empty included list assesses nothing; "." names the whole repository.
  if (!included.some(under)) return `outside scope.included ${JSON.stringify(included)}`;
  if (excluded.some(under)) return `inside scope.excluded ${JSON.stringify(excluded)}`;
  return null;
}

function claimOrigin(claim, packet) {
  const producer = PRODUCER_OWNERS[packet.producer.skill] ?? null;
  if (producer !== "architecture") return { origin: "adopted", origin_ref: producer ? `${producer}:${packet.packet_id}` : null };
  if ((packet.producer.artifact_refs ?? []).some(ref => ref?.kind === "health-artifact")) return { origin: "adopted", origin_ref: `health:${packet.packet_id}` };
  for (const source of claim.sources ?? []) {
    const ref = String(source?.ref ?? "");
    const foreign = FOREIGN_REF_PREFIXES.find(([prefix]) => ref.startsWith(prefix));
    if (foreign) return { origin: "adopted", origin_ref: `${foreign[1]}:${ref}` };
    const other = /^evidence-recon:([a-f0-9]{64})/.exec(ref);
    if (other) return { origin: "adopted", origin_ref: null };
  }
  return { origin: "original", origin_ref: null };
}

/** §6.2 quality a cited claim can lend. Never above the packet's declaration, capped
 * at moderate for inferred claims and sampled coverage. Null means it cannot support a score. */
function lendableQuality(claim, negative) {
  const declared = claim.evidence_quality;
  if (!Object.hasOwn(QUALITY_RANK, declared)) return { quality: null, reason: `evidence_quality ${declared}` };
  if (!SUPPORTABLE_COVERAGE.includes(claim.coverage?.state)) return { quality: null, reason: `coverage.state ${claim.coverage?.state}` };
  let quality = declared;
  if (!negative) {
    if (claim.epistemic_status === "unknown") return { quality: null, reason: "epistemic_status unknown" };
    if (claim.epistemic_status === "inferred") quality = minQuality(quality, "moderate");
  }
  if (claim.coverage.state === "sampled") quality = minQuality(quality, "moderate");
  return { quality, reason: null };
}

/** A policy violation: the writer rejects it; RIA withholds the evidence and records why. */
class PolicyViolation extends Error {}
function policyError(code, detail) { const error = new PolicyViolation(`FAIL-ARCHITECTURE-EVIDENCE-${code}: ${detail}`); error.code = code; error.detail = detail; return error; }

/**
 * Resolves Architecture evidence against bound packet bytes.
 * artifact: the candidate set (input or stored artifact).
 * options: { repositoryRoot, binding, allowedRoots, mode: "write" | "consume", casePolicy, sourceSnapshot? }
 * Integrity violations always throw: tampered or unparseable bytes, path escape, binding
 * mismatch, and dangling refs (an unknown packet digest or claim id, or a cited file or
 * line absent at a readable revision). Policy violations (legacy string packet refs,
 * unqualified claim refs, a scored dimension citing nothing, a claim that cannot support
 * the dimension, an out-of-scope source) throw in "write" mode and withhold that evidence
 * in "consume" mode, where they are listed in `withheld`.
 * Returns { schema_version, binding, mode, packets[], dimensions{ id: { state, refs, facts, unbound, limitations } }, candidates{ id: { facts, unbound, limitations } }, withheld[] }.
 */
function resolveArchitectureEvidence(artifact, { repositoryRoot, binding, allowedRoots, mode = "consume", casePolicy = "sensitive", sourceSnapshot = null } = {}) {
  if (!["write", "consume"].includes(mode)) fail("MODE", `unknown mode ${mode}`);
  if (!object(binding) || ![binding.repository_id, binding.root_id, binding.revision].every(nonempty)) fail("BINDING-MISMATCH", "binding needs repository_id, root_id and revision");
  if (!object(artifact)) fail("ARTIFACT", "candidate set must be an object");
  if (artifact.repository_revision !== binding.revision) fail("BINDING-MISMATCH", `candidate set revision ${artifact.repository_revision} differs from ${binding.revision}`);
  const model = evidenceModel();
  const withheld = [];
  /** Throws in write mode; in consume mode records the violation and returns its message. */
  function policy(code, detail) {
    const error = policyError(code, detail);
    if (mode === "write") throw error;
    withheld.push(error.message);
    return error.message;
  }
  let refs = artifact.evidence_packet_refs;
  if (!Array.isArray(refs)) { policy("PACKET-REF", "evidence_packet_refs must be an array"); refs = []; }
  const packets = new Map();
  const packetSummaries = [];
  refs.forEach((ref, index) => {
    if (typeof ref === "string") {
      packetSummaries.push({ legacy_ref: ref, status: "unbound", reason: policy("PACKET-REF", `evidence_packet_refs[${index}] ${JSON.stringify(ref)} is a legacy string ref with no bound bytes`) });
      return;
    }
    const loaded = loadPacket(ref, index, { allowedRoots: allowedRoots ?? [], binding, mode });
    if (packets.has(ref.sha256)) fail("PACKET-REF", `${ref.artifact_id} is listed twice`);
    packets.set(ref.sha256, { ref, ...loaded });
    packetSummaries.push({ artifact_id: ref.artifact_id, sha256: ref.sha256, packet_id: ref.packet_id, producer_skill: ref.producer_skill, status: loaded.status, ...(loaded.reason ? { reason: loaded.reason } : {}) });
  });
  const snapshot = sourceSnapshot ?? sourceSnapshotFor(path.resolve(repositoryRoot), binding.revision);
  if (!object(snapshot) || !(snapshot.kind === "worktree" || (snapshot.kind === "git" && nonempty(snapshot.revision)))) fail("MODE", "sourceSnapshot must be { kind: \"git\", revision } or { kind: \"worktree\" }");
  const lineCount = revisionReader(path.resolve(repositoryRoot), snapshot);
  const resolved = new Map();

  function resolveClaim(qualified, dimensionId) {
    const [, digest, claimId] = QUALIFIED_REF.exec(qualified);
    const entry = packets.get(digest);
    if (!entry) fail("DANGLING", `${qualified} names a packet not in evidence_packet_refs`);
    if (entry.status !== "bound") return { complete: false, facts: [], unbound: [], limitations: [`${qualified}: packet unavailable (${entry.reason})`] };
    const claim = entry.packet.claims.find(item => item.claim_id === claimId);
    const negative = claim ? null : (entry.packet.negative_claims ?? []).find(item => item.negative_claim_id === claimId);
    if (!claim && !negative) fail("DANGLING", `${qualified} names no claim or negative claim in ${entry.ref.artifact_id}`);
    const subject = claim ?? negative;
    const lendable = lendableQuality(subject, Boolean(negative));
    if (dimensionId) {
      if (lendable.quality === null) throw policyError("UNSUPPORTED", `${qualified} cannot support ${dimensionId}: ${lendable.reason}`);
      if (claim && !(claim.supports ?? []).includes(supportsTag(dimensionId))) throw policyError("UNSUPPORTED", `${qualified} does not declare supports "${supportsTag(dimensionId)}"`);
    }
    const origin = claimOrigin(subject, entry.packet);
    const facts = [], unbound = [], limitations = [];
    let complete = true;
    for (const source of subject.sources ?? []) {
      let classified;
      try { classified = model.classifyEvidence(source, { binding, casePolicy }); }
      catch (error) { fail("SOURCE-UNRESOLVED", `${qualified} source ${JSON.stringify(source.ref)}: ${error.message}`); }
      for (const item of classified.unbound) unbound.push({ claim_ref: qualified, ...item });
      for (const key of classified.keys) {
        if (key.kind === "code") {
          const gitPath = String(source.ref).trim().replace(/^(.+?)(?::L?\d+(?:\s*[-–]\s*L?\d+)?)?$/, "$1").replace(/\\/g, "/").replace(/^\.\//, "");
          const present = lineCount(gitPath);
          if (present.state === "absent") fail("DANGLING", `${qualified} cites ${gitPath}, which does not exist at ${binding.revision}`);
          if (present.state === "unavailable") {
            if (mode === "write") fail("SOURCE-UNRESOLVED", `${qualified}: revision ${binding.revision} is not readable in ${repositoryRoot}`);
            limitations.push(`${qualified}: revision unavailable, ${key.path} not verified`);
            complete = false;
            continue;
          }
          if (key.range && key.range[1] > present.lines) fail("DANGLING", `${qualified} cites ${key.path}:${key.range[0]}-${key.range[1]} past end of file (${present.lines} lines)`);
          const outside = scopeProblem(key.path, artifact.scope);
          if (outside) throw policyError("OUT-OF-SCOPE", `${qualified} cites ${key.path}, ${outside}`);
        }
        if (lendable.quality === null) { unbound.push({ claim_ref: qualified, reason: `not-supporting:${lendable.reason}`, key: key.key }); continue; }
        facts.push({ ...key, quality: lendable.quality, origin: origin.origin, origin_ref: origin.origin_ref, claim_ref: qualified });
      }
    }
    if (origin.origin === "adopted" && origin.origin_ref === null) limitations.push(`${qualified}: adopted from an unidentified owner`);
    return { complete: complete && facts.length > 0, facts, unbound, limitations };
  }
  function resolveRef(qualified, dimensionId = null) {
    const cacheKey = `${qualified}\u0000${dimensionId ?? ""}`;
    if (!resolved.has(cacheKey)) {
      let value;
      try { value = resolveClaim(qualified, dimensionId); }
      catch (error) {
        if (!(error instanceof PolicyViolation)) throw error;
        value = { complete: false, facts: [], unbound: [], limitations: [policy(error.code, error.detail)] };
      }
      resolved.set(cacheKey, value);
    }
    return resolved.get(cacheKey);
  }
  /** Packet-qualified refs to resolve. A malformed qualified ref, or a claim-shaped ref
   * without a packet digest, is a policy violation; other free text stays a note. */
  function qualifiedRefs(cited, label, sink) {
    const out = [];
    for (const ref of cited) {
      if (typeof ref !== "string") continue;
      if (ref.startsWith("evidence-recon:")) {
        if (QUALIFIED_REF.test(ref)) out.push(ref);
        else sink.push(policy("UNQUALIFIED", `${label} cites ${JSON.stringify(ref)}; use evidence-recon:<packet sha256>#<claim id>`));
      } else if (UNQUALIFIED_CLAIM_REF.test(ref)) sink.push(policy("UNQUALIFIED", `${label} cites ${ref}; qualify it as evidence-recon:<packet sha256>#<claim id>`));
    }
    return out;
  }

  const dimensions = {};
  const fitness = artifact.architecture_fitness;
  if (object(fitness?.dimensions)) {
    for (const [id, dimension] of Object.entries(fitness.dimensions)) {
      if (!object(dimension)) continue;
      // `evidence_complete`: every cited claim resolved to bound facts. A sub-dimension whose
      // cited evidence is unavailable, withheld or unverifiable retains missing mass in RIA
      // (composite-scoring-v3 §4.1) rather than scoring on whatever else it cited.
      const out = { state: dimension.state, refs: [], evidence_complete: false, facts: [], unbound: [], limitations: [] };
      const before = out.limitations.length;
      out.refs = qualifiedRefs(Array.isArray(dimension.evidence_refs) ? dimension.evidence_refs : [], `fitness dimension ${id}`, out.limitations);
      if (dimension.state === "scored" && out.refs.length === 0) out.limitations.push(policy("UNBOUND-DIMENSION", `scored fitness dimension ${id} cites no packet-qualified claim`));
      let complete = dimension.state === "scored" && out.refs.length > 0 && out.limitations.length === before;
      for (const ref of out.refs) {
        const value = resolveRef(ref, dimension.state === "scored" ? id : null);
        complete = complete && value.complete;
        out.facts.push(...value.facts); out.unbound.push(...value.unbound); out.limitations.push(...value.limitations);
      }
      out.evidence_complete = complete;
      dimensions[id] = out;
    }
  }
  const candidates = {};
  for (const candidate of Array.isArray(artifact.candidates) ? artifact.candidates : []) {
    const out = { facts: [], unbound: [], limitations: [] };
    for (const ref of qualifiedRefs(candidate.evidence_refs ?? [], `candidate ${candidate.candidate_id}`, out.limitations)) {
      const value = resolveRef(ref);
      out.facts.push(...value.facts); out.unbound.push(...value.unbound); out.limitations.push(...value.limitations);
    }
    candidates[candidate.candidate_id] = out;
  }
  return { schema_version: BINDING_VERSION, binding: { ...binding }, mode, source_snapshot: { ...snapshot }, packets: packetSummaries, dimensions, candidates, withheld };
}

module.exports = { BINDING_VERSION, ROOT_ID, QUALIFIED_REF, supportsTag, bindingFromEnvelope, packetRefFor, sourceSnapshotFor, revisionReader, resolveArchitectureEvidence };
