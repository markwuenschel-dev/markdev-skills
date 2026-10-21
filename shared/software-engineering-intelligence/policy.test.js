"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { compilePolicy } = require("./policy.js");

function policySource(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const documentPath = path.join(root, "engineering-policy.md");
  const bytes = Buffer.from("# Engineering Policy\n\nDeployments require review.\n", "utf8");
  fs.writeFileSync(documentPath, bytes);
  const source = {
    document_path: documentPath,
    expected_digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
  };
  Object.defineProperty(source, "source_ref", {
    enumerable: false,
    value: { document_path: documentPath, locator: "#deployments-require-review" },
  });
  return source;
}

function rule(source, ruleId, severity, status) {
  return {
    rule_id: ruleId,
    source_refs: [structuredClone(source.source_ref)],
    category: "delivery",
    severity,
    applicability: {
      status: "applicable",
      reason: "repository deploys to production",
      source_refs: [structuredClone(source.source_ref)],
    },
    verification: { method: "artifact", evidence_refs: [`receipt:${ruleId}`] },
    oracle: "review receipt exists",
    status,
  };
}

test("a source policy cannot be evaluated without its hash-bound document", () => {
  assert.throws(() => compilePolicy({ rule_map: [] }), /FAIL-POLICY-SOURCE-DRIFT/);
});

test("policy compilation rejects missing and mismatched pinned digests", (t) => {
  const source = policySource(t);
  assert.throws(
    () => compilePolicy({ document_path: source.document_path, rule_map: [] }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );
  assert.throws(
    () => compilePolicy({ ...source, expected_digest: `sha256:${"0".repeat(64)}`, rule_map: [] }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );
  assert.throws(
    () => compilePolicy({ ...source, rule_map: [] }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );
});

test("policy compilation accepts only exact documented top-level snake-case keys", (t) => {
  const source = policySource(t);
  const input = {
    ...source,
    documentPath: source.document_path,
    rule_map: [rule(source, "POL-EXACT-INPUT", "required", "pass")],
  };
  assert.throws(() => compilePolicy(input), /FAIL-POLICY-SOURCE-DRIFT/);
});

test("compiled policy preserves rule authority and separates every result state", (t) => {
  const source = policySource(t);
  const profile = compilePolicy({
    ...source,
    rule_map: [
      rule(source, "POL-001", "hard-invariant", "pass"),
      rule(source, "POL-002", "required", "fail"),
      rule(source, "POL-003", "convention", "partial"),
      rule(source, "POL-004", "advisory", "unverifiable"),
      {
        ...rule(source, "POL-005", "advisory", "N/A"),
        applicability: { status: "not_applicable", reason: "no mobile app", source_refs: [structuredClone(source.source_ref)] },
      },
    ],
  });

  assert.equal(profile.source.document_path, source.document_path);
  assert.equal(profile.source.digest, source.expected_digest);
  const expectedRule = rule(source, "POL-001", "hard-invariant", "pass");
  expectedRule.source_refs[0].digest = source.expected_digest;
  expectedRule.applicability.source_refs[0].digest = source.expected_digest;
  assert.deepEqual(profile.rules[0], expectedRule);
  assert.deepEqual(profile.summary.counts, {
    pass: 1,
    fail: 1,
    partial: 1,
    unverifiable: 1,
    not_applicable: 1,
  });
  assert.deepEqual(profile.summary.by_status.fail, ["POL-002"]);
  assert.equal("score" in profile.summary, false);
  assert.equal("average" in profile.summary, false);
});

test("a failed hard invariant is explicit and cannot be averaged away", (t) => {
  const source = policySource(t);
  const input = {
    ...source,
    rule_map: [
      rule(source, "POL-HARD", "hard-invariant", "fail"),
      rule(source, "POL-ADVICE", "advisory", "pass"),
      rule(source, "POL-CONVENTION", "convention", "pass"),
    ],
  };
  const profile = compilePolicy(input);
  assert.equal(profile.summary.status, "fail");
  assert.deepEqual(profile.summary.hard_invariant_failures, ["POL-HARD"]);
  assert.throws(() => compilePolicy({ ...input, summary_method: "average" }), /FAIL-HARD-INVARIANT-MASKED/);
});

test("policy rules require stable IDs, source mappings, applicability, and verification oracles", (t) => {
  const source = policySource(t);
  assert.throws(
    () => compilePolicy({ ...source, rule_map: [{ ...rule(source, "POL-001", "required", "pass"), source_refs: [] }] }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );
  assert.throws(
    () => compilePolicy({ ...source, rule_map: [{ ...rule(source, "POL-001", "required", "pass"), verification: null, oracle: null }] }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );
});

test("policy rejects empty, blank, nonexistent, or bare authority mappings and unusable verification", (t) => {
  const source = policySource(t);
  const valid = rule(source, "POL-STRICT", "required", "pass");
  for (const invalid of [
    { rule_id: " " },
    { source_refs: [" "] },
    { source_refs: [`${path.join(path.dirname(source.document_path), "missing.md")}#missing`] },
    { applicability: "applicable" },
    {
      applicability: {
        status: "invented",
        reason: "has a reason",
        source_refs: [structuredClone(source.source_ref)],
      },
    },
    { applicability: { status: "applicable", reason: " ", source_refs: [structuredClone(source.source_ref)] } },
    { applicability: { status: "applicable", reason: "has a reason" } },
    { verification: {} },
    { verification: null, oracle: " " },
  ]) {
    assert.throws(
      () => compilePolicy({ ...source, rule_map: [{ ...valid, ...invalid }] }),
      /FAIL-POLICY-SOURCE-DRIFT/,
    );
  }
});

test("every hard-invariant non-pass remains explicit and rejects aggregate masking", (t) => {
  const source = policySource(t);
  const input = {
    ...source,
    rule_map: [
      rule(source, "POL-HARD-PARTIAL", "hard-invariant", "partial"),
      rule(source, "POL-HARD-UNKNOWN", "hard-invariant", "unverifiable"),
      rule(source, "POL-ADVICE", "advisory", "pass"),
    ],
  };
  const profile = compilePolicy(input);
  assert.equal(profile.summary.status, "fail");
  assert.deepEqual(profile.summary.hard_invariant_non_passes, ["POL-HARD-PARTIAL", "POL-HARD-UNKNOWN"]);
  assert.throws(() => compilePolicy({ ...input, summary_method: "category" }), /FAIL-HARD-INVARIANT-MASKED/);
  assert.throws(() => compilePolicy({ ...input, summary_method: "median" }), /FAIL-HARD-INVARIANT-MASKED/);
  assert.throws(() => compilePolicy({ ...input, summaryMethod: "median" }), /FAIL-POLICY-SOURCE-DRIFT/);
  assert.throws(() => compilePolicy({ ...input, aggregateResult: "median" }), /FAIL-POLICY-SOURCE-DRIFT/);
  assert.throws(() => compilePolicy({ ...input, report: { summary_method: "median" } }), /FAIL-HARD-INVARIANT-MASKED/);
  assert.throws(() => compilePolicy({ ...input, aggregation: "weighted average" }), /FAIL-HARD-INVARIANT-MASKED/);
  assert.throws(() => compilePolicy({ ...input, overall_status: "partial" }), /FAIL-HARD-INVARIANT-MASKED/);
});

test("policy rejects undeclared nested metadata and output aliases", (t) => {
  const source = policySource(t);
  const metadataRule = rule(source, "POL-METADATA", "required", "pass");
  metadataRule.verification = {
    ...metadataRule.verification,
    expected_value: "reviewed",
    count: 1,
  };
  assert.throws(() => compilePolicy({ ...source, rule_map: [metadataRule] }), /FAIL-POLICY-SOURCE-DRIFT/);
  assert.throws(
    () => compilePolicy({ ...source, rule_map: [metadataRule], unknown_config: true }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );
  assert.throws(
    () => compilePolicy({ ...source, rule_map: [metadataRule], reducer: "median" }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );

  const hardInput = {
    ...source,
    rule_map: [rule(source, "POL-HARD-BOUNDARY", "hard-invariant", "partial")],
  };
  assert.throws(() => compilePolicy({ ...hardInput, reducer: "median" }), /FAIL-HARD-INVARIANT-MASKED/);
  assert.throws(
    () => compilePolicy({ ...hardInput, calculation: { method: "average" } }),
    /FAIL-HARD-INVARIANT-MASKED/,
  );
});

test("policy canonicalizes rule IDs and rejects result-status aliases", (t) => {
  const source = policySource(t);
  const canonical = compilePolicy({
    ...source,
    rule_map: [rule(source, " POL-CANONICAL ", "required", "pass")],
  });
  assert.equal(canonical.rules[0].rule_id, "POL-CANONICAL");
  assert.throws(
    () => compilePolicy({
      ...source,
      rule_map: [
        rule(source, "P", "required", "pass"),
        rule(source, " P ", "required", "pass"),
      ],
    }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );
  assert.throws(
    () => compilePolicy({
      ...source,
      rule_map: [{ ...rule(source, "POL-CONFLICT", "hard-invariant", "pass"), result: "fail" }],
    }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );
  assert.throws(
    () => compilePolicy({
      ...source,
      rule_map: [{ ...rule(source, "POL-AGREE", "hard-invariant", "pass"), result: " PASS " }],
    }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );
});

test("policy keeps an agreed hard-invariant N/A categorical rather than failing it", (t) => {
  const source = policySource(t);
  const notApplicable = rule(source, "POL-HARD-N-A", "hard-invariant", "N/A");
  notApplicable.applicability.status = "not applicable";
  const profile = compilePolicy({ ...source, rule_map: [notApplicable] });
  assert.equal(profile.summary.status, "not_applicable");
  assert.deepEqual(profile.summary.hard_invariant_non_passes, []);
  assert.deepEqual(profile.summary.by_status.not_applicable, ["POL-HARD-N-A"]);
});

test("policy rejects incoherent applicability results and all source-reference aliases", (t) => {
  const source = policySource(t);
  const contradictoryApplicability = rule(source, "POL-HARD-CONTRADICTION", "hard-invariant", "pass");
  contradictoryApplicability.applicability.status = "not_applicable";
  assert.throws(
    () => compilePolicy({ ...source, rule_map: [contradictoryApplicability] }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );

  const contradictoryResult = rule(source, "POL-RESULT-N-A", "required", "N/A");
  assert.throws(
    () => compilePolicy({ ...source, rule_map: [contradictoryResult] }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );

  const agreeing = rule(source, "POL-REF-AGREE", "required", "pass");
  agreeing.source_refs = [{
    document_path: source.document_path,
    path: path.resolve(source.document_path),
    locator: " #deployments-require-review ",
    anchor: "#deployments-require-review",
    section: " #deployments-require-review",
  }];
  assert.throws(() => compilePolicy({ ...source, rule_map: [agreeing] }), /FAIL-POLICY-SOURCE-DRIFT/);

  const otherDocument = path.join(path.dirname(source.document_path), "other-policy.md");
  fs.writeFileSync(otherDocument, "# Other policy\n", "utf8");
  const conflictingPath = rule(source, "POL-REF-PATH", "required", "pass");
  conflictingPath.source_refs = [{
    document_path: source.document_path,
    path: otherDocument,
    locator: "#deployments-require-review",
  }];
  assert.throws(
    () => compilePolicy({ ...source, rule_map: [conflictingPath] }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );

  const conflictingLocator = rule(source, "POL-REF-LOCATOR", "required", "pass");
  conflictingLocator.source_refs = [{
    document_path: source.document_path,
    locator: "#deployments-require-review",
    anchor: "#other-section",
  }];
  assert.throws(
    () => compilePolicy({ ...source, rule_map: [conflictingLocator] }),
    /FAIL-POLICY-SOURCE-DRIFT/,
  );
});
