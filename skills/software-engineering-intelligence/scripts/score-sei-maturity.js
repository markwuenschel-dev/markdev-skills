#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { resolveSeiLayout } = require(path.resolve(
  __dirname,
  "../../shared/software-engineering-intelligence/layout.js",
));

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail("FAIL-SEI-MATURITY-ARGUMENTS", "arguments must be an array");
  const options = { evidence: null, out: null, requirePromotion: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-promotion") {
      if (options.requirePromotion) fail("FAIL-SEI-MATURITY-ARGUMENTS", "--require-promotion may appear only once");
      options.requirePromotion = true;
      continue;
    }
    if (!["--evidence", "--out"].includes(argument)) fail("FAIL-SEI-MATURITY-ARGUMENTS", `unsupported argument ${argument}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) fail("FAIL-SEI-MATURITY-ARGUMENTS", `${argument} requires a value`);
    const key = argument === "--evidence" ? "evidence" : "out";
    if (options[key] !== null) fail("FAIL-SEI-MATURITY-ARGUMENTS", `${argument} may appear only once`);
    options[key] = value;
    index += 1;
  }
  if (options.evidence === null || options.out === null) fail("FAIL-SEI-MATURITY-ARGUMENTS", "--evidence and --out are required");
  return Object.freeze(options);
}

function readEvidence(filePath) {
  const resolved = path.resolve(filePath);
  let metadata;
  try { metadata = fs.lstatSync(resolved); } catch (error) { fail("FAIL-SEI-MATURITY-EVIDENCE", `cannot inspect ${resolved} (${error.code ?? error.message})`); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("FAIL-SEI-MATURITY-EVIDENCE", "evidence must be a regular non-symlink JSON file");
  try { return { resolved, value: JSON.parse(fs.readFileSync(resolved, "utf8")) }; } catch (error) { fail("FAIL-SEI-MATURITY-EVIDENCE", `cannot parse ${resolved} (${error.message})`); }
}

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function existingArtifact(artifact) {
  let metadata;
  try { metadata = fs.lstatSync(artifact.path); } catch (error) {
    if (error.code === "ENOENT") return false;
    fail("FAIL-SEI-MATURITY-IMMUTABLE", `cannot inspect ${artifact.path} (${error.code ?? error.message})`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("FAIL-SEI-MATURITY-IMMUTABLE", `${artifact.path} is not a regular immutable file`);
  if (!fs.readFileSync(artifact.path).equals(artifact.bytes)) fail("FAIL-SEI-MATURITY-IMMUTABLE", `existing bytes differ at ${artifact.path}`);
  return true;
}

function cleanup(entries) {
  for (const entry of entries) {
    try { fs.unlinkSync(entry.stagePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { fs.rmdirSync(entry.stageDirectory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
  }
}

function publishImmutable(artifacts) {
  const existing = new Map(artifacts.map((artifact) => [artifact.path, existingArtifact(artifact)]));
  const staged = [];
  const published = [];
  try {
    for (const artifact of artifacts) {
      if (existing.get(artifact.path)) continue;
      fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
      const stageDirectory = fs.mkdtempSync(path.join(path.dirname(artifact.path), ".sei-maturity-stage-"));
      const stagePath = path.join(stageDirectory, "artifact");
      fs.writeFileSync(stagePath, artifact.bytes, { flag: "wx" });
      staged.push({ stageDirectory, stagePath, artifact });
    }
    for (const entry of staged) {
      try {
        fs.linkSync(entry.stagePath, entry.artifact.path);
        published.push(entry.artifact.path);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        existingArtifact(entry.artifact);
      }
    }
  } catch (error) {
    for (const publishedPath of published.reverse()) {
      try { fs.unlinkSync(publishedPath); } catch (rollbackError) { if (rollbackError.code !== "ENOENT") throw rollbackError; }
    }
    cleanup(staged);
    if (error.message?.startsWith("FAIL-SEI-MATURITY-")) throw error;
    fail("FAIL-SEI-MATURITY-PUBLISH", error.code ?? error.message);
  }
  cleanup(staged);
}

function execute(argv) {
  const options = parseArguments(argv);
  const layout = resolveSeiLayout({ skillRoot: path.resolve(__dirname, "..") });
  const {
    scoreMaturity,
    renderMaturityScorecardMarkdown,
    validateMaturityScorecard,
    withEvidenceArtifactRoot,
  } = require(path.join(layout.shared_engine_root, "maturity-scorer.js"));
  const evidence = readEvidence(options.evidence);
  const scorecard = scoreMaturity(withEvidenceArtifactRoot(evidence.value, path.dirname(evidence.resolved)));
  validateMaturityScorecard(scorecard);
  const jsonBytes = Buffer.from(`${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  const markdownBytes = Buffer.from(renderMaturityScorecardMarkdown(scorecard), "utf8");
  const artifactRoot = path.resolve(options.out, "maturity-scorecards");
  const jsonPath = path.join(artifactRoot, `${scorecard.scorecard_id}.json`);
  const markdownPath = path.join(artifactRoot, `${scorecard.scorecard_id}.md`);
  publishImmutable([{ path: jsonPath, bytes: jsonBytes }, { path: markdownPath, bytes: markdownBytes }]);
  const receipt = Object.freeze({
    kind: "sei-maturity-scorecard-receipt-v1",
    scorecard_id: scorecard.scorecard_id,
    total_points: scorecard.total_points,
    maximum_points: scorecard.maximum_points,
    promotion_status: scorecard.promotion.status,
    json_path: jsonPath,
    json_sha256: digest(jsonBytes),
    markdown_path: markdownPath,
    markdown_sha256: digest(markdownBytes),
  });
  if (options.requirePromotion && scorecard.promotion.status !== "pass") {
    const error = new Error(`FAIL-SEI-MATURITY-PROMOTION: promotion is ${scorecard.promotion.status}`);
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

if (require.main === module) {
  try {
    const receipt = execute(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    if (error.receipt) process.stdout.write(`${JSON.stringify(error.receipt)}\n`);
    process.stderr.write(`SEI_MATURITY_ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { execute, parseArguments };
