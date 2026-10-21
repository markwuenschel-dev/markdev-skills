"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const inventory = read("contracts/completion-binding-parity.json");
const assessment = read("RUNTIME-CONTRACT.json");
const mutation = read("MUTATION-RUNTIME-CONTRACT.json");

function completion(contract) {
  return contract.authorized_handoff?.completion_binding ?? null;
}

test("completion-binding parity preserves every legacy semantic obligation", () => {
  assert.equal(inventory.schema_version, "integrity-completion-binding-parity@1");
  assert.equal(inventory.legacy_contract.revision, "2d77970d41ea8ec79585cc5148bf2496e0de3cdd");

  const assessmentBinding = completion(assessment);
  const mutationBinding = completion(mutation);
  assert.equal(assessmentBinding, null, "assessment contract must not own mutation completion obligations");
  assert.ok(mutationBinding, "mutation contract must own the legacy completion obligations");
  assert.equal(mutationBinding.schema.type, "object");
  assert.equal(mutationBinding.schema.additionalProperties, false);

  const legacyFields = inventory.obligations.map((item) => item.legacy_field).sort();
  const assessmentFields = assessmentBinding?.schema?.required ?? [];
  const mutationFields = mutationBinding.schema.required;
  assert.deepEqual([...new Set([...assessmentFields, ...mutationFields])].sort(), legacyFields, "split-contract union must equal the legacy obligation set");
  assert.equal(assessmentFields.filter((field) => mutationFields.includes(field)).length, 0, "a completion obligation must have one authority");

  for (const obligation of inventory.obligations) {
    assert.equal(obligation.legacy_required, true, `${obligation.legacy_field} lost requiredness`);
    assert.equal(obligation.migration_behavior, "preserved-without-rename", `${obligation.legacy_field} has an undeclared migration`);
    assert.equal(obligation.new_owning_contract, "MUTATION-RUNTIME-CONTRACT.json", `${obligation.legacy_field} moved to the wrong authority`);
    assert.equal(obligation.new_field, obligation.legacy_field, `${obligation.legacy_field} was unintentionally renamed`);
    assert.equal(mutationFields.includes(obligation.new_field), true, `${obligation.new_field} is not required`);
    const property = mutationBinding.schema.properties[obligation.new_field];
    assert.ok(property, `${obligation.new_field} has no contract definition`);
    assert.equal(property.type, obligation.legacy_type, `${obligation.new_field} type changed`);
    assert.deepEqual(property.enum ?? null, obligation.legacy_enum, `${obligation.new_field} enum changed`);
    for (const [constraint, value] of Object.entries(obligation.legacy_constraints)) assert.deepEqual(property[constraint], value, `${obligation.new_field} ${constraint} changed`);
    assert.equal(property["x-binding"], obligation.legacy_binding_semantics, `${obligation.new_field} binding semantics changed`);
  }

  assert.deepEqual(mutationBinding.completion_semantics, inventory.legacy_contract.completion_semantics, "completion semantics changed during the split");
});
