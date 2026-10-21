"use strict";

/* Historical experimental installation diagnostic. It intentionally does not
 * import the runtime router, mutate a mission, resolve a production route, or
 * gate the production skill surface. */
const path = require("path");
const Registry = require("../../shared/capability-registry/registry");

const REQUIRED = [
  "loop-router",
  "repository-improvement-assessment",
  "remediation-graph-optimizer",
  "production-flywheel",
  "human-directed-swarm-planner",
  "shared/orchestration-runtime",
  "shared/remediation-graph",
  "shared/action-graph-execution",
  "shared/action-integration-reassessment",
  "shared/capability-registry"
];
const EXTERNAL_REFERENCED = [
  "codebase-design", "tdd", "writing-plans", "executing-plans", "subagent-driven-development",
  "requesting-code-review", "receiving-code-review", "verification-before-completion", "using-git-worktrees",
  "research", "prototype", "decision-terrain-mapper", "expanded-grill-with-docs", "superpowers", "matt-router"
];
const CONTRACT_DEPENDENCIES = {
  "production-flywheel": { required: ["expanded-grill-with-docs", "tdd", "independent-verification"], conditional: ["codebase-design", "using-git-worktrees", "decision-terrain-mapper"] },
  "repository-improvement-assessment": { required: ["repository-health-assessment", "codebase-integrity-audit-loop", "architecture-improvement-intelligence"], conditional: ["remediation-graph-optimizer"] },
};
const ACTIVE_OPERATIONAL_STATUSES = new Set(["active", "explicit-only"]);
function activeReferenceFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of require("fs").readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "__pycache__", ".pytest_cache", "dist", "build"].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^(SKILL\.md|MANIFEST\.json)$|\.(?:md|js|py)$/i.test(entry.name)) files.push(full);
    }
  }
  walk(root); return files.sort();
}

function audit(root, options = {}) {
  let inventory, snapshot;
  try {
    inventory = Registry.discover(root);
    snapshot = Registry.snapshot(root, [...new Set(REQUIRED.concat(EXTERNAL_REFERENCED))], { mirrors: options.mirrors || [] });
  } catch (error) {
    return Object.freeze({ ok: false, status: "red", exit_code: 2, severity: { 0: "blocking", 1: "warning", 2: "informational" }, findings: [{ severity: 0, code: "AUDIT_UNVERIFIABLE", message: error.message, capability: null }], errors: [error.message], warnings: [], installed_packages: [], snapshot: null });
  }
  const findings = [];
  const add = (severity, code, message, capability = null) => findings.push(Object.freeze({ severity, code, message, capability }));
  const errors = [];
  const warnings = [];
  for (const item of inventory.packages) add(2, "INSTALLED_CAPABILITY", "installed capability discovered: " + item.name, item.name);
  for (const item of snapshot.capabilities.filter(item => REQUIRED.includes(item.capability) && item.status !== "installed")) {
    const message = "missing installed package: " + item.capability;
    errors.push(message); add(0, "MISSING_PACKAGE", message, item.capability);
  }
  const byName = new Map(snapshot.capabilities.filter(item => item.status === "installed").map(item => [item.capability, item.provenance]));
  const router = byName.get("loop-router"), runtime = byName.get("shared/orchestration-runtime");
  if (!router || !runtime) { errors.push("experimental router/runtime fixture pair is incomplete"); add(0, "EXPERIMENTAL_PAIR_INCOMPLETE", "experimental router/runtime fixture pair is incomplete"); }
  else {
    if (router.lifecycle_authority || router.authority_class !== "experimental-lifecycle-router" || router.invocation_mode !== "explicit-only") { const message = "loop-router must remain explicit-only experimental infrastructure without lifecycle authority"; errors.push(message); add(0, "EXPERIMENTAL_ROUTER_CONTAINMENT_INVALID", message, "loop-router"); }
    if (!/^(?:experimental-)?durable-lifecycle-state$/.test(runtime.authority_class)) { const message = "orchestration-runtime must remain internal historical lifecycle-state infrastructure"; errors.push(message); add(0, "EXPERIMENTAL_RUNTIME_CONTAINMENT_INVALID", message, "shared/orchestration-runtime"); }
  }
  const allByName = new Map(inventory.packages.map(item => [item.name, item]));
  const requiredExternal = new Set(options.required_external || snapshot.external_overlay && snapshot.external_overlay.required_external || []);
  const conditionalExternal = new Set();
  const contractReferences = [];
  for (const [owner, dependency] of Object.entries(CONTRACT_DEPENDENCIES)) {
    const ownerPath = path.join(root, owner, "SKILL.md");
    if (!require("fs").existsSync(ownerPath)) continue;
    for (const capability of dependency.required || []) { requiredExternal.add(capability); contractReferences.push({ owner, capability, class: "required" }); }
    for (const capability of dependency.conditional || []) { conditionalExternal.add(capability); contractReferences.push({ owner, capability, class: "conditional" }); }
  }
  for (const item of snapshot.capabilities.filter(item => EXTERNAL_REFERENCED.includes(item.capability))) {
    if (item.status === "unknown" || item.status === "external-overlay") {
      const message = "external capability provenance is " + (item.status === "external-overlay" ? "overlay-only" : "unknown") + ": " + item.capability;
      if (requiredExternal.has(item.capability) && !(options.allow_host_external === true && item.status === "external-overlay")) { errors.push(message); add(0, "REQUIRED_EXTERNAL_PROVENANCE_UNKNOWN", message, item.capability); }
      else if (requiredExternal.has(item.capability)) { warnings.push("required external capability is host-resolved outside the candidate root: " + item.capability); add(1, "HOST_EXTERNAL_RESOLUTION", "required external capability is host-resolved outside the candidate root: " + item.capability, item.capability); }
      else { warnings.push(message); add(1, "OPTIONAL_EXTERNAL_PROVENANCE_UNKNOWN", message, item.capability); }
    }
  }
  const installedNames = new Set(inventory.packages.map(item => item.name));
  const knownNames = new Set([...installedNames, ...Object.keys(inventory.overlay.capabilities || {})]);
  const staticReferences = [];
  for (const file of activeReferenceFiles(root)) {
    const text = require("fs").readFileSync(file, "utf8");
    for (const referenced of [...knownNames, ...EXTERNAL_REFERENCED]) {
      if (!referenced || !text.includes(referenced)) continue;
      const historical = /histor(?:y|ical)|archive|superseded|legacy-only/i.test(text.slice(Math.max(0, text.indexOf(referenced) - 80), text.indexOf(referenced) + referenced.length + 80));
      if (!historical) staticReferences.push({ file: path.relative(root, file).split(path.sep).join("/"), referenced });
    }
  }
  const staticPairs = new Set();
  const packageNamesByPath = [...allByName.keys()].sort((a, b) => b.length - a.length);
  for (const reference of staticReferences) {
    const owner = packageNamesByPath.find((name) => reference.file === name || reference.file.startsWith(name + "/"));
    const record = owner && allByName.get(owner);
    const pair = String(owner || "unknown") + "->" + reference.referenced;
    if (reference.referenced === owner || staticPairs.has(pair)) continue;
    staticPairs.add(pair);
    if (!record || !record.expected_callees.includes(reference.referenced)) {
      const message = "static reference is not declared as a reciprocal callee: " + reference.file + " -> " + reference.referenced;
      warnings.push(message); add(1, "UNDECLARED_STATIC_REFERENCE", message, reference.referenced);
    }
  }
  for (const item of inventory.packages) {
    if (item.name !== "loop-router" && ACTIVE_OPERATIONAL_STATUSES.has(item.operational_status) && item.expected_callees.includes("loop-router")) {
      const message = "active capability declares the experimental Loop Router as a callee: " + item.name;
      errors.push(message); add(0, "ACTIVE_LOOP_ROUTER_DEPENDENCY", message, item.name);
    }
    if (item.name !== "loop-router" && item.lifecycle_authority) { const message = "competing lifecycle authority: " + item.name; errors.push(message); add(0, "COMPETING_LIFECYCLE_AUTHORITY", message, item.name); }
    if (item.external_router) { const message = "external router is contained as non-authoritative: " + item.name; warnings.push(message); add(1, "EXTERNAL_ROUTER_CONTAINED", message, item.name); }
    if (item.source === "unknown") { const message = "unknown provenance: " + item.name; warnings.push(message); add(1, "UNKNOWN_PROVENANCE", message, item.name); }
    if (item.authority_class === "unknown") { const message = "unknown authority class: " + item.name; warnings.push(message); add(1, "UNKNOWN_AUTHORITY_CLASS", message, item.name); }
    if (/(^|\/)(backup|backups|archive|archives)(\/|$)|\.bak(?:\/|$)/i.test(item.name)) { const message = "backup or archive package is reachable from discovery root: " + item.name; warnings.push(message); add(1, "BACKUP_IN_DISCOVERY_ROOT", message, item.name); }
    for (const caller of item.expected_callers) {
      if (!allByName.has(caller) && caller !== "user") { const message = "missing declared caller " + caller + " for " + item.name; errors.push(message); add(0, "MISSING_DECLARED_CALLER", message, item.name); continue; }
      const callerRecord = allByName.get(caller);
      if (callerRecord && callerRecord.expected_callees.length && !callerRecord.expected_callees.includes(item.name)) { const message = "missing reciprocal caller/callee declaration: " + caller + " -> " + item.name; warnings.push(message); add(1, "MISSING_RECIPROCAL_RELATIONSHIP", message, item.name); }
    }
    for (const callee of item.expected_callees) if (!allByName.has(callee)) { const message = "stale or external declared callee " + callee + " from " + item.name; warnings.push(message); add(1, "STALE_OR_EXTERNAL_CALLEE", message, item.name); }
  }
  const installedNameOwners = new Map();
  for (const item of inventory.packages) {
    const prior = installedNameOwners.get(item.installed_name);
    if (prior && prior !== item.real_path) { const message = "duplicate installed_name shadows another package: " + item.installed_name; errors.push(message); add(0, "DUPLICATE_INSTALLED_NAME", message, item.name); }
    installedNameOwners.set(item.installed_name, item.real_path);
  }
  const ordered = findings.sort((left, right) => left.severity - right.severity || left.code.localeCompare(right.code) || String(left.capability).localeCompare(String(right.capability)));
  const uniqueErrors = [...new Set(errors)].sort();
  const uniqueWarnings = [...new Set(warnings)].sort();
  const status = uniqueErrors.length ? "red" : uniqueWarnings.length ? "green-with-warnings" : "green";
  return Object.freeze({
    ok: uniqueErrors.length === 0,
    status,
    exit_code: status === "red" ? 2 : status === "green-with-warnings" ? 1 : 0,
    severity: { 0: "blocking", 1: "warning", 2: "informational" },
    findings: ordered,
    errors: uniqueErrors,
    warnings: uniqueWarnings,
    installed_packages: inventory.packages,
    snapshot,
    contract_dependencies: contractReferences,
    static_references: staticReferences,
  });
}

if (require.main === module) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.env.AGENT_SKILLS_ROOT;
  if (!root) throw new Error("AUDIT_SKILL_ROOT_REQUIRED");
  const result = audit(root);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.exit_code;
}
module.exports = { audit, REQUIRED, EXTERNAL_REFERENCED };
