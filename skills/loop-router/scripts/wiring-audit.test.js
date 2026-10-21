"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { audit } = require("./wiring-audit");

const root = path.resolve(__dirname, "..", "..");
const strict = audit(root);
if (strict.status === "red") {
  assert.ok(strict.errors.some((message) => /expanded-grill-with-docs|tdd/.test(message)), "red wiring must identify the unavailable required host capability");
} else {
  assert.ok(["green", "green-with-warnings"].includes(strict.status), `unexpected strict wiring status: ${strict.status}`);
}
const hostResolved = audit(root, { allow_host_external: true });
assert.ok(hostResolved.ok, JSON.stringify(hostResolved.errors));
assert.ok(hostResolved.contract_dependencies.some((item) => item.owner === "production-flywheel" && item.capability === "expanded-grill-with-docs" && item.class === "required"));
assert.ok(hostResolved.static_references.length > 0, "active Markdown/JS/Python reference scan emits evidence");

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loop-router-active-dependency-"));
try {
  fs.cpSync(root, fixtureRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source).split(path.sep).join("/");
      return relative !== ".git" && !relative.startsWith(".git/") && !relative.includes("/__pycache__/");
    },
  });
  const manifestPath = path.join(fixtureRoot, "production-flywheel", "MANIFEST.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.consumes.push("loop-router");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const activeDependency = audit(fixtureRoot, { allow_host_external: true });
  assert.equal(activeDependency.ok, false, "an active package must not declare Loop Router as a callee");
  assert.ok(activeDependency.findings.some((item) => item.code === "ACTIVE_LOOP_ROUTER_DEPENDENCY" && item.capability === "production-flywheel"));
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
console.log("GREEN — wiring audit dependency/reference checks passed");
