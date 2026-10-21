"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Scope = require("../shared/repository-scope");

const IMPACT_GATE_SCHEMA_VERSION = "connected-impact-gate@2";
const FULL_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SIGNAL_REASON = Object.freeze({
  "auth-boundary": "AUTHORIZATION_BOUNDARY_CHANGE",
  "cross-repository-contract": "CROSS_REPOSITORY_CONTRACT_CHANGE",
  "database-schema": "DATABASE_SCHEMA_CHANGE",
  "event-schema": "EVENT_SCHEMA_CHANGE",
  "exported-type": "EXPORTED_TYPE_CHANGE",
  migration: "MIGRATION_CHANGE",
  "public-api": "PUBLIC_API_CHANGE",
  "semantic-boundary-unknown": "SEMANTIC_BOUNDARY_UNKNOWN",
  "shared-config-contract": "SHARED_CONFIG_CONTRACT_CHANGE",
  "wire-schema": "WIRE_SCHEMA_CHANGE",
});
const FULL_REASON_CODES = new Set(Object.values(SIGNAL_REASON));

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

function deriveSignals(repositoryPath, patch = "") {
  const value = repositoryPath.toLowerCase();
  const changedLines = String(patch).split(/\r?\n/).filter((line) => /^[+-](?![+-])/.test(line)).map((line) => line.slice(1)).join("\n").toLowerCase();
  const signals = new Set();
  const authSemantics = /\b(?:authenticat(?:e|ion)|authoriz(?:e|ation)|permissions?|access[_ -]?control|acl|role[_ -]?check|policy[_ -]?check|is[_ -]?admin|isadmin|has[_ -]?role|hasrole|principal|claims?|scopes?)\b/.test(changedLines);
  const moduleExport = /\bmodule\.exports\b|\bexports\s*\.|\bexport\s*(?:\{|\*|default\b)/.test(changedLines);
  const routeDeclaration = /\b(?:router|app)\s*\.\s*(?:get|post|put|patch|delete)\s*\(/.test(changedLines);
  const publicMethod = /\bpublic\s+(?:(?:static|final|abstract|virtual|override|async|synchronized)\s+)*(?:[a-z_$][\w$<>\[\]?.,]*\s+)+[a-z_$][\w$]*\s*\(/i.test(changedLines);
  const exportedDeclaration = /\bexport\s+(?:(?:declare|default|abstract)\s+)*(?:type|interface|class|function|const|let|var|enum)\b|\bpublic\s+(?:class|interface|record|enum|struct)\b/.test(changedLines);
  if (/(?:^|\/)(?:auth|authentication|authorization|permissions?|policies)(?:\/|[._-]|$)/.test(value) || authSemantics) signals.add("auth-boundary");
  if (/(?:^|\/)(?:api|public|openapi|endpoints?)(?:\/|[._-]|$)/.test(value) || /\b(?:openapi|public api|endpoint)\b/.test(changedLines) || routeDeclaration || moduleExport || publicMethod) signals.add("public-api");
  if (/\.d\.(?:ts|mts|cts)$/.test(value) || /(?:^|\/)(?:public|exports?|types?)(?:\/|[._-]|$)/.test(value) || exportedDeclaration) signals.add("exported-type");
  if (/(?:^|\/)(?:db|database)(?:\/|$).*(?:schema|migrations?)|(?:^|\/)(?:schema|migrations?)(?:\/|[._-]|$)/.test(value) || /\b(?:create|alter|drop)\s+(?:table|column|index|constraint)\b/.test(changedLines)) signals.add("database-schema");
  if (/(?:^|\/)migrations?(?:\/|[._-]|$)/.test(value) || /\b(?:migrate|migration|backfill)\b/.test(changedLines)) signals.add("migration");
  if (/(?:^|\/)(?:events?|event-schema)(?:\/|[._-]|$)/.test(value) || /\b(?:event[_ -]?schema|event[_ -]?type|publish\s*\(|emit\s*\()/.test(changedLines)) signals.add("event-schema");
  if (/\.(?:proto|avsc|thrift)$/.test(value) || /(?:^|\/)(?:wire|protocol)(?:\/|[._-]|$)/.test(value) || /\b(?:protobuf|avro|thrift|wire[_ -]?(?:format|schema|protocol))\b/.test(changedLines)) signals.add("wire-schema");
  if (/(?:^|\/)contracts?(?:\/|[._-]|$)/.test(value) || /\b(?:external|cross[_ -]?repository|consumer)[_ -]?contract\b/.test(changedLines)) signals.add("cross-repository-contract");
  if (/(?:^|\/)(?:shared[-_.]?config|config\/shared)(?:\/|[._-]|$)/.test(value) || /\bshared[_ -]?config(?:uration)?\b/.test(changedLines)) signals.add("shared-config-contract");
  const unresolvedBoundaryHint = /\b(?:export|public|authoriz|authenticat|permission|admin|role|scope|claim|principal|endpoint|route)\w*\b|\b(?:module\.exports|exports\s*\.)/.test(changedLines);
  if (unresolvedBoundaryHint && !["auth-boundary", "public-api", "exported-type"].some((signal) => signals.has(signal))) signals.add("semantic-boundary-unknown");
  return [...signals].sort();
}

function git(repositoryRoot, args, encoding = "utf8") {
  try { return execFileSync("git", ["-C", repositoryRoot, ...args], { encoding, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); }
  catch (error) { fail("FAIL-IMPACT-GIT-EVIDENCE", String(error.stderr || error.message || error).trim()); }
}

function resolveCommit(repositoryRoot, revision, label) {
  if (!FULL_OID.test(revision)) fail("FAIL-IMPACT-GATE-INPUT", `${label} must be a full commit OID`);
  const resolved = String(git(repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`])).trim().toLowerCase();
  if (resolved !== revision) fail("FAIL-IMPACT-GIT-EVIDENCE", `${label} did not resolve exactly`);
  return resolved;
}

function deriveGitEvidence(input) {
  const requestedRoot = text(input.repository_root, "repository_root");
  let repositoryRoot;
  try { repositoryRoot = fs.realpathSync.native(path.resolve(requestedRoot)); }
  catch (_) { fail("FAIL-IMPACT-GIT-EVIDENCE", "repository_root is unavailable"); }
  const baseRevision = resolveCommit(repositoryRoot, text(input.base_revision, "base_revision").toLowerCase(), "base_revision");
  const repositoryRevision = resolveCommit(repositoryRoot, text(input.repository_revision, "repository_revision").toLowerCase(), "repository_revision");
  const raw = git(repositoryRoot, ["diff", "--no-renames", "--name-only", "-z", baseRevision, repositoryRevision, "--"], "buffer");
  const paths = raw.toString("utf8").split("\0").filter(Boolean).map((value) => {
    try { return Scope.canonicalRepositoryPath(value.replace(/\\/g, "/")); }
    catch (_) { fail("FAIL-IMPACT-GIT-EVIDENCE", "Git emitted a non-canonical path"); }
  }).sort();
  if (paths.length === 0) fail("FAIL-IMPACT-GIT-EVIDENCE", "the bound revisions have no changes");
  const patches = new Map(paths.map((repositoryPath) => [repositoryPath, String(git(repositoryRoot, ["diff", "--no-ext-diff", "--no-renames", "--unified=0", baseRevision, repositoryRevision, "--", repositoryPath]))]));
  return Object.freeze({ repositoryRoot, baseRevision, repositoryRevision, paths: Object.freeze(paths), patches });
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
    fail("FAIL-IMPACT-GATE-INPUT", `${label} must be bounded non-empty text`);
  }
  return value;
}

function normalizeGraph(graph, repositoryRevision) {
  if (graph === undefined) return Object.freeze({ nodes: Object.freeze([]), edges: Object.freeze([]) });
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) fail("FAIL-IMPACT-GATE-INPUT", "dependency_graph must be an object");
  if (graph.repository_revision !== undefined && graph.repository_revision !== repositoryRevision) {
    fail("FAIL-IMPACT-GRAPH-REVISION", "dependency graph is not bound to the requested repository revision");
  }
  if (graph.nodes !== undefined && !Array.isArray(graph.nodes)) fail("FAIL-IMPACT-GATE-INPUT", "dependency_graph.nodes must be an array");
  if (graph.edges !== undefined && !Array.isArray(graph.edges)) fail("FAIL-IMPACT-GATE-INPUT", "dependency_graph.edges must be an array");
  const nodes = [...new Set((graph.nodes ?? []).map((value, index) => text(value, `dependency_graph.nodes[${index}]`)))].sort();
  const nodeSet = new Set(nodes);
  const edges = (graph.edges ?? []).map((edge, index) => {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) fail("FAIL-IMPACT-GATE-INPUT", `dependency_graph.edges[${index}] must be an object`);
    const from = text(edge.from, `dependency_graph.edges[${index}].from`);
    const to = text(edge.to, `dependency_graph.edges[${index}].to`);
    nodeSet.add(from);
    nodeSet.add(to);
    return { from, to };
  }).sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  return Object.freeze({ nodes: Object.freeze([...nodeSet].sort()), edges: Object.freeze(edges.map(Object.freeze)) });
}

class RevisionGraphCache {
  constructor() {
    this.byRevision = new Map();
  }

  resolve(repositoryRevision, graph) {
    const graphHash = digest(graph);
    const existing = this.byRevision.get(repositoryRevision);
    if (existing) {
      if (existing.graph_hash !== graphHash) fail("FAIL-IMPACT-GRAPH-DRIFT", "one repository revision resolved to different dependency graphs");
      return Object.freeze({ ...existing, cache_hit: true });
    }
    const entry = Object.freeze({
      repository_revision: repositoryRevision,
      graph_hash: graphHash,
      cache_key: digest({ repository_revision: repositoryRevision, graph_hash: graphHash }),
      graph,
    });
    this.byRevision.set(repositoryRevision, entry);
    return Object.freeze({ ...entry, cache_hit: false });
  }
}

function reachableComponents(graph, roots) {
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function normalizeChanges(changes, evidence) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 10_000) {
    fail("FAIL-IMPACT-GATE-INPUT", "changes must contain 1..10000 entries");
  }
  return changes.map((change, index) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) fail("FAIL-IMPACT-GATE-INPUT", `changes[${index}] must be an object`);
    if (change.signals !== undefined && !Array.isArray(change.signals)) fail("FAIL-IMPACT-GATE-INPUT", `changes[${index}].signals must be an array`);
    if (change.deployable_units !== undefined && !Array.isArray(change.deployable_units)) fail("FAIL-IMPACT-GATE-INPUT", `changes[${index}].deployable_units must be an array`);
    const declaredSignals = [...new Set(change.signals ?? [])].sort();
    for (const signal of declaredSignals) {
      if (typeof signal !== "string" || !Object.hasOwn(SIGNAL_REASON, signal)) fail("FAIL-IMPACT-GATE-INPUT", `changes[${index}] contains an unknown signal`);
    }
    let repositoryPath;
    try { repositoryPath = Scope.canonicalRepositoryPath(change.path); }
    catch (_) { fail("FAIL-IMPACT-GATE-INPUT", `changes[${index}].path is not a canonical repository path`); }
    const derivedSignals = deriveSignals(repositoryPath, evidence.patches.get(repositoryPath) || "");
    const derivedSet = new Set(derivedSignals);
    const underivedSignals = declaredSignals.filter((signal) => !derivedSet.has(signal));
    if (underivedSignals.length) fail("FAIL-IMPACT-SIGNAL-UNDERIVED", `changes[${index}] contains caller-only signals: ${underivedSignals.join(",")}`);
    const signals = derivedSignals;
    const dependencyFanout = change.dependency_fanout ?? 0;
    if (!Number.isSafeInteger(dependencyFanout) || dependencyFanout < 0) fail("FAIL-IMPACT-GATE-INPUT", `changes[${index}].dependency_fanout is invalid`);
    const deployableUnits = [...new Set(change.deployable_units ?? [])].map((value, unitIndex) => text(value, `changes[${index}].deployable_units[${unitIndex}]`)).sort();
    return Object.freeze({
      path: repositoryPath,
      component: text(change.component, `changes[${index}].component`),
      signals: Object.freeze(signals),
      derived_signals: Object.freeze(derivedSignals),
      dependency_fanout: dependencyFanout,
      deployable_units: Object.freeze(deployableUnits),
    });
  });
}

function evaluateImpactGate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("FAIL-IMPACT-GATE-INPUT", "input must be an object");
  const evidence = deriveGitEvidence(input);
  const repositoryRevision = evidence.repositoryRevision;
  const changes = normalizeChanges(input.changes, evidence);
  try { Scope.canonicalRepositoryPaths(changes.map((change) => change.path)); }
  catch (_) { fail("FAIL-IMPACT-GATE-INPUT", "change paths contain aliases or case collisions"); }
  if (JSON.stringify(changes.map((change) => change.path).sort()) !== JSON.stringify(evidence.paths)) fail("FAIL-IMPACT-CHANGESET-DRIFT", "caller paths do not exactly match the Git diff");
  if (input.explicit_request !== undefined && typeof input.explicit_request !== "boolean") fail("FAIL-IMPACT-GATE-INPUT", "explicit_request must be boolean");
  const graph = normalizeGraph(input.dependency_graph, repositoryRevision);
  const graphCache = input.graphCache ?? new RevisionGraphCache();
  if (!(graphCache instanceof RevisionGraphCache)) fail("FAIL-IMPACT-GATE-INPUT", "graphCache must be a RevisionGraphCache");
  const cached = graphCache.resolve(repositoryRevision, graph);
  const changedComponents = new Set(changes.map((change) => change.component));
  const affected = reachableComponents(graph, changedComponents);
  for (const change of changes) for (const unit of change.deployable_units) affected.add(unit);

  const reasons = new Set();
  if (input.explicit_request) reasons.add("EXPLICIT_REQUEST");
  for (const change of changes) {
    for (const signal of change.signals) reasons.add(SIGNAL_REASON[signal]);
    if (change.dependency_fanout >= 5) reasons.add("HIGH_DEPENDENCY_FANOUT");
  }
  const deployableUnits = new Set(changes.flatMap((change) => change.deployable_units));
  if (deployableUnits.size >= 2) reasons.add("MULTIPLE_DEPLOYABLE_UNITS");
  const discoveredFanout = affected.size - changedComponents.size;
  if (discoveredFanout >= 5) reasons.add("HIGH_DEPENDENCY_FANOUT");

  let level;
  const hasFullReason = [...reasons].some((reason) => FULL_REASON_CODES.has(reason)
    || ["EXPLICIT_REQUEST", "HIGH_DEPENDENCY_FANOUT", "MULTIPLE_DEPLOYABLE_UNITS"].includes(reason));
  if (hasFullReason) {
    level = "full";
  } else if (changes.length > 1) {
    level = "light";
    reasons.add("INTERNAL_MULTI_FILE");
  } else if (discoveredFanout > 0) {
    level = "light";
    reasons.add("DEPENDENCY_FANOUT_PRESENT");
  } else {
    level = "skip";
    reasons.add("LOCAL_IMPLEMENTATION_ONLY");
  }

  return Object.freeze({
    schema_version: IMPACT_GATE_SCHEMA_VERSION,
    level,
    reason_codes: Object.freeze([...reasons].sort()),
    affected_components: Object.freeze([...affected].sort()),
    repository_revision: repositoryRevision,
    base_revision: evidence.baseRevision,
    repository_identity: digest({ repository_root: evidence.repositoryRoot.replace(/\\/g, "/").toLowerCase() }),
    changed_path_set_sha256: digest(changes.map((change) => change.path).sort()),
    semantic_patch_set_sha256: digest(evidence.paths.map((repositoryPath) => ({ path: repositoryPath, patch: evidence.patches.get(repositoryPath) }))),
    graph_cache: Object.freeze({
      cache_hit: cached.cache_hit,
      cache_key: cached.cache_key,
      graph_hash: cached.graph_hash,
      repository_revision: cached.repository_revision,
    }),
  });
}

module.exports = Object.freeze({
  IMPACT_GATE_SCHEMA_VERSION,
  RevisionGraphCache,
  SIGNAL_REASON,
  deriveSignals,
  evaluateImpactGate,
});
