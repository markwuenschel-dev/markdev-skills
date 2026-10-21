"use strict";
/* Verifier for integrity.coverage@2 (composite-scoring-v3 §7.1) and the RIA-mode
 * requirements on Integrity-minted findings (§6.4). Owned by the Integrity
 * package; RIA's normalizer calls the same function when it reads a bound ledger.
 *
 * Vocabularies are imported, never restated: surfaces, criticality weights,
 * coverage credits and evidence factors come from Health's exports through the
 * RIA scoring-config loader (which records their digests); coverage states,
 * evidence qualities and negative-claim validation come from Evidence Recon.
 * Coverage is always computed here; a declared coverage number is rejected. */

const { loadScoringConfig } = require("../../shared/ria-scoring/composite-v2-config.js");
const { validateNegativeClaim } = require("../../shared/evidence-recon/evidence-recon.js");
const { normalizeRelativePath } = require("../../shared/ria-scoring/evidence-model.js");

const COVERAGE_SCHEMA = "integrity.coverage@2";
const DIMENSIONS = Object.freeze(["correctness", "contracts", "security", "reliability"]);
const SURFACE_KEYS = Object.freeze(["surface_id", "criticality_weight", "state", "evidence_quality", "methods", "scope", "evidence_refs", "reason", "weight_rationale"]);
const DIMENSION_KEYS = Object.freeze(["surfaces", "negative_claims", "not_applicable"]);
const REF_KINDS = Object.freeze(["candidate", "claim", "path", "command", "inventory", "rationale"]);
const EVIDENCED_STATES = Object.freeze(["inspected", "sampled", "inventory-only"]);
const INTEGRITY_NAMESPACE = "integrity:";

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value) { return typeof value === "string" && value.trim().length > 0; }

/** A path ref without its line suffix, normalized; throws on escape or absolute paths. */
function refPath(ref, casePolicy) { return normalizeRelativePath(String(ref).replace(/:[L\d][\d\-–L]*$/, ""), { casePolicy }); }

/** §7.1 rule 4: a path ref must name a file that exists at the assessed revision. Without a
 * `resolveSource` the check is syntax-only and the result reports sources_verified: false. */
function resolutionProblem(relative, label, resolveSource) {
  if (!resolveSource) return null;
  const state = resolveSource(relative)?.state;
  if (state === "present") return null;
  return state === "unavailable" ? `${label} ${relative} cannot be resolved at the assessed revision` : `${label} ${relative} does not exist at the assessed revision`;
}

/** Validates one evidence ref {kind, ref, revision?}. Returns a problem string or null.
 * With a `resolveSource` (RIA consumption) every ref must resolve (§7.1 rule 4): a `path` or
 * `inventory` ref names a file present at the assessed revision, a `claim` ref names a
 * negative claim in this ledger, a `command` ref names a command in the bound verification
 * baseline (`resolveCommand`), and a `rationale` is not a resolvable reference at all. */
function refProblem(ref, { candidateIds, claimIds, revision, casePolicy, resolveSource, resolveCommand }) {
  if (!isRecord(ref) || !REF_KINDS.includes(ref.kind) || !text(ref.ref)) return `evidence ref must be {kind: ${REF_KINDS.join("|")}, ref}`;
  for (const key of Object.keys(ref)) if (!["kind", "ref", "revision"].includes(key)) return `evidence ref key ${key} is not declared`;
  if (ref.revision !== undefined && ref.revision !== revision) return `evidence ref ${ref.ref} is bound to revision ${ref.revision}, not ${revision}`;
  if (ref.kind === "candidate" && !candidateIds.has(ref.ref)) return `evidence ref candidate ${ref.ref} does not resolve to a ledger row`;
  if (ref.kind === "path") {
    let relative;
    try { relative = refPath(ref.ref, casePolicy); }
    catch (error) { return `evidence ref path ${ref.ref}: ${error.message}`; }
    return resolutionProblem(relative, "evidence ref path", resolveSource);
  }
  if (!resolveSource) return null;
  if (ref.kind === "inventory") {
    let relative;
    try { relative = refPath(ref.ref, casePolicy); }
    catch (error) { return `evidence ref inventory ${JSON.stringify(ref.ref)} does not name an inventory file: ${error.message}`; }
    return resolutionProblem(relative, "evidence ref inventory", resolveSource);
  }
  if (ref.kind === "claim" && !claimIds.has(ref.ref)) return `evidence ref claim ${ref.ref} does not resolve to a negative claim in this ledger`;
  if (ref.kind === "command" && !(typeof resolveCommand === "function" && resolveCommand(ref.ref))) return `evidence ref command ${ref.ref} does not resolve to a command in the bound verification baseline`;
  if (ref.kind === "rationale") return `evidence ref rationale ${JSON.stringify(ref.ref)} is prose, not a resolvable reference`;
  return null;
}

/** The recorded scope of an applicable inspected or sampled surface, for absence (§7.1 rule
 * 5), as an explicit inventory of files. Its `path` refs are inventory. Its `scope` text must
 * be one of a closed set of forms: empty or `<surface_id> at the assessed revision` (the
 * surface itself, enumerated by its path refs), or a list of repository file paths separated
 * by commas, whitespace or "and", every one of which resolves to a file at the assessed
 * revision. Anything else (prose, a quoted name, a directory, an unresolved path) and any
 * inventory, command or claim ref cannot be enumerated to files, so it is returned in
 * `unenumerable` and keeps the uncertainty: absence over it is unsupported. Nothing in the
 * scope text is ever silently dropped. Candidate refs are graded rows, not scope, so a surface
 * that cites only candidates has an empty inventory, which is itself unenumerable. */
function recordedScope(surface, { casePolicy, resolveSource }) {
  const paths = [];
  const unenumerable = [];
  for (const ref of surface.evidence_refs) {
    if (ref.kind === "path") paths.push(refPath(ref.ref, casePolicy));
    else if (ref.kind !== "candidate") unenumerable.push(`${ref.kind}:${ref.ref}`);
  }
  const scope = String(surface.scope ?? "").trim();
  if (scope !== "" && scope !== `${surface.surface_id} at the assessed revision`) {
    for (const token of scope.split(/[\s,]+/).filter(item => item && item !== "and")) {
      let relative = null;
      try { relative = refPath(token, casePolicy); } catch { relative = null; }
      if (relative !== null && relative === token && resolveSource?.(relative)?.state === "present") paths.push(relative);
      else unenumerable.push(`scope ${JSON.stringify(token)}`);
    }
  }
  // An inspected or sampled surface whose inventory lists no file has not been enumerated:
  // an empty list must keep the uncertainty, not pass an empty-list comparison.
  if (paths.length === 0) unenumerable.push("no file inventory (no path ref or file path in scope)");
  return { paths, unenumerable };
}

/** True when `scope` (a normalized path) is the same file as, or a directory above, `target`. */
function pathCovers(scope, target) { return scope === target || target.startsWith(`${scope}/`); }

/** §7.1 rule 5: a negative claim supports absence for a dimension only if it is
 * a valid Evidence Recon receipt with supports_absence, its search scope names
 * every applicable mapped surface (`surface:<id>`), its exclusions remove no
 * graded surface or Integrity row, and its methods name every configured defect
 * check for the dimension (`defect-check:<class>`). Its path sources must exist at the
 * assessed revision and cover every path the applicable surfaces record as inspected or
 * sampled (a search of one file cannot establish absence over a wider recorded scope), and
 * every exclusion must be a surface, a ledger row or a repository path that removes no
 * recorded or graded path; free-text exclusions cannot be checked and so defeat absence. */
function negativeClaimVerdict(claim, { dimension, applicableSurfaces, surfaceStates, checks, candidateIds, recordedPaths, unenumerableScope, gradedPaths, casePolicy, resolveSource }) {
  const shape = validateNegativeClaim(claim, `negative_claims[${claim?.negative_claim_id ?? "?"}]`);
  const problems = shape.problems.map(problem => `${problem.code}: ${problem.message}`);
  const limitations = [];
  if (!shape.ok) return { id: claim?.negative_claim_id ?? null, valid: false, supports_absence: false, quality: null, problems, limitations };
  const scope = new Set(claim.search_scope);
  const missingSurfaces = applicableSurfaces.filter(surface => !scope.has(`surface:${surface}`));
  if (missingSurfaces.length) limitations.push(`search scope omits mapped surfaces: ${missingSurfaces.join(", ")}`);
  // §7.3: the claim asserts inspected coverage over the mapped surfaces (Evidence Recon requires
  // it), so every applicable surface it covers must itself be inspected; "sampling every surface
  // therefore cannot produce a 100", and neither can an uninspected or inventory-only surface.
  const notInspected = applicableSurfaces.filter(surface => surfaceStates[surface] !== "inspected").map(surface => `${surface} (${surfaceStates[surface]})`);
  if (notInspected.length) limitations.push(`negative claim asserts inspected coverage, but these applicable surfaces are not inspected: ${notInspected.join(", ")}`);
  const methods = new Set(claim.search_methods);
  const missingChecks = checks.filter(check => !methods.has(`defect-check:${check}`));
  if (missingChecks.length) limitations.push(`search methods omit configured ${dimension} defect checks: ${missingChecks.join(", ")}`);
  const searched = [];
  for (const source of claim.sources) {
    if (!["path", "line"].includes(source.kind)) continue;
    let relative;
    try { relative = refPath(source.ref, casePolicy); }
    catch (error) { problems.push(`negative claim ${claim.negative_claim_id} source ${source.ref}: ${error.message}`); continue; }
    const unresolved = resolutionProblem(relative, `negative claim ${claim.negative_claim_id} source`, resolveSource);
    if (unresolved) problems.push(unresolved);
    else searched.push(relative);
  }
  const unsearched = recordedPaths.filter(target => !searched.some(scopePath => pathCovers(scopePath, target)));
  if (unsearched.length) limitations.push(`search sources do not cover the recorded surface scope: ${unsearched.join(", ")}`);
  if (unenumerableScope.length) limitations.push(`recorded surface scope cannot be enumerated to paths, so its search cannot be checked: ${unenumerableScope.join(", ")}`);
  const excluded = [];
  for (const item of claim.exclusions) {
    if (applicableSurfaces.some(surface => item === `surface:${surface}`) || candidateIds.has(item)) { excluded.push(item); continue; }
    if (/^surface:/.test(item)) continue;
    let relative = null;
    try { if (!/\s/.test(item.trim())) relative = refPath(item, casePolicy); } catch { relative = null; }
    if (relative === null) { limitations.push(`exclusion ${JSON.stringify(item)} is not a surface, ledger row or repository path, so its effect on graded scope cannot be checked`); continue; }
    if ([...recordedPaths, ...gradedPaths].some(target => pathCovers(relative, target))) excluded.push(item);
  }
  if (excluded.length) limitations.push(`exclusions remove graded scope: ${excluded.join(", ")}`);
  if (problems.length) return { id: claim.negative_claim_id, valid: false, supports_absence: false, quality: null, problems, limitations };
  const supports = claim.supports_absence === true && limitations.length === 0;
  return { id: claim.negative_claim_id, valid: true, supports_absence: supports, quality: claim.evidence_quality, problems, limitations };
}

/** Verifies one dimension of the receipt and computes its coverage (§7.1 rules 1-4). */
function verifyDimension(dimension, entry, context) {
  const { config, imports, candidateIds, claimIds, revision, casePolicy, resolveSource, resolveCommand, gradedPaths } = context;
  const refContext = { candidateIds, claimIds, revision, casePolicy, resolveSource, resolveCommand };
  const problems = [];
  const surfacesDefault = imports.health_default_surfaces;
  const credits = imports.health_coverage_credit;
  const factors = imports.health_evidence_factor;
  const mapped = config.integrity_surface_map[dimension];
  const checks = config.integrity_defect_checks[dimension];
  if (!isRecord(entry)) return { problems: [`${dimension}: dimension receipt is required`] };
  for (const key of Object.keys(entry)) if (!DIMENSION_KEYS.includes(key)) problems.push(`${dimension}.${key} is not declared${/coverage/.test(key) ? " (declared coverage numbers are rejected; coverage is computed)" : ""}`);
  if (!Array.isArray(entry.surfaces)) problems.push(`${dimension}.surfaces must be an array`);
  if (!Array.isArray(entry.negative_claims)) problems.push(`${dimension}.negative_claims must be an array (use [] when none)`);
  if (problems.length) return { problems };

  const seen = new Map();
  for (const [index, surface] of entry.surfaces.entries()) {
    const at = `${dimension}.surfaces[${index}]`;
    if (!isRecord(surface)) { problems.push(`${at} must be an object`); continue; }
    for (const key of Object.keys(surface)) if (!SURFACE_KEYS.includes(key)) problems.push(`${at}.${key} is not declared${/coverage/.test(key) ? " (declared coverage numbers are rejected; coverage is computed)" : ""}`);
    if (!text(surface.surface_id)) { problems.push(`${at}.surface_id is required`); continue; }
    if (seen.has(surface.surface_id)) problems.push(`${dimension}: duplicate surface ${surface.surface_id}`);
    seen.set(surface.surface_id, surface);
    const defaults = surfacesDefault[surface.surface_id];
    if (!defaults) { problems.push(`${at}: unknown surface ${surface.surface_id}`); continue; }
    if (!mapped.includes(surface.surface_id)) problems.push(`${at}: surface ${surface.surface_id} is not mapped to ${dimension}; record it under the dimension it was inspected for`);
    if (!Object.prototype.hasOwnProperty.call(credits, surface.state)) problems.push(`${at}.state ${JSON.stringify(surface.state)} is not an Evidence Recon coverage state`);
    if (!Object.prototype.hasOwnProperty.call(factors, surface.evidence_quality)) problems.push(`${at}.evidence_quality ${JSON.stringify(surface.evidence_quality)} is not an Evidence Recon quality`);
    if (!Number.isInteger(surface.criticality_weight) || surface.criticality_weight < 1 || surface.criticality_weight > 5) problems.push(`${at}.criticality_weight must be an integer 1-5`);
    else if (surface.criticality_weight !== defaults.weight && !text(surface.weight_rationale)) problems.push(`${at}: criticality ${surface.criticality_weight} differs from the default ${defaults.weight} and needs weight_rationale`);
    if (!Array.isArray(surface.methods) || surface.methods.some(method => !text(method))) problems.push(`${at}.methods must be an array of non-empty strings`);
    if (typeof surface.scope !== "string") problems.push(`${at}.scope must be a string`);
    if (!Array.isArray(surface.evidence_refs)) problems.push(`${at}.evidence_refs must be an array`);
    else {
      if (EVIDENCED_STATES.includes(surface.state) && surface.evidence_refs.length === 0) problems.push(`${at}: ${surface.state} requires non-empty evidence_refs`);
      for (const ref of surface.evidence_refs) { const problem = refProblem(ref, refContext); if (problem) problems.push(`${at}: ${problem}`); }
    }
    if (EVIDENCED_STATES.includes(surface.state) && (!Array.isArray(surface.methods) || surface.methods.length === 0)) problems.push(`${at}: ${surface.state} requires methods`);
    if (surface.state === "inspected" && !["strong", "moderate"].includes(surface.evidence_quality)) problems.push(`${at}: inspected coverage requires strong or moderate evidence (Evidence Recon)`);
    if (["unavailable", "not-applicable"].includes(surface.state) && !text(surface.reason)) problems.push(`${at}: ${surface.state} requires a reason`);
    if (surface.state === "not-applicable" && defaults.core) problems.push(`${at}: core surface ${surface.surface_id} may never be not-applicable`);
  }
  for (const surface of mapped) if (!seen.has(surface)) problems.push(`${dimension}: mapped surface ${surface} is missing from the receipt`);
  if (problems.length) return { problems };

  let numerator = 0, denominator = 0, qualityWeighted = 0;
  const applicable = [];
  for (const surfaceId of mapped) {
    const surface = seen.get(surfaceId);
    const credit = credits[surface.state];
    if (credit === null) continue; // not-applicable leaves the denominator
    applicable.push(surfaceId);
    numerator += surface.criticality_weight * credit * factors[surface.evidence_quality];
    qualityWeighted += surface.criticality_weight * factors[surface.evidence_quality];
    denominator += surface.criticality_weight;
  }
  let notApplicable = false;
  if (denominator === 0) {
    const declaration = entry.not_applicable;
    const valid = isRecord(declaration) && text(declaration.rationale) && Array.isArray(declaration.evidence_refs) && declaration.evidence_refs.length > 0
      && declaration.evidence_refs.every(ref => refProblem(ref, refContext) === null);
    if (!valid) return { problems: [`${dimension}: no applicable mapped surface; a verified not_applicable {rationale, evidence_refs} declaration is required`] };
    notApplicable = true;
  } else if (entry.not_applicable !== undefined) {
    return { problems: [`${dimension}: not_applicable is only valid when no mapped surface is applicable`] };
  }

  const scopes = applicable.map(surfaceId => seen.get(surfaceId)).filter(surface => ["inspected", "sampled"].includes(surface.state)).map(surface => ({ id: surface.surface_id, ...recordedScope(surface, { casePolicy, resolveSource }) }));
  const recordedPaths = [...new Set(scopes.flatMap(scope => scope.paths))].sort();
  const unenumerableScope = scopes.flatMap(scope => scope.unenumerable.map(item => `${scope.id} ${item}`));
  const claims = entry.negative_claims.map(claim => negativeClaimVerdict(claim, { dimension, applicableSurfaces: applicable, surfaceStates: Object.fromEntries(applicable.map(surfaceId => [surfaceId, seen.get(surfaceId).state])), checks, candidateIds, recordedPaths, unenumerableScope, gradedPaths, casePolicy, resolveSource }));
  for (const claim of claims) if (!claim.valid) problems.push(...claim.problems.map(problem => `${dimension}: ${problem}`));
  if (problems.length) return { problems };
  const supporting = claims.filter(claim => claim.supports_absence);
  const qualityRank = { strong: 3, moderate: 2 };
  const bestSupporting = supporting.sort((a, b) => (qualityRank[b.quality] ?? 0) - (qualityRank[a.quality] ?? 0))[0] ?? null;
  return {
    problems: [],
    result: {
      dimension,
      not_applicable: notApplicable,
      coverage: notApplicable ? null : numerator / denominator,
      q_surface: notApplicable ? null : qualityWeighted / denominator,
      applicable_weight: denominator,
      applicable_surfaces: applicable,
      absence_supported: bestSupporting !== null,
      negative_claim_quality: bestSupporting?.quality ?? null,
      negative_claims: claims.map(({ id, supports_absence, quality, limitations }) => ({ id, supports_absence, quality, limitations })),
    },
  };
}

/** Verifies the ledger's integrity.coverage@2 receipt and, in RIA mode, the
 * required fields on Integrity-minted rows. Returns { ok, problems,
 * dimensions, limitations, import_digests, sources_verified }.
 * resolveSource(relativePath) -> { state: "present" | "absent" | "unavailable" } resolves path
 * and inventory refs at the assessed revision, and resolveCommand(commandId) -> boolean resolves
 * command refs against the bound verification baseline (§7.1 rule 4). Without resolveSource the
 * check is syntax-only,
 * sources_verified is false, and RIA does not score from the receipt. */
function verifyIntegrityCoverage(ledger, { revision, casePolicy = "sensitive", loaded = loadScoringConfig(), requireMintedFields = true, resolveSource = null, resolveCommand = null } = {}) {
  const problems = [];
  const limitations = [];
  const coverage = ledger?.coverage;
  const candidates = Array.isArray(ledger?.candidates) ? ledger.candidates : [];
  const candidateIds = new Set(candidates.map(candidate => candidate?.candidate_id).filter(text));
  const sourcesVerified = typeof resolveSource === "function";
  if (!sourcesVerified) limitations.push("coverage path refs were checked for syntax only; no source resolver was supplied");
  const gradedPaths = [...new Set(candidates.flatMap(candidate => (Array.isArray(candidate?.evidence) ? candidate.evidence : []).flatMap(item => {
    if (!text(item?.path)) return [];
    try { return [refPath(item.path, casePolicy)]; } catch { return []; }
  })))].sort();
  const claimIds = new Set(isRecord(coverage?.dimensions) ? Object.values(coverage.dimensions).flatMap(entry => (Array.isArray(entry?.negative_claims) ? entry.negative_claims : []).map(claim => claim?.negative_claim_id).filter(text)) : []);
  if (!isRecord(coverage)) return { ok: false, problems: ["coverage (integrity.coverage@2) is required"], dimensions: {}, limitations, import_digests: loaded.import_digests, sources_verified: sourcesVerified };
  for (const key of Object.keys(coverage)) if (!["schema_version", "dimensions"].includes(key)) problems.push(`coverage.${key} is not declared${/coverage|ratio|weighted/.test(key) ? " (declared coverage numbers are rejected)" : ""}`);
  if (coverage.schema_version !== COVERAGE_SCHEMA) problems.push(`coverage.schema_version must be ${COVERAGE_SCHEMA}`);
  if (!isRecord(coverage.dimensions)) problems.push("coverage.dimensions must be an object");
  const dimensions = {};
  if (isRecord(coverage.dimensions)) {
    for (const key of Object.keys(coverage.dimensions)) if (!DIMENSIONS.includes(key)) problems.push(`coverage.dimensions.${key} is not an Integrity dimension`);
    for (const dimension of DIMENSIONS) {
      const verdict = verifyDimension(dimension, coverage.dimensions[dimension], { config: loaded.config, imports: loaded.imports, candidateIds, claimIds, revision, casePolicy, resolveSource: sourcesVerified ? resolveSource : null, resolveCommand, gradedPaths });
      problems.push(...verdict.problems);
      if (verdict.result) dimensions[dimension] = verdict.result;
    }
  }
  if (requireMintedFields) {
    for (const candidate of candidates) {
      const id = String(candidate?.candidate_id ?? "");
      if (!id.startsWith(INTEGRITY_NAMESPACE)) {
        if (!Array.isArray(candidate?.lane_sources) || candidate.lane_sources.length === 0) limitations.push(`${id}: adopted row has no lane_sources; its RIA dimensions cannot be derived`);
        continue;
      }
      if (!Array.isArray(candidate.ria_dimensions) || candidate.ria_dimensions.length === 0) problems.push(`${id}: Integrity-minted rows require ria_dimensions in RIA mode`);
      if (typeof candidate.defect_class !== "string") problems.push(`${id}: Integrity-minted rows require defect_class in RIA mode`);
      if (!isRecord(candidate.ria_proof)) problems.push(`${id}: Integrity-minted rows require ria_proof (failure predicate, input binding and proofs) in RIA mode`);
      else if (revision && candidate.ria_proof.input_binding?.revision !== revision) limitations.push(`${id}: ria_proof is bound to revision ${candidate.ria_proof.input_binding?.revision}, not ${revision}; its proofs will be inadmissible`);
    }
  }
  return { ok: problems.length === 0, problems, dimensions, limitations, import_digests: loaded.import_digests, sources_verified: sourcesVerified };
}

module.exports = { COVERAGE_SCHEMA, DIMENSIONS, INTEGRITY_NAMESPACE, verifyIntegrityCoverage };
