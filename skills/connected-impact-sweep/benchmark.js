"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { RevisionGraphCache, evaluateImpactGate } = require("./impact-gate");
const { createImpactFixture } = require("./test-support/git-impact-fixture");

const DEFAULT_CORPUS = path.join(__dirname, "fixtures", "gate-corpus.json");

function runBenchmark(corpusPath = DEFAULT_CORPUS) {
  const bytes = fs.readFileSync(corpusPath);
  const corpus = JSON.parse(bytes.toString("utf8"));
  if (corpus?.schema_version !== "connected-impact-corpus@1" || !Array.isArray(corpus.cases)) {
    throw new Error("FAIL-IMPACT-BENCHMARK-CORPUS: unsupported corpus");
  }
  const confusion = { true_full: 0, false_full: 0, true_non_full: 0, missed_full: 0 };
  let lowRiskFullSweeps = 0;
  const cache = new RevisionGraphCache();
  for (const fixture of corpus.cases) {
    const repository = createImpactFixture(fixture.input);
    let predictedFull;
    try { predictedFull = evaluateImpactGate({ ...repository.input, graphCache: cache }).level === "full"; }
    finally { fs.rmSync(repository.root, { recursive: true, force: true }); }
    const expectedFull = fixture.expected_level === "full";
    if (expectedFull && predictedFull) confusion.true_full += 1;
    else if (!expectedFull && predictedFull) {
      confusion.false_full += 1;
      lowRiskFullSweeps += 1;
    } else if (expectedFull) confusion.missed_full += 1;
    else confusion.true_non_full += 1;
  }
  return Object.freeze({
    schema_version: "connected-impact-benchmark@1",
    synthetic: true,
    cases: corpus.cases.length,
    corpus_bytes: bytes.length,
    corpus_sha256: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
    confusion_matrix: Object.freeze(confusion),
    low_risk_full_sweeps: lowRiskFullSweeps,
  });
}

if (require.main === module) process.stdout.write(`${JSON.stringify(runBenchmark())}\n`);

module.exports = Object.freeze({ runBenchmark });
