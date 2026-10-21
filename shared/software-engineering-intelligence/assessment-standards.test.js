"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MARK_ENGINEERING_STANDARD,
  SEI_DEFAULT_ENGINEERING_STANDARD,
  resolveAssessmentStandard,
} = require("./assessment-standards.js");

function fixtureRepository(t, profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-assessment-standard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (profile !== undefined) {
    fs.mkdirSync(path.join(root, ".sei"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sei", "assessment-profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
  }
  return root;
}

test("assessment standard resolution defaults to the pinned bundled Mark Engineering Standard", () => {
  const resolved = resolveAssessmentStandard({ repositoryRoot: "C:/does-not-exist" });

  assert.equal(resolved.resolution, "bundled_mark");
  assert.equal(resolved.standard.standard_id, MARK_ENGINEERING_STANDARD.standard_id);
  assert.equal(resolved.standard.source.digest, "sha256:324fa3b9a139a0b96f4fe333142d45f55e29c3882c2c0994357c2a1b7b7c7122");
  assert.match(resolved.standard_digest, /^sha256:[a-f0-9]{64}$/);
});

test("an explicit assessment configuration wins over a committed repository-local profile", (t) => {
  const root = fixtureRepository(t, { standard: "sei-default" });
  const resolved = resolveAssessmentStandard({
    repositoryRoot: root,
    assessmentConfig: { standard: "mark" },
  });

  assert.equal(resolved.resolution, "explicit_config");
  assert.equal(resolved.standard.standard_id, MARK_ENGINEERING_STANDARD.standard_id);
});

test("repository-local assessment profile is used when no explicit configuration exists", (t) => {
  const root = fixtureRepository(t, { standard: "sei-default" });
  const resolved = resolveAssessmentStandard({ repositoryRoot: root });

  assert.equal(resolved.resolution, "repository_profile");
  assert.equal(resolved.standard.standard_id, SEI_DEFAULT_ENGINEERING_STANDARD.standard_id);
  assert.equal(resolved.source.path, path.join(root, ".sei", "assessment-profile.json"));
});

test("the bundled fallback remains available when Mark is explicitly disabled", () => {
  const resolved = resolveAssessmentStandard({
    repositoryRoot: "C:/does-not-exist",
    assessmentConfig: { standard: "sei-default" },
  });

  assert.equal(resolved.resolution, "explicit_config");
  assert.equal(resolved.standard.standard_id, SEI_DEFAULT_ENGINEERING_STANDARD.standard_id);
});

test("an explicit pinned custom standard may override a bundled profile without becoming a source-adoption policy", () => {
  const resolved = resolveAssessmentStandard({
    assessmentConfig: {
      rubric: { version: "independently-consumed-by-the-assessor" },
      standard: {
        standard_id: "repository-engineering-standard",
        standard_version: "2.0.0",
        source: { kind: "repository-pinned", digest: `sha256:${"a".repeat(64)}` },
        criterion_mappings: { test_execution: ["Verification"] },
      },
    },
  });

  assert.equal(resolved.standard.standard_id, "repository-engineering-standard");
  assert.equal(resolved.resolution, "explicit_config");
  assert.equal(Object.isFrozen(resolved.standard), true);
});

test("standard resolution rejects malformed, unknown, and non-deterministic profile values", (t) => {
  const root = fixtureRepository(t, { standard: "unknown-standard" });
  assert.throws(() => resolveAssessmentStandard({ repositoryRoot: root }), /FAIL-ASSESSMENT-STANDARD-PROFILE/);
  assert.throws(
    () => resolveAssessmentStandard({ assessmentConfig: { standard: { standard_id: "caller-defined" } } }),
    /FAIL-ASSESSMENT-STANDARD-PROFILE/,
  );
  const invalidJsonRoot = fixtureRepository(t, undefined);
  fs.mkdirSync(path.join(invalidJsonRoot, ".sei"));
  fs.writeFileSync(path.join(invalidJsonRoot, ".sei", "assessment-profile.json"), "not-json\n");
  assert.throws(() => resolveAssessmentStandard({ repositoryRoot: invalidJsonRoot }), /FAIL-ASSESSMENT-STANDARD-PROFILE/);
});
