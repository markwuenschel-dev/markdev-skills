"use strict";
// Drives one Appendix A fixture run through the real ria.js CLI (instructions Phase 9):
// run to the owner rendezvous, author the three owner inputs from the fixture and the bound
// envelope, write them with each owner's canonical writer, then continue with report
// generation. Variants change one owner input and rerun the canonical writers in their own
// fixture run; nothing hand-edits a hash.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const A = require("./appendix-a-fixture.js");

const skillsRoot = path.resolve(__dirname, "..", "..", "..");
const RIA = path.join(skillsRoot, "repository-improvement-assessment", "scripts", "ria.js");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(skillsRoot, "repository-improvement-assessment", "request.example.json"), "utf8"));
const WRITERS = Object.freeze({
  "repository-health-assessment": path.join(skillsRoot, "repository-health-assessment", "assets", "write-health-artifact.js"),
  "codebase-integrity-audit-loop": path.join(skillsRoot, "codebase-integrity-audit-loop", "assets", "write-ledger.js"),
  "architecture-improvement-intelligence": path.join(skillsRoot, "architecture-improvement-intelligence", "assets", "write-candidate-set.js"),
});

function requestFor(root, extra = {}) {
  return { ...EXAMPLE, repository: { root }, verification_contract: { commands: [A.VERIFICATION_COMMAND] }, command_authorization: { ...EXAMPLE.command_authorization, commands: ["node"] }, presentation_policy: "generate", ...extra };
}
function runRia(sandbox, request, label) {
  const requestPath = path.join(sandbox, `${label}-request.json`); const outputPath = path.join(sandbox, `${label}-result.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const run = childProcess.spawnSync(process.execPath, [RIA, "--request", requestPath, "--output", outputPath], { encoding: "utf8", timeout: 600000 });
  const result = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, "utf8")) : null;
  return { status: run.status, stderr: run.stderr, stdout: run.stdout, result };
}

/** variant: { integrity?: {...} (integrityLedger variant), architectureFails?: true, mutate?: { health?, integrity?, architecture? } } */
function appendixARun({ sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ria-appendix-a-")), variant = {} } = {}) {
  const root = path.join(sandbox, "repo");
  const { revision } = A.buildAppendixARepo(root);
  const first = runRia(sandbox, requestFor(root), "rendezvous");
  if (first.status !== 3) throw new Error(`expected exit 3 at the rendezvous, got ${first.status}: ${first.stderr}`);
  const rendezvous = first.result.owner_rendezvous;
  const env = { ...process.env, ...(rendezvous.contract?.env ?? {}) };
  const inputs = path.join(sandbox, "owner-inputs"); fs.mkdirSync(inputs, { recursive: true });
  const writes = {};
  for (const [owner, writer] of Object.entries(WRITERS)) {
    const envelopePath = rendezvous.envelopes[owner];
    const envelope = JSON.parse(fs.readFileSync(envelopePath, "utf8"));
    if (owner === "architecture-improvement-intelligence" && variant.architectureFails) { writes[owner] = { skipped: "architecture owner failed" }; continue; }
    let value;
    if (owner === "repository-health-assessment") {
      const verificationArtifact = JSON.parse(fs.readFileSync(envelope.verification_baseline_ref.path, "utf8"));
      value = A.healthIsland({ revision, envelope, verificationArtifact });
      variant.mutate?.health?.(value);
    } else if (owner === "codebase-integrity-audit-loop") {
      const ledger = A.integrityLedger({ envelope, root, receiptDir: path.join(root, ".project-intelligence", "assessments", "integrity", "receipts"), variant: variant.integrity ?? {} });
      delete ledger.reproductions;
      value = ledger; variant.mutate?.integrity?.(value);
    } else {
      value = A.architectureInput({ root, envelope }).input; variant.mutate?.architecture?.(value);
    }
    const inputPath = path.join(inputs, `${owner}.json`); fs.writeFileSync(inputPath, JSON.stringify(value, null, 2));
    const out = childProcess.spawnSync(process.execPath, [writer, "--input", inputPath, "--repo", root, "--ria-envelope", envelopePath, "--return-out", rendezvous.return_paths[owner]], { encoding: "utf8", env });
    writes[owner] = { status: out.status, stderr: out.stderr };
    if (out.status !== 0) throw new Error(`${owner} writer failed: ${out.stderr}`);
  }
  const second = runRia(sandbox, requestFor(root, { lifecycle: "continue", state_path: first.result.state_path, ...(variant.architectureFails ? { allow_degraded: true } : {}) }), "continue");
  return { sandbox, root, revision, first, second, writes, rendezvous };
}

module.exports = { appendixARun, requestFor, runRia };
