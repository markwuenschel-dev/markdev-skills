"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIXTURE_ONLY = true;
const FIXTURE_SOURCE_MARKER = "<!-- sei-programming-guidelines-fixture-only -->";

const RULE_FIXTURES = Object.freeze([
  {
    rule_id: "PG-LAYOUT-NAMESPACE-001",
    heading: "## Layout and namespace boundaries",
    mechanic: { kind: "forbidden_paths", patterns: ["scratch/**", "tmp/**"] },
  },
  {
    rule_id: "PG-DEPENDENCY-AUTHORITY-001",
    heading: "## Dependency authority",
    mechanic: {
      kind: "dependency_authority",
      manifests: ["package.json"],
      forbidden_dependencies: ["left-pad"],
      forbidden_imports: ["legacy-config"],
      source_extensions: [".cjs", ".js", ".mjs"],
    },
  },
  {
    rule_id: "PG-SINGLE-OWNER-CHOKEPOINT-001",
    heading: "## Single-owner chokepoints",
    mechanic: {
      kind: "sole_owner_import",
      specifier: "@app/config",
      owner_patterns: ["src/config-owner.js"],
      source_extensions: [".cjs", ".js", ".mjs"],
      require_import: true,
    },
  },
  {
    rule_id: "PG-FAIL-CLOSED-001",
    heading: "## Fail-closed behavior",
    mechanic: { kind: "unverifiable" },
  },
  {
    rule_id: "PG-IDEMPOTENCY-001",
    heading: "## Idempotency",
    mechanic: { kind: "unverifiable" },
  },
  {
    rule_id: "PG-DB-TRANSACTION-LOCKING-001",
    heading: "## Database transactions and locking",
    mechanic: { kind: "unverifiable" },
  },
  {
    rule_id: "PG-TESTING-001",
    heading: "## Testing",
    mechanic: {
      kind: "required_test_layout",
      required_paths: ["src", "tests"],
      test_patterns: ["tests/**/*.test.js"],
    },
  },
  {
    rule_id: "PG-GENERATED-CONTRACTS-001",
    heading: "## Generated contracts",
    mechanic: { kind: "generated_edits", generated_patterns: ["generated/**"] },
  },
  {
    rule_id: "PG-SECRETS-CONFIG-001",
    heading: "## Secrets and configuration",
    mechanic: {
      kind: "secret_path_config",
      forbidden_patterns: [".env", "secrets/**"],
      required_paths: ["config/example.env"],
    },
  },
  {
    rule_id: "PG-DELIVERY-001",
    heading: "## Delivery",
    mechanic: { kind: "unverifiable" },
  },
]);

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function sectionText(rule) {
  const directive = JSON.stringify({ rule_id: rule.rule_id, mechanic: rule.mechanic });
  return [
    rule.heading,
    "",
    `<!-- sei-programming-guidelines ${directive} -->`,
    "",
    `Policy prose for ${rule.rule_id}.`,
    "",
  ].join("\n");
}

function fixtureDocument() {
  return [
    "# Fixture-only Programming Guidelines",
    "",
    FIXTURE_SOURCE_MARKER,
    "",
    "This document is test data and is not an adopted repository policy.",
    "",
    ...RULE_FIXTURES.map(sectionText),
  ].join("\n");
}

function adoptedDocument() {
  return [
    "# Repository Programming Guidelines",
    "",
    "This document is an adopted repository policy source.",
    "",
    ...RULE_FIXTURES.map(sectionText),
  ].join("\n");
}

function fixtureLocators() {
  return Object.fromEntries(RULE_FIXTURES.map((rule) => [
    rule.rule_id,
    { heading: rule.heading, fingerprint: digest(sectionText(rule)) },
  ]));
}

function writeProgrammingGuidelinesFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-programming-guidelines-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adopted = options.adopted === true;
  const documentPath = path.join(root, adopted ? "PROGRAMMING-GUIDELINES.md" : "PROGRAMMING-GUIDELINES.fixture.md");
  const document = adopted ? adoptedDocument() : fixtureDocument();
  fs.writeFileSync(documentPath, document, "utf8");
  const input = {
    document_path: documentPath,
    expected_digest: digest(Buffer.from(document, "utf8")),
    adoption_evidence_ref: adopted ? "adoption:repository-policy" : "adoption:fixture-only",
    locators: fixtureLocators(),
  };
  Object.defineProperty(input, "root", { value: root, enumerable: false });
  return input;
}

function writeAdoptedProgrammingGuidelinesFixture(t) {
  return writeProgrammingGuidelinesFixture(t, { adopted: true });
}

function writeRepositoryFixture(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-programming-guidelines-repository-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaults = {
    "package.json": `${JSON.stringify({ name: "fixture-repository", dependencies: {} }, null, 2)}\n`,
    "src/config-owner.js": "module.exports = require(\"@app/config\");\n",
    "src/index.js": "module.exports = require(\"./config-owner.js\");\n",
    "tests/app.test.js": "// fixture test\n",
    "config/example.env": "APP_MODE=example\n",
  };
  for (const [relativePath, contents] of Object.entries({ ...defaults, ...files })) {
    const target = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

module.exports = {
  FIXTURE_ONLY,
  FIXTURE_SOURCE_MARKER,
  RULE_FIXTURES,
  adoptedDocument,
  fixtureDocument,
  fixtureLocators,
  writeAdoptedProgrammingGuidelinesFixture,
  writeRepositoryFixture,
  writeProgrammingGuidelinesFixture,
};
