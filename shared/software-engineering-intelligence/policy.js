"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const schema = require("./intelligence.schema.json");
const { validateAgainstSchema } = require("./schema-validator.js");

const SEVERITIES = new Set(["hard-invariant", "required", "convention", "advisory"]);
const APPLICABILITY_STATUSES = new Set(["applicable", "not_applicable", "conditional"]);
const COMPILE_INPUT_FIELDS = new Set(["document_path", "expected_digest", "rule_map"]);
const OUTPUT_REQUEST_KEY = /(^|_)(score|weighted|weight|composite|aggregate|aggregation|summary|rollup|overall|median|sum|min|max|mean|average|total|scalar|rating|rank|index|reducer|calculation|report|output)(_|$)/;
const RESULT_STATES = new Map([
  ["pass", "pass"],
  ["fail", "fail"],
  ["partial", "partial"],
  ["unverifiable", "unverifiable"],
  ["n/a", "not_applicable"],
  ["n-a", "not_applicable"],
  ["n_a", "not_applicable"],
  ["not-applicable", "not_applicable"],
  ["not_applicable", "not_applicable"],
]);
const POLICY_PROFILE_VERSION = "1.0.0";
const RULE_FIELDS = new Set([
  "rule_id",
  "source_refs",
  "category",
  "severity",
  "applicability",
  "verification",
  "oracle",
  "status",
]);
const SOURCE_REFERENCE_FIELDS = new Set(["document_path", "locator", "digest"]);
const APPLICABILITY_FIELDS = new Set(["status", "reason", "source_refs"]);
const VERIFICATION_FIELDS = new Set(["method", "evidence_refs"]);

function fail(message) {
  throw new Error(`FAIL-POLICY-SOURCE-DRIFT: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function policyProfileHash(source, rules) {
  return sha256({
    policy_profile_version: POLICY_PROFILE_VERSION,
    source,
    rules,
  });
}

function policyProfileId(hash) {
  return `policy-${hash.slice("sha256:".length, "sha256:".length + 24)}`;
}

function requireClosedKeys(value, allowed, label) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail(`${label} contains unsupported or alias fields`);
  }
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeDigest(value) {
  if (typeof value !== "string") fail("expected pinned sha256 digest is required");
  const normalized = value.toLowerCase();
  const digest = normalized.startsWith("sha256:") ? normalized : `sha256:${normalized}`;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) fail("expected digest must be a complete sha256 value");
  return digest;
}

function sourceDocument(documentPath, expectedDigest) {
  if (!isNonBlankString(documentPath)) fail("authoritative document_path is required");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(documentPath)) fail("document_path must be a local file");
  const resolved = path.resolve(documentPath.trim());
  let bytes;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) fail("document_path must identify a regular local file");
    bytes = fs.readFileSync(resolved);
  } catch (error) {
    if (String(error.message).includes("FAIL-POLICY-SOURCE-DRIFT")) throw error;
    fail(`authoritative document is absent or unreadable at ${resolved}`);
  }
  const actual = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  const expected = normalizeDigest(expectedDigest);
  if (actual !== expected) fail(`pinned digest mismatch: expected ${expected}, observed ${actual}`);
  return { document_path: fs.realpathSync(resolved), digest: actual };
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonBlankString);
}

function resolveSourceReferencePath(value, ruleId) {
  if (!isNonBlankString(value)) fail(`${ruleId} source reference document_path is blank`);
  const resolved = path.resolve(value.trim());
  try {
    if (!fs.statSync(resolved).isFile()) fail(`${ruleId} source reference is not a regular local file`);
    return fs.realpathSync(resolved);
  } catch (error) {
    if (String(error.message).includes("FAIL-POLICY-SOURCE-DRIFT")) throw error;
    fail(`${ruleId} source reference does not exist locally`);
  }
}

function validateSourceReference(reference, source, ruleId) {
  let resolvedDocumentPath;
  let locator;
  if (typeof reference === "string") {
    const separator = reference.indexOf("#");
    if (separator <= 0) fail(`${ruleId} source reference must map a local document to a nonblank locator`);
    resolvedDocumentPath = resolveSourceReferencePath(reference.slice(0, separator), ruleId);
    locator = reference.slice(separator + 1);
  } else if (isRecord(reference)) {
    requireClosedKeys(reference, SOURCE_REFERENCE_FIELDS, `${ruleId} source reference`);
    resolvedDocumentPath = resolveSourceReferencePath(reference.document_path, ruleId);
    locator = reference.locator;
    if (reference.digest !== undefined && normalizeDigest(reference.digest) !== source.digest) {
      fail(`${ruleId} source reference digest does not match authoritative source`);
    }
  } else {
    fail(`${ruleId} source reference must be a local document mapping`);
  }
  if (!isNonBlankString(locator)) fail(`${ruleId} source reference locator is blank`);
  if (!resolvedDocumentPath) resolvedDocumentPath = resolveSourceReferencePath(undefined, ruleId);
  if (resolvedDocumentPath !== source.document_path) {
    fail(`${ruleId} source reference does not bind to the authoritative document`);
  }
  return {
    document_path: resolvedDocumentPath,
    locator: locator.trim(),
    digest: source.digest,
  };
}

function validateSourceReferences(value, source, ruleId) {
  if (!Array.isArray(value) || value.length === 0) fail(`${ruleId} requires source_refs into the pinned document`);
  const references = value.map((reference) => validateSourceReference(reference, source, ruleId));
  const seen = new Set();
  references.forEach((reference) => {
    const identity = stableStringify(reference);
    if (seen.has(identity)) fail(`${ruleId} source_refs contain a duplicate canonical reference`);
    seen.add(identity);
  });
  return references.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function validateApplicability(value, source, ruleId) {
  requireClosedKeys(value, APPLICABILITY_FIELDS, `${ruleId} applicability`);
  if (!isNonBlankString(value.status)) fail(`${ruleId} applicability status is blank`);
  const status = String(value.status).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!APPLICABILITY_STATUSES.has(status)) fail(`${ruleId} applicability status is unsupported`);
  if (!isNonBlankString(value.reason)) fail(`${ruleId} applicability reason is blank`);
  value.source_refs = validateSourceReferences(value.source_refs, source, `${ruleId} applicability`);
  value.status = status;
  return status;
}

function validateVerification(rule, ruleId) {
  let usable = false;
  if (Object.hasOwn(rule, "verification")) {
    requireClosedKeys(rule.verification, VERIFICATION_FIELDS, `${ruleId} verification`);
    if (!isNonBlankString(rule.verification.method)) fail(`${ruleId} verification method is blank`);
    if (!nonEmptyStrings(rule.verification.evidence_refs)) fail(`${ruleId} verification evidence_refs are blank`);
    if (new Set(rule.verification.evidence_refs).size !== rule.verification.evidence_refs.length) {
      fail(`${ruleId} verification evidence_refs contain duplicates`);
    }
    rule.verification = {
      method: rule.verification.method.trim(),
      evidence_refs: [...rule.verification.evidence_refs].map((reference) => reference.trim()).sort(),
    };
    usable = true;
  }
  if (Object.hasOwn(rule, "oracle")) {
    if (!isNonBlankString(rule.oracle)) fail(`${ruleId} oracle is blank`);
    rule.oracle = rule.oracle.trim();
    usable = true;
  }
  if (!usable) fail(`${ruleId} requires verification or oracle`);
}

function normalizedResultState(value) {
  if (!isNonBlankString(value)) return null;
  const normalized = value.trim().toLowerCase();
  return RESULT_STATES.get(normalized) ?? RESULT_STATES.get(normalized.replace(/[\s-]+/g, "_")) ?? null;
}

function validateRule(rule, index, seen, source) {
  requireClosedKeys(rule, RULE_FIELDS, `rule_map[${index}]`);
  if (!isNonBlankString(rule.rule_id)) fail(`rule_map[${index}].rule_id is required`);
  const ruleId = rule.rule_id.trim();
  if (seen.has(ruleId)) fail(`rule_map contains duplicate rule_id ${ruleId}`);
  seen.add(ruleId);
  rule.rule_id = ruleId;
  rule.source_refs = validateSourceReferences(rule.source_refs, source, ruleId);
  if (!isNonBlankString(rule.category)) fail(`${ruleId} requires category`);
  if (!SEVERITIES.has(rule.severity)) fail(`${ruleId} has unsupported severity`);
  const applicabilityStatus = validateApplicability(rule.applicability, source, ruleId);
  validateVerification(rule, ruleId);

  const hasStatus = Object.hasOwn(rule, "status");
  const statusState = hasStatus ? normalizedResultState(rule.status) : null;
  if (hasStatus && !statusState) {
    fail(`${ruleId} has unsupported result status`);
  }
  const normalizedStatus = statusState ?? "unverifiable";
  if (!normalizedStatus) fail(`${rule.rule_id} has unsupported result status`);
  if (applicabilityStatus === "not_applicable" && normalizedStatus !== "not_applicable") {
    fail(`${ruleId} not_applicable applicability requires a not_applicable result`);
  }
  if (normalizedStatus === "not_applicable" && applicabilityStatus !== "not_applicable") {
    fail(`${ruleId} not_applicable result requires not_applicable applicability`);
  }
  rule.category = rule.category.trim();
  rule.status = normalizedStatus;
  return normalizedStatus;
}

function summarize(rules, states) {
  const counts = { pass: 0, fail: 0, partial: 0, unverifiable: 0, not_applicable: 0 };
  const byStatus = { pass: [], fail: [], partial: [], unverifiable: [], not_applicable: [] };
  rules.forEach((rule, index) => {
    const state = states[index];
    counts[state] += 1;
    byStatus[state].push(rule.rule_id);
  });
  const hardInvariantNonPasses = rules
    .filter((rule, index) => (
      rule.severity === "hard-invariant" &&
      states[index] !== "pass" &&
      states[index] !== "not_applicable"
    ))
    .map((rule) => rule.rule_id);
  let status = "pass";
  if (hardInvariantNonPasses.length > 0 || counts.fail > 0) status = "fail";
  else if (counts.partial > 0) status = "partial";
  else if (counts.unverifiable > 0) status = "unverifiable";
  else if (counts.pass === 0 && counts.not_applicable > 0) status = "not_applicable";
  return {
    status,
    counts,
    by_status: byStatus,
    hard_invariant_failures: hardInvariantNonPasses,
    hard_invariant_non_passes: hardInvariantNonPasses,
  };
}

function compileInputBoundary(input) {
  if (!isRecord(input)) fail("compile input must be an object");
  const aggregationRequests = [];
  const unknown = [];
  for (const key of Object.keys(input)) {
    if (COMPILE_INPUT_FIELDS.has(key)) continue;
    if (OUTPUT_REQUEST_KEY.test(key)) aggregationRequests.push(key);
    else unknown.push(key);
  }
  if (unknown.length > 0) fail(`unsupported compile input field(s): ${unknown.join(", ")}`);
  return aggregationRequests;
}

function schemaDefinitionErrors(value, definition) {
  return validateAgainstSchema(value, {
    $defs: schema.$defs,
    $ref: `#/$defs/${definition}`,
  });
}

function policySourceContractErrors(source) {
  const errors = [];
  if (!isRecord(source)) return ["source must be an object"];
  if (!isNonBlankString(source.document_path)) errors.push("source.document_path must be a non-empty local file path");
  if (typeof source.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(source.digest)) {
    errors.push("source.digest must be a complete sha256 digest");
  }
  if (errors.length > 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(source.document_path)) return errors;
  const resolved = path.resolve(source.document_path.trim());
  let bytes;
  let canonical;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      errors.push("source.document_path must identify a regular local file");
      return errors;
    }
    canonical = fs.realpathSync(resolved);
    bytes = fs.readFileSync(canonical);
  } catch {
    errors.push("source.document_path is absent or unreadable");
    return errors;
  }
  if (source.document_path !== canonical) {
    errors.push("source.document_path is not the canonical local path");
  }
  const actual = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  if (source.digest !== actual) {
    errors.push("source.digest does not match the authoritative local document");
  }
  return errors;
}

function validatePolicyProfile(profile) {
  const errors = schemaDefinitionErrors(profile, "policyProfile")
    .map((error) => `FAIL-POLICY-CONTRACT: ${error}`);
  if (!isRecord(profile)) return { ok: false, errors };
  policySourceContractErrors(profile.source).forEach((error) => {
    errors.push(`FAIL-POLICY-CONTRACT: ${error}`);
  });
  const expectedHash = policyProfileHash(profile.source, profile.rules);
  if (profile.policy_profile_version !== POLICY_PROFILE_VERSION) {
    errors.push("FAIL-POLICY-CONTRACT: policy_profile_version does not match the canonical contract");
  }
  if (profile.policy_profile_hash !== expectedHash) {
    errors.push("FAIL-POLICY-CONTRACT: policy_profile_hash does not match canonical source and rules");
  }
  if (profile.policy_profile_id !== policyProfileId(expectedHash)) {
    errors.push("FAIL-POLICY-CONTRACT: policy_profile_id does not match policy_profile_hash");
  }
  const rules = Array.isArray(profile.rules) ? profile.rules : [];
  if (rules.length === 0) {
    errors.push("FAIL-POLICY-CONTRACT: rules must be a non-empty authoritative rule set");
  }
  const ruleIds = new Set();
  for (const [index, rule] of rules.entries()) {
    const path = `rules[${index}]`;
    if (!isRecord(rule)) continue;
    if (ruleIds.has(rule.rule_id)) errors.push(`FAIL-DUPLICATE-ID: ${path}.rule_id duplicates ${rule.rule_id}`);
    ruleIds.add(rule.rule_id);
    for (const reference of Array.isArray(rule.source_refs) ? rule.source_refs : []) {
      if (reference?.document_path !== profile.source?.document_path || reference?.digest !== profile.source?.digest) {
        errors.push(`FAIL-POLICY-CONTRACT: ${path}.source_refs is not bound to the profile source`);
      }
    }
    for (const reference of Array.isArray(rule.applicability?.source_refs) ? rule.applicability.source_refs : []) {
      if (reference?.document_path !== profile.source?.document_path || reference?.digest !== profile.source?.digest) {
        errors.push(`FAIL-POLICY-CONTRACT: ${path}.applicability.source_refs is not bound to the profile source`);
      }
    }
    if (rule.applicability?.status === "not_applicable" && rule.status !== "not_applicable") {
      errors.push(`FAIL-POLICY-CONTRACT: ${path}.not_applicable applicability requires not_applicable status`);
    }
    if (rule.status === "not_applicable" && rule.applicability?.status !== "not_applicable") {
      errors.push(`FAIL-POLICY-CONTRACT: ${path}.not_applicable status requires not_applicable applicability`);
    }
  }
  if (isRecord(profile.summary) && Array.isArray(profile.rules) && profile.rules.every(isRecord)) {
    const stateErrors = [];
    const states = rules.map((rule, index) => {
      const state = normalizedResultState(rule.status);
      if (!state) stateErrors.push(`FAIL-POLICY-CONTRACT: rules[${index}].status is unsupported`);
      return state;
    });
    errors.push(...stateErrors);
    if (stateErrors.length === 0 && stableStringify(profile.summary) !== stableStringify(summarize(rules, states))) {
      errors.push("FAIL-POLICY-CONTRACT: summary does not match canonical rule states");
    }
  }
  return { ok: errors.length === 0, errors };
}

function compilePolicy(input = {}) {
  const aggregationRequests = compileInputBoundary(input);
  const source = sourceDocument(input.document_path, input.expected_digest);
  if (!Array.isArray(input.rule_map) || input.rule_map.length === 0) fail("rule_map must be a non-empty array");
  const rules = structuredClone(input.rule_map);
  const seen = new Set();
  const states = rules.map((rule, index) => validateRule(rule, index, seen, source));
  const summary = summarize(rules, states);
  if (aggregationRequests.length > 0 && summary.hard_invariant_non_passes.length > 0) {
    throw new Error("FAIL-HARD-INVARIANT-MASKED: a hard-invariant failure cannot be averaged or scored away");
  }
  if (aggregationRequests.length > 0) fail(`output aggregation request is unsupported: ${aggregationRequests.join(", ")}`);
  const profile = {
    policy_profile_version: POLICY_PROFILE_VERSION,
    source,
    rules,
    summary,
  };
  profile.policy_profile_hash = policyProfileHash(profile.source, profile.rules);
  profile.policy_profile_id = policyProfileId(profile.policy_profile_hash);
  const validation = validatePolicyProfile(profile);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return profile;
}

module.exports = { compilePolicy, validatePolicyProfile };
