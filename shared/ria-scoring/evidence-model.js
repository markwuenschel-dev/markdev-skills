"use strict";
/* Shared evidence model for the RIA v2 composite (composite-scoring-v3 §6, §7.2).
 *
 * Pure: data in, data out. No file I/O, no clock, no randomness. Every
 * set-valued output is canonically ordered so results are deterministic under
 * input permutation.
 *
 * Owner evidence shapes are classified into these key kinds (§6.1):
 *   code         Health claim {path, lines?}, spine {file, line?}, Evidence Recon
 *                `line`/`path` sources and path-shaped `document`/`history` refs.
 *                A missing range is whole-file evidence: a discovery match only.
 *   sei-metric   {kind:"sei-criterion", criterion_id, metric_id} against the
 *                bound assessment bytes.
 *   command      a verification-baseline command (Recon `command` sources that
 *                resolve to a baseline command id).
 *   analyzer     a deterministic check: check id + input/output receipt digest.
 *   reproduction a failing reproduction: check id + receipt digest.
 * Anything else (free-text refs, architecture-level rationale) is `unbound`:
 * it never becomes an evidence key, earns no strength and is reported as a
 * limitation.
 *
 * Workflow fields (`status`, `rollup`, `candidate_lifecycle`) are never read
 * here (D9). */

const crypto = require("node:crypto");

const KEY_KINDS = Object.freeze(["code", "sei-metric", "command", "analyzer", "reproduction"]);
const QUALITIES = Object.freeze(["strong", "moderate", "weak"]);
const ORIGINS = Object.freeze(["original", "adopted"]);
const OWNERS = Object.freeze(["health", "architecture", "integrity", "sei"]);
const CONFIRMED_STATES = Object.freeze(["reproduced", "mechanical", "observed"]);
const DEFECT_CLASSES = Object.freeze(["logic-error", "contract-drift", "missing-validation", "security-exposure", "failure-handling", "concurrency", "data-integrity", "stale-or-dead-path", "other"]);
const DEFECT_DIMENSIONS = Object.freeze(["correctness", "contracts", "security", "reliability"]);
const STATE_RANK = Object.freeze({ reproduced: 3, mechanical: 2, observed: 1 });

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}
function sha256(text) { return crypto.createHash("sha256").update(text).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function uniqueSorted(values) { return [...new Set(values)].sort(compare); }

/* ------------------------------ §6.1 keys ------------------------------- */

/** Normalizes a repository-relative path: separators, dot segments, and the
 * assessed root's case policy. Rejects absolute paths and escapes. */
function normalizeRelativePath(input, { casePolicy = "sensitive" } = {}) {
  if (!nonempty(input)) fail("FAIL-EVIDENCE-PATH", "path must be a non-empty string");
  const text = input.trim().replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(text) || text.startsWith("/") || text.startsWith("//")) fail("FAIL-EVIDENCE-PATH", `absolute path ${input}`);
  const out = [];
  for (const segment of text.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) fail("FAIL-EVIDENCE-PATH", `path escapes the assessed root: ${input}`);
      out.pop();
    } else out.push(segment);
  }
  if (out.length === 0) fail("FAIL-EVIDENCE-PATH", `path resolves to the root: ${input}`);
  const joined = out.join("/");
  return casePolicy === "insensitive" ? joined.toLowerCase() : joined;
}

/** Parses a line range. Accepts an integer, "n", "n-m" or "Ln-Lm". Returns
 * null for whole-file evidence; rejects inverted or invalid ranges. */
function parseLineRange(value) {
  if (value === null || value === undefined || value === "") return null;
  if (Number.isInteger(value)) {
    if (value < 1) fail("FAIL-EVIDENCE-RANGE", `line ${value} must be >= 1`);
    return [value, value];
  }
  if (typeof value !== "string") fail("FAIL-EVIDENCE-RANGE", "line range must be an integer or a string");
  const match = /^\s*L?(\d+)\s*(?:[-–:]\s*L?(\d+)\s*)?$/.exec(value);
  if (!match) fail("FAIL-EVIDENCE-RANGE", `unparseable line range ${JSON.stringify(value)}`);
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start) fail("FAIL-EVIDENCE-RANGE", `invalid line range ${JSON.stringify(value)}`);
  return [start, end];
}

function requireBinding(binding) {
  for (const field of ["repository_id", "root_id", "revision"]) {
    if (!nonempty(binding?.[field])) fail("FAIL-EVIDENCE-BINDING", `binding.${field} is required`);
  }
  return binding;
}

/** A structured line range: null (whole file) or [start, end], positive ascending integers. */
function requireRange(range) {
  if (range === null || range === undefined) return null;
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] < 1 || range[1] < range[0]) fail("FAIL-EVIDENCE-RANGE", `line range ${JSON.stringify(range)} must be [start, end] with integers 1 <= start <= end`);
  return range;
}

function codeKey(binding, relativePath, range, options = {}) {
  requireBinding(binding);
  requireRange(range);
  const normalized = normalizeRelativePath(relativePath, options);
  const rangeText = range ? `[${range[0]},${range[1]}]` : "[*]";
  return {
    kind: "code",
    key: `code:${binding.repository_id}:${binding.root_id}:${binding.revision}:${normalized}:${rangeText}`,
    binding: { repository_id: binding.repository_id, root_id: binding.root_id, revision: binding.revision },
    path: normalized,
    range: range ? [range[0], range[1]] : null,
    whole_file: !range,
  };
}

function seiMetricKey(assessmentSha256, criterionId, metricId) {
  if (!/^[a-f0-9]{64}$/.test(String(assessmentSha256 ?? ""))) fail("FAIL-EVIDENCE-BINDING", "SEI metric keys need the bound assessment sha256");
  if (!nonempty(criterionId) || !nonempty(metricId)) fail("FAIL-EVIDENCE-SEI-CITATION", "criterion_id and metric_id are required");
  return { kind: "sei-metric", key: `sei-metric:${assessmentSha256}:${criterionId}:${metricId}`, assessment_sha256: assessmentSha256, criterion_id: criterionId, metric_id: metricId };
}

function commandKey(verificationBaselineSha256, commandId) {
  if (!/^[a-f0-9]{64}$/.test(String(verificationBaselineSha256 ?? ""))) fail("FAIL-EVIDENCE-BINDING", "command keys need the verification baseline sha256");
  if (!nonempty(commandId)) fail("FAIL-EVIDENCE-COMMAND", "command_id is required");
  return { kind: "command", key: `command:${verificationBaselineSha256}:${commandId}`, verification_baseline_sha256: verificationBaselineSha256, command_id: commandId };
}

function checkKey(kind, binding, checkId, receiptSha256) {
  if (kind !== "analyzer" && kind !== "reproduction") fail("FAIL-EVIDENCE-KIND", `unknown check kind ${kind}`);
  requireBinding(binding);
  if (!nonempty(checkId)) fail("FAIL-EVIDENCE-CHECK", "check_id is required");
  if (!/^[a-f0-9]{64}$/.test(String(receiptSha256 ?? ""))) fail("FAIL-EVIDENCE-CHECK", "check keys need an input/output receipt digest");
  return { kind, key: `${kind}:${binding.repository_id}:${binding.root_id}:${binding.revision}:${checkId}:${receiptSha256}`, binding: { ...binding }, check_id: checkId, receipt_sha256: receiptSha256 };
}

/** Classifies one owner evidence entry into evidence keys (§6.1). Returns
 * { keys: [...], unbound: [...] } so unclassifiable evidence is reported, never
 * silently dropped. `context` supplies the bindings and resolvers. */
function classifyEvidence(entry, context) {
  const { binding, casePolicy, seiAssessmentSha256, verificationBaselineSha256, commandIdFor } = context;
  const keys = [];
  const unbound = [];
  if (!entry || typeof entry !== "object") return { keys, unbound: [{ reason: "not-an-object" }] };
  if (entry.kind === "sei-criterion") {
    keys.push(seiMetricKey(seiAssessmentSha256, entry.criterion_id, entry.metric_id));
  } else if (entry.architecture_level === true) {
    unbound.push({ reason: "architecture-level-rationale" });
  } else if (typeof entry.path === "string") {
    keys.push(codeKey(binding, entry.path, parseLineRange(entry.lines), { casePolicy }));
  } else if (typeof entry.file === "string") {
    keys.push(codeKey(binding, entry.file, parseLineRange(entry.line), { casePolicy }));
  } else if (typeof entry.kind === "string" && typeof entry.ref === "string") {
    // Evidence Recon source {kind, ref}.
    if (entry.kind === "line" || entry.kind === "path" || entry.kind === "document" || entry.kind === "history") {
      const match = /^(.+?)(?::(L?\d+(?:\s*[-–]\s*L?\d+)?))?$/.exec(entry.ref.trim());
      const candidate = match ? match[1] : entry.ref;
      if (/\s/.test(candidate) || !/[./]/.test(candidate)) unbound.push({ reason: "free-text-ref", ref: entry.ref });
      else keys.push(codeKey(binding, candidate, entry.kind === "line" || match[2] ? parseLineRange(match[2]) : null, { casePolicy }));
    } else if (entry.kind === "command") {
      const commandId = typeof commandIdFor === "function" ? commandIdFor(entry.ref) : null;
      if (commandId && verificationBaselineSha256) keys.push(commandKey(verificationBaselineSha256, commandId));
      else unbound.push({ reason: "command-not-in-verification-baseline", ref: entry.ref });
    } else {
      unbound.push({ reason: `unbound-source-kind:${entry.kind}`, ref: entry.ref });
    }
  } else if (entry.kind === "analyzer" || entry.kind === "reproduction") {
    keys.push(checkKey(entry.kind, binding, entry.check_id, entry.receipt_sha256));
  } else if (entry.kind === "command" && typeof entry.command_id === "string") {
    keys.push(commandKey(verificationBaselineSha256, entry.command_id));
  } else {
    unbound.push({ reason: "unclassified-shape" });
  }
  return { keys, unbound };
}

/** §6.1 match rule between two keys: "exact", "overlap" (≥ 50% of the shorter
 * inclusive range on the same binding/path), "discovery" (same file, at least
 * one side whole-file) or null. Matches are candidates, not defect identity. */
function matchKeys(a, b) {
  if (!a || !b || a.kind !== b.kind) return null;
  if (a.kind !== "code") return a.key === b.key ? "exact" : null;
  if (canonicalJson(a.binding) !== canonicalJson(b.binding) || a.path !== b.path) return null;
  if (a.whole_file || b.whole_file) return a.whole_file && b.whole_file ? "discovery" : "discovery";
  const start = Math.max(a.range[0], b.range[0]);
  const end = Math.min(a.range[1], b.range[1]);
  if (end < start) return null;
  const overlap = end - start + 1;
  const shorter = Math.min(a.range[1] - a.range[0] + 1, b.range[1] - b.range[0] + 1);
  if (a.range[0] === b.range[0] && a.range[1] === b.range[1]) return "exact";
  return overlap * 2 >= shorter ? "overlap" : null;
}

/** Deduplicates identical keys before strength arithmetic. When the same key
 * is held both originally and by adoption, adoption wins (conservative); the
 * strongest declared quality is kept. */
function dedupeKeys(entries) {
  const byKey = new Map();
  const order = { strong: 3, moderate: 2, weak: 1 };
  for (const entry of entries) {
    const existing = byKey.get(entry.key);
    if (!existing) { byKey.set(entry.key, { ...entry }); continue; }
    if (entry.origin === "adopted") { existing.origin = "adopted"; existing.origin_ref = existing.origin_ref ?? entry.origin_ref ?? null; }
    if ((order[entry.quality] ?? 0) > (order[existing.quality] ?? 0)) existing.quality = entry.quality;
  }
  return [...byKey.values()].sort((x, y) => compare(x.key, y.key));
}

/* ------------------------- §6.2 origin and strength ---------------------- */

/** Assigns origin to a key an owner holds. Adopted when it arrives through an
 * explicit adoption link, or when it is an SEI metric held by a non-SEI owner. */
function classifyOrigin(owner, key, { adoptedFrom = null } = {}) {
  if (adoptedFrom) return { origin: "adopted", origin_ref: adoptedFrom };
  if (key.kind === "sei-metric" && owner !== "sei") return { origin: "adopted", origin_ref: "sei" };
  return { origin: "original", origin_ref: null };
}

/** Validates the imported Evidence Recon / Health vocabularies (§6.2) and
 * returns the strength factor table. No competing numbers are introduced. */
function strengthFactors(imports) {
  const qualities = imports?.evidence_qualities;
  const factors = imports?.health_evidence_factor;
  if (!Array.isArray(qualities) || !factors) fail("FAIL-EVIDENCE-VOCABULARY", "evidence qualities and HEALTH_EVIDENCE_FACTOR must be imported");
  for (const quality of QUALITIES) {
    if (!qualities.includes(quality)) fail("FAIL-EVIDENCE-VOCABULARY", `Evidence Recon lacks quality ${quality}`);
    if (typeof factors[quality] !== "number") fail("FAIL-EVIDENCE-VOCABULARY", `HEALTH_EVIDENCE_FACTOR lacks ${quality}`);
  }
  return Object.freeze({ strong: factors.strong, moderate: factors.moderate, weak: factors.weak });
}

/* ------------------------- §6.3 contribution dependence ------------------ */

/** Classifies one contribution's independence from its consumed facts.
 * facts: [{ key, kind, quality, origin, origin_ref, owner_of_origin? }]
 * Returns { classification: "independent" | "dependent" | "insufficient_evidence",
 *           adopted_strength_ratio, adopted_strength, original_strength,
 *           origin_owners, facts, limitations }.
 * "dependent" here is provisional: resolveDependenceGraph confirms that every
 * origin is an admissible scored contribution in the same dimension. */
function contributionDependence({ owner, dimension, facts, factors, threshold, sharedCommandOwner = "health" }) {
  const limitations = [];
  const prepared = (facts ?? []).map(fact => {
    // A shared verification receipt is attributed once, to Health for the
    // verification and delivery dimensions; anyone else citing it is adopting.
    if (fact.kind === "command" && owner !== sharedCommandOwner) return { ...fact, origin: "adopted", origin_ref: sharedCommandOwner };
    return fact;
  });
  const unique = dedupeKeys(prepared);
  let adopted = 0;
  let original = 0;
  let strongOriginal = 0;
  const originOwners = new Set();
  for (const fact of unique) {
    const factor = factors[fact.quality];
    if (typeof factor !== "number") fail("FAIL-EVIDENCE-QUALITY", `fact ${fact.key} has unknown quality ${fact.quality}`);
    if (fact.origin === "adopted") {
      adopted += factor;
      if (fact.origin_ref) originOwners.add(String(fact.origin_ref).split(":")[0]);
      else limitations.push(`adopted fact ${fact.key} has no origin link`);
    } else if (fact.quality === "strong" || fact.quality === "moderate") {
      original += factor;
      if (fact.quality === "strong") strongOriginal += 1;
    }
  }
  const total = adopted + original;
  const base = { owner, dimension, adopted_strength: adopted, original_strength: original, facts: unique, origin_owners: [...originOwners].sort(compare) };
  if (total === 0) {
    return { ...base, classification: "insufficient_evidence", adopted_strength_ratio: null, limitations: [...limitations, "no rubric-relevant evidence strength"] };
  }
  const ratio = adopted / total;
  if (ratio < threshold && strongOriginal > 0) {
    return { ...base, classification: "independent", adopted_strength_ratio: ratio, limitations };
  }
  if (adopted > 0 && originOwners.size > 0) {
    return { ...base, classification: "dependent", adopted_strength_ratio: ratio, limitations };
  }
  return { ...base, classification: "insufficient_evidence", adopted_strength_ratio: ratio, limitations: [...limitations, "no strong original evidence and no scored origin"] };
}

/** Resolves dependence as a graph within one dimension (§6.3).
 * nodes: [{ owner, eligible: boolean, classification, origin_owners }]
 * A dependent node keeps "dependent" only if every origin chain ends at an
 * eligible independent node. Orphans and cycles become missing evidence
 * ("insufficient_evidence"), never an empty denominator. */
function resolveDependenceGraph(nodes) {
  const byOwner = new Map(nodes.map(node => [node.owner, node]));
  const memo = new Map();
  function resolve(owner, stack) {
    if (memo.has(owner)) return memo.get(owner);
    const node = byOwner.get(owner);
    if (!node || !node.eligible) return { ok: false, reason: `origin ${owner} is not an admissible scored contribution` };
    if (node.classification === "independent") return { ok: true, roots: [owner] };
    if (node.classification !== "dependent") return { ok: false, reason: `origin ${owner} has insufficient evidence` };
    if (stack.includes(owner)) return { ok: false, reason: `dependence cycle ${[...stack, owner].join(" -> ")}` };
    const roots = new Set();
    for (const origin of node.origin_owners) {
      if (origin === owner) return { ok: false, reason: `${owner} cannot be its own origin` };
      const result = resolve(origin, [...stack, owner]);
      if (!result.ok) return result;
      result.roots.forEach(root => roots.add(root));
    }
    if (roots.size === 0) return { ok: false, reason: `${owner} has no origin` };
    return { ok: true, roots: [...roots].sort(compare) };
  }
  const out = {};
  for (const node of [...nodes].sort((a, b) => compare(a.owner, b.owner))) {
    if (node.classification !== "dependent") { out[node.owner] = { state: node.classification, origin_refs: [], limitations: [] }; continue; }
    const result = resolve(node.owner, []);
    memo.set(node.owner, result);
    out[node.owner] = result.ok
      ? { state: "dependent", origin_refs: result.roots, limitations: [] }
      : { state: "insufficient_evidence", origin_refs: [], limitations: [`unresolved origin: ${result.reason}`] };
  }
  return out;
}

/* ------------------------- §7.2 evidentiary state ------------------------ */

function sameBinding(a, b) {
  return !!a && !!b && a.repository_id === b.repository_id && a.root_id === b.root_id && a.revision === b.revision;
}

const RECEIPT_SCHEMA = "ria.proof-receipt@1";
/** Fields a receipt of each kind states; the receipt's values are authoritative. */
const RECEIPT_FIELDS = Object.freeze({
  reproduction: ["check_id", "expected", "actual", "exit_code", "harness_error"],
  analyzer: ["check_id", "proposition"],
  "counter-evidence": ["check_id"],
  resolution: ["outcome", "explains"],
  "prevention-check": ["check_id", "outcome"],
  "runtime-guard": ["check_id", "outcome"],
});

/** §7.2 "the verifier checks the source receipt and its exact assessed binding". Resolves
 * the proof's receipt through context.readReceipt(sha256) -> { status: "present", receipt }
 * | { status: "missing" } (the caller verifies the bytes hash to the digest) and returns the
 * proof with the receipt's own values, or null with a limitation. A receipt must be a
 * `ria.proof-receipt@1` of the same kind, bound to the assessed baseline and naming the same
 * predicate; a proof record that states a value its receipt contradicts is inadmissible. */
function receiptBacked(proof, predicate, assessed, context, label, limitations) {
  if (!/^[a-f0-9]{64}$/.test(String(proof.receipt_sha256 ?? ""))) { limitations.push(`${label} has no receipt digest`); return null; }
  const found = typeof context.readReceipt === "function" ? context.readReceipt(proof.receipt_sha256) : { status: "missing" };
  if (!found || found.status !== "present" || !found.receipt || typeof found.receipt !== "object") { limitations.push(`${label} receipt bytes are not available to the verifier`); return null; }
  const receipt = found.receipt;
  if (receipt.schema_version !== RECEIPT_SCHEMA) { limitations.push(`${label} receipt is not a ${RECEIPT_SCHEMA}`); return null; }
  if (receipt.kind !== proof.kind) { limitations.push(`${label} receipt records a ${receipt.kind}, not a ${proof.kind}`); return null; }
  if (!sameBinding(receipt.binding, assessed)) { limitations.push(`${label} receipt is bound to a different revision or root (stale)`); return null; }
  if (receipt.predicate_id !== predicate) { limitations.push(`${label} receipt proves a different predicate`); return null; }
  const merged = { ...proof };
  for (const field of RECEIPT_FIELDS[proof.kind] ?? []) {
    const stated = Object.hasOwn(proof, field) && proof[field] !== undefined;
    const recorded = Object.hasOwn(receipt, field) && receipt[field] !== undefined;
    if (stated && (!recorded || canonicalJson(proof[field]) !== canonicalJson(receipt[field]))) { limitations.push(`${label} states ${field} that its receipt does not record`); return null; }
    if (recorded) merged[field] = receipt[field]; else delete merged[field];
  }
  return merged;
}

/** §7.2 "naming an evidence kind or supplying observation.confirmed text is not sufficient":
 * an observation's code key is re-derived from its own path and range at the assessed
 * binding (so its metadata cannot disagree with its key), and that path and line range must
 * exist in the assessed source, read through context.resolveSource(path) -> { state:
 * "present", lines } | { state: "absent" | "unavailable" }. Returns a problem or null. */
function observedSourceProblem(evidenceKey, assessed, context) {
  let derived;
  try { derived = codeKey(assessed, evidenceKey.path, evidenceKey.range); } catch (error) { return `has an invalid code key: ${error.message}`; }
  if (derived.key !== evidenceKey.key || derived.whole_file) return "has a code key that does not match its own path, range and binding";
  if (typeof context.resolveSource !== "function") return "cites source the verifier cannot resolve (no source snapshot)";
  const found = context.resolveSource(derived.path);
  if (!found || found.state !== "present") return `cites ${derived.path}, which ${found?.state === "unavailable" ? "cannot be read" : "does not exist"} at the assessed revision`;
  if (!Number.isInteger(found.lines) || derived.range[1] > found.lines) return `cites ${derived.path}:${derived.range[0]}-${derived.range[1]}, beyond the file's ${found.lines ?? "unknown"} lines`;
  return null;
}

/** §9.2 containment: a verified runtime guard or passing prevention check, backed by its
 * receipt, for the same predicate at the assessed baseline. */
function containmentVerified(containment, predicate, context) {
  const limitations = [];
  if (!containment || typeof containment !== "object" || !["prevention-check", "runtime-guard"].includes(containment.kind) || !nonempty(predicate)) return { contained: false, limitations: containment ? ["containment is not a prevention check or runtime guard"] : [] };
  if (containment.predicate_id !== predicate) return { contained: false, limitations: ["containment covers a different predicate"] };
  const backed = receiptBacked(containment, predicate, context.binding, context, `containment ${containment.kind}`, limitations);
  if (!backed) return { contained: false, limitations };
  if (backed.outcome !== "pass") return { contained: false, limitations: [`containment ${containment.kind} did not pass`] };
  return { contained: true, limitations };
}

/** Computes a finding's evidentiary state from its proof records only.
 * finding: { predicate: {predicate_id}, binding, proofs: [...] }
 * context: { binding, seiHasMetric(criterion_id, metric_id) -> boolean,
 *            readReceipt(sha256) -> { status: "present", receipt } | { status: "missing" },
 *            resolveSource(path) -> { state: "present", lines } | { state: "absent" | "unavailable" } }
 * A strong observation is admissible only when its cited path and line range exist in the
 * assessed source (observedSourceProblem).
 * Reproduction, analyzer, counter-evidence and resolution proofs are admissible only through
 * their receipt (receiptBacked): a digest alone proves nothing.
 * Proof kinds:
 *   reproduction  { receipt_sha256, binding, predicate_id, expected, actual, exit_code, harness_error? }
 *   analyzer      { check_id, receipt_sha256, binding, predicate_id, proposition }
 *   sei-metric    { criterion_id, metric_id, assessment_sha256, predicate_id, proposition }
 *   observation   { quality, evidence_key, binding, predicate_id, confirmed }
 *   judgment      {}  (review_source.proof_basis "judgment" or moderate/weak evidence)
 *   counter-evidence { receipt_sha256, binding, predicate_id }
 *   resolution    { receipt_sha256, binding, predicate_id, outcome: "confirmed" | "refuted", explains: string }
 * Returns { state, confirmed, admissible_proofs, limitations }. */
function evidentiaryState(finding, context) {
  const limitations = [];
  const predicate = finding?.predicate?.predicate_id;
  const assessed = context.binding;
  if (!nonempty(predicate)) {
    return { state: "inferred", confirmed: false, admissible_proofs: [], limitations: ["no normalized failure predicate"] };
  }
  const positive = [];
  const counter = [];
  const resolutions = [];
  let judgment = false;
  for (let proof of finding.proofs ?? []) {
    const label = `${proof.kind}${proof.receipt_sha256 ? `:${proof.receipt_sha256.slice(0, 12)}` : ""}`;
    if (proof.kind === "judgment") { judgment = true; continue; }
    if (proof.predicate_id !== predicate) { limitations.push(`${label} proves a different predicate`); continue; }
    if (proof.kind === "sei-metric") {
      if (proof.assessment_sha256 !== context.seiAssessmentSha256) { limitations.push(`${label} cites a different SEI assessment`); continue; }
      if (typeof context.seiHasMetric !== "function" || !context.seiHasMetric(proof.criterion_id, proof.metric_id)) { limitations.push(`${label} metric is not in the bound assessment`); continue; }
      if (proof.proposition !== predicate) { limitations.push(`${label} metric does not measure the predicate`); continue; }
      positive.push({ state: "mechanical", proof });
      continue;
    }
    if (!sameBinding(proof.binding, assessed)) { limitations.push(`${label} is bound to a different revision or root (stale)`); continue; }
    if (Object.hasOwn(RECEIPT_FIELDS, proof.kind) && !["prevention-check", "runtime-guard"].includes(proof.kind)) {
      const backed = receiptBacked(proof, predicate, assessed, context, label, limitations);
      if (!backed) continue;
      proof = backed;
    }
    if (proof.kind === "reproduction") {
      const mismatch = proof.expected !== undefined && proof.actual !== undefined && canonicalJson(proof.expected) !== canonicalJson(proof.actual);
      if (!/^[a-f0-9]{64}$/.test(String(proof.receipt_sha256 ?? ""))) limitations.push(`${label} has no receipt digest`);
      else if (proof.harness_error) limitations.push(`${label} is a harness error, not a reproduction`);
      else if (!mismatch) limitations.push(`${label} does not demonstrate an expected/actual mismatch`);
      else if (!Number.isInteger(proof.exit_code) || proof.exit_code === 0) limitations.push(`${label} did not fail`);
      else positive.push({ state: "reproduced", proof });
    } else if (proof.kind === "analyzer") {
      if (!nonempty(proof.check_id) || !/^[a-f0-9]{64}$/.test(String(proof.receipt_sha256 ?? ""))) limitations.push(`${label} lacks a check id or receipt`);
      else if (proof.proposition !== predicate) limitations.push(`${label} does not measure the predicate`);
      else positive.push({ state: "mechanical", proof });
    } else if (proof.kind === "observation") {
      if (proof.quality !== "strong") { judgment = true; limitations.push(`${label} is ${proof.quality ?? "unqualified"} evidence`); }
      else if (!nonempty(proof.confirmed)) limitations.push(`${label} has no confirmed observation`);
      else if (!proof.evidence_key || proof.evidence_key.kind !== "code" || proof.evidence_key.whole_file || !sameBinding(proof.evidence_key.binding, assessed)) limitations.push(`${label} is not bound direct evidence`);
      else {
        const problem = observedSourceProblem(proof.evidence_key, assessed, context);
        if (problem) limitations.push(`${label} ${problem}`);
        else positive.push({ state: "observed", proof });
      }
    } else if (proof.kind === "counter-evidence") {
      if (!/^[a-f0-9]{64}$/.test(String(proof.receipt_sha256 ?? ""))) limitations.push(`${label} has no receipt`);
      else counter.push(proof);
    } else if (proof.kind === "resolution") {
      if (!/^[a-f0-9]{64}$/.test(String(proof.receipt_sha256 ?? "")) || !nonempty(proof.explains) || !["confirmed", "refuted"].includes(proof.outcome)) limitations.push(`${label} is not an auditable resolution`);
      else resolutions.push(proof);
    } else {
      limitations.push(`unknown proof kind ${proof.kind}`);
    }
  }
  const best = positive.sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state])[0] ?? null;
  const admissible = positive.map(entry => entry.proof);
  if (counter.length > 0 && best) {
    const resolution = resolutions[0];
    if (!resolution) return { state: "contested", confirmed: false, admissible_proofs: admissible, limitations: [...limitations, "confirmed evidence and counter-evidence conflict without a resolution receipt"] };
    if (resolution.outcome === "refuted") return { state: "refuted", confirmed: false, admissible_proofs: admissible, limitations };
    return { state: best.state, confirmed: true, admissible_proofs: admissible, limitations };
  }
  if (counter.length > 0) return { state: "refuted", confirmed: false, admissible_proofs: [], limitations };
  if (best) return { state: best.state, confirmed: true, admissible_proofs: admissible, limitations };
  return { state: "inferred", confirmed: false, admissible_proofs: [], limitations: judgment ? limitations : [...limitations, "no admissible positive proof"] };
}

/* ------------------------- §6.4 canonical defects ------------------------ */

/** Derives RIA defect dimensions for an adopted finding from validated
 * upstream lane_sources through the config's lane_dimension_map. */
function deriveAdoptedDimensions(laneSources, laneDimensionMap) {
  const lanes = Array.isArray(laneSources) ? laneSources : [];
  const mapped = new Set();
  const unknown = [];
  for (const lane of lanes) {
    const dimensions = laneDimensionMap?.[lane];
    if (Array.isArray(dimensions)) dimensions.forEach(dimension => mapped.add(dimension));
    else unknown.push(lane);
  }
  const limitations = [];
  if (lanes.length === 0) limitations.push("adopted finding has no lane_sources");
  if (unknown.length) limitations.push(`lane_sources without a dimension mapping: ${uniqueSorted(unknown).join(", ")}`);
  return { dimensions: uniqueSorted([...mapped]), limitations, ambiguous: mapped.size === 0 };
}

class UnionFind {
  constructor(ids) { this.parent = new Map(ids.map(id => [id, id])); }
  find(id) { let root = id; while (this.parent.get(root) !== root) root = this.parent.get(root); this.parent.set(id, root); return root; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra === rb) return; if (compare(ra, rb) < 0) this.parent.set(rb, ra); else this.parent.set(ra, rb); }
}

function primaryKeysMatch(a, b) {
  for (const x of a.evidence_keys ?? []) for (const y of b.evidence_keys ?? []) {
    const match = matchKeys(x, y);
    if (match === "exact" || match === "overlap") return true;
  }
  return false;
}
function sharesFileDiscovery(a, b) {
  for (const x of a.evidence_keys ?? []) for (const y of b.evidence_keys ?? []) if (matchKeys(x, y)) return true;
  return false;
}
function samePredicate(a, b) {
  return nonempty(a.predicate?.predicate_id) && a.predicate?.predicate_id === b.predicate?.predicate_id
    && sameBinding(a.binding, b.binding) && a.defect_class === b.defect_class;
}

/** Groups findings from all owners into canonical defect groups (§6.4).
 * findings: normalized findings { finding_id, owner, origin, adopted_from,
 *   dimensions, defect_class, severity, predicate, binding, evidence_keys,
 *   proofs, dedup: {duplicate_group, merged_from}, limitations }
 * context: as evidentiaryState.
 * Returns { groups, unresolved, rejected_links, limitations }. Each group is
 * per (canonical defect, dimension); a defect tagged for two dimensions yields
 * one group per dimension sharing the same defect_id. */
function groupCanonicalDefects(findings, context) {
  const ordered = [...findings].sort((a, b) => compare(a.finding_id, b.finding_id));
  const ids = ordered.map(finding => finding.finding_id);
  if (new Set(ids).size !== ids.length) fail("FAIL-EVIDENCE-DUPLICATE-FINDING", "finding ids must be unique");
  const byId = new Map(ordered.map(finding => [finding.finding_id, finding]));
  const states = new Map(ordered.map(finding => [finding.finding_id, evidentiaryState(finding, context)]));
  const uf = new UnionFind(ids);
  const rejectedLinks = [];
  const unresolved = [];

  function compatible(a, b) {
    const sharedDimension = a.dimensions.some(dimension => b.dimensions.includes(dimension));
    return sharedDimension && samePredicate(a, b);
  }
  // Adoption and merged_from name a specific record, so they merge unless the
  // two sides demonstrably assert different failures. A generic duplicate_group
  // label must meet the full predicate rule (it cannot merge unrelated claims).
  function recordLinkCompatible(a, b) {
    const sharedDimension = a.dimensions.some(dimension => b.dimensions.includes(dimension));
    const bothPredicates = nonempty(a.predicate?.predicate_id) && nonempty(b.predicate?.predicate_id);
    const predicateOk = !bothPredicates || a.predicate.predicate_id === b.predicate.predicate_id;
    const classOk = !a.defect_class || !b.defect_class || a.defect_class === b.defect_class;
    return sharedDimension && predicateOk && classOk && sameBinding(a.binding, b.binding);
  }
  function link(fromId, toId, via) {
    const a = byId.get(fromId), b = byId.get(toId);
    if (!a || !b) { rejectedLinks.push({ from: fromId, to: toId, via, reason: "link target is not a known finding" }); return; }
    if (via === "duplicate_group" ? compatible(a, b) : recordLinkCompatible(a, b)) uf.union(fromId, toId);
    else {
      rejectedLinks.push({ from: fromId, to: toId, via, reason: "linked findings assert different failure predicates, bindings, classes or dimensions" });
      unresolved.push({ members: uniqueSorted([fromId, toId]), reason: `explicit ${via} link could not be validated` });
    }
  }
  // 1. Explicit links: adoption, merged_from, and duplicate_group labels.
  for (const finding of ordered) {
    if (finding.adopted_from) link(finding.finding_id, finding.adopted_from, "adoption");
    for (const merged of finding.dedup?.merged_from ?? []) link(finding.finding_id, merged, "merged_from");
  }
  const labels = new Map();
  for (const finding of ordered) {
    const label = finding.dedup?.duplicate_group;
    if (!nonempty(label)) continue;
    const scoped = `${finding.binding?.repository_id}:${label}`;
    if (!labels.has(scoped)) labels.set(scoped, []);
    labels.get(scoped).push(finding.finding_id);
  }
  for (const members of labels.values()) for (let i = 1; i < members.length; i += 1) link(members[i], members[0], "duplicate_group");
  // 2. Same predicate + binding + dimension + class + matching primary keys.
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i], b = ordered[j];
      if (uf.find(a.finding_id) === uf.find(b.finding_id)) continue;
      if (compatible(a, b) && primaryKeysMatch(a, b)) { uf.union(a.finding_id, b.finding_id); continue; }
      const sameDimensionAndClass = a.dimensions.some(d => b.dimensions.includes(d)) && a.defect_class === b.defect_class;
      const comparable = nonempty(a.predicate?.predicate_id) && nonempty(b.predicate?.predicate_id);
      if (sameDimensionAndClass && !comparable && sharesFileDiscovery(a, b)) {
        unresolved.push({ members: [a.finding_id, b.finding_id], reason: "potential duplicate without a comparable failure predicate" });
      }
    }
  }
  const clusters = new Map();
  for (const id of ids) {
    const root = uf.find(id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(id);
  }
  const groups = [];
  for (const memberIds of clusters.values()) {
    const members = memberIds.sort(compare).map(id => byId.get(id));
    const defectId = `defect:${sha256(canonicalJson(memberIds)).slice(0, 16)}`;
    const dimensions = uniqueSorted(members.flatMap(member => member.dimensions));
    const memberStates = members.map(member => ({ member, verdict: states.get(member.finding_id) }));
    const confirmedMembers = memberStates.filter(entry => entry.verdict.confirmed);
    const contested = memberStates.some(entry => entry.verdict.state === "contested");
    const refuted = memberStates.some(entry => entry.verdict.state === "refuted");
    let state;
    if (contested || (refuted && confirmedMembers.length > 0)) state = "contested";
    else if (confirmedMembers.length > 0) state = confirmedMembers.map(entry => entry.verdict.state).sort((a, b) => STATE_RANK[b] - STATE_RANK[a])[0];
    else if (refuted) state = "refuted";
    else state = "inferred";
    const severities = confirmedMembers.map(entry => entry.member.severity).filter(Number.isInteger);
    const severity = severities.length ? Math.max(...severities) : null;
    const owners = uniqueSorted(members.map(member => `${member.owner}:${member.origin}`));
    const qualityRank = { strong: 3, moderate: 2, weak: 1 };
    const primaryQuality = members.flatMap(member => (member.evidence_keys ?? []).map(key => key.quality)).filter(quality => qualityRank[quality]).sort((a, b) => qualityRank[b] - qualityRank[a])[0] ?? null;
    const limitations = uniqueSorted(memberStates.flatMap(entry => entry.verdict.limitations.map(text => `${entry.member.finding_id}: ${text}`)));
    for (const dimension of dimensions) {
      groups.push({
        group_id: `${defectId}:${dimension}`,
        defect_id: defectId,
        dimension,
        members: memberIds,
        defect_class: members.find(member => member.defect_class)?.defect_class ?? null,
        predicate_id: members.find(member => nonempty(member.predicate?.predicate_id))?.predicate.predicate_id ?? null,
        severity,
        evidentiary_state: state,
        confirmed: CONFIRMED_STATES.includes(state),
        primary_quality: primaryQuality,
        owners,
        holders: uniqueSorted(members.map(member => member.owner)),
        limitations,
      });
    }
  }
  groups.sort((a, b) => compare(a.group_id, b.group_id));
  const unresolvedOut = uniqueSorted(unresolved.map(entry => canonicalJson({ members: uniqueSorted(entry.members), reason: entry.reason }))).map(text => JSON.parse(text));
  rejectedLinks.sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
  return { groups, unresolved: unresolvedOut, rejected_links: rejectedLinks, finding_states: Object.fromEntries(ids.map(id => [id, states.get(id).state])) };
}

module.exports = {
  CONFIRMED_STATES,
  DEFECT_CLASSES,
  DEFECT_DIMENSIONS,
  KEY_KINDS,
  ORIGINS,
  OWNERS,
  QUALITIES,
  RECEIPT_SCHEMA,
  canonicalJson,
  checkKey,
  classifyEvidence,
  classifyOrigin,
  codeKey,
  commandKey,
  containmentVerified,
  contributionDependence,
  dedupeKeys,
  deriveAdoptedDimensions,
  evidentiaryState,
  groupCanonicalDefects,
  matchKeys,
  normalizeRelativePath,
  parseLineRange,
  resolveDependenceGraph,
  seiMetricKey,
  strengthFactors,
};
