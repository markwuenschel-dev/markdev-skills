"use strict";
// Materializes the Architecture RIA-mode fixture (architecture.evidence-binding@1) for one
// repository and envelope: the canonical packet is stored content-addressed in the
// repository workspace, citing a tracked non-empty file at the bound revision, and the
// candidate set's placeholders are replaced by the structured, bound packet ref.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const skillsRoot = path.resolve(__dirname, "..", "..", "..");
const assets = path.join(skillsRoot, "architecture-improvement-intelligence", "assets");
const { writeEvidencePacketForRepository } = require(path.join(skillsRoot, "shared", "evidence-recon", "evidence-recon.js"));
const { bindingFromEnvelope, packetRefFor, sourceSnapshotFor } = require(path.join(assets, "architecture-evidence-binding.js"));

function trackedSource(repositoryRoot, revision) {
  // A multi-root or dirty baseline revision is a fingerprint, not a commit; its sources are
  // read from the working tree, whose tracked files are those at HEAD.
  const commit = sourceSnapshotFor(repositoryRoot, revision).kind === "git" ? revision : "HEAD";
  const names = childProcess.execFileSync("git", ["-C", repositoryRoot, "ls-tree", "-r", "--name-only", commit], { encoding: "utf8", windowsHide: true }).split("\n").filter(Boolean).sort();
  const pick = names.find((name) => !name.startsWith(".") && childProcess.execFileSync("git", ["-C", repositoryRoot, "show", `${commit}:${name}`], { encoding: "utf8", windowsHide: true }).length > 0);
  if (!pick) throw new Error(`architecture RIA fixture: no tracked non-empty file at ${revision}`);
  return pick;
}

/** Returns { input, packet_path, packet_sha256, source_path }. `mutatePacket` may edit the
 * packet before it is stored, so a test can vary exactly one thing and still bind it. */
function architectureRiaInput(repositoryRoot, envelope, { sourcePath = null, mutatePacket = null, owner = "architecture-improvement-intelligence" } = {}) {
  const binding = bindingFromEnvelope(envelope);
  const source = sourcePath ?? trackedSource(repositoryRoot, binding.revision);
  const packet = JSON.parse(fs.readFileSync(path.join(assets, "canonical-ria-evidence-packet.json"), "utf8").replaceAll("__ARCH_SOURCE_PATH__", source));
  if (mutatePacket) mutatePacket(packet);
  const stored = writeEvidencePacketForRepository(repositoryRoot, packet, { owner });
  const ref = packetRefFor(stored.path, binding);
  const text = fs.readFileSync(path.join(assets, "architecture-candidate-set.ria.example.json"), "utf8").replaceAll("__RIA_REVISION__", binding.revision).replaceAll("__ARCH_PACKET_SHA256__", stored.sha256);
  const input = JSON.parse(text);
  input.evidence_packet_refs = input.evidence_packet_refs.map((item) => (item === "__ARCH_PACKET_REF__" ? ref : item));
  return { input, packet_path: stored.path, packet_sha256: stored.sha256, source_path: source, packet_ref: ref };
}

module.exports = { architectureRiaInput, trackedSource };
