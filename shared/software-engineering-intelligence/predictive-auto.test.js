"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createForwardTemporalFixture, createV3ForwardTemporalFixture } = require("./forward-temporal-fixtures.js");
const forwardTemporal = require("./forward-temporal-evaluator.js");
const { evaluateAutomatic } = require("./predictive-auto.js");

function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function receiptDigest(receipt) {
  const body = { ...receipt };
  delete body.receipt_sha256;
  return "sha256:" + crypto.createHash("sha256").update(stableStringify(body)).digest("hex");
}

function createObservablePromotionStore() {
  const promotions = new Map();
  const calls = { read: 0, publish: 0 };
  return {
    calls,
    readPromotion({ key }) {
      calls.read += 1;
      const promotion = promotions.get(key);
      if (!promotion) return null;
      return {
        manifest: { key, binding: promotion.binding },
        objects: promotion.objects.map((object) => ({
          ...object,
          size: Buffer.byteLength(object.bytes),
          digest: "sha256:" + crypto.createHash("sha256").update(object.bytes).digest("hex"),
        })),
      };
    },
    publishPromotion({ key, binding, objects }) {
      calls.publish += 1;
      promotions.set(key, { binding, objects: objects.map((object) => ({ ...object })) });
    },
    object(label) {
      const promotion = [...promotions.values()][0];
      assert.ok(promotion, "test must publish one promotion before mutating it");
      const object = promotion.objects.find((entry) => entry.label === label);
      assert.ok(object, "test promotion must include " + label);
      return object;
    },
    objects() {
      const promotion = [...promotions.values()][0];
      assert.ok(promotion, "test must publish one promotion before reading its objects");
      return promotion.objects;
    },
    objectCount() {
      return [...promotions.values()][0]?.objects.length ?? 0;
    },
  };
}

function v3FixtureInputs(fixture, store, { mode = "required", cutoff_builder, signal, configuration_hash } = {}) {
  const current_snapshot = fixture.input.horizons[0].snapshots.at(-1);
  const byRevision = new Map(fixture.input.horizons.flatMap((horizon) => horizon.snapshots)
    .map((snapshot) => [snapshot.repository.revision, snapshot]));
  return {
    mode,
    output_root: path.join(os.tmpdir(), "sei-predictive-auto-fixture-output"),
    state_root: path.join(os.tmpdir(), "sei-predictive-auto-fixture-state"),
    repository_id: current_snapshot.repository.repository_id,
    configuration_hash: configuration_hash ?? current_snapshot.repository.configuration_hash,
    history_stage: fixture.input.history_stage,
    current_snapshot,
    artifact_store: store,
    cutoff_builder: cutoff_builder ?? (({ required_revisions }) => required_revisions.map((revision) => ({
      snapshot: byRevision.get(revision),
    }))),
    ranking_k: fixture.input.ranking_k,
    signal,
  };
}

test("automatic prediction degrades to a bounded readiness result when history has too few cutoffs", () => {
  const fixture = createForwardTemporalFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-auto-"));
  try {
    const result = evaluateAutomatic({
      output_root: path.join(root, "output"),
      state_root: path.join(root, "state"),
      repository_id: "canonical-repository",
      configuration_hash: "sha256:" + "a".repeat(64),
      history_stage: fixture.input.history_stage,
      current_snapshot: fixture.input.snapshots.at(-1),
    });
    assert.equal(result.schema_version, "sei.forward-temporal-auto@1");
    assert.equal(result.status, "not-ready");
    assert.match(result.reason, /needs 6 canonical cutoff snapshots/i);
    assert.ok(result.binding, "automatic readiness must be branded to the current snapshot for report projection");
    assert.equal(result.forecast_state, "readiness");
    assert.equal(result.artifact_bytes, null);
    assert.ok(Number.isSafeInteger(result.available_snapshot_count));
    assert.ok(Object.isFrozen(result));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("required prediction constructs once, publishes a closed promotion, and reuses the exact object", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = createObservablePromotionStore();
  let cutoffBuilds = 0;
  const first = evaluateAutomatic(v3FixtureInputs(fixture, store, {
    cutoff_builder({ required_revisions }) {
      cutoffBuilds += 1;
      const all = new Map(fixture.input.horizons.flatMap((horizon) => horizon.snapshots)
        .map((snapshot) => [snapshot.repository.revision, snapshot]));
      return required_revisions.map((revision) => ({ snapshot: all.get(revision) }));
    },
  }));
  assert.equal(first.status, "evaluated");
  assert.equal(first.cache_status, "published");
  assert.equal(first.artifact_bytes, null);
  assert.equal(cutoffBuilds, 1);
  assert.equal(store.calls.publish, 1);
  assert.equal(first.telemetry.cutoff_construction_count, 1);
  assert.equal(first.telemetry.promotion_publication_count, 1);
  assert.equal(first.receipt.schema_version, "sei.forward-temporal-evaluation@3");

  const second = evaluateAutomatic(v3FixtureInputs(fixture, store, {
    cutoff_builder() {
      throw new Error("reused promotion must not construct cutoff snapshots");
    },
  }));
  assert.equal(second.status, "evaluated");
  assert.equal(second.cache_status, "hit");
  assert.equal(cutoffBuilds, 1);
  assert.equal(store.calls.publish, 1);
  assert.equal(second.telemetry.cutoff_construction_count, 0);
  assert.equal(second.telemetry.promotion_publication_count, 0);
  assert.equal(second.receipt.receipt_sha256, first.receipt.receipt_sha256);
  assert.deepEqual(second.current_rankings, first.current_rankings);
});

test("automatic prediction rejects a valid-digest serialized V3 receipt without its package-owned replay", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = createObservablePromotionStore();
  const built = evaluateAutomatic(v3FixtureInputs(fixture, store));
  assert.equal(built.status, "evaluated");
  const receiptObject = store.object("v3-receipt");
  const forged = JSON.parse(receiptObject.bytes);
  forged.limitations = [...forged.limitations, "forged raw-receipt-only claim"];
  forged.receipt_sha256 = receiptDigest(forged);
  receiptObject.bytes = JSON.stringify(forged);

  let cutoffBuilds = 0;
  const result = evaluateAutomatic(v3FixtureInputs(fixture, store, {
    mode: "auto",
    cutoff_builder() {
      cutoffBuilds += 1;
      throw new Error("automatic mode must not repair a forged promotion");
    },
  }));
  assert.equal(result.status, "not-ready");
  assert.equal(result.cache_status, "rejected");
  assert.equal(result.receipt, null);
  assert.equal(cutoffBuilds, 0);
  assert.equal(store.calls.publish, 1);
  assert.match(result.reason, /promotion was rejected/i);
});

test("automatic prediction rejects aliased and divergent package-owned cutoff objects", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = createObservablePromotionStore();
  const built = evaluateAutomatic(v3FixtureInputs(fixture, store));
  assert.equal(built.status, "evaluated");
  const cutoffObjects = store.objects().filter((object) => object.label.startsWith("cutoff-snapshot:"));
  assert.ok(cutoffObjects.length >= 2);
  const firstBytes = cutoffObjects[0].bytes;
  const secondBytes = cutoffObjects[1].bytes;
  cutoffObjects[0].bytes = secondBytes;

  const aliased = evaluateAutomatic(v3FixtureInputs(fixture, store, { mode: "auto" }));
  assert.equal(aliased.status, "not-ready");
  assert.match(aliased.reason, /objects are aliased/i);

  cutoffObjects[0].bytes = secondBytes;
  cutoffObjects[1].bytes = firstBytes;
  const divergent = evaluateAutomatic(v3FixtureInputs(fixture, store, { mode: "auto" }));
  assert.equal(divergent.status, "not-ready");
  assert.equal(divergent.cache_status, "rejected");
  assert.match(divergent.reason, /does not bind one exact/i);
  assert.equal(store.calls.publish, 1);
});

test("corruption, configuration drift, and cancellation fail closed before predictive binding or publication", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = createObservablePromotionStore();
  const built = evaluateAutomatic(v3FixtureInputs(fixture, store));
  assert.equal(built.status, "evaluated");
  const published = store.calls.publish;

  store.object("current-snapshot").bytes = "{not-json";
  const corrupt = evaluateAutomatic(v3FixtureInputs(fixture, store, { mode: "auto" }));
  assert.equal(corrupt.status, "not-ready");
  assert.equal(corrupt.cache_status, "rejected");
  assert.equal(store.calls.publish, published);

  const drift = evaluateAutomatic(v3FixtureInputs(fixture, store, {
    mode: "auto",
    configuration_hash: "b".repeat(64),
  }));
  assert.equal(drift.status, "not-ready");
  assert.equal(drift.cache_status, "rejected");
  assert.equal(store.calls.publish, published);

  const controller = new AbortController();
  controller.abort(new Error("test cancellation"));
  assert.throws(() => evaluateAutomatic(v3FixtureInputs(fixture, store, {
    mode: "auto",
    signal: controller.signal,
  })), /test cancellation/);
  assert.equal(store.calls.publish, published);
});

test("cancellation after a promotion read prevents replay from producing a predictive binding", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = createObservablePromotionStore();
  const seeded = evaluateAutomatic(v3FixtureInputs(fixture, store));
  assert.equal(seeded.status, "evaluated");
  const published = store.calls.publish;
  const controller = new AbortController();
  const readPromotion = store.readPromotion;
  store.readPromotion = (request) => {
    const hit = readPromotion(request);
    controller.abort(new Error("cancelled after promotion read"));
    return hit;
  };

  assert.throws(() => evaluateAutomatic(v3FixtureInputs(fixture, store, {
    mode: "auto",
    signal: controller.signal,
  })), /cancelled after promotion read/);
  assert.equal(store.calls.publish, published);
});

test("cancellation during immutable publication fails closed while preserving the one immutable promotion", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = createObservablePromotionStore();
  const controller = new AbortController();
  const publishPromotion = store.publishPromotion;
  store.publishPromotion = (request) => {
    publishPromotion(request);
    controller.abort(new Error("cancelled during immutable publication"));
  };

  assert.throws(() => evaluateAutomatic(v3FixtureInputs(fixture, store, {
    signal: controller.signal,
  })), /cancelled during immutable publication/);
  assert.equal(store.calls.publish, 1, "an irreversible publication may have completed before cancellation was observed");
  assert.ok(store.objects().length > 0, "the immutable object remains available for a later clean replay");

  const recovered = evaluateAutomatic(v3FixtureInputs(fixture, store, { mode: "auto" }));
  assert.equal(recovered.status, "evaluated");
  assert.equal(store.calls.publish, 1, "recovery must reuse the immutable object rather than publish a replacement");
});

test("cancellation after the required publication read prevents its replay binding", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = createObservablePromotionStore();
  const controller = new AbortController();
  const readPromotion = store.readPromotion;
  let reads = 0;
  store.readPromotion = (request) => {
    const hit = readPromotion(request);
    reads += 1;
    if (reads === 2) controller.abort(new Error("cancelled after immutable publication read"));
    return hit;
  };

  assert.throws(() => evaluateAutomatic(v3FixtureInputs(fixture, store, {
    signal: controller.signal,
  })), /cancelled after immutable publication read/);
  assert.equal(store.calls.publish, 1);
  assert.ok(store.objects().length > 0);
});

test("cancellation after V3 replay prevents a replay-owned receipt from becoming a binding", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = createObservablePromotionStore();
  const seeded = evaluateAutomatic(v3FixtureInputs(fixture, store));
  assert.equal(seeded.status, "evaluated");
  const controller = new AbortController();
  const evaluateForwardTemporal = forwardTemporal.evaluateForwardTemporal;
  forwardTemporal.evaluateForwardTemporal = (input) => {
    const receipt = evaluateForwardTemporal(input);
    controller.abort(new Error("cancelled after V3 replay"));
    return receipt;
  };
  try {
    assert.throws(() => evaluateAutomatic(v3FixtureInputs(fixture, store, {
      mode: "auto",
      signal: controller.signal,
    })), /cancelled after V3 replay/);
  } finally {
    forwardTemporal.evaluateForwardTemporal = evaluateForwardTemporal;
  }
  assert.equal(store.calls.publish, 1);
});

test("required publication preflight rejects cancellation before the immutable store can commit", () => {
  const fixture = createV3ForwardTemporalFixture();
  const store = createObservablePromotionStore();
  const controller = new AbortController();
  const snapshots = new Map(fixture.input.horizons.flatMap((horizon) => horizon.snapshots)
    .map((snapshot) => [snapshot.repository.revision, snapshot]));
  assert.throws(() => evaluateAutomatic(v3FixtureInputs(fixture, store, {
    signal: controller.signal,
    cutoff_builder({ required_revisions }) {
      controller.abort(new Error("cancelled before immutable publication"));
      return required_revisions.map((revision) => ({ snapshot: snapshots.get(revision) }));
    },
  })), /cancelled before immutable publication/);
  assert.equal(store.calls.publish, 0);
  assert.equal(store.objectCount(), 0);
});

test("off performs no predictive store, replay, construction, or publication work", () => {
  const store = createObservablePromotionStore();
  const result = evaluateAutomatic({
    mode: "off",
    artifact_store: store,
    cutoff_builder() {
      throw new Error("off must not construct cutoff snapshots");
    },
  });
  assert.equal(result.status, "disabled");
  assert.equal(result.binding, null);
  assert.equal(store.calls.read, 0);
  assert.equal(store.calls.publish, 0);
  assert.equal(result.telemetry.cutoff_construction_count, 0);
  assert.equal(result.telemetry.promotion_publication_count, 0);
});

test("automatic mode reads a compatible promotion but never constructs cutoffs or publishes predictive objects", () => {
  const fixture = createV3ForwardTemporalFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sei-predictive-auto-no-build-"));
  let storeReads = 0;
  let cutoffBuilds = 0;
  let promotionPublications = 0;
  try {
    const currentSnapshot = fixture.input.horizons[0].snapshots.at(-1);
    const result = evaluateAutomatic({
      mode: "auto",
      output_root: path.join(root, "output"),
      state_root: path.join(root, "state"),
      repository_id: currentSnapshot.repository.repository_id,
      configuration_hash: currentSnapshot.repository.configuration_hash,
      history_stage: fixture.input.history_stage,
      current_snapshot: currentSnapshot,
      artifact_store: {
        readPromotion() {
          storeReads += 1;
          return null;
        },
        publishPromotion() {
          promotionPublications += 1;
          throw new Error("automatic mode must not publish a promotion");
        },
      },
      cutoff_builder() {
        cutoffBuilds += 1;
        throw new Error("automatic mode must not construct cutoffs");
      },
    });

    assert.equal(result.status, "not-ready");
    assert.equal(storeReads, 1);
    assert.equal(cutoffBuilds, 0);
    assert.equal(promotionPublications, 0);
    assert.match(result.reason, /compatible predictive promotion|required/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
