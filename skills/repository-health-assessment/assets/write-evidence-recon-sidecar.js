#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { projectHealthIslandToEvidencePacket } = require("./evidence-recon-projection.js");
const artifact = require("./write-health-artifact.js");

const USAGE = "Usage: node assets/write-evidence-recon-sidecar.js --island <health-island.json> [--repo <repository-root>] [--output <output.json>] [--receipts <negative-receipts.json>] [--evidence-recon <evidence-recon.js>] [--ledger-verify <ledger-verify.js>] [--allow-path-outside]\n" +
  "The island is verified (health-verify.js + ledger-verify.js, LEDGER_VERIFY_PATH honored) before projection; an invalid island exits 1.\n" +
  "--output must resolve inside <repo>/.project-intelligence/ or $RIA_RUNTIME_ROOT unless --allow-path-outside is given.\n" +
  "Legacy positional form remains supported: <island> <output> [receipts] [evidence-recon].";

function fail(message, code = 2) { console.error(message); process.exit(code); }
function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is not readable JSON: ${error.message}`); }
}
function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--island","--output","--receipts","--evidence-recon","--repo","--ledger-verify"].includes(arg)) {
      if (!argv[i+1]) fail(`Missing value for ${arg}`);
      out[arg.slice(2).replace(/-/g,"_")] = argv[++i];
    } else if (arg === "--allow-path-outside") out.allow_path_outside = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else out.positional.push(arg);
  }
  // Backward-compatible positional form: <island> <output> [receipts] [evidence-recon].
  if (!out.island && out.positional[0]) out.island = out.positional[0];
  if (!out.output && out.positional[1]) out.output = out.positional[1];
  if (!out.receipts && out.positional[2]) out.receipts = out.positional[2];
  if (!out.evidence_recon && out.positional[3]) out.evidence_recon = out.positional[3];
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.island) {
  if (args.help) console.log(USAGE); else console.error(USAGE);
  process.exit(args.help ? 0 : 2);
}
const islandPath = path.resolve(args.island);
const receiptsPath = args.receipts ? path.resolve(args.receipts) : null;
const evidenceReconPath = args.evidence_recon ? path.resolve(args.evidence_recon) : path.resolve(__dirname, "../../shared/evidence-recon/evidence-recon.js");
if (!fs.existsSync(islandPath)) fail(`Health island not found: ${islandPath}`);
if (receiptsPath && !fs.existsSync(receiptsPath)) fail(`Negative-claim receipts not found: ${receiptsPath}`);
if (!fs.existsSync(evidenceReconPath)) fail(`Evidence Recon module not found: ${evidenceReconPath}`);
let workspace;
let explicitOutputPath = null;
try {
  workspace = artifact.loadWorkspace();
  if (args.output) explicitOutputPath = artifact.assertOutputAllowed(args.output, { repo: args.repo, allowOutside: !!args.allow_path_outside, label: "--output", workspace });
} catch (error) { fail(error.message, 1); }
if (explicitOutputPath && fs.existsSync(explicitOutputPath)) fail(`Refusing to overwrite existing sidecar: ${explicitOutputPath}`);

const island = readJson(islandPath, "Health island");
const receipts = receiptsPath ? readJson(receiptsPath, "Negative-claim receipts") : {};

// Verify the island before projecting it: a sidecar must never launder an island
// that the health verifier rejects. The health artifact reference binds the
// sidecar to the exact bytes write-health-artifact.js persists for this island.
let healthRef;
try {
  const HV = artifact.loadVerifier(artifact.ledgerVerifyPath(args.ledger_verify));
  const { value } = artifact.preparePersistedHealth(HV, island);
  const ref = artifact.healthArtifactRefFor(workspace, value);
  healthRef = { artifact_id: ref.artifact_id, sha256: ref.sha256 };
} catch (error) {
  console.error("Health island failed verification; refusing to write an Evidence Recon sidecar");
  console.error(error.message || String(error));
  process.exit(1);
}

let packet;
try {
  packet = projectHealthIslandToEvidencePacket(island, { evidenceReconPath, negative_claim_receipts: receipts, healthArtifactRef: healthRef });
} catch (error) {
  console.error("Evidence Recon projection failed");
  if (error.problems) console.error(JSON.stringify(error.problems, null, 2));
  else console.error(error.stack || error.message || String(error));
  process.exit(1);
}

const ER = require(evidenceReconPath);
let outputPath, sha256;
try {
  if (explicitOutputPath) {
    const bytes = Buffer.from(JSON.stringify(packet, null, 2) + "\n", "utf8");
    fs.mkdirSync(path.dirname(explicitOutputPath), { recursive: true });
    const temporary = path.join(path.dirname(explicitOutputPath), `.${path.basename(explicitOutputPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(temporary, bytes, { flag: "wx" });
      fs.renameSync(temporary, explicitOutputPath);
    } finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {} }
    outputPath = explicitOutputPath;
    sha256 = crypto.createHash("sha256").update(fs.readFileSync(explicitOutputPath)).digest("hex");
  } else {
    const repositoryRoot = args.repo || process.cwd();
    const written = ER.writeEvidencePacketForRepository(repositoryRoot, packet, { owner: "health" });
    outputPath = written.path; sha256 = written.sha256;
  }
} catch (error) { fail(`Could not write sidecar atomically: ${error.message}`, 1); }

const summary = ER.summarizePacket(packet);
console.log(JSON.stringify({ status: "valid", output: outputPath, sha256, packet_id: packet.packet_id, health_artifact_ref: healthRef, summary }, null, 2));
