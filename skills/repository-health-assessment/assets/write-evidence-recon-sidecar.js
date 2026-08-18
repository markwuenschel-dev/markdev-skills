#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { projectHealthIslandToEvidencePacket } = require("./evidence-recon-projection.js");

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}
function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is not readable JSON: ${error.message}`); }
}

const args = process.argv.slice(2);
if (args.length < 2 || args.includes("--help")) {
  console.error("Usage: node assets/write-evidence-recon-sidecar.js <health-island.json> <output.json> [negative-receipts.json] [evidence-recon.js]");
  process.exit(args.includes("--help") ? 0 : 2);
}
const islandPath = path.resolve(args[0]);
const outputPath = path.resolve(args[1]);
const receiptsPath = args[2] ? path.resolve(args[2]) : null;
const evidenceReconPath = args[3] ? path.resolve(args[3]) : path.resolve(__dirname, "../../../shared/evidence-recon/evidence-recon.js");
if (!fs.existsSync(islandPath)) fail(`Health island not found: ${islandPath}`);
if (receiptsPath && !fs.existsSync(receiptsPath)) fail(`Negative-claim receipts not found: ${receiptsPath}`);
if (!fs.existsSync(evidenceReconPath)) fail(`Evidence Recon module not found: ${evidenceReconPath}`);
if (fs.existsSync(outputPath)) fail(`Refusing to overwrite existing sidecar: ${outputPath}`);

const island = readJson(islandPath, "Health island");
const receipts = receiptsPath ? readJson(receiptsPath, "Negative-claim receipts") : {};
let packet;
try {
  packet = projectHealthIslandToEvidencePacket(island, {
    evidenceReconPath,
    negative_claim_receipts: receipts
  });
} catch (error) {
  console.error("Evidence Recon projection failed");
  if (error.problems) console.error(JSON.stringify(error.problems, null, 2));
  else console.error(error.stack || error.message || String(error));
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temporary = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
try {
  fs.writeFileSync(temporary, JSON.stringify(packet, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, outputPath);
} catch (error) {
  try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
  fail(`Could not write sidecar atomically: ${error.message}`, 1);
}
const ER = require(evidenceReconPath);
const summary = ER.summarizePacket(packet);
console.log(JSON.stringify({ status: "valid", output: outputPath, packet_id: packet.packet_id, summary }, null, 2));
