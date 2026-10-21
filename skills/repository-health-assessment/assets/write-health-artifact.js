#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const USAGE = "usage: node assets/write-health-artifact.js --input <health-island.json> [--repo <repository-root>] [--output <json>] [--ledger-verify <file>] [--ria-envelope <json>] [--evidence-recon <sidecar.json>] [--testing-fitness <ria.testing-fitness@1.json>] [--return-out <owner-return.json>] [--allow-path-outside]\n" +
  "  --output, --return-out must resolve inside <repo>/.project-intelligence/ or $RIA_RUNTIME_ROOT unless --allow-path-outside is given.\n" +
  "  --return-out refuses to overwrite an existing file. LEDGER_VERIFY_PATH overrides the shared ledger-verify.js location.\n" +
  "  --testing-fitness is deprecated: translate review reports into health claims with assets/review-to-claims.js.";

const VALUE_FLAGS = ["--input", "--repo", "--output", "--ledger-verify", "--ria-envelope", "--testing-fitness", "--return-out", "--evidence-recon"];
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) { if (!argv[i + 1]) throw new Error(`MISSING_VALUE:${a}`); out[a.slice(2).replace(/-/g, "_")] = argv[++i]; }
    else if (a === "--allow-path-outside") out.allow_path_outside = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`UNKNOWN_ARGUMENT:${a}`);
  }
  return out;
}
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function sharedFile(skillRoot, pkg, file, envPath) {
  const candidates = [];
  if (envPath) {
    const resolved = path.resolve(envPath);
    candidates.push(fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? path.join(resolved, file) : resolved);
  }
  candidates.push(path.resolve(skillRoot, "..", "shared", pkg, file), path.resolve(skillRoot, "..", "..", "shared", pkg, file), path.resolve(process.cwd(), "shared", pkg, file), path.resolve(process.cwd(), "skills", "shared", pkg, file));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`SHARED_FILE_NOT_FOUND:${pkg}/${file}`);
}
const SKILL_ROOT = path.resolve(__dirname, "..");
function ledgerVerifyPath(explicit) { return explicit ? path.resolve(explicit) : sharedFile(SKILL_ROOT, "candidate-ledger-spine", "ledger-verify.js", process.env.LEDGER_VERIFY_PATH); }
function loadWorkspace() { return require(sharedFile(SKILL_ROOT, "project-intelligence-workspace", "project-intelligence-workspace.js", process.env.PROJECT_INTELLIGENCE_WORKSPACE_PATH)); }
function loadVerifier(ledgerPath) {
  const sandbox = { console }; sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(ledgerPath, "utf8"), sandbox, { filename: ledgerPath });
  const hp = path.join(__dirname, "health-verify.js");
  vm.runInNewContext(fs.readFileSync(hp, "utf8"), sandbox, { filename: hp });
  if (!sandbox.HealthVerify?.verifyHealth) throw new Error("HEALTH_VERIFY_API_MISSING");
  return sandbox.HealthVerify;
}
const problemsText = v => v.problems.map(p => `[${p.code}] ${p.message}`).join("\n");

/** Grade block persisted with the artifact. Prefers HealthVerify.computeGradeBlock
 * (lane alpha); falls back to the verifier's recomputed grade when that export is absent. */
function gradeBlockFor(HV, island, verified) {
  if (typeof HV.computeGradeBlock === "function") return JSON.parse(JSON.stringify(HV.computeGradeBlock(island)));
  const g = verified.grade;
  const block = { raw_score: g.raw_score, raw_grade: g.raw_grade, final_grade: g.final_grade, caps_applied: g.caps_applied.map(c => ({ cap: c.cap, ceiling: c.ceiling, ...(c.trigger ? { trigger: String(c.trigger) } : {}), ...(typeof c.binding === "boolean" ? { binding: c.binding } : {}) })) };
  if (g.raw_grade == null) delete block.raw_grade;
  if (g.not_gradable) { block.not_gradable = true; if (g.reason) block.reason = String(g.reason); }
  return block;
}
/** Verify the island, inject the computed grade block, and re-verify as a persisted artifact. */
function preparePersistedHealth(HV, island) {
  const verified = HV.verifyHealth(island);
  if (!verified.ok) throw new Error("HEALTH_INVALID:\n" + problemsText(verified));
  const value = JSON.parse(JSON.stringify(island));
  value.grade = { ...(value.grade || {}), ...gradeBlockFor(HV, island, verified) };
  const persisted = HV.verifyHealth(value, { persisted: true });
  if (!persisted.ok) throw new Error("HEALTH_PERSISTED_INVALID:\n" + problemsText(persisted));
  return { value, verified: persisted };
}
function healthArtifactRefFor(workspace, value) {
  const bytes = workspace.canonicalJsonBytes(value);
  const digest = sha256(bytes);
  return { artifact_id: `health-assessment:${digest}`, sha256: digest, bytes };
}

/** Output containment: <repo>/.project-intelligence/ or $RIA_RUNTIME_ROOT, unless explicitly overridden. */
function realish(p) {
  let cur = path.resolve(p); const tail = [];
  while (!fs.existsSync(cur)) { const parent = path.dirname(cur); if (parent === cur) break; tail.unshift(path.basename(cur)); cur = parent; }
  try { cur = fs.realpathSync(cur); } catch {}
  return path.join(cur, ...tail);
}
function inside(root, candidate) { const rel = path.relative(root, candidate); return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }
function assertOutputAllowed(target, { repo, allowOutside, label, workspace }) {
  if (allowOutside) return path.resolve(target);
  const resolved = realish(target);
  const ws = workspace || loadWorkspace();
  let repoRoot; try { repoRoot = ws.canonicalRepositoryRoot(repo || process.cwd(), { requireGit: false }); } catch { repoRoot = path.resolve(repo || process.cwd()); }
  const roots = [realish(path.join(repoRoot, ".project-intelligence"))];
  if (process.env.RIA_RUNTIME_ROOT) roots.push(realish(process.env.RIA_RUNTIME_ROOT));
  if (roots.some(root => inside(root, resolved))) return resolved;
  throw new Error(`OUTPUT_PATH_OUTSIDE_ALLOWED_ROOTS:${label}=${resolved}\nallowed: ${roots.join(", ")} (set RIA_RUNTIME_ROOT or pass --allow-path-outside)`);
}

/** RIA's rendezvous requires the owner return as a FILE at a path it names, while this
 * writer has only ever printed to stdout — so the redirect was an unwritten manual step
 * and a silent way for a dispatched owner to look like it never ran. --return-out closes it.
 * The file is opened with "wx": an existing owner return is never overwritten. */
function emitOwnerReturn(value, target) {
  const json = JSON.stringify(value, null, 2);
  if (!target) { console.log(json); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(target, `${json}\n`, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`REFUSING_TO_OVERWRITE_RETURN:${target}`); throw error; }
  console.log(target);
}
function atomicExplicit(output, bytes) { if (fs.existsSync(output)) throw new Error(`REFUSING_TO_OVERWRITE:${output}`); fs.mkdirSync(path.dirname(output), { recursive: true }); const tmp = output + `.${process.pid}.tmp`; try { fs.writeFileSync(tmp, bytes, { flag: "wx" }); fs.renameSync(tmp, output); } finally { try { fs.unlinkSync(tmp); } catch {} } }

function validateEnvelopeBindings(envelope, revision) {
  if (!envelope || typeof envelope !== "object") throw new Error("RIA_ENVELOPE_INVALID: not an object");
  const baseline = envelope.baseline_ref;
  if (!baseline || typeof baseline !== "object") throw new Error("RIA_ENVELOPE_BASELINE_REF_MISSING");
  if (baseline.repository_revision !== revision) throw new Error(`RIA_ENVELOPE_REVISION_MISMATCH: baseline_ref.repository_revision=${baseline.repository_revision} island repository.revision=${revision}`);
  const vRef = envelope.verification_baseline_ref;
  if (vRef) {
    if (vRef.repository_revision !== revision) throw new Error(`RIA_VERIFICATION_BASELINE_REVISION_MISMATCH: verification_baseline_ref.repository_revision=${vRef.repository_revision} island repository.revision=${revision}`);
    const expected = vRef.file_sha256 || vRef.sha256;
    if (vRef.path && expected) {
      const file = path.resolve(vRef.path);
      if (!fs.existsSync(file)) throw new Error(`RIA_VERIFICATION_BASELINE_MISSING: ${file}`);
      const actual = sha256(fs.readFileSync(file));
      for (const [field, value] of [["file_sha256", vRef.file_sha256], ["sha256", vRef.sha256]]) if (value && value !== actual) throw new Error(`RIA_VERIFICATION_BASELINE_HASH_MISMATCH: ${field}=${value} actual=${actual} path=${file}`);
    } else throw new Error("RIA_VERIFICATION_BASELINE_UNBOUND: verification_baseline_ref needs path and file_sha256/sha256 to be re-hashed");
  }
}
// Single source for the sidecar binding note format (also written by the projection).
const { healthArtifactRefNote: healthRefNote } = require("./evidence-recon-projection.js");
/** A sidecar binds to the health artifact through the structured producer.artifact_refs
 * entry (evidence-recon 1.1.0), the legacy consumer note, or both. Either form alone is
 * accepted; when both are present they must name the same artifact. Absence or any
 * disagreement is EVIDENCE_RECON_SIDECAR_UNBOUND. */
function assertSidecarBound(packet, healthRef) {
  const regenerate = "regenerate it from this island with write-evidence-recon-sidecar.js";
  const structured = (Array.isArray(packet.producer?.artifact_refs) ? packet.producer.artifact_refs : []).filter(r => r && r.kind === "health-artifact");
  const notePrefix = "health_artifact_ref ";
  const notes = (packet.handoff?.consumer_notes || []).filter(n => typeof n === "string" && n.startsWith(notePrefix));
  if (!structured.length && !notes.length) throw new Error(`EVIDENCE_RECON_SIDECAR_UNBOUND: sidecar carries neither producer.artifact_refs[kind=health-artifact] nor "${healthRefNote(healthRef)}" — ${regenerate}`);
  if (structured.length > 1) throw new Error("EVIDENCE_RECON_SIDECAR_UNBOUND: sidecar carries more than one health-artifact ref");
  if (notes.length > 1) throw new Error("EVIDENCE_RECON_SIDECAR_UNBOUND: sidecar carries more than one health_artifact_ref note");
  if (structured.length && (structured[0].artifact_id !== healthRef.artifact_id || structured[0].sha256 !== healthRef.sha256)) throw new Error(`EVIDENCE_RECON_SIDECAR_UNBOUND: producer.artifact_refs names ${structured[0].artifact_id} sha256=${structured[0].sha256}, expected ${healthRef.artifact_id} sha256=${healthRef.sha256} — ${regenerate}`);
  if (notes.length && notes[0] !== healthRefNote(healthRef)) throw new Error(`EVIDENCE_RECON_SIDECAR_UNBOUND: sidecar note "${notes[0]}" does not match "${healthRefNote(healthRef)}" — ${regenerate}`);
  // Both forms present and each equal to healthRef implies they agree with each other.
  return { structured: structured.length === 1, legacy_note: notes.length === 1 };
}
function evidenceReconSpecialistRef(sidecarPath, healthRef, revision) {
  const ER = require(sharedFile(SKILL_ROOT, "evidence-recon", "evidence-recon.js", process.env.EVIDENCE_RECON_PATH));
  const bytes = fs.readFileSync(sidecarPath);
  let packet; try { packet = JSON.parse(bytes.toString("utf8")); } catch (error) { throw new Error(`EVIDENCE_RECON_SIDECAR_UNREADABLE: ${error.message}`); }
  const validation = ER.validateEvidencePacket(packet);
  if (!validation.ok) throw new Error("EVIDENCE_RECON_SIDECAR_INVALID:\n" + validation.problems.map(p => `[${p.code}] ${p.path} ${p.message}`).join("\n"));
  if (packet.producer?.skill !== "repository-health-assessment") throw new Error(`EVIDENCE_RECON_SIDECAR_FOREIGN_PRODUCER:${packet.producer?.skill}`);
  assertSidecarBound(packet, healthRef);
  const digest = sha256(bytes);
  return { kind: "evidence-recon", schema_version: `evidence-recon.packet@${packet.evidence_packet_version}`, artifact_id: `evidence-recon:${digest}`, sha256: digest, repository_revision: revision, path: sidecarPath, artifact_path: sidecarPath, packet_id: packet.packet_id };
}

/** composite-scoring-v3 §5.3: sei-criterion citations must exist in the bound assessment
 * bytes. The reader is the one RIA advertises in its rendezvous contract; it needs only
 * the envelope and the repository, so no extra CLI argument is involved. */
function validateSeiCitations(envelope, island, repositoryRoot) {
  const reader = require(path.resolve(SKILL_ROOT, "..", "repository-improvement-assessment", "engineering-intelligence-reader.js"));
  const citations = reader.collectSeiCitations(island);
  if (!citations.length) return;
  const evidence = reader.readSeiEvidence({ repository_root: path.resolve(repositoryRoot), envelope });
  const problems = reader.seiCitationProblems(evidence.assessment, citations);
  if (problems.length) throw new Error(`FAIL-SEI-CITATION-INVALID:\n${problems.join("\n")}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }
  if (!args.input) { console.error(USAGE); process.exitCode = 2; return; }
  const workspace = loadWorkspace();
  const HV = loadVerifier(ledgerVerifyPath(args.ledger_verify));
  const island = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));
  const { value } = preparePersistedHealth(HV, island);
  const revision = value.repository?.revision ?? null;
  const guard = { repo: args.repo, allowOutside: !!args.allow_path_outside, workspace };
  const outputPath = args.output ? assertOutputAllowed(args.output, { ...guard, label: "--output" }) : null;
  const returnOut = args.return_out ? assertOutputAllowed(args.return_out, { ...guard, label: "--return-out" }) : null;
  if (returnOut && fs.existsSync(returnOut)) throw new Error(`REFUSING_TO_OVERWRITE_RETURN:${returnOut}`);
  if (returnOut && !args.ria_envelope) throw new Error("--return-out requires --ria-envelope");
  if ((args.evidence_recon || args.testing_fitness) && !args.ria_envelope) throw new Error("--evidence-recon and --testing-fitness require --ria-envelope");
  const envelope = args.ria_envelope ? JSON.parse(fs.readFileSync(path.resolve(args.ria_envelope), "utf8")) : null;
  if (envelope) validateEnvelopeBindings(envelope, revision);
  if (envelope) validateSeiCitations(envelope, value, args.repo || process.cwd());
  const healthRef = healthArtifactRefFor(workspace, value);
  const specialist_refs = [];
  const warnings = [];
  if (envelope && args.testing_fitness) {
    console.error("DEPRECATED: --testing-fitness attaches a review report as a lane substitute; translate review reports into health claims with assets/review-to-claims.js instead.");
    const specialistPath = path.resolve(args.testing_fitness);
    const specialist = JSON.parse(fs.readFileSync(specialistPath, "utf8"));
    if (specialist.schema_version !== "ria.testing-fitness@1") throw new Error("TESTING_FITNESS_SCHEMA_INVALID");
    if (!specialist.source?.repository_revision) throw new Error("TESTING_FITNESS_REVISION_MISSING: source.repository_revision is required");
    if (specialist.source.repository_revision !== revision) throw new Error(`TESTING_FITNESS_REVISION_MISMATCH: ${specialist.source.repository_revision} != ${revision}`);
    const digest = sha256(fs.readFileSync(specialistPath));
    specialist_refs.push({ kind: "testing-fitness", schema_version: "ria.testing-fitness@1", artifact_id: `testing-fitness:${digest}`, sha256: digest, repository_revision: revision, path: specialistPath });
  }
  if (envelope && args.evidence_recon) specialist_refs.push(evidenceReconSpecialistRef(path.resolve(args.evidence_recon), healthRef, revision));

  const bytes = healthRef.bytes; let stored;
  if (outputPath) { atomicExplicit(outputPath, bytes); stored = { path: outputPath, sha256: healthRef.sha256, bytes: bytes.length }; }
  else stored = workspace.storeJsonArtifact(args.repo || process.cwd(), "assessments", "health", value);
  if (stored.sha256 !== healthRef.sha256) throw new Error(`HEALTH_ARTIFACT_HASH_DRIFT: stored ${stored.sha256} expected ${healthRef.sha256}`);
  const ref = { owner: "repository-health-assessment", artifact_id: healthRef.artifact_id, sha256: stored.sha256, repository_revision: revision };
  if (envelope) {
    const { createOwnerReturn } = require(sharedFile(SKILL_ROOT, "ria-owner-return", "owner-return.js"));
    emitOwnerReturn(createOwnerReturn({ owner: ref.owner, canonical_artifact_ref: ref, repository_revision: revision, artifact_path: stored.path, input_binding_echo: envelope, specialist_refs, warnings }), returnOut);
  } else console.log(JSON.stringify({ ...ref, path: stored.path, bytes: stored.bytes, final_grade: value.grade.final_grade }, null, 2));
}

module.exports = { USAGE, loadVerifier, ledgerVerifyPath, loadWorkspace, sharedFile, preparePersistedHealth, healthArtifactRefFor, healthRefNote, assertSidecarBound, assertOutputAllowed, validateEnvelopeBindings };
if (require.main === module) { try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; } }
