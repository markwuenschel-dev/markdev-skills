"use strict";

const path = require("node:path");
const crypto = require("node:crypto");

function resolveEvidenceRecon(explicitPath) {
  const candidate = explicitPath || process.env.EVIDENCE_RECON_PATH || path.resolve(__dirname, "../../shared/evidence-recon/evidence-recon.js");
  return require(candidate);
}

// Conservative on purpose: any negation-shaped wording routes the statement to
// negative_claims, where it cannot reach safe_to_assume without an explicit
// coverage receipt. A false positive costs a receipt; a false negative promotes
// "nothing tests this" to an assumed fact.
const NEGATIVE_RE = /\b(no|none|nothing|nobody|nowhere|not|without|absent|missing|unused|never|neither|nor|lacks?|lacking|zero|cannot|unreachable|untested|unenforced|unvalidated|unverified)\b|n['\u2019]t\b|\bdoes not exist\b|\bdo not exist\b|\bno recorded\b|\bno automated\b/i;
const slug = value => String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : (value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value);

// Lane receipt status vocabulary is the shared expedition-lane enum
// (shared/evidence-recon/expedition-lane.schema.json): complete|partial|failed|blocked.
// "timeout" is not in that enum, so it maps to failed and is recorded as a limitation.
const WORKER_STATUS_RANK = { complete: 0, partial: 1, blocked: 2, failed: 3 };
function workerStatus(status) {
  if (status === "timeout") return "failed";
  return Object.prototype.hasOwnProperty.call(WORKER_STATUS_RANK, status) ? status : "failed";
}
function healthArtifactRefNote(ref) { return `health_artifact_ref artifact_id=${ref.artifact_id} sha256=${ref.sha256}`; }
function healthArtifactStructuredRef(ref) { return { kind: "health-artifact", artifact_id: String(ref.artifact_id), sha256: String(ref.sha256) }; }
// packet_id is content-derived: sha256 over the canonical (key-sorted) packet without packet_id.
function contentPacketId(packet) {
  const body = { ...packet }; delete body.packet_id;
  return `RHA-ER:sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex")}`;
}

function evidenceSources(evidence) {
  const out = [];
  for (const item of evidence || []) {
    if (item && typeof item.path === "string") {
      const ref = item.lines ? `${item.path}:${item.lines}` : item.path;
      out.push({ kind: item.lines ? "line" : "path", ref, ...(item.note ? { note: item.note } : {}) });
    } else if (item && item.architecture_level === true) {
      out.push({ kind: "other", ref: "architecture-level observation", note: String(item.rationale || "") });
    }
  }
  return out;
}

function bestSurface(island, claimId) {
  const matches = (island.coverage || []).filter(surface => (surface.evidence_refs || []).some(ref => ref && ref.kind === "claim" && ref.ref === claimId));
  if (!matches.length) return null;
  const rank = { inspected: 5, sampled: 4, "inventory-only": 3, uninspected: 2, unavailable: 1, "not-applicable": 0 };
  return matches.slice().sort((a, b) => (rank[b.coverage] || 0) - (rank[a.coverage] || 0))[0];
}

function coverageFor(island, claim, epistemicStatus, sources) {
  const surface = bestSurface(island, claim.claim_id);
  if (surface) {
    const direct = sources.some(source => ["line", "path", "command", "runtime", "test"].includes(source.kind));
    let quality = surface.evidence_quality || "none";
    if (epistemicStatus === "confirmed" && direct) quality = "strong";
    else if (epistemicStatus === "confirmed" && ["weak", "none"].includes(quality) && sources.length) quality = "moderate";
    else if (["inferred", "unknown"].includes(epistemicStatus) && sources.length) quality = "moderate";
    return {
      evidence_quality: quality,
      coverage: {
        state: surface.coverage,
        scope: `RHA surface ${surface.id}`,
        methods: ["repository-health-assessment lane inspection and claim traceability"],
        limitations: surface.note ? [surface.note] : [],
        ...(["unavailable", "not-applicable"].includes(surface.coverage) ? { reason: surface.reason || "RHA surface state requires a reason" } : {})
      }
    };
  }
  if (sources.length) {
    const direct = sources.some(source => ["line", "path", "command", "runtime", "test"].includes(source.kind));
    return {
      evidence_quality: epistemicStatus === "inferred" ? "moderate" : (direct ? "strong" : "moderate"),
      coverage: {
        state: direct ? "inspected" : "sampled",
        scope: `RHA claim ${claim.claim_id} evidence records`,
        methods: [direct ? "direct evidence inspection" : "architecture-level evidence review"],
        limitations: ["No health surface referenced this claim directly; coverage was conservatively projected from claim evidence."]
      }
    };
  }
  return {
    evidence_quality: "none",
    coverage: {
      state: "uninspected",
      scope: `RHA claim ${claim.claim_id}`,
      methods: [],
      limitations: ["The health island recorded no source for this observation."]
    }
  };
}

function confidenceFor(status, quality) {
  if (status === "unknown") return { level: quality === "none" ? "none" : "low", rationale: "The health observation explicitly remains unknown." };
  if (status === "inferred") return { level: quality === "none" ? "low" : "medium", rationale: "The observation is an inference rather than a directly established fact." };
  return { level: quality === "strong" ? "high" : "medium", rationale: "The observation is recorded as confirmed; confidence follows the projected evidence quality." };
}

function mergeReceipt(base, receipt) {
  if (!receipt) return base;
  return {
    ...base,
    ...clone(receipt),
    coverage: receipt.coverage ? clone(receipt.coverage) : base.coverage,
    confidence: receipt.confidence ? clone(receipt.confidence) : base.confidence,
    search_scope: receipt.search_scope ? clone(receipt.search_scope) : base.search_scope,
    search_methods: receipt.search_methods ? clone(receipt.search_methods) : base.search_methods,
    sources: receipt.sources ? clone(receipt.sources) : base.sources,
    exclusions: receipt.exclusions ? clone(receipt.exclusions) : base.exclusions,
    limitations: receipt.limitations ? clone(receipt.limitations) : base.limitations
  };
}

function projectHealthIslandToEvidencePacket(island, options = {}) {
  if (!island || typeof island !== "object") throw new Error("health island is required");
  const ER = resolveEvidenceRecon(options.evidenceReconPath);
  const runId = options.runId || `rha:${island.repository && island.repository.name ? slug(island.repository.name) : "repository"}:${island.generated || "run"}`;
  const generated = island.generated || (island.repository && island.repository.freshness_evidence && island.repository.freshness_evidence.observed_at) || new Date(0).toISOString();
  const laneIds = new Map();
  for (const claim of island.claims || []) laneIds.set(claim.lane, `RHA-LANE:${slug(claim.lane)}`);
  const workers = Array.isArray(island.evidence_workers) ? island.evidence_workers.filter(w => w && typeof w === "object" && typeof w.lane === "string" && w.lane) : [];
  for (const worker of workers) if (!laneIds.has(worker.lane)) laneIds.set(worker.lane, `RHA-LANE:${slug(worker.lane)}`);

  const packet = {
    evidence_packet_version: ER.EVIDENCE_PACKET_VERSION,
    packet_id: "RHA-ER:pending",
    producer: {
      skill: "repository-health-assessment", run_id: runId, mode: "expedition", created_at: generated,
      // Structured binding (evidence-recon 1.1.0). The legacy consumer note below is
      // still emitted for one release so pre-1.1.0 consumers keep resolving the binding.
      ...(options.healthArtifactRef ? { artifact_refs: [healthArtifactStructuredRef(options.healthArtifactRef)] } : {})
    },
    scope: {
      claim_or_question: `What does the repository-health assessment establish about ${island.repository && island.repository.name ? island.repository.name : "the assessed repository"}?`,
      objective: "Expose the health run's generic evidence claims, coverage limits, negative-claim gaps, and decision surfaces without changing health-grade authority.",
      required_completeness: "exhaustive",
      included_surfaces: (island.coverage || []).filter(s => s.coverage !== "not-applicable").map(s => ({ surface_id: s.id, description: `RHA health surface ${s.id}` })),
      excluded_surfaces: (island.coverage || []).filter(s => s.coverage === "not-applicable").map(s => ({ surface_id: s.id, reason: s.reason || "RHA marked not-applicable" }))
    },
    coverage_plan: {
      source_classes: ["repository-code", "tests-and-commands", "architecture-records", "inventory"],
      independent_surfaces: Array.from(laneIds.keys()),
      contradiction_risk: "high",
      false_negative_cost: "high",
      cross_source_reconciliation: true,
      parallelizable: true,
      selected_mode: "expedition",
      mode_rationale: "A full RHA run evaluates multiple independent repository-wide lanes and already uses bounded parallel evidence packets; the sidecar preserves that provenance under one parent."
    },
    claims: [],
    negative_claims: [],
    contradictions: [],
    handoff: { safe_to_assume: [], unresolved_facts: [], owner_intent_required: [], possible_decision_surfaces: [], consumer_notes: ["RHA remains authoritative for health grading; this sidecar is generic evidence only."].concat(options.healthArtifactRef ? [healthArtifactRefNote(options.healthArtifactRef)] : []) },
    lane_receipts: []
  };

  const projectedByOriginal = new Map();
  const laneRecords = new Map(Array.from(laneIds.entries()).map(([lane, id]) => [lane, { lane_id: id, surface: `RHA lane ${lane}`, status: null, claim_refs: [], negative_claim_refs: [], contradiction_refs: [], limitations: [] }]));
  const receiptOverrides = options.negative_claim_receipts || {};

  for (const claim of island.claims || []) {
    const observation = claim.observation || {};
    const entries = ["confirmed", "inferred", "unknown"].filter(kind => typeof observation[kind] === "string" && observation[kind].trim());
    if (!entries.length) entries.push(claim.result === "unknown" ? "unknown" : (claim.result === "partial" ? "inferred" : "confirmed"));
    for (const kind of entries) {
      const statement = (observation[kind] || claim.statement || "").trim();
      const sources = evidenceSources(claim.evidence);
      const derived = coverageFor(island, claim, kind, sources);
      const laneId = laneIds.get(claim.lane);
      const baseId = `RHA:${claim.claim_id}:${kind}`;
      const negative = NEGATIVE_RE.test(statement) || NEGATIVE_RE.test(claim.statement || "");
      projectedByOriginal.set(claim.claim_id, [...(projectedByOriginal.get(claim.claim_id) || []), baseId]);

      if (negative) {
        const fallback = {
          negative_claim_id: baseId,
          statement,
          search_scope: sources.length ? sources.map(source => source.ref) : [`RHA lane ${claim.lane}`],
          search_methods: ["projected from an RHA observation; the health island does not encode an explicit negative-search method"],
          coverage: derived.coverage,
          evidence_quality: derived.evidence_quality,
          sources,
          exclusions: [],
          search_completeness: "unknown",
          supports_absence: false,
          confidence: confidenceFor(kind, derived.evidence_quality),
          limitations: ["An explicit negative-claim coverage receipt is required before this statement can support absence."],
          origin_lane: laneId
        };
        const override = receiptOverrides[baseId] || receiptOverrides[claim.claim_id];
        const item = mergeReceipt(fallback, override);
        item.negative_claim_id = baseId;
        item.origin_lane = laneId;
        packet.negative_claims.push(item);
        laneRecords.get(claim.lane).negative_claim_refs.push(baseId);
        if (item.supports_absence) packet.handoff.safe_to_assume.push(baseId); else packet.handoff.unresolved_facts.push(baseId);
      } else {
        const item = {
          claim_id: baseId,
          statement,
          epistemic_status: kind,
          evidence_quality: derived.evidence_quality,
          coverage: derived.coverage,
          sources,
          confidence: confidenceFor(kind, derived.evidence_quality),
          supports: [`health-lane:${claim.lane}`, `health-result:${claim.result}`],
          contradiction_refs: [],
          limitations: kind === "unknown" ? ["The health observation remains unresolved."] : [],
          origin_lane: laneId
        };
        packet.claims.push(item);
        laneRecords.get(claim.lane).claim_refs.push(baseId);
        if (kind === "confirmed") packet.handoff.safe_to_assume.push(baseId); else packet.handoff.unresolved_facts.push(baseId);
      }
    }
  }

  for (const candidate of island.candidates || []) {
    const refs = [...new Set((candidate.claim_refs || []).flatMap(id => projectedByOriginal.get(id) || []))];
    const decisionId = `RHA-DS:${candidate.candidate_id}`;
    if (candidate.status === "needs-human-decision" || (candidate.rollup && candidate.rollup.execution_mode === "blocked-needs-human-decision")) {
      packet.handoff.owner_intent_required.push({
        id: `RHA-OI:${candidate.candidate_id}`,
        question: candidate.title,
        rationale: candidate.summary || candidate.root_cause || "The health candidate requires human intent.",
        claim_refs: refs
      });
    }
    if ((candidate.rollup && ["design", "prototype"].includes(candidate.rollup.recommended_action)) || candidate.status === "needs-human-decision") {
      packet.handoff.possible_decision_surfaces.push({
        id: decisionId,
        title: candidate.title,
        rationale: candidate.root_cause || candidate.summary || "RHA identified a possible decision surface.",
        claim_refs: refs
      });
    }
  }

  // Lane status comes from the island's evidence_workers record when one exists;
  // the worst worker status wins. Without a worker record a lane is "complete" only
  // when it actually produced claims.
  for (const [lane, record] of laneRecords) {
    const laneWorkers = workers.filter(w => w.lane === lane);
    const produced = record.claim_refs.length + record.negative_claim_refs.length;
    if (laneWorkers.length) {
      let status = "complete";
      for (const worker of laneWorkers) {
        const mapped = workerStatus(worker.status);
        if (WORKER_STATUS_RANK[mapped] > WORKER_STATUS_RANK[status]) status = mapped;
        const id = worker.worker_id ? String(worker.worker_id) : "unnamed";
        if (worker.status === "timeout") record.limitations.push(`timeout: evidence worker ${id} timed out`);
        else if (mapped !== worker.status) record.limitations.push(`evidence worker ${id} reported unrecognized status ${JSON.stringify(worker.status)}; treated as failed`);
        for (const limitation of Array.isArray(worker.limitations) ? worker.limitations : []) if (typeof limitation === "string" && limitation.trim()) record.limitations.push(`${id}: ${limitation.trim()}`);
      }
      if (status === "complete" && !produced) { status = "partial"; record.limitations.push("Evidence workers reported complete but the lane produced no claims."); }
      record.status = status;
    } else if (produced) record.status = "complete";
    else { record.status = "partial"; record.limitations.push("No evidence worker record and no claims for this lane."); }
    record.limitations = [...new Set(record.limitations)];
  }
  packet.lane_receipts = Array.from(laneRecords.values());
  packet.handoff.safe_to_assume = [...new Set(packet.handoff.safe_to_assume)];
  packet.handoff.unresolved_facts = [...new Set(packet.handoff.unresolved_facts)].filter(id => !packet.handoff.safe_to_assume.includes(id));

  packet.packet_id = options.packetId || contentPacketId(packet);
  const validation = ER.validateEvidencePacket(packet);
  if (!validation.ok) {
    const error = new Error("RHA evidence-recon projection failed validation");
    error.problems = validation.problems;
    throw error;
  }
  return packet;
}

module.exports = { projectHealthIslandToEvidencePacket, resolveEvidenceRecon, NEGATIVE_RE, healthArtifactRefNote, healthArtifactStructuredRef, contentPacketId };
