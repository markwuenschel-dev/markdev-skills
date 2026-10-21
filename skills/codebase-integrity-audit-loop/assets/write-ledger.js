#!/usr/bin/env node
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function sharedFile(skillRoot, packageName, fileName) {
  for (const candidate of [path.resolve(skillRoot, "..", "shared", packageName, fileName), path.resolve(skillRoot, "..", "..", "shared", packageName, fileName), path.resolve(process.cwd(), "shared", packageName, fileName), path.resolve(process.cwd(), "skills", "shared", packageName, fileName)]) if (fs.existsSync(candidate)) return candidate;
  throw new Error(`SHARED_FILE_NOT_FOUND:${packageName}/${fileName}`);
}
function parse(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--input", "--output", "--ledger-verify", "--repo", "--ria-envelope", "--return-out"].includes(name) || !argv[index + 1]) throw new Error(`UNKNOWN_OR_MISSING_ARGUMENT:${name}`);
    out[name.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  return out;
}
function loadVerifier(file) {
  const sandbox = { console }; sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  if (!sandbox.LedgerVerify?.verifyLedger) throw new Error("LEDGER_VERIFY_API_MISSING");
  return sandbox.LedgerVerify;
}
function explicitWrite(allowedRoot, output, bytes) {
  const target = path.resolve(output); const relative = path.relative(allowedRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`ARTIFACT_PATH_FORBIDDEN: ledger output must remain under ${allowedRoot}`);
  if (fs.existsSync(target)) throw new Error(`REFUSING_TO_OVERWRITE:${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, bytes, { flag: "wx" }); fs.renameSync(temporary, target); }
  finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
  return { path: target, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}
function main() {
  const args = parse(process.argv.slice(2)); if (!args.input) throw new Error("--input is required");
  const skillRoot = path.resolve(__dirname, "..");
  const workspace = require(sharedFile(skillRoot, "project-intelligence-workspace", "project-intelligence-workspace.js"));
  const ledgerPath = args.ledger_verify || sharedFile(skillRoot, "candidate-ledger-spine", "ledger-verify.js");
  const input = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8")); const ledger = input?.ledger ?? input;
  const verified = loadVerifier(ledgerPath).verifyLedger(ledger);
  if (!verified.ok) throw new Error(`LEDGER_INVALID:\n${verified.problems.map((problem) => `[${problem.code}] ${problem.message}`).join("\n")}`);
  const envelope = args.ria_envelope ? JSON.parse(fs.readFileSync(path.resolve(args.ria_envelope), "utf8")) : null;
  // RIA mode (composite-scoring-v3 §7.1, §6.4): the per-dimension coverage receipt and the
  // minted-row fields are required and verified before anything is stored.
  let coverageWarnings = [];
  if (envelope) {
    const { verifyIntegrityCoverage } = require("./integrity-coverage.js");
    const coverage = verifyIntegrityCoverage(ledger, { revision: envelope?.baseline_ref?.repository_revision ?? null });
    if (!coverage.ok) throw new Error(`FAIL-INTEGRITY-COVERAGE-INVALID:\n${coverage.problems.join("\n")}`);
    coverageWarnings = coverage.limitations.map((limitation) => `integrity-coverage: ${limitation}`);
  }
  const repository = args.repo || process.cwd(); const allowedRoot = workspace.resolvePath(repository, "assessments", "integrity", "ledgers");
  const bytes = workspace.canonicalJsonBytes(ledger);
  const stored = args.output
    ? explicitWrite(allowedRoot, args.output, bytes)
    : workspace.storeJsonArtifact(repository, "assessments", "integrity", ledger);
  const revision = envelope?.baseline_ref?.repository_revision ?? ledger.repository_revision ?? ledger.repository?.revision ?? null;
  const ref = { owner: "codebase-integrity-audit-loop", artifact_id: `integrity-ledger:${stored.sha256}`, sha256: stored.sha256, repository_revision: revision };
  if (envelope) {
    const { createOwnerReturn } = require("../../shared/ria-owner-return/owner-return.js");
    // RIA's rendezvous requires this return as a FILE at a path it names; printing to
    // stdout left the redirect as an unwritten manual step.
    const ownerReturn = createOwnerReturn({ owner: ref.owner, canonical_artifact_ref: ref, repository_revision: revision, artifact_path: stored.path, input_binding_echo: envelope, warnings: coverageWarnings });
    if (args.return_out) {
      const target = path.resolve(args.return_out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(ownerReturn, null, 2)}\n`, "utf8");
      process.stdout.write(`${target}\n`);
    } else process.stdout.write(`${JSON.stringify(ownerReturn, null, 2)}\n`);
  } else process.stdout.write(`${JSON.stringify({ ...ref, path: stored.path, bytes: stored.bytes, candidates: verified.candidates.length }, null, 2)}\n`);
}
try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
