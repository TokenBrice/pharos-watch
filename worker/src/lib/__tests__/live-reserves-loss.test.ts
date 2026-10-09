import { describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { computeLiveReserveConfigFingerprint, LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import type { EvidenceLossOutcome } from "@shared/types/evidence-loss";
import type { AcceptedReserveGeneration } from "@shared/types/accepted-reserve-generation";
import type { ReserveCompositionRecord } from "../live-reserves/store-shared";
import { beginReserveSyncAttempt, didReserveSyncAttemptBecomeAuthoritative, finalizeReserveSyncAttempt, finalizeReserveSyncSuccess, loadReserveSyncStateMap, loadFreshIndependentLiveReserveMap } from "../live-reserves/store";
import { evaluateLiveReserveAdmission } from "../live-reserves/store-snapshot-state";
import { reserveLossLineage, reserveLossOutcome, reserveRedemptionParentLoss } from "../live-reserves/loss";
import { acceptedReserveMetadataMap } from "../accepted-reserve-generation";
import { createReserveAdapterRunner } from "../../cron/reserve-adapter-runner";
import { createAdapterLatencyCollector } from "../../cron/sync-live-reserves-core";
import type { ConfiguredCoin } from "../../cron/sync-live-reserves-shared";

const ASSET = "iusd-infinifi";
const FETCHED = 1_000;
function recordFor(id = ASSET): ReserveCompositionRecord {
  const config = WORKER_TRACKED_META_BY_ID.get(id)!.liveReservesConfig!;
  return { stablecoinId: id, slices: [{ name: "Measured cash", pct: 100, risk: "low" }],
    fetchedAt: FETCHED, source: config.adapter, attemptId: `${id}:success`,
    configFingerprint: computeLiveReserveConfigFingerprint(config), metadata: { freshnessMode: "not-applicable" },
    warningCount: 0, warnings: [], adapterSourceModel: "dynamic-mix", adapterEvidenceClass: "independent" };
}
function lossFor(id: string, attempt: string, at: number, disposition: "operational" | "semantic" | "unknown" = "operational"): EvidenceLossOutcome {
  const record = recordFor(id);
  const sourceId = record.configFingerprint!;
  const reason = disposition === "operational" ? "budget-deferred" : disposition === "semantic" ? "validation-failed" : "collector-exception";
  return reserveLossOutcome({ assetId: id, sourceId, attemptId: attempt, observedAtSec: at, reason,
    legs: [{ key: "primary", sourceId: `${sourceId}:primary`, result: "not-started",
      loss: { key: "primary", sourceId: `${sourceId}:primary`, disposition, reason,
        proof: disposition === "unknown" ? null : `reserve-attempt:${attempt}:primary` } }],
    priorEvidence: { ref: `reserve-composition:${id}:${record.attemptId}`, observedAtSec: FETCHED, expiresAtSec: FETCHED + 172_801 } });
}
async function seed(db: D1Database, id = ASSET) {
  const record = recordFor(id);
  await beginReserveSyncAttempt(db, { stablecoinId: id, adapterKey: record.source, breakerKey: "fixture", attemptedAt: FETCHED, attemptId: record.attemptId!, configFingerprint: record.configFingerprint });
  await finalizeReserveSyncSuccess(db, record, { stablecoinId: id, adapterKey: record.source, breakerKey: "fixture",
    lastAttemptedAt: FETCHED, lastSuccessAt: FETCHED, lastStatus: "ok", warningCount: 0, warnings: [], lastError: null,
    metadata: {}, lastAttemptId: record.attemptId, pendingAttemptId: record.attemptId, lastSuccessAttemptId: record.attemptId,
    configFingerprint: record.configFingerprint }, Date.now() + 30_000);
  return record;
}
async function fail(db: D1Database, loss: EvidenceLossOutcome) {
  const id = loss.scope.assetId;
  const record = recordFor(id);
  await beginReserveSyncAttempt(db, { stablecoinId: id, adapterKey: record.source, breakerKey: "fixture", attemptedAt: loss.observedAtSec!, attemptId: loss.attemptId!, configFingerprint: record.configFingerprint });
  const current = (await loadReserveSyncStateMap(db)).get(id)!;
  return finalizeReserveSyncAttempt(db, { ...current, lastStatus: "error", lastError: loss.reason, warnings: [], warningCount: 0,
    metadata: { reserveLoss: loss } });
}

describe("reserve loss integrity", () => {
  it("leaves legacy successful evidence admitted when no later failure or loss packet exists", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const record = await seed(db);
      const state = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      expect(state.metadata.reserveLoss).toBeUndefined();
      expect(state.metadata.reserveLossLineage).toBeUndefined();
      expect(reserveLossLineage(state)).toMatchObject({ latest: null, invalidations: {} });
      expect(evaluateLiveReserveAdmission(record, state, WORKER_TRACKED_META_BY_ID.get(ASSET), FETCHED + 30).eligible).toBe(true);
      expect(evaluateLiveReserveAdmission(record, {
        lastSuccessAt: FETCHED, lastSuccessAttemptId: record.attemptId!,
      }, WORKER_TRACKED_META_BY_ID.get(ASSET), FETCHED + 30).eligible).toBe(true);
      expect((await loadFreshIndependentLiveReserveMap(db, FETCHED + 30)).get(ASSET)).toEqual(record.slices);
    } finally { sqlite.close(); }
  });

  it.each(["clean", "operational", "semantic", "legacy-error"] as const)(
    "preserves the prior finalized %s result during an in-flight attempt",
    async (priorResult) => {
      const { sqlite, db } = createLatestSchemaSqlite();
      try {
        const record = await seed(db);
        if (priorResult === "operational" || priorResult === "semantic") {
          await fail(db, lossFor(ASSET, "previous-attempt", 1_010, priorResult));
        } else if (priorResult === "legacy-error") {
          sqlite.prepare("UPDATE reserve_sync_state SET last_status = 'error', last_attempt_id = NULL").run();
        }
        const prior = (await loadReserveSyncStateMap(db)).get(ASSET)!;
        const originalLoss = reserveLossLineage(prior).latest;
        await beginReserveSyncAttempt(db, { stablecoinId: ASSET, adapterKey: record.source, breakerKey: "fixture",
          attemptedAt: 1_020, attemptId: "in-flight", configFingerprint: record.configFingerprint });
        const pending = (await loadReserveSyncStateMap(db)).get(ASSET)!;
        const lineage = reserveLossLineage(pending);
        const eligible = priorResult === "clean" || priorResult === "operational";
        expect(evaluateLiveReserveAdmission(record, pending, WORKER_TRACKED_META_BY_ID.get(ASSET), 4_000).eligible).toBe(eligible);
        expect(reserveRedemptionParentLoss(lineage, 4_000) == null).toBe(eligible);
        if (priorResult === "legacy-error") {
          expect(lineage.latest).toMatchObject({ disposition: "unknown", reason: "legacy-refresh-loss-unproved",
            attemptId: null, observedAtSec: 0, legacy: true });
        } else {
          expect(lineage.latest).toEqual(originalLoss);
        }
        expect(evaluateLiveReserveAdmission(record, pending, WORKER_TRACKED_META_BY_ID.get(ASSET), 174_000).eligible).toBe(false);
        expect(sqlite.prepare("SELECT fetched_at FROM reserve_composition").get()).toEqual({ fetched_at: FETCHED });
      } finally { sqlite.close(); }
    },
  );

  it("recognizes committed success for checkpoint recovery without treating retained evidence or finalized failure as current success", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const record = await seed(db);
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, ASSET, record.attemptId!)).toBe(true);
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, ASSET, "different-attempt")).toBe(false);
      await beginReserveSyncAttempt(db, { stablecoinId: ASSET, adapterKey: record.source, breakerKey: "fixture",
        attemptedAt: 1_010, attemptId: "current-failure", configFingerprint: record.configFingerprint });
      const pending = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      expect(evaluateLiveReserveAdmission(record, pending, WORKER_TRACKED_META_BY_ID.get(ASSET), 1_020).eligible).toBe(true);
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, ASSET, record.attemptId!)).toBe(false);
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, ASSET, "current-failure")).toBe(false);
      const loss = lossFor(ASSET, "current-failure", 1_010, "semantic");
      await expect(finalizeReserveSyncAttempt(db, { ...pending, lastStatus: "error", lastError: loss.reason,
        metadata: { reserveLoss: loss } })).resolves.toEqual({ finalized: true });
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, ASSET, "current-failure")).toBe(false);
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, ASSET, record.attemptId!)).toBe(false);
      const failed = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      expect(evaluateLiveReserveAdmission(record, failed, WORKER_TRACKED_META_BY_ID.get(ASSET), 1_020).eligible).toBe(false);
    } finally { sqlite.close(); }
  });

  it("uses actual reserve loss rather than healthy success identity to revoke a consumed parent", () => {
    const healthy = { latest: null, invalidations: {},
      authority: { attemptId: "new-success", sourceId: "a".repeat(64), observedAtSec: FETCHED + 10 } };
    expect(reserveRedemptionParentLoss(undefined, FETCHED + 30)).toBeNull();
    expect(reserveRedemptionParentLoss(healthy, FETCHED + 30)).toBeNull();
    const loss = lossFor(ASSET, "semantic", FETCHED + 10, "semantic");
    expect(reserveRedemptionParentLoss({ ...healthy, latest: loss, invalidations: { composition: loss } }, FETCHED + 30)).toEqual(loss);
    expect(reserveRedemptionParentLoss({ ...healthy, latest: lossFor(ASSET, "deferred", FETCHED + 10) }, FETCHED + 30)).toBeNull();
  });

  it.each([1_020, null])("never accepts a prior operational packet as current terminal proof (current clock: %s)", (lastAttemptedAt) => {
    const record = recordFor();
    const state = { stablecoinId: ASSET, configFingerprint: record.configFingerprint!,
      lastSuccessAt: FETCHED, lastSuccessAttemptId: record.attemptId!,
      lastAttemptId: "current-attempt", lastAttemptedAt, pendingAttemptId: null, lastStatus: "skipped" as const,
      metadata: { reserveLoss: lossFor(ASSET, "prior-attempt", 1_010) } };
    const lineage = reserveLossLineage(state);
    expect(lineage.latest).toMatchObject({ disposition: "unknown", attemptId: "current-attempt",
      reason: "current-attempt-proof-mismatched" });
    expect(reserveRedemptionParentLoss(lineage, 1_030)).toEqual(lineage.latest);
    expect(evaluateLiveReserveAdmission(record, state, WORKER_TRACKED_META_BY_ID.get(ASSET), 1_030).eligible).toBe(false);
  });

  it("never resurrects a semantic invalidation after an operational skip, and never rewrites historical evidence", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await seed(db);
      const before = sqlite.prepare("SELECT * FROM reserve_composition").get();
      const semantic = lossFor(ASSET, "semantic", 1_010, "semantic");
      await fail(db, semantic);
      await fail(db, lossFor(ASSET, "budget-skip", 1_020));
      const state = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      expect(state.metadata.reserveInvalidations?.composition).toEqual(semantic);
      expect(state.metadata.reserveLoss?.disposition).toBe("operational");
      expect(evaluateLiveReserveAdmission(recordFor(), state, WORKER_TRACKED_META_BY_ID.get(ASSET), 1_030).reasons).toContain("live-scope-invalidated");
      expect(sqlite.prepare("SELECT * FROM reserve_composition").get()).toEqual(before);
      expect(sqlite.prepare("SELECT COUNT(*) n FROM reserve_composition_history").get()).toEqual({ n: 1 });
    } finally { sqlite.close(); }
  });

  it("rejects legacy fallback-withheld without operational proof, including after a later skip", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await seed(db);
      sqlite.prepare("UPDATE reserve_sync_state SET last_attempted_at = 1010, last_attempt_id = 'withheld', last_status = 'degraded', metadata = ?").run(JSON.stringify({ reason: "fallback-withheld-score-grade-retained", failureCategory: "parse-failure" }));
      const prior = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      const loss = lossFor(ASSET, "operational-skip", 1_020);
      await beginReserveSyncAttempt(db, { stablecoinId: ASSET, adapterKey: prior.adapterKey, breakerKey: "fixture", attemptedAt: 1_020, attemptId: loss.attemptId!, configFingerprint: recordFor().configFingerprint });
      await finalizeReserveSyncAttempt(db, { ...prior, lastAttemptedAt: 1_020, lastAttemptId: loss.attemptId, pendingAttemptId: loss.attemptId,
        lastStatus: "skipped", metadata: { reserveLoss: loss, reserveInvalidations: reserveLossLineage(prior).invalidations } });
      const state = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      expect(state.metadata.reserveInvalidations?.composition.legacy).toBe(true);
      expect((await loadFreshIndependentLiveReserveMap(db, 1_030)).has(ASSET)).toBe(false);
    } finally { sqlite.close(); }
  });

  it("retains a proved operational loss only through the independent ORIGINAL fetch and source clocks", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const record = await seed(db);
      await fail(db, lossFor(ASSET, "budget", 1_010));
      const state = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      const coin = WORKER_TRACKED_META_BY_ID.get(ASSET)!;
      expect(evaluateLiveReserveAdmission(record, state, coin, FETCHED + 172_800).eligible).toBe(true);
      expect(evaluateLiveReserveAdmission(record, state, coin, FETCHED + 172_801).eligible).toBe(false);
      const cappedCoin = { ...coin, liveReservesConfig: { ...coin.liveReservesConfig!, scoring: { maxSourceAgeSec: 100 } } };
      const sourced = { ...record, metadata: { freshnessMode: "verified" as const, sourceTimestamp: 980 } };
      expect(evaluateLiveReserveAdmission(sourced, state, cappedCoin, 1_080).eligible).toBe(true);
      expect(evaluateLiveReserveAdmission(sourced, state, cappedCoin, 1_081).reasons).toContain("stale");
      expect(record.fetchedAt).toBe(FETCHED);
      expect(sourced.metadata.sourceTimestamp).toBe(980);
      expect(state.metadata.reserveLoss?.priorEvidence).toEqual(lossFor(ASSET, "budget", 1_010).priorEvidence);
    } finally { sqlite.close(); }
  });

  it("isolates two assets and leaves the unaffected asset's new deterioration authoritative", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await seed(db);
      const other = await seed(db, "hbd-hive");
      await fail(db, lossFor(ASSET, "semantic", 1_010, "semantic"));
      const map = await loadFreshIndependentLiveReserveMap(db, 1_020);
      expect(map.has(ASSET)).toBe(false);
      expect(map.get("hbd-hive")).toEqual(other.slices);
      const adverse = { ...other, attemptId: "hbd-adverse", fetchedAt: 1_030,
        warnings: [{ code: "undercollateralized", message: "Measured shortfall", severity: "warning" as const, effect: "degraded" as const }], warningCount: 1 };
      await beginReserveSyncAttempt(db, { stablecoinId: other.stablecoinId, adapterKey: other.source, breakerKey: "fixture", attemptedAt: 1_030, attemptId: adverse.attemptId, configFingerprint: other.configFingerprint });
      const current = (await loadReserveSyncStateMap(db)).get(other.stablecoinId)!;
      await finalizeReserveSyncSuccess(db, adverse, { ...current, lastSuccessAt: adverse.fetchedAt, lastSuccessAttemptId: adverse.attemptId, lastStatus: "degraded", warnings: adverse.warnings, warningCount: 1, metadata: {} }, Date.now() + 30_000);
      expect(sqlite.prepare("SELECT fetched_at, warnings FROM reserve_composition WHERE stablecoin_id = 'hbd-hive'").get()).toEqual({ fetched_at: 1_030, warnings: JSON.stringify(adverse.warnings) });
      expect((await loadReserveSyncStateMap(db)).get(ASSET)?.metadata.reserveInvalidations?.composition.disposition).toBe("semantic");
    } finally { sqlite.close(); }
  });

  it("keeps a mixed semantic primary plus proved timeout fallback semantic in either order", () => {
    const primary = lossFor(ASSET, "mixed", 1_010, "semantic");
    const timeout = { key: "fallback", sourceId: "fallback", disposition: "operational" as const, reason: "timeout", proof: "attempt:mixed:timeout" };
    for (const legs of [[primary.legs[0]!, timeout], [timeout, primary.legs[0]!]]) {
      const loss = reserveLossOutcome({ assetId: ASSET, sourceId: primary.sourceId!, attemptId: "mixed", observedAtSec: 1_010,
        reason: "mixed-chain", priorEvidence: primary.priorEvidence,
        legs: legs.map((leg) => ({ key: leg.key, sourceId: leg.sourceId, result: "failed", loss: leg })) });
      expect(loss.disposition).toBe("semantic");
    }
  });

  it("preserves every failed primary/fallback leg when a later fallback succeeds", async () => {
    const coin = WORKER_TRACKED_META_BY_ID.get(ASSET)! as ConfiguredCoin;
    const config = { ...coin.liveReservesConfig, inputs: { primary: { kind: "http-json" as const, url: "https://example.com/primary" },
      fallbacks: [{ kind: "http-json" as const, url: "https://example.com/one" }, { kind: "http-json" as const, url: "https://example.com/two" }] } };
    const fetch = vi.fn().mockRejectedValueOnce(new Error("schema drift is not operational")).mockRejectedValueOnce(new Error("adapter-timeout"))
      .mockResolvedValueOnce({ slices: recordFor().slices, metadata: { freshnessMode: "not-applicable" } });
    const descriptor = LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter];
    const run = createReserveAdapterRunner({ signal: new AbortController().signal, adapterCtx: {}, adapterTimeoutMs: 30_000, telemetry: createAdapterLatencyCollector() });
    const result = await run(coin, config, { ...descriptor, key: config.adapter, fetch });
    expect(result.metadata?.reserveAttemptLegs?.map((leg) => [leg.key, leg.result, leg.loss?.disposition ?? null])).toEqual([
      ["primary", "failed", "unknown"], ["fallback-0", "failed", "unknown"], ["fallback-1", "returned", null],
    ]);
    expect(result.metadata?.reserveAttemptLegs?.every((leg) => leg.loss?.disposition !== "operational")).toBe(true);
  });

  it("preserves finalized carry while pending and requires readback after lost failure acknowledgement", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await seed(db);
      await fail(db, lossFor(ASSET, "first-operational", 1_010));
      await beginReserveSyncAttempt(db, { stablecoinId: ASSET, adapterKey: recordFor().source, breakerKey: "fixture", attemptedAt: 1_020, attemptId: "ambiguous", configFingerprint: recordFor().configFingerprint });
      const pending = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      expect(evaluateLiveReserveAdmission(recordFor(), pending, WORKER_TRACKED_META_BY_ID.get(ASSET), 1_030).eligible).toBe(true);
      const lostAck: D1Database = { ...db, batch: async (statements) => { await db.batch(statements); throw new Error("ack lost"); } };
      await expect(finalizeReserveSyncAttempt(lostAck, { ...pending, lastStatus: "error", metadata: { reserveLoss: lossFor(ASSET, "ambiguous", 1_020) } })).resolves.toEqual({ finalized: true });
      const state = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      expect(evaluateLiveReserveAdmission(recordFor(), state, WORKER_TRACKED_META_BY_ID.get(ASSET), 1_030).eligible).toBe(true);
    } finally { sqlite.close(); }
  });

  it("rolls back a failed loss-history write and does not authenticate an uncommitted failure", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const record = await seed(db);
      await fail(db, lossFor(ASSET, "previous-operational", 1_010));
      await beginReserveSyncAttempt(db, { stablecoinId: ASSET, adapterKey: record.source, breakerKey: "fixture",
        attemptedAt: 1_020, attemptId: "uncommitted", configFingerprint: record.configFingerprint });
      const pending = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      const beforeState = sqlite.prepare("SELECT * FROM reserve_sync_state").get();
      const beforeComposition = sqlite.prepare("SELECT * FROM reserve_composition").get();
      const beforeHistory = sqlite.prepare("SELECT * FROM reserve_sync_attempt_history ORDER BY attempted_at").all();
      sqlite.exec(`CREATE TRIGGER reject_loss_history BEFORE INSERT ON reserve_sync_attempt_history
        WHEN NEW.attempt_id = 'uncommitted'
        BEGIN SELECT RAISE(ABORT, 'loss history unavailable'); END`);
      const loss = lossFor(ASSET, "uncommitted", 1_020, "semantic");
      await expect(finalizeReserveSyncAttempt(db, { ...pending, lastStatus: "error", lastError: loss.reason,
        metadata: { reserveLoss: loss } })).rejects.toThrow("loss history unavailable");
      expect(sqlite.prepare("SELECT * FROM reserve_sync_state").get()).toEqual(beforeState);
      expect(sqlite.prepare("SELECT * FROM reserve_composition").get()).toEqual(beforeComposition);
      expect(sqlite.prepare("SELECT * FROM reserve_sync_attempt_history ORDER BY attempted_at").all()).toEqual(beforeHistory);
      const state = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      expect(state.pendingAttemptId).toBe("uncommitted");
      expect(state.metadata.reserveLoss?.attemptId).toBe("previous-operational");
      expect(evaluateLiveReserveAdmission(record, state, WORKER_TRACKED_META_BY_ID.get(ASSET), 1_030).eligible).toBe(true);
    } finally { sqlite.close(); }
  });

  it("rejects a conflicting terminal retry instead of authenticating different loss under the same attempt tuple", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const record = await seed(db);
      const semantic = lossFor(ASSET, "finalized-semantic", 1_010, "semantic");
      await fail(db, semantic);
      const state = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      const beforeState = sqlite.prepare("SELECT * FROM reserve_sync_state").get();
      const beforeHistory = sqlite.prepare("SELECT * FROM reserve_sync_attempt_history ORDER BY attempted_at").all();
      const conflicting = lossFor(ASSET, "finalized-semantic", 1_010);
      await expect(finalizeReserveSyncAttempt(db, { ...state, lastError: conflicting.reason,
        metadata: { reserveLoss: conflicting } })).resolves.toEqual({ finalized: false });
      expect(sqlite.prepare("SELECT * FROM reserve_sync_state").get()).toEqual(beforeState);
      expect(sqlite.prepare("SELECT * FROM reserve_sync_attempt_history ORDER BY attempted_at").all()).toEqual(beforeHistory);
      const retained = (await loadReserveSyncStateMap(db)).get(ASSET)!;
      expect(retained.metadata.reserveLoss).toEqual(semantic);
      expect(retained.metadata.reserveInvalidations?.composition).toEqual(semantic);
      expect(evaluateLiveReserveAdmission(record, retained, WORKER_TRACKED_META_BY_ID.get(ASSET), 1_030).eligible).toBe(false);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_composition_history").get()).toEqual({ count: 1 });
    } finally { sqlite.close(); }
  });

  it("fences immutable accepted reserve evidence against a semantic refresh after sealing", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const record = await seed(db);
      const { slices, ...projection } = record;
      const envelope: AcceptedReserveGeneration = { schemaVersion: 2, generationId: "reserve:1000:test", root: { scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1_000, queueHash: "test" },
        sealedBy: { attemptNo: 1, executionGeneration: 1, invocationId: "seal" }, producerCompletedAtSec: 1_005, contentSha256: "a".repeat(64),
        members: [{ stablecoinId: ASSET, snapshot: { ...projection, attemptId: projection.attemptId!, configFingerprint: projection.configFingerprint!, sliceCount: slices.length,
          lastSuccessAt: FETCHED, lastSuccessAttemptId: record.attemptId! }, latestAttempt: { attemptId: record.attemptId!, attemptedAt: FETCHED, status: "ok" } }] };
      expect(acceptedReserveMetadataMap(envelope, 1_006, await loadReserveSyncStateMap(db)).get(ASSET)?.admission?.eligible).toBe(true);
      await fail(db, lossFor(ASSET, "after-seal-semantic", 1_010, "semantic"));
      await fail(db, lossFor(ASSET, "after-seal-operational", 1_020));
      const projected = acceptedReserveMetadataMap(envelope, 1_030, await loadReserveSyncStateMap(db)).get(ASSET)!;
      expect(projected.admission?.eligible).toBe(false);
      expect(projected.metadata.reserveLossLineage?.invalidations.composition.disposition).toBe("semantic");
      expect(projected.fetchedAt).toBe(FETCHED);
      expect(envelope.members[0]!.snapshot!.metadata.reserveLossLineage).toBeUndefined();
    } finally { sqlite.close(); }
  });
});
