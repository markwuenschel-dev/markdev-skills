"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { compilePolicy, validatePolicyProfile } = require("./policy.js");

const VERIFICATION_MODES = new Set(["static", "executable", "runtime", "process", "review", "external-evidence"]);
const COMPILE_FIELDS = new Set(["document_path", "expected_digest", "adoption_evidence_ref", "locators"]);
const EVALUATE_FIELDS = new Set(["profile", "repository_root", "changed_paths", "changed_paths_evidence_ref"]);
const LOCATOR_FIELDS = new Set(["heading", "fingerprint"]);
const DIRECTIVE_FIELDS = new Set(["rule_id", "mechanic"]);
const FIXTURE_SOURCE_MARKER = "<!-- sei-programming-guidelines-fixture-only -->";

const PROGRAMMING_GUIDELINES_RULES = Object.freeze([
  Object.freeze({ rule_id: "PG-LAYOUT-NAMESPACE-001", category: "layout-namespace", severity: "convention", verification_mode: "static", mechanic_kind: "forbidden_paths" }),
  Object.freeze({ rule_id: "PG-DEPENDENCY-AUTHORITY-001", category: "dependency-authority", severity: "required", verification_mode: "static", mechanic_kind: "dependency_authority" }),
  Object.freeze({ rule_id: "PG-SINGLE-OWNER-CHOKEPOINT-001", category: "single-owner-chokepoints", severity: "hard-invariant", verification_mode: "static", mechanic_kind: "sole_owner_import" }),
  Object.freeze({ rule_id: "PG-FAIL-CLOSED-001", category: "fail-closed", severity: "hard-invariant", verification_mode: "review", mechanic_kind: "unverifiable" }),
  Object.freeze({ rule_id: "PG-IDEMPOTENCY-001", category: "idempotency", severity: "required", verification_mode: "runtime", mechanic_kind: "unverifiable" }),
  Object.freeze({ rule_id: "PG-DB-TRANSACTION-LOCKING-001", category: "db-transaction-locking", severity: "hard-invariant", verification_mode: "runtime", mechanic_kind: "unverifiable" }),
  Object.freeze({ rule_id: "PG-TESTING-001", category: "testing", severity: "required", verification_mode: "executable", mechanic_kind: "required_test_layout" }),
  Object.freeze({ rule_id: "PG-GENERATED-CONTRACTS-001", category: "generated-contracts", severity: "hard-invariant", verification_mode: "process", mechanic_kind: "generated_edits" }),
  Object.freeze({ rule_id: "PG-SECRETS-CONFIG-001", category: "secrets-config", severity: "hard-invariant", verification_mode: "static", mechanic_kind: "secret_path_config" }),
  Object.freeze({ rule_id: "PG-DELIVERY-001", category: "delivery", severity: "advisory", verification_mode: "external-evidence", mechanic_kind: "unverifiable" }),
]);
const PROGRAMMING_GUIDELINES_RULE_IDS = Object.freeze(PROGRAMMING_GUIDELINES_RULES.map((rule) => rule.rule_id));

function fail(code, message) {
  throw new Error(`${code}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireClosedKeys(value, allowed, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(code, `${label} contains unsupported field(s): ${unknown.join(", ")}`);
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function normalizeDigest(value, code, label) {
  if (!nonBlank(value)) fail(code, `${label} is required`);
  const normalized = value.trim().toLowerCase();
  const result = normalized.startsWith("sha256:") ? normalized : `sha256:${normalized}`;
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) fail(code, `${label} must be a complete sha256 digest`);
  return result;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sourceDocument(input) {
  if (!nonBlank(input.document_path)) {
    fail("FAIL-PROGRAMMING-GUIDELINES-UNAVAILABLE", "an adopted authoritative document_path is required");
  }
  if (!nonBlank(input.adoption_evidence_ref)) {
    fail("FAIL-PROGRAMMING-GUIDELINES-UNAVAILABLE", "explicit repository adoption evidence is required");
  }
  const expected = normalizeDigest(
    input.expected_digest,
    "FAIL-PROGRAMMING-GUIDELINES-SOURCE-DRIFT",
    "expected_digest",
  );
  const resolved = path.resolve(input.document_path.trim());
  let bytes;
  try {
    if (!fs.statSync(resolved).isFile()) {
      fail("FAIL-PROGRAMMING-GUIDELINES-UNAVAILABLE", "document_path must identify a regular local file");
    }
    bytes = fs.readFileSync(resolved);
  } catch (error) {
    if (String(error.message).includes("FAIL-PROGRAMMING-GUIDELINES-")) throw error;
    fail("FAIL-PROGRAMMING-GUIDELINES-UNAVAILABLE", `authoritative source is absent or unreadable at ${resolved}`);
  }
  const actual = digest(bytes);
  if (actual !== expected) {
    fail("FAIL-PROGRAMMING-GUIDELINES-SOURCE-DRIFT", `expected ${expected}, observed ${actual}`);
  }
  const text = bytes.toString("utf8").replace(/\r\n?/g, "\n");
  if (text.includes(FIXTURE_SOURCE_MARKER)) {
    fail(
      "FAIL-PROGRAMMING-GUIDELINES-FIXTURE-SOURCE",
      "a fixture-only source document cannot establish repository policy",
    );
  }
  return {
    document_path: fs.realpathSync(resolved),
    digest: actual,
    text,
  };
}

function headingSection(text, heading, ruleId) {
  if (!nonBlank(heading) || !/^(#{1,6})\s+\S/.test(heading.trim())) {
    fail("FAIL-PROGRAMMING-GUIDELINES-LOCATOR", `${ruleId} heading must be an exact Markdown heading`);
  }
  const expected = heading.trim();
  const lines = text.split("\n");
  const matches = [];
  lines.forEach((line, index) => {
    if (line.trimEnd() === expected) matches.push(index);
  });
  if (matches.length !== 1) {
    fail("FAIL-PROGRAMMING-GUIDELINES-LOCATOR", `${ruleId} heading must exist exactly once: ${expected}`);
  }
  const start = matches[0];
  const level = expected.match(/^(#+)/)[1].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = lines[index].match(/^(#{1,6})\s+\S/);
    if (next && next[1].length <= level) {
      end = index;
      break;
    }
  }
  return `${lines.slice(start, end).join("\n").trimEnd()}\n`;
}

function normalizedStrings(value, label, options = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !nonBlank(entry))) {
    fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${label} must be a non-empty string array`);
  }
  const strings = value.map((entry) => entry.trim());
  if (new Set(strings).size !== strings.length) {
    fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${label} contains duplicates`);
  }
  if (options.paths && strings.some((entry) => path.isAbsolute(entry) || entry.replace(/\\/g, "/").split("/").includes(".."))) {
    fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${label} must contain repository-relative patterns`);
  }
  if (options.extensions && strings.some((entry) => !/^\.[A-Za-z0-9]+$/.test(entry))) {
    fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${label} contains an unsupported source extension`);
  }
  return strings.sort();
}

function mechanicFields(kind) {
  const fields = {
    forbidden_paths: ["kind", "patterns"],
    dependency_authority: ["kind", "manifests", "forbidden_dependencies", "forbidden_imports", "source_extensions"],
    sole_owner_import: ["kind", "specifier", "owner_patterns", "source_extensions", "require_import"],
    required_test_layout: ["kind", "required_paths", "test_patterns"],
    generated_edits: ["kind", "generated_patterns"],
    secret_path_config: ["kind", "forbidden_patterns", "required_paths"],
    unverifiable: ["kind"],
  };
  return fields[kind] ? new Set(fields[kind]) : null;
}

function validateMechanic(value, definition) {
  if (!isRecord(value) || value.kind !== definition.mechanic_kind) {
    fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${definition.rule_id} requires mechanic ${definition.mechanic_kind}`);
  }
  const allowed = mechanicFields(value.kind);
  if (!allowed) fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${definition.rule_id} uses an unsupported mechanic`);
  requireClosedKeys(value, allowed, "FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${definition.rule_id} mechanic`);
  const mechanic = { kind: value.kind };
  if (value.kind === "forbidden_paths") {
    mechanic.patterns = normalizedStrings(value.patterns, `${definition.rule_id}.patterns`, { paths: true });
  } else if (value.kind === "dependency_authority") {
    mechanic.manifests = normalizedStrings(value.manifests, `${definition.rule_id}.manifests`, { paths: true });
    mechanic.forbidden_dependencies = normalizedStrings(value.forbidden_dependencies, `${definition.rule_id}.forbidden_dependencies`);
    mechanic.forbidden_imports = normalizedStrings(value.forbidden_imports, `${definition.rule_id}.forbidden_imports`);
    mechanic.source_extensions = normalizedStrings(value.source_extensions, `${definition.rule_id}.source_extensions`, { extensions: true });
  } else if (value.kind === "sole_owner_import") {
    if (!nonBlank(value.specifier)) fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${definition.rule_id}.specifier is required`);
    if (typeof value.require_import !== "boolean") fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${definition.rule_id}.require_import must be boolean`);
    mechanic.specifier = value.specifier.trim();
    mechanic.owner_patterns = normalizedStrings(value.owner_patterns, `${definition.rule_id}.owner_patterns`, { paths: true });
    mechanic.source_extensions = normalizedStrings(value.source_extensions, `${definition.rule_id}.source_extensions`, { extensions: true });
    mechanic.require_import = value.require_import;
  } else if (value.kind === "required_test_layout") {
    mechanic.required_paths = normalizedStrings(value.required_paths, `${definition.rule_id}.required_paths`, { paths: true });
    mechanic.test_patterns = normalizedStrings(value.test_patterns, `${definition.rule_id}.test_patterns`, { paths: true });
  } else if (value.kind === "generated_edits") {
    mechanic.generated_patterns = normalizedStrings(value.generated_patterns, `${definition.rule_id}.generated_patterns`, { paths: true });
  } else if (value.kind === "secret_path_config") {
    mechanic.forbidden_patterns = normalizedStrings(value.forbidden_patterns, `${definition.rule_id}.forbidden_patterns`, { paths: true });
    mechanic.required_paths = normalizedStrings(value.required_paths, `${definition.rule_id}.required_paths`, { paths: true });
  }
  return mechanic;
}

function directiveFromSection(section, definition) {
  const expression = /<!--\s*sei-programming-guidelines\s+({[\s\S]*?})\s*-->/g;
  const matches = [...section.matchAll(expression)];
  if (matches.length !== 1) {
    fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${definition.rule_id} section requires exactly one machine-readable directive`);
  }
  let directive;
  try {
    directive = JSON.parse(matches[0][1]);
  } catch (error) {
    fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${definition.rule_id} directive is invalid JSON (${error.message})`);
  }
  requireClosedKeys(directive, DIRECTIVE_FIELDS, "FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${definition.rule_id} directive`);
  if (directive.rule_id !== definition.rule_id) {
    fail("FAIL-PROGRAMMING-GUIDELINES-DIRECTIVE", `${definition.rule_id} directive identity does not match its stable rule ID`);
  }
  return validateMechanic(directive.mechanic, definition);
}

function encodedOracle(mechanic) {
  return `pg-evaluator-v1:${Buffer.from(stableStringify(mechanic), "utf8").toString("base64url")}`;
}

function decodedOracle(rule, definition) {
  const prefix = "pg-evaluator-v1:";
  if (!nonBlank(rule.oracle) || !rule.oracle.startsWith(prefix)) {
    fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", `${rule.rule_id} has no supported evaluator oracle`);
  }
  let mechanic;
  try {
    const json = Buffer.from(rule.oracle.slice(prefix.length), "base64url").toString("utf8");
    mechanic = JSON.parse(json);
  } catch (error) {
    fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", `${rule.rule_id} evaluator oracle is invalid (${error.message})`);
  }
  const canonical = validateMechanic(mechanic, definition);
  if (encodedOracle(canonical) !== rule.oracle) {
    fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", `${rule.rule_id} evaluator oracle is not canonical`);
  }
  return canonical;
}

function programmingGuidelinesMechanics(profile) {
  const validation = validatePolicyProfile(profile);
  if (!validation.ok) {
    fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", validation.errors.join("; "));
  }
  const byId = new Map(profile.rules.map((rule) => [rule.rule_id, rule]));
  const actualIds = [...byId.keys()].sort();
  const expectedIds = [...PROGRAMMING_GUIDELINES_RULE_IDS].sort();
  if (stableStringify(actualIds) !== stableStringify(expectedIds) || byId.size !== profile.rules.length) {
    fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", "rule inventory does not match the first-party profile contract");
  }
  const sourceText = fs.readFileSync(profile.source.document_path, "utf8").replace(/\r\n?/g, "\n");
  return new Map(PROGRAMMING_GUIDELINES_RULES.map((definition) => {
    const rule = byId.get(definition.rule_id);
    if (
      rule.category !== definition.category ||
      rule.severity !== definition.severity ||
      rule.verification?.method !== definition.verification_mode
    ) {
      fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", `${definition.rule_id} classification does not match the first-party profile contract`);
    }
    if (!Array.isArray(rule.source_refs) || rule.source_refs.length !== 1) {
      fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", `${definition.rule_id} must have exactly one source section reference`);
    }
    const locator = rule.source_refs[0].locator;
    const marker = " | sha256:";
    const markerIndex = typeof locator === "string" ? locator.lastIndexOf(marker) : -1;
    if (markerIndex <= 0) {
      fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", `${definition.rule_id} locator does not carry a heading and fingerprint`);
    }
    const heading = locator.slice(0, markerIndex);
    const fingerprint = normalizeDigest(
      locator.slice(markerIndex + " | ".length),
      "FAIL-PROGRAMMING-GUIDELINES-PROFILE",
      `${definition.rule_id} locator fingerprint`,
    );
    let sourceMechanic;
    try {
      const section = headingSection(sourceText, heading, definition.rule_id);
      if (digest(Buffer.from(section, "utf8")) !== fingerprint) {
        fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", `${definition.rule_id} locator fingerprint no longer matches its source section`);
      }
      sourceMechanic = directiveFromSection(section, definition);
    } catch (error) {
      if (String(error.message).includes("FAIL-PROGRAMMING-GUIDELINES-PROFILE")) throw error;
      fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", `${definition.rule_id} is not reproducible from its pinned source (${error.message})`);
    }
    const oracleMechanic = decodedOracle(rule, definition);
    if (encodedOracle(sourceMechanic) !== encodedOracle(oracleMechanic)) {
      fail("FAIL-PROGRAMMING-GUIDELINES-PROFILE", `${definition.rule_id} evaluator oracle differs from its pinned source directive`);
    }
    return [definition.rule_id, oracleMechanic];
  }));
}

function normalizedRelativePath(value, label) {
  if (!nonBlank(value)) fail("FAIL-PROGRAMMING-GUIDELINES-INPUT", `${label} is blank`);
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.isAbsolute(value) || normalized.split("/").includes("..")) {
    fail("FAIL-PROGRAMMING-GUIDELINES-INPUT", `${label} must be repository-relative`);
  }
  return normalized;
}

function globExpression(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => globExpression(pattern).test(value));
}

function repositoryInventory(root) {
  const files = [];
  const paths = [];
  const walk = (current, relative) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!relative && entry.name === ".git") continue;
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const nextPath = path.join(current, entry.name);
      paths.push(nextRelative);
      if (entry.isDirectory()) walk(nextPath, nextRelative);
      else if (entry.isFile()) files.push(nextRelative);
    }
  };
  walk(root, "");
  return { files, paths };
}

function evidence(status, kind, details = []) {
  return {
    status,
    evidence_refs: [...new Set([`policy-evaluator:${kind}:${status}`, ...details])].sort(),
  };
}

function readQuotedString(text, start, quote) {
  let value = "";
  let hasEscape = false;
  for (let index = start + 1; index < text.length;) {
    const character = text[index];
    if (character === quote) return { value, next: index + 1, unsupported: false, has_escape: hasEscape };
    if (character === "\n" || character === "\r") return { unsupported: true };
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    hasEscape = true;
    const escape = text[index + 1];
    if (escape === undefined || escape === "\n" || escape === "\r") return { unsupported: true };
    const simpleEscapes = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      0: "\0",
    };
    if (Object.hasOwn(simpleEscapes, escape)) {
      value += simpleEscapes[escape];
      index += 2;
      continue;
    }
    if (escape === "x") {
      const hex = text.slice(index + 2, index + 4);
      if (!/^[a-fA-F0-9]{2}$/.test(hex)) return { unsupported: true };
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    if (escape === "u") {
      if (text[index + 2] === "{") {
        const end = text.indexOf("}", index + 3);
        const codePoint = end === -1 ? "" : text.slice(index + 3, end);
        if (!/^[a-fA-F0-9]{1,6}$/.test(codePoint) || Number.parseInt(codePoint, 16) > 0x10ffff) {
          return { unsupported: true };
        }
        value += String.fromCodePoint(Number.parseInt(codePoint, 16));
        index = end + 1;
        continue;
      }
      const hex = text.slice(index + 2, index + 6);
      if (!/^[a-fA-F0-9]{4}$/.test(hex)) return { unsupported: true };
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    value += escape;
    index += 2;
  }
  return { unsupported: true };
}

function readTemplateLiteral(text, start) {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "`") return { next: index + 1, unsupported: false };
    if (text[index] === "\\") {
      if (index + 1 >= text.length) return { unsupported: true };
      index += 1;
      continue;
    }
    if (text[index] === "$" && text[index + 1] === "{") return { unsupported: true };
  }
  return { unsupported: true };
}

function importSpecifiers(tokens) {
  const specifiers = new Set();
  const unsupportedImportCalls = new Set();
  const reflectionCapabilityPrimitiveNames = new Set([
    "__proto__",
    "constructor",
    "prototype",
    "getPrototypeOf",
    "setPrototypeOf",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "getOwnPropertySymbols",
    "defineProperty",
    "defineProperties",
    "isExtensible",
    "preventExtensions",
    "seal",
    "freeze",
    "ownKeys",
    "Proxy",
  ]);
  const processCapabilityPropertyNames = new Set([
    "_linkedBinding",
    "_load",
    "binding",
    "createRequire",
    "dlopen",
  ]);
  const bareKeyword = (index, value) => (
    tokens[index]?.type === "identifier"
    && tokens[index].value === value
    && tokens[index - 1]?.value !== "."
  );
  const executableBareReference = (index, value) => (
    tokens[index]?.type === "identifier"
    && tokens[index].value === value
    && (
      tokens[index - 1]?.value !== "."
      // The lexer emits spread syntax as three period tokens.  It is still an
      // executable root reference rather than a member named by the root.
      || (tokens[index - 2]?.value === "." && tokens[index - 3]?.value === ".")
    )
  );
  const literalCallSpecifier = (index) => (
    tokens[index + 1]?.value === "("
    && tokens[index + 2]?.type === "string"
    && tokens[index + 3]?.value === ")"
      ? tokens[index + 2].value
      : null
  );
  const staticLoaderCapabilityReason = Object.freeze({
    module: "static-module-loader-construction",
    "node:module": "static-module-loader-construction",
    process: "static-process-loader-capability-import",
    "node:process": "static-process-loader-capability-import",
    vm: "static-vm-code-execution-capability-import",
    "node:vm": "static-vm-code-execution-capability-import",
    child_process: "static-code-execution-capability-import",
    "node:child_process": "static-code-execution-capability-import",
    cluster: "static-code-execution-capability-import",
    "node:cluster": "static-code-execution-capability-import",
    inspector: "static-code-execution-capability-import",
    "node:inspector": "static-code-execution-capability-import",
    repl: "static-code-execution-capability-import",
    "node:repl": "static-code-execution-capability-import",
    worker_threads: "static-code-execution-capability-import",
    "node:worker_threads": "static-code-execution-capability-import",
  });
  const recordStaticSpecifier = (specifier) => {
    // This lexical oracle neither follows aliases nor proves an imported
    // capability is harmless.  Loader and direct code-execution builtins can
    // construct a repository-relative import outside the sole-owner rule, so
    // their static imports are deliberately outside its verifiable subset.
    if (Object.hasOwn(staticLoaderCapabilityReason, specifier)) {
      const reason = staticLoaderCapabilityReason[specifier];
      unsupportedImportCalls.add(reason);
      return;
    }
    specifiers.add(specifier);
  };
  const moduleRequireReference = (index) => (
    bareKeyword(index, "module")
    && tokens[index + 1]?.value === "."
    && tokens[index + 2]?.type === "identifier"
    && tokens[index + 2].value === "require"
  );
  const bareRequireReason = (index) => {
    if (tokens[index + 1]?.value === "?" && tokens[index + 2]?.value === "." && tokens[index + 3]?.value === "(") {
      return "optional-require-call";
    }
    if ([",", "("].includes(tokens[index - 1]?.value) || tokens[index + 1]?.value === ")") {
      return "indirect-require-call";
    }
    return "nontrivial-require-reference";
  };
  const computedPropertyRequireReason = (index) => {
    const closeBracket = index + 1;
    if (tokens[closeBracket + 1]?.value === "(") return "computed-property-require-call";
    if (tokens[closeBracket + 1]?.value === "?" && tokens[closeBracket + 2]?.value === "." && tokens[closeBracket + 3]?.value === "(") {
      return "optional-computed-property-require-call";
    }
    return "computed-property-require-reference";
  };
  const computedPropertyRequireReference = (index) => {
    if (tokens[index]?.type !== "string" || tokens[index].value !== "require" || tokens[index - 1]?.value !== "[" || tokens[index + 1]?.value !== "]") {
      return false;
    }
    const propertyBase = tokens[index - 2];
    if (propertyBase?.type === "identifier" || [")", "]"].includes(propertyBase?.value)) return true;
    return propertyBase?.value === "."
      && (tokens[index - 3]?.type === "identifier" || tokens[index - 3]?.value === "?" || [")", "]"].includes(tokens[index - 3]?.value));
  };
  const literalComputedModuleRequire = (index) => (
    bareKeyword(index, "module")
    && tokens[index + 1]?.value === "["
    && tokens[index + 2]?.type === "string"
    && tokens[index + 2]?.value === "require"
    && tokens[index + 3]?.value === "]"
  );
  const computedModulePropertyReference = (index) => (
    bareKeyword(index, "module")
    && tokens[index + 1]?.value === "["
    && !literalComputedModuleRequire(index)
  );
  const benignModuleExportsReference = (index) => (
    bareKeyword(index, "module")
    && tokens[index + 1]?.value === "."
    && tokens[index + 2]?.type === "identifier"
    && tokens[index + 2].value === "exports"
    && ![".", "[", "?", "("].includes(tokens[index + 3]?.value)
  );
  const unrecognizedModuleLoaderConstruction = (index) => (
    bareKeyword(index, "module")
    && !moduleRequireReference(index)
    && !computedModulePropertyReference(index)
    && !literalComputedModuleRequire(index)
    && !benignModuleExportsReference(index)
  );
  const reflectGetCall = (index) => (
    bareKeyword(index, "Reflect")
    && tokens[index + 1]?.value === "."
    && tokens[index + 2]?.type === "identifier"
    && tokens[index + 2]?.value === "get"
    && tokens[index + 3]?.value === "("
  );
  const unrecognizedReflectLoaderConstruction = (index) => (
    bareKeyword(index, "Reflect")
    && !reflectGetCall(index)
  );
  const dynamicImportCall = (index) => (
    bareKeyword(index, "import")
    && tokens[index + 1]?.value === "("
  );
  const directProcessBuiltinModuleAccessEnd = (index) => {
    if (!bareKeyword(index, "process")) return null;
    if (
      tokens[index + 1]?.value === "."
      && tokens[index + 2]?.type === "identifier"
      && tokens[index + 2].value === "getBuiltinModule"
    ) {
      return index + 2;
    }
    if (
      tokens[index + 1]?.value === "?"
      && tokens[index + 2]?.value === "."
      && tokens[index + 3]?.type === "identifier"
      && tokens[index + 3].value === "getBuiltinModule"
    ) {
      return index + 3;
    }
    return null;
  };
  const processBuiltinModuleAccessEnd = (index) => {
    const directAccessEnd = directProcessBuiltinModuleAccessEnd(index);
    if (directAccessEnd !== null) return directAccessEnd;
    if (!bareKeyword(index, "process")) return null;
    if (
      tokens[index + 1]?.value === "["
      && tokens[index + 2]?.type === "string"
      && tokens[index + 2].value === "getBuiltinModule"
      && tokens[index + 3]?.value === "]"
    ) {
      return index + 3;
    }
    if (
      tokens[index + 1]?.value === "?"
      && tokens[index + 2]?.value === "."
      && tokens[index + 3]?.value === "["
      && tokens[index + 4]?.type === "string"
      && tokens[index + 4].value === "getBuiltinModule"
      && tokens[index + 5]?.value === "]"
    ) {
      return index + 5;
    }
    return null;
  };
  const exactDirectProcessBuiltinFsAccess = (index) => (
    bareKeyword(index, "process")
    && tokens[index + 1]?.value === "."
    && tokens[index + 2]?.type === "identifier"
    && tokens[index + 2].value === "getBuiltinModule"
    && literalCallSpecifier(index + 2) === "fs"
    && tokens[index + 4]?.has_escape !== true
  );
  const directProcessBuiltinModuleReference = (index) => (
    tokens[index]?.type === "identifier"
    && tokens[index].value === "getBuiltinModule"
    && (
      (bareKeyword(index - 2, "process") && tokens[index - 1]?.value === ".")
      || (
        bareKeyword(index - 3, "process")
        && tokens[index - 2]?.value === "?"
        && tokens[index - 1]?.value === "."
      )
    )
  );
  const computedNamedPropertyReference = (index, name) => {
    if (tokens[index]?.type !== "string" || tokens[index].value !== name ||
        tokens[index - 1]?.value !== "[" || tokens[index + 1]?.value !== "]") return false;
    const propertyBase = tokens[index - 2];
    if (propertyBase?.type === "identifier" || [")", "]"].includes(propertyBase?.value)) return true;
    return propertyBase?.value === "."
      && (tokens[index - 3]?.type === "identifier" || tokens[index - 3]?.value === "?" || [")", "]"].includes(tokens[index - 3]?.value));
  };
  const computedPropertyEnd = (index) => {
    if (tokens[index]?.value !== "[") return null;
    let depth = 0;
    for (let cursor = index; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].value === "[") depth += 1;
      else if (tokens[cursor].value === "]") {
        depth -= 1;
        if (depth === 0) return cursor;
      }
    }
    return null;
  };
  const delimiterStructure = (() => {
    const closeForOpen = new Map();
    const parentOpen = new Map();
    const expectedClose = new Map([["{", "}"], ["[", "]"], ["(", ")"]]);
    const closing = new Set([...expectedClose.values()]);
    const stack = [];
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
      const value = tokens[cursor].value;
      if (expectedClose.has(value)) {
        parentOpen.set(cursor, stack.length > 0 ? stack[stack.length - 1].index : null);
        stack.push({ index: cursor, expected: expectedClose.get(value) });
        continue;
      }
      if (!closing.has(value)) continue;
      const open = stack[stack.length - 1];
      if (open?.expected !== value) continue;
      stack.pop();
      closeForOpen.set(open.index, cursor);
    }
    return { close_for_open: closeForOpen, parent_open: parentOpen };
  })();
  const functionParameterGroup = (openIndex, closeIndex) => {
    if (tokens[openIndex]?.value !== "(" || tokens[closeIndex + 1]?.value !== "{") return false;
    const previous = tokens[openIndex - 1];
    return previous?.type === "identifier" && !["for", "if", "switch", "while", "with"].includes(previous.value);
  };
  const objectDestructuringPattern = (index) => {
    if (tokens[index]?.value !== "{") return false;
    let openIndex = index;
    let closeIndex = delimiterStructure.close_for_open.get(openIndex);
    if (!Number.isInteger(closeIndex)) return false;
    while (true) {
      const next = tokens[closeIndex + 1]?.value;
      if (["=", "in", "of"].includes(next)) return true;
      if (functionParameterGroup(openIndex, closeIndex)) return true;
      // A container introduced after an assignment is an initializer/value,
      // not a binding pattern.  Stop before climbing into its surrounding
      // parameter or collection group, which keeps direct object literals in
      // defaults and expressions inside the verified subset.
      if (tokens[openIndex - 1]?.value === "=") return false;
      const parent = delimiterStructure.parent_open.get(openIndex);
      if (!Number.isInteger(parent)) return false;
      const parentClose = delimiterStructure.close_for_open.get(parent);
      if (!Number.isInteger(parentClose)) return false;
      openIndex = parent;
      closeIndex = parentClose;
    }
  };
  const computedPropertyBase = (index) => {
    if (tokens[index - 1]?.value === "." && tokens[index - 2]?.value === "?") return tokens[index - 3];
    return tokens[index - 1];
  };
  const nonPropertyBaseKeywords = new Set([
    "await", "case", "class", "const", "delete", "do", "else", "export", "extends",
    "from", "function", "import", "in", "instanceof", "let", "new", "of", "return",
    "throw", "typeof", "var", "void", "yield",
  ]);
  const executableComputedPropertyAccess = (index) => {
    if (tokens[index]?.value !== "[") return false;
    const end = computedPropertyEnd(index);
    if (end === null) return false;
    const base = computedPropertyBase(index);
    const isPropertyAccess = (
      (base?.type === "identifier" && !nonPropertyBaseKeywords.has(base.value))
      || base?.type === "string"
      || [")", "]", "}"].includes(base?.value)
    );
    if (!isPropertyAccess) return false;
    // This lexical oracle does not evaluate member lookup.  Even a raw string
    // key can reach Function/require through reflection, so every executable
    // computed member access is outside the verified grammar.  Array and
    // object literals themselves have no member base and remain benign.
    return true;
  };
  const concatenatedRawStringPropertyName = (index) => {
    if (tokens[index]?.value !== "[") return null;
    const end = computedPropertyEnd(index);
    if (end === null || end === index + 1) return null;
    let name = "";
    let expectString = true;
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const token = tokens[cursor];
      if (expectString) {
        if (token.type !== "string" || token.has_escape === true) return null;
        name += token.value;
      } else if (token.value !== "+") {
        return null;
      }
      expectString = !expectString;
    }
    return expectString ? null : name;
  };
  const optionalComputedCodeConstructorReference = (index) => (
    tokens[index]?.value === "["
    && tokens[index - 1]?.value === "."
    && tokens[index - 2]?.value === "?"
    && ["Function", "AsyncFunction", "constructor"].includes(concatenatedRawStringPropertyName(index))
  );
  const computedPropertyEvalReference = (index) => concatenatedRawStringPropertyName(index) === "eval";
  // This deliberately lexical evaluator cannot prove that a Function-family
  // constructor or a constructor property is harmless.  Treat every code
  // reference as unsupported so a runtime-created loader cannot turn a pass
  // into a false assurance.  Comments, strings, and interpolation-free
  // templates never become tokens, so they remain outside this boundary.
  const dynamicCodeConstructorReference = (index) => (
    (tokens[index]?.type === "identifier"
      && ["Function", "AsyncFunction"].includes(tokens[index].value))
    || (
      tokens[index]?.type === "identifier"
      && tokens[index].value === "constructor"
      && (
        tokens[index - 1]?.value === "."
        || (tokens[index - 2]?.value === "?" && tokens[index - 1]?.value === ".")
      )
    )
    || ["Function", "AsyncFunction", "constructor"].some((name) => computedNamedPropertyReference(index, name))
  );
  const directReflectionConstructionPrimitiveReference = (index) => (
    tokens[index]?.type === "identifier"
    && (
      tokens[index].value === "__proto__"
      || tokens[index].value === "getPrototypeOf"
      || tokens[index].value === "getOwnPropertyDescriptors"
    )
    && (
      tokens[index - 1]?.value === "."
      || (tokens[index - 2]?.value === "?" && tokens[index - 1]?.value === ".")
    )
  );
  const getBuiltinModuleDescriptorReference = (index) => (
    (tokens[index]?.type === "identifier" && tokens[index].value === "getOwnPropertyDescriptor")
    || computedNamedPropertyReference(index, "getOwnPropertyDescriptor")
  );
  const reflectionCapabilityPrimitiveReference = (index) => (
    tokens[index]?.type === "identifier"
    && reflectionCapabilityPrimitiveNames.has(tokens[index].value)
  );
  const executableArgumentsReference = (index) => (
    tokens[index]?.type === "identifier"
    && tokens[index].value === "arguments"
    && (
      tokens[index - 1]?.value !== "."
      // The lexer emits an ellipsis as three punctuation tokens.  It is a
      // spread expression, not a member access such as object.arguments.
      || (tokens[index - 2]?.value === "." && tokens[index - 3]?.value === ".")
    )
  );
  const executableAmbientGlobalRootReference = (index) => (
    ["self", "this", "window"].some((name) => executableBareReference(index, name))
  );
  const processCapabilityPropertyReference = (index) => (
    tokens[index]?.type === "identifier"
    && processCapabilityPropertyNames.has(tokens[index].value)
    && (
      tokens[index - 1]?.value === "."
      || (tokens[index - 2]?.value === "?" && tokens[index - 1]?.value === ".")
    )
  );
  const processAliasReference = (index) => (
    bareKeyword(index, "process")
    && processBuiltinModuleAccessEnd(index) === null
    && ![".", "[", "?"].includes(tokens[index + 1]?.value)
  );
  const globalProcessAliasReference = (index) => (
    bareKeyword(index, "globalThis")
    && (
      (tokens[index + 1]?.value === "." && tokens[index + 2]?.type === "identifier" && tokens[index + 2].value === "process")
      || (tokens[index + 1]?.value === "[" && tokens[index + 2]?.type === "string" && tokens[index + 2].value === "process" && tokens[index + 3]?.value === "]")
      || (tokens[index + 1]?.value === "?" && tokens[index + 2]?.value === "." && tokens[index + 3]?.type === "identifier" && tokens[index + 3].value === "process")
      || (tokens[index + 1]?.value === "?" && tokens[index + 2]?.value === "." && tokens[index + 3]?.value === "[" && tokens[index + 4]?.type === "string" && tokens[index + 4].value === "process" && tokens[index + 5]?.value === "]")
    )
  );
  const unrecognizedExecutableGlobalAccess = (index) => (
    (executableBareReference(index, "globalThis") || executableBareReference(index, "global"))
    && tokens[index + 1]?.value !== "["
  );
  const propertyEvalReference = (index) => (
    tokens[index]?.type === "identifier"
    && tokens[index].value === "eval"
    && tokens[index - 1]?.value === "."
  );
  const unrecognizedGetBuiltinModuleAccess = (index) => (
    (tokens[index]?.type === "identifier" && tokens[index].value === "getBuiltinModule" && !directProcessBuiltinModuleReference(index))
    || computedNamedPropertyReference(index, "getBuiltinModule")
    || getBuiltinModuleDescriptorReference(index)
    || processAliasReference(index)
    || globalProcessAliasReference(index)
  );
  const unrecognizedComputedProcessLoaderAccess = (index) => (
    bareKeyword(index, "process")
    && processBuiltinModuleAccessEnd(index) === null
    && (
      tokens[index + 1]?.value === "["
      || (
        tokens[index + 1]?.value === "?"
        && tokens[index + 2]?.value === "."
        && tokens[index + 3]?.value === "["
      )
    )
  );
  const processBuiltinModuleLoaderReason = (index) => {
    if (!bareKeyword(index, "process")) return null;
    // This is deliberately a finite grammar: the one process construction
    // this evaluator can safely ignore is the raw, direct fs builtin call.
    // Every other process reference is unsupported before a later property
    // can manufacture a require/createRequire alias outside this lexer.
    if (exactDirectProcessBuiltinFsAccess(index)) return null;
    const accessEnd = processBuiltinModuleAccessEnd(index);
    if (accessEnd === null) {
      if (unrecognizedComputedProcessLoaderAccess(index)) {
        return "unrecognized-process-computed-loader-access";
      }
      if (processAliasReference(index)) return "unrecognized-get-builtin-module-access";
      return "unrecognized-process-loader-construction";
    }
    const builtin = literalCallSpecifier(accessEnd);
    if (builtin === "module" || builtin === "node:module") return "process-builtin-module-loader-chain";
    return "nontrivial-process-builtin-module-loader-access";
  };
  for (let index = 0; index < tokens.length; index += 1) {
    // Object destructuring can bind a loader through arbitrary literal,
    // concatenated, nested, or rest keys without a member-access token.  This
    // lexical evaluator only retains ordinary object literals in its verified
    // subset; every executable object pattern is fail-closed.
    if (objectDestructuringPattern(index)) {
      unsupportedImportCalls.add("unrecognized-object-destructuring-pattern");
      continue;
    }
    if (optionalComputedCodeConstructorReference(index)) {
      unsupportedImportCalls.add("dynamic-code-constructor-reference");
      continue;
    }
    if (executableComputedPropertyAccess(index)) {
      unsupportedImportCalls.add("unrecognized-dynamic-property-loader-access");
      continue;
    }
    if (dynamicCodeConstructorReference(index)) {
      unsupportedImportCalls.add("dynamic-code-constructor-reference");
      continue;
    }
    if (directReflectionConstructionPrimitiveReference(index)) {
      unsupportedImportCalls.add("dynamic-code-constructor-reference");
      continue;
    }
    const processBuiltinModuleReason = processBuiltinModuleLoaderReason(index);
    if (processBuiltinModuleReason !== null) {
      unsupportedImportCalls.add(processBuiltinModuleReason);
      continue;
    }
    if (unrecognizedGetBuiltinModuleAccess(index)) {
      unsupportedImportCalls.add("unrecognized-get-builtin-module-access");
      continue;
    }
    // Destructuring keys and aliases do not have a property-access token
    // before the dangerous name.  This lexical oracle cannot prove those
    // bindings harmless, so every executable reflection/capability primitive
    // is outside the verified grammar.  Strings, comments, and plain template
    // text are tokenized separately and remain benign text.
    if (reflectionCapabilityPrimitiveReference(index)) {
      unsupportedImportCalls.add("reflection-capability-primitive-reference");
      continue;
    }
    // CommonJS wrapper arguments expose `require` positionally.  A lexical
    // evaluator cannot prove that an executable reference or destructuring
    // binding does not retain that loader capability, so it is outside the
    // verified grammar regardless of the alias name or binding pattern.
    if (executableArgumentsReference(index)) {
      unsupportedImportCalls.add("unrecognized-executable-arguments-access");
      continue;
    }
    // Ambient roots can be aliases for a runtime process object, and native
    // process/module capability properties can execute or construct loaders
    // without a static import.  Neither is in this lexical safe subset.
    if (executableAmbientGlobalRootReference(index)) {
      unsupportedImportCalls.add("unrecognized-executable-ambient-global-access");
      continue;
    }
    if (processCapabilityPropertyReference(index)) {
      unsupportedImportCalls.add("unrecognized-process-capability-access");
      continue;
    }
    if (unrecognizedExecutableGlobalAccess(index)) {
      unsupportedImportCalls.add("unrecognized-executable-global-access");
      continue;
    }
    if (computedPropertyEvalReference(index) || propertyEvalReference(index)) {
      unsupportedImportCalls.add("property-eval-reference");
      continue;
    }
    if (moduleRequireReference(index)) {
      const specifier = literalCallSpecifier(index + 2);
      if (specifier !== null) {
        recordStaticSpecifier(specifier);
      } else if (tokens[index + 3]?.value === "?" && tokens[index + 4]?.value === "." && tokens[index + 5]?.value === "(") {
        unsupportedImportCalls.add("optional-module-require-call");
      } else {
        unsupportedImportCalls.add("nontrivial-module-require-reference");
      }
      continue;
    }
    if (computedModulePropertyReference(index)) {
      unsupportedImportCalls.add("computed-module-property-call");
      continue;
    }
    if (unrecognizedModuleLoaderConstruction(index)) {
      unsupportedImportCalls.add("unrecognized-module-loader-construction");
      continue;
    }
    if (reflectGetCall(index)) {
      unsupportedImportCalls.add("reflect-get-call");
      continue;
    }
    if (unrecognizedReflectLoaderConstruction(index)) {
      unsupportedImportCalls.add("unrecognized-reflect-loader-construction");
      continue;
    }
    if (bareKeyword(index, "eval")) {
      unsupportedImportCalls.add(tokens[index + 1]?.value === "(" ? "eval-call" : "nontrivial-eval-reference");
      continue;
    }
    if (dynamicImportCall(index)) {
      unsupportedImportCalls.add("dynamic-import-call");
      continue;
    }
    if (computedPropertyRequireReference(index)) {
      unsupportedImportCalls.add(computedPropertyRequireReason(index));
      continue;
    }
    if (tokens[index]?.type === "identifier" && tokens[index].value === "require") {
      if (bareKeyword(index, "require")) {
        const specifier = literalCallSpecifier(index);
        if (specifier !== null) recordStaticSpecifier(specifier);
        else unsupportedImportCalls.add(bareRequireReason(index));
      } else if (tokens[index - 1]?.value === "." && !moduleRequireReference(index - 2)) {
        if (tokens[index + 1]?.value === "(") unsupportedImportCalls.add("property-require-call");
        else if (tokens[index + 1]?.value === "?" && tokens[index + 2]?.value === "." && tokens[index + 3]?.value === "(") {
          unsupportedImportCalls.add("optional-property-require-call");
        } else {
          unsupportedImportCalls.add("nontrivial-property-require-reference");
        }
      }
    }
    if (!bareKeyword(index, "import")) continue;
    if (tokens[index + 1]?.value === "("
      && tokens[index + 2]?.type === "string"
      && tokens[index + 3]?.value === ")") {
      specifiers.add(tokens[index + 2].value);
      continue;
    }
    const previous = tokens[index - 1];
    if (tokens[index].depth !== 0 || (previous && previous.value !== ";" && previous.value !== "}")) continue;
    if (tokens[index + 1]?.type === "string") {
      recordStaticSpecifier(tokens[index + 1].value);
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token.depth === 0 && token.value === ";") break;
      if (token.depth === 0 && token.value === "from" && tokens[cursor + 1]?.type === "string") {
        recordStaticSpecifier(tokens[cursor + 1].value);
        break;
      }
    }
  }
  return {
    specifiers,
    unsupported_import_calls: [...unsupportedImportCalls].sort(),
  };
}

function literalImportScan(text) {
  const tokens = [];
  let unsupported = text.includes("\ufffd");
  let braceDepth = 0;
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (text.startsWith("//", index)) {
      const lineFeed = text.indexOf("\n", index + 2);
      const carriageReturn = text.indexOf("\r", index + 2);
      const lineEnd = carriageReturn !== -1 && (lineFeed === -1 || carriageReturn < lineFeed)
        ? carriageReturn
        : lineFeed;
      if (lineEnd === -1) {
        index = text.length;
      } else {
        index = lineEnd + (text[lineEnd] === "\r" && text[lineEnd + 1] === "\n" ? 2 : 1);
      }
      continue;
    }
    if (text.startsWith("/*", index)) {
      const commentEnd = text.indexOf("*/", index + 2);
      if (commentEnd === -1) {
        unsupported = true;
        break;
      }
      index = commentEnd + 2;
      continue;
    }
    if (character === "'" || character === "\"") {
      const string = readQuotedString(text, index, character);
      if (string.unsupported) {
        unsupported = true;
        break;
      }
      tokens.push({ type: "string", value: string.value, has_escape: string.has_escape, depth: braceDepth });
      index = string.next;
      continue;
    }
    if (character === "`") {
      const template = readTemplateLiteral(text, index);
      if (template.unsupported) {
        unsupported = true;
        break;
      }
      index = template.next;
      continue;
    }
    if (character === "\\") {
      unsupported = true;
      break;
    }
    if (character === "/") {
      unsupported = true;
      break;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end += 1;
      tokens.push({ type: "identifier", value: text.slice(index, end), depth: braceDepth });
      index = end;
      continue;
    }
    const token = { type: "punctuation", value: character, depth: braceDepth };
    tokens.push(token);
    if (character === "{") braceDepth += 1;
    else if (character === "}") {
      if (braceDepth === 0) {
        unsupported = true;
        break;
      }
      braceDepth -= 1;
    }
    index += 1;
  }
  if (braceDepth !== 0) unsupported = true;
  const imports = importSpecifiers(tokens);
  const unsupportedReasons = new Set(imports.unsupported_import_calls);
  if (unsupported) unsupportedReasons.add("source-syntax");
  return {
    specifiers: imports.specifiers,
    unsupported_reasons: [...unsupportedReasons].sort(),
  };
}

function sourceFilesFor(root, inventory, extensions) {
  return inventory.files
    .filter((relativePath) => extensions.includes(path.extname(relativePath)))
    .map((relativePath) => ({
      relative_path: relativePath,
      scan: literalImportScan(fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8")),
    }));
}

function sourceScanDetails(source) {
  return source.scan.unsupported_reasons.map((reason) => (
    reason === "source-syntax"
      ? `unsupported-source-syntax:${source.relative_path}`
      : `unsupported-import-call:${source.relative_path}:${reason}`
  ));
}

function evaluateMechanic(mechanic, context) {
  if (mechanic.kind === "unverifiable") {
    return evidence("unverifiable", "subjective");
  }
  if (mechanic.kind === "forbidden_paths") {
    const violations = context.inventory.paths.filter((entry) => matchesAny(entry, mechanic.patterns));
    return violations.length > 0
      ? evidence("fail", mechanic.kind, violations.map((entry) => `path:${entry}`))
      : evidence("pass", mechanic.kind, [`repository-path-count:${context.inventory.paths.length}`]);
  }
  if (mechanic.kind === "dependency_authority") {
    const details = [];
    let unverifiable = false;
    const dependencyViolations = [];
    for (const manifestPath of mechanic.manifests) {
      const absolute = path.join(context.root, ...manifestPath.split("/"));
      if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
        unverifiable = true;
        details.push(`missing-manifest:${manifestPath}`);
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(absolute, "utf8"));
      } catch {
        unverifiable = true;
        details.push(`invalid-manifest:${manifestPath}`);
        continue;
      }
      details.push(`manifest:${manifestPath}`);
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const names = isRecord(manifest[field]) ? Object.keys(manifest[field]) : [];
        names.filter((name) => mechanic.forbidden_dependencies.includes(name))
          .forEach((name) => dependencyViolations.push(`dependency:${manifestPath}:${field}:${name}`));
      }
    }
    const sources = sourceFilesFor(context.root, context.inventory, mechanic.source_extensions);
    if (sources.length === 0) {
      unverifiable = true;
      details.push("missing-supported-source-files");
    }
    const importViolations = [];
    for (const source of sources) {
      const unsupportedDetails = sourceScanDetails(source);
      if (unsupportedDetails.length > 0) {
        unverifiable = true;
        details.push(...unsupportedDetails);
      }
      for (const specifier of mechanic.forbidden_imports) {
        if (source.scan.specifiers.has(specifier)) {
          importViolations.push(`import:${source.relative_path}:${specifier}`);
        }
      }
    }
    const violations = [...dependencyViolations, ...importViolations].sort();
    if (violations.length > 0) return evidence("fail", mechanic.kind, violations);
    if (unverifiable) return evidence("unverifiable", mechanic.kind, details);
    return evidence("pass", mechanic.kind, [...details, `source-file-count:${sources.length}`]);
  }
  if (mechanic.kind === "sole_owner_import") {
    const sources = sourceFilesFor(context.root, context.inventory, mechanic.source_extensions);
    if (sources.length === 0) return evidence("unverifiable", mechanic.kind, ["missing-supported-source-files"]);
    const importers = sources
      .filter((source) => source.scan.specifiers.has(mechanic.specifier))
      .map((source) => source.relative_path);
    const violations = importers.filter((relativePath) => !matchesAny(relativePath, mechanic.owner_patterns));
    if (violations.length > 0) {
      return evidence("fail", mechanic.kind, violations.map((entry) => `non-owner-import:${entry}:${mechanic.specifier}`));
    }
    const unsupportedSources = sources.flatMap(sourceScanDetails);
    if (unsupportedSources.length > 0) return evidence("unverifiable", mechanic.kind, unsupportedSources);
    if (importers.length === 0 && mechanic.require_import) {
      return evidence("unverifiable", mechanic.kind, [`missing-import:${mechanic.specifier}`]);
    }
    return evidence("pass", mechanic.kind, importers.map((entry) => `owner-import:${entry}:${mechanic.specifier}`));
  }
  if (mechanic.kind === "required_test_layout") {
    const missing = mechanic.required_paths.filter((relativePath) => (
      !fs.statSync(path.join(context.root, ...relativePath.split("/")), { throwIfNoEntry: false })
    ));
    const tests = context.inventory.files.filter((entry) => matchesAny(entry, mechanic.test_patterns));
    const violations = [
      ...missing.map((entry) => `missing-path:${entry}`),
      ...(tests.length === 0 ? ["missing-required-tests"] : []),
    ];
    return violations.length > 0
      ? evidence("fail", mechanic.kind, violations)
      : evidence("pass", mechanic.kind, [...mechanic.required_paths.map((entry) => `path:${entry}`), ...tests.map((entry) => `test:${entry}`)]);
  }
  if (mechanic.kind === "generated_edits") {
    if (context.changed_paths === null) return evidence("unverifiable", mechanic.kind, ["missing-changed-paths-evidence"]);
    const violations = context.changed_paths.filter((entry) => matchesAny(entry, mechanic.generated_patterns));
    return violations.length > 0
      ? evidence("fail", mechanic.kind, violations.map((entry) => `generated-edit:${entry}`))
      : evidence("pass", mechanic.kind, [context.changed_paths_evidence_ref]);
  }
  if (mechanic.kind === "secret_path_config") {
    const secretPaths = context.inventory.paths.filter((entry) => matchesAny(entry, mechanic.forbidden_patterns));
    const missing = mechanic.required_paths.filter((relativePath) => (
      !fs.statSync(path.join(context.root, ...relativePath.split("/")), { throwIfNoEntry: false })
    ));
    const violations = [
      ...secretPaths.map((entry) => `forbidden-secret-path:${entry}`),
      ...missing.map((entry) => `missing-config-path:${entry}`),
    ];
    return violations.length > 0
      ? evidence("fail", mechanic.kind, violations)
      : evidence("pass", mechanic.kind, mechanic.required_paths.map((entry) => `config-path:${entry}`));
  }
  return evidence("unverifiable", "unsupported-mechanic");
}

function compileProgrammingGuidelinesProfile(input = {}) {
  requireClosedKeys(input, COMPILE_FIELDS, "FAIL-PROGRAMMING-GUIDELINES-INPUT", "compile input");
  const source = sourceDocument(input);
  if (!isRecord(input.locators)) {
    fail("FAIL-PROGRAMMING-GUIDELINES-LOCATOR", "every required rule needs a source locator");
  }
  const locatorIds = Object.keys(input.locators).sort();
  const expectedIds = [...PROGRAMMING_GUIDELINES_RULE_IDS].sort();
  if (stableStringify(locatorIds) !== stableStringify(expectedIds)) {
    const missing = expectedIds.filter((ruleId) => !locatorIds.includes(ruleId));
    const extra = locatorIds.filter((ruleId) => !expectedIds.includes(ruleId));
    fail(
      "FAIL-PROGRAMMING-GUIDELINES-LOCATOR",
      `locator inventory must be exact (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }

  const ruleMap = PROGRAMMING_GUIDELINES_RULES.map((definition) => {
    if (!VERIFICATION_MODES.has(definition.verification_mode)) {
      fail("FAIL-PROGRAMMING-GUIDELINES-CONTRACT", `${definition.rule_id} has an unsupported verification mode`);
    }
    const locator = input.locators[definition.rule_id];
    requireClosedKeys(locator, LOCATOR_FIELDS, "FAIL-PROGRAMMING-GUIDELINES-LOCATOR", `${definition.rule_id} locator`);
    const fingerprint = normalizeDigest(
      locator.fingerprint,
      "FAIL-PROGRAMMING-GUIDELINES-LOCATOR",
      `${definition.rule_id} fingerprint`,
    );
    const section = headingSection(source.text, locator.heading, definition.rule_id);
    const actualFingerprint = digest(Buffer.from(section, "utf8"));
    if (actualFingerprint !== fingerprint) {
      fail(
        "FAIL-PROGRAMMING-GUIDELINES-LOCATOR",
        `${definition.rule_id} fingerprint mismatch: expected ${fingerprint}, observed ${actualFingerprint}`,
      );
    }
    const mechanic = directiveFromSection(section, definition);
    const sourceReference = {
      document_path: source.document_path,
      locator: `${locator.heading.trim()} | ${fingerprint}`,
      digest: source.digest,
    };
    return {
      rule_id: definition.rule_id,
      source_refs: [sourceReference],
      category: definition.category,
      severity: definition.severity,
      applicability: {
        status: "applicable",
        reason: "programming-guidelines-source-adopted",
        source_refs: [sourceReference],
      },
      verification: {
        method: definition.verification_mode,
        evidence_refs: [
          input.adoption_evidence_ref.trim(),
          `policy-section:${fingerprint}`,
          `policy-source:${source.digest}`,
        ],
      },
      oracle: encodedOracle(mechanic),
      status: "unverifiable",
    };
  });

  return compilePolicy({
    document_path: source.document_path,
    expected_digest: source.digest,
    rule_map: ruleMap,
  });
}

function evaluateProgrammingGuidelinesProfile(input = {}) {
  requireClosedKeys(input, EVALUATE_FIELDS, "FAIL-PROGRAMMING-GUIDELINES-INPUT", "evaluation input");
  const mechanics = programmingGuidelinesMechanics(input.profile);
  if (!nonBlank(input.repository_root)) {
    fail("FAIL-PROGRAMMING-GUIDELINES-INPUT", "repository_root is required");
  }
  const repositoryRoot = path.resolve(input.repository_root.trim());
  try {
    if (!fs.statSync(repositoryRoot).isDirectory()) {
      fail("FAIL-PROGRAMMING-GUIDELINES-INPUT", "repository_root must identify a directory");
    }
  } catch (error) {
    if (String(error.message).includes("FAIL-PROGRAMMING-GUIDELINES-")) throw error;
    fail("FAIL-PROGRAMMING-GUIDELINES-INPUT", `repository_root is absent or unreadable at ${repositoryRoot}`);
  }
  let changedPaths = null;
  if (input.changed_paths !== undefined) {
    if (!Array.isArray(input.changed_paths)) {
      fail("FAIL-PROGRAMMING-GUIDELINES-INPUT", "changed_paths must be an array when supplied");
    }
    changedPaths = input.changed_paths.map((entry, index) => normalizedRelativePath(entry, `changed_paths[${index}]`));
    if (new Set(changedPaths).size !== changedPaths.length) {
      fail("FAIL-PROGRAMMING-GUIDELINES-INPUT", "changed_paths contains duplicates");
    }
    changedPaths.sort();
    if (!nonBlank(input.changed_paths_evidence_ref)) {
      fail("FAIL-PROGRAMMING-GUIDELINES-INPUT", "changed_paths_evidence_ref is required with changed_paths");
    }
  } else if (input.changed_paths_evidence_ref !== undefined) {
    fail("FAIL-PROGRAMMING-GUIDELINES-INPUT", "changed_paths_evidence_ref requires changed_paths");
  }
  const context = {
    root: repositoryRoot,
    inventory: repositoryInventory(repositoryRoot),
    changed_paths: changedPaths,
    changed_paths_evidence_ref: input.changed_paths_evidence_ref?.trim(),
  };
  const rules = input.profile.rules.map((rule) => {
    const result = evaluateMechanic(mechanics.get(rule.rule_id), context);
    return {
      ...structuredClone(rule),
      verification: {
        ...structuredClone(rule.verification),
        evidence_refs: [...new Set([...rule.verification.evidence_refs, ...result.evidence_refs])].sort(),
      },
      status: result.status,
    };
  });
  return compilePolicy({
    document_path: input.profile.source.document_path,
    expected_digest: input.profile.source.digest,
    rule_map: rules,
  });
}

module.exports = {
  PROGRAMMING_GUIDELINES_RULE_IDS,
  PROGRAMMING_GUIDELINES_RULES,
  compileProgrammingGuidelinesProfile,
  evaluateProgrammingGuidelinesProfile,
  validatePolicyProfile,
};
