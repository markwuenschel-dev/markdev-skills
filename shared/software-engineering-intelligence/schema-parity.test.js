"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateAgainstSchema } = require("./schema-validator.js");
const { materializeSnapshot, validateSnapshot } = require("./intelligence-engine.js");
const { evaluateProfiles } = require("./profiles.js");

const root = __dirname;
const schema = JSON.parse(fs.readFileSync(path.join(root, "intelligence.schema.json"), "utf8"));
const canonical = JSON.parse(fs.readFileSync(path.join(root, "canonical-intelligence.json"), "utf8"));

test("schema and canonical snapshot retain the engine's required metric provenance fields", () => {
  const metric = schema.$defs.metric;
  for (const field of [
    "metric_id",
    "definition_id",
    "family",
    "subject",
    "repository_revision",
    "measurement",
    "source",
    "scope",
    "window",
    "analyzer_identity",
    "analyzer_version",
    "comparability",
  ]) {
    assert.ok(metric.required.includes(field), `schema requires ${field}`);
    assert.ok(Object.hasOwn(canonical.measurements[0], field), `canonical snapshot contains ${field}`);
  }
  assert.ok(schema.$defs.source.required.includes("kind"));
  assert.ok(schema.$defs.source.required.includes("command"));
  assert.ok(schema.$defs.source.required.includes("artifact_refs"));
  assert.ok(schema.$defs.cacheMetadata.required.includes("collector_fingerprints"));
  for (const field of ["binding_kind", "baseline_repository_revision", "baseline_value", "delta", "confidence"]) {
    assert.ok(Object.hasOwn(schema.$defs.comparison.properties, field), `comparison schema declares ${field}`);
  }
  assert.equal(schema.$defs.runMetadata.properties.trend_baseline.$ref, "#/$defs/trendBaselineMetadata");
  assert.deepEqual(Object.keys(canonical.measurements[0].comparability).sort(), [
    "analyzer_identity",
    "analyzer_version",
    "compatible_with_prior",
    "configuration_hash",
    "reason",
  ]);
});

test("schema and runtime reject the same representative provenance values", () => {
  assert.deepEqual(validateAgainstSchema(canonical, schema), []);
  assert.equal(validateSnapshot(canonical).ok, true);

  const cases = [
    {
      name: "empty generated path pattern",
      mutate: (snapshot) => { snapshot.repository.generated_path_patterns = [""]; },
    },
    {
      name: "unavailable collector without a reason",
      mutate: (snapshot) => {
        snapshot.collectors[0].status = "unavailable";
        snapshot.collectors[0].reason = null;
      },
    },
    {
      name: "empty measured reason",
      mutate: (snapshot) => { snapshot.measurements[0].measurement.reason = ""; },
    },
    {
      name: "empty source command even with an artifact",
      mutate: (snapshot) => { snapshot.measurements[0].source.command = ""; },
    },
    {
      name: "duplicate source artifact reference",
      mutate: (snapshot) => { snapshot.measurements[0].source.artifact_refs.push(snapshot.measurements[0].source.artifact_refs[0]); },
    },
    {
      name: "generated code included without an inclusion reason",
      mutate: (snapshot) => {
        snapshot.measurements[0].scope.generated_code = true;
        snapshot.measurements[0].scope.included_in_human_maintainability = true;
        delete snapshot.measurements[0].scope.generated_code_inclusion_reason;
      },
    },
  ];

  for (const { name, mutate } of cases) {
    const snapshot = structuredClone(canonical);
    mutate(snapshot);
    assert.notDeepEqual(validateAgainstSchema(snapshot, schema), [], `schema rejects ${name}`);
    assert.equal(validateSnapshot(snapshot).ok, false, `runtime rejects ${name}`);
  }
});

test("schema and runtime require persisted profile evidence to bind a snapshot metric", () => {
  const profileSnapshot = structuredClone(canonical);
  const metric = profileSnapshot.measurements[0];
  profileSnapshot.profiles = [evaluateProfiles(profileSnapshot, [{
    profile_id: "SPACE",
    evidence: [{
      kind: "metric-observation",
      dimension: "activity",
      status: "measured",
      metric_id: metric.metric_id,
      evidence_refs: [metric.source.artifact_refs[0]],
    }],
  }]).SPACE];
  const malformed = materializeSnapshot(profileSnapshot);
  delete malformed.profiles[0].dimensions.activity.evidence[0].metric_id;

  const schemaErrors = validateAgainstSchema(malformed, schema);
  assert.notDeepEqual(schemaErrors, []);
  assert.match(schemaErrors.join("\n"), /metric_id: is required/);
  assert.equal(validateSnapshot(malformed).ok, false);
});

test("uniqueItems validation remains exact for large primitive provenance arrays", () => {
  const values = Array.from({ length: 4096 }, (_, index) => `artifact:${index.toString(16).padStart(4, "0")}`);
  const uniqueSchema = { type: "object", additionalProperties: false, required: ["refs"], properties: {
    refs: { type: "array", uniqueItems: true, items: { type: "string" } },
  } };
  assert.deepEqual(validateAgainstSchema({ refs: values }, uniqueSchema), []);
  const duplicate = values.slice();
  duplicate[4095] = duplicate[0];
  assert.match(validateAgainstSchema({ refs: duplicate }, uniqueSchema).join("\n"), /duplicates/);
});
