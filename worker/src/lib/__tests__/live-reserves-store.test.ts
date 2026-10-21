import { describe, expect, it } from "vitest";
import { computeLiveReserveConfigFingerprint, getLiveReserveAdapterDefinition, NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC } from "@shared/lib/live-reserve-adapters";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { STATUS_RESERVE_COHORT_SLO } from "@shared/lib/status-thresholds";
import {
  LIVE_SLICES,
  makeReservesDb,
  mockReserveD1 as mockD1,
  reserveCompositionInput,
  reserveSyncStateInput,
  reserveCompositionRow,
  reserveSyncRow,
} from "./live-reserves-store.test-support";
import {
  computeReserveCompositionOverview,
  loadFreshIndependentLiveReserveMap,
} from "../live-reserves/store-overview";
import { getMaxSyncAge } from "../live-reserves/store-read";
import { resolveReserveResult } from "../live-reserves/store-views";
import { evaluateLiveReserveAdmission } from "../live-reserves/store-snapshot-state";
import { getConfiguredLiveReserveCoins } from "../live-reserves/store-shared";
import { parseSnapshotMetadata } from "../live-reserves/store-row-decoding";
import { decodeLiveReserveRedemptionTelemetry } from "@shared/types/live-reserves";

import { RESERVE_FEED_REVIEWS } from "../reserve-feed-reviews";
import { resolveScheduledSlotPolicy } from "../scheduled-slot-policy";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { beginLiveReserveCheckpoint } from "../scheduled-recovery-checkpoint";

function pendingCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    state: "running", slot_started_at: 9_600, next_item_key: "coin-tail",
    items_done: 3, items_total: 12, updated_at: 9_905,
    producer_state: "running", producer_finished_at: null,
    ...overrides,
  };
}
describe("live-reserves-store", () => {
  it.each([
    ["fatal", "warning", true, false], ["fatal", "info", true, false], ["fatal", "warning", false, false],
    ["degraded", "warning", true, true], ["degraded", "warning", false, false], ["info", "warning", false, true],
  ] as const)("judges %s effects independently of %s severity and degraded allowlisting (%s)", (effect, severity, allowed, eligible) => {
    const coin = WORKER_TRACKED_META_BY_ID.get("iusd-infinifi")!;
    const config = coin.liveReservesConfig!;
    const record = reserveCompositionInput("retained", {
      metadata: { freshnessMode: "not-applicable" }, warningCount: 1,
      warnings: [{ code: "reviewed-gap", message: "Retained observation warning", severity, effect }],
    });
    const admission = evaluateLiveReserveAdmission(record, reserveSyncStateInput("retained", { lastStatus: "error" }), {
      liveReservesConfig: { ...config, scoring: { ...config.scoring, allowedDegradedWarningCodes: allowed ? ["reviewed-gap"] : [] } },
    }, 1_200);
    expect(admission.eligible).toBe(eligible);
    expect(admission.reasons).toEqual(eligible ? [] : ["degraded-snapshot"]);
  });

  it.each(["fatal", "info"] as const)("serves retained %s warnings without promoting fatal evidence", async (effect) => {
    const warnings = JSON.stringify([{ code: "retained-warning", message: "Stored evidence warning", severity: "info", effect }]);
    const composition = reserveCompositionRow({
      metadata: JSON.stringify({ freshnessMode: "not-applicable" }), warnings, warning_count: 1,
      adapter_source_model: "dynamic-mix", adapter_evidence_class: "independent",
    });
    const state = reserveSyncRow();
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [composition], first: composition },
      { match: "FROM reserve_sync_state", rows: [state], first: state },
    ]);
    expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has("iusd-infinifi")).toBe(effect === "info");
    const detail = await resolveReserveResult(db, "iusd-infinifi", 1_200);
    expect(detail?.mode).toBe(effect === "fatal" ? "curated-fallback" : "live");
    expect(detail?.liveAt).toBe(effect === "fatal" ? undefined : 1_000);
    if (effect === "fatal") {
      expect(detail?.metadata).toBeUndefined();
      expect(detail?.provenance).toBeUndefined();
      expect(detail?.sync?.status).toBe("degraded");
      expect(detail?.sync?.lastError).toContain("fatal warnings");
    }
  });

  it.each([
    ["not-json", 1], ["{}", 0], ["null", 0], ['[{"code":"material-unknown-exposure","effect":"degraded"}]', 1],
    ['[{"code":"gap","message":"gap","severity":"broken"}]', 1], ["[]", 1],
    ['[{"code":"gap","message":"gap","severity":"info"}]', 0],
  ])("quarantines corrupt warning payload %s while retaining healthy peers", async (warnings, warning_count) => {
    const now = 1_800_000_000;
    const compositions = ["iusd-infinifi", "fdusd-first-digital"].map((id) => reserveCompositionRow({
      stablecoin_id: id, fetched_at: now - 60, attempt_id: "observed", metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
      adapter_source_model: "dynamic-mix", adapter_evidence_class: "independent", warnings: id === "iusd-infinifi" ? warnings : "[]",
      warning_count: id === "iusd-infinifi" ? warning_count : 0,
    }));
    const states = ["iusd-infinifi", "fdusd-first-digital"].map((id) => reserveSyncRow({
      stablecoin_id: id, last_success_at: now - 60, last_attempted_at: now - 60,
      last_success_attempt_id: "observed", last_attempt_id: "observed",
    }));
    const db = mockD1([
      { match: "FROM reserve_composition", rows: compositions }, { match: "FROM reserve_sync_state", rows: states },
    ]);
    const map = await loadFreshIndependentLiveReserveMap(db, now);
    expect([...map.keys()]).toEqual(["fdusd-first-digital"]);
  });

  it.each([null, "[]", '[{"code":"note","message":"legacy note","severity":"info"}]', "not-json"])(
    "retains supported legacy warnings but quarantines corrupt state payload %s", async (warnings) => {
      const now = 1_800_000_000;
      const valid = warnings !== "not-json";
      const count = warnings == null || warnings === "[]" ? 0 : 1;
      const db = mockD1([
        { match: "FROM reserve_composition", rows: [reserveCompositionRow({
          fetched_at: now - 60, warnings: null, warning_count: null, metadata: "{}",
        })] },
        { match: "FROM reserve_sync_state", rows: [reserveSyncRow({
          last_success_at: now - 60, last_attempted_at: now - 60, warnings, warning_count: count,
          metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
        })] },
      ]);
      expect((await loadFreshIndependentLiveReserveMap(db, now)).has("iusd-infinifi")).toBe(valid);
    },
  );
  it("conserves raw evidence and removes each acknowledged feed's actual authoritative contribution", async () => {
    const review = RESERVE_FEED_REVIEWS.find((item) => item.stablecoinId === "mtbill-midas")!;
    const now = review.reviewedAt + 1;
    const composition = reserveCompositionRow({
      stablecoin_id: review.stablecoinId, source: review.adapterKey, fetched_at: now - 100,
      adapter_source_model: "dynamic-mix", adapter_evidence_class: "independent",
      metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: now - 100 }),
    });
    const sync = reserveSyncRow({
      stablecoin_id: review.stablecoinId, adapter_key: review.adapterKey,
      last_attempted_at: now, last_success_at: now - 100, last_status: "error",
      last_error: review.errorPrefix, metadata: JSON.stringify({ failureCategory: review.failureCategory }),
    });
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [composition], first: composition },
      { match: "FROM reserve_sync_state", rows: [sync], first: sync },
    ]);
    const overview = await computeReserveCompositionOverview(db, now, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    expect(overview.errorCoins).toBe(1);
    expect(overview.freshCoins).toBe(0);
    expect(overview.acknowledgedFeedIds).toEqual([review.stablecoinId]);
    expect(overview.healthConfiguredCoins).toBe(overview.configuredCoins - 1);
    expect(overview.healthAuthoritativeFreshCoins).toBe(overview.independentFreshEligible
      + overview.independentFreshUnverified + overview.staticValidatedFresh - 1);
    const expired = await computeReserveCompositionOverview(db, review.expiresAt, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    expect(expired.acknowledgedFeedIds).toEqual([]);
    expect(expired.healthConfiguredCoins).toBe(expired.configuredCoins);
    expect(expired.expiredFeedReviewIds).toContain(review.stablecoinId);
  });
  it.each([
    ["fdusd-first-digital", "fdusd-independent-assurance", 36 * 86400, 60, false],
    ["xsgd-straitsx", "straitsx-independent-assurance", 63 * 86400, 60, false],
    ["xsgd-straitsx", "straitsx-independent-assurance", NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC, 60, false],
    ["xsgd-straitsx", "straitsx-independent-assurance", NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC + 1, 60, true],
    ["xsgd-straitsx", "straitsx-independent-assurance", 86400, 3 * 86400, true],
  ])("aligns detail, scoring and overview source/fetch freshness for %s (%i, %i)", async (id, adapter, sourceAge, fetchAge, stale) => {
    const now = 1_800_000_000;
    const composition = reserveCompositionRow({
      stablecoin_id: id, source: adapter, fetched_at: now - fetchAge,
      metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: now - sourceAge }),
      adapter_source_model: "dynamic-mix", adapter_evidence_class: "independent",
    });
    const syncState = reserveSyncRow({
      stablecoin_id: id, adapter_key: adapter,
      last_success_at: now - fetchAge, last_attempted_at: now - fetchAge,
    });
    const db = mockD1([
      { match: "reserve_composition", rows: [composition], first: composition },
      { match: "reserve_sync_state", rows: [syncState], first: syncState },
    ]);
    const detail = await resolveReserveResult(db, id, now);
    expect(detail?.mode).toBe(stale ? "live-stale" : "live");
    expect(detail?.provenance?.scoringEligible).toBe(!stale);
    expect(detail?.displayBadge).toEqual({ kind: "proof", label: "Attestation" });
    expect((await loadFreshIndependentLiveReserveMap(db, now)).has(id)).toBe(!stale);
    const overview = await computeReserveCompositionOverview(db, now, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    expect(overview.freshCoins).toBe(stale ? 0 : 1);
    expect(overview.staleCoins).toBe(stale ? 1 : 0);
  });

  it("chunks configured reserve state reads within the D1 bind limit", async () => {
    const stablecoinIds = Array.from({ length: 181 }, (_, index) => `coin-${index}`);
    const db = mockD1([
      {
        match: "FROM reserve_sync_state",
        rows: stablecoinIds.map((stablecoinId, index) => reserveSyncRow({
          stablecoin_id: stablecoinId,
          adapter_key: "test",
          breaker_key: "test",
          last_attempted_at: 900 + index,
          last_success_at: 900 + index,
        })),
      },
    ]);

    await expect(getMaxSyncAge(db, 1_000, stablecoinIds)).resolves.toBe(100);
    const reserveQueries = db.getHistory().filter((entry) => entry.sql.includes("FROM reserve_sync_state"));
    expect(reserveQueries).toHaveLength(3);
    expect(reserveQueries.every((entry) => entry.binds.length <= 90)).toBe(true);
  });

  it("falls back when reserve composition exists without a matching successful sync state", async () => {
    const db = makeReservesDb({
      syncState: null,
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

    expect(result?.mode).toBe("curated-fallback");
    expect(result?.liveAt).toBeUndefined();
  });

  it.each([1, 2])("admits only corrected HCHF backing from retained binding v%i", async (version) => {
    const id = "hchf-hedera-swiss-franc";
    const coin = WORKER_TRACKED_META_BY_ID.get(id)!;
    const config = coin.liveReservesConfig!;
    expect(config.version).toBe(2);
    const configFingerprint = computeLiveReserveConfigFingerprint({ ...config, version });
    const slices = [{ sourceKey: "hliquity-hedera:hbar", name: "HBAR", pct: 100, risk: "high" as const }];
    const metadata = { freshnessMode: "not-applicable" as const };
    const record = reserveCompositionInput("hchf-retained", {
      stablecoinId: id, source: "hliquity-hedera", slices, metadata,
      adapterSourceModel: "single-bucket", configFingerprint,
    });
    const state = reserveSyncStateInput("hchf-retained", { stablecoinId: id, adapterKey: "hliquity-hedera" });
    const admission = evaluateLiveReserveAdmission(record, state, coin, 1_200);
    expect(admission.eligible).toBe(version === 2);
    expect(admission.reasons).toEqual(version === 1 ? ["config-mismatch"] : []);

    const db = makeReservesDb({
      composition: {
        stablecoin_id: id, source: "hliquity-hedera", slices: JSON.stringify(slices),
        config_fingerprint: configFingerprint, metadata: JSON.stringify(metadata),
        adapter_source_model: "single-bucket", adapter_evidence_class: "independent",
      },
      syncState: { stablecoin_id: id, adapter_key: "hliquity-hedera" },
    });
    const detail = await resolveReserveResult(db, id, 1_200);
    expect(detail?.mode).toBe(version === 2 ? "live" : "curated-fallback");
    expect(detail?.liveAt).toBe(version === 2 ? 1_000 : undefined);
    expect(detail?.metadata).toEqual(version === 2 ? metadata : undefined);
  });

  it("returns live data only when composition and sync state agree on the last successful snapshot", async () => {
    const db = makeReservesDb();

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

    expect(result).toMatchObject({
      mode: "live",
      liveAt: 1_000,
      reserves: LIVE_SLICES,
      displayBadge: {
        kind: "live",
        label: "Live",
      },
      provenance: {
        evidenceClass: "independent",
        sourceModel: "dynamic-mix",
        scoringEligible: false,
      },
      sync: {
        status: "ok",
        bootstrap: false,
        stale: false,
      },
    });

    const staleSourceWarning = {
      code: "stale-source-data",
      message: "Upstream reserve source timestamp is older than the accepted maximum",
      severity: "warning",
      effect: "degraded",
    };
    const staleSourceDb = makeReservesDb({
      composition: {
        fetched_at: 4_999_900,
        metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: 700 }),
      },
      syncState: {
        last_attempted_at: 4_999_900,
        last_success_at: 4_999_900,
        last_status: "degraded",
        warning_count: 1,
        warnings: JSON.stringify([staleSourceWarning]),
      },
    });
    // RDP-01: a stale upstream observation must demote the card to live-stale rather
    // than being presented as fresh. It stays visible -- the snapshot was validly
    // observed, and V9 excludes it separately by requiring lastStatus "ok".
    const staleSourceResult = await resolveReserveResult(staleSourceDb, "iusd-infinifi", 5_000_000, 300);
    expect(staleSourceResult).toMatchObject({
      mode: "live-stale",
      sync: {
        status: "degraded",
        stale: true,
        warnings: [staleSourceWarning.message],
      },
    });
    expect(staleSourceResult?.reserves).toEqual(LIVE_SLICES);

    // A fresh Worker fetch cannot launder a stale upstream observation into "live",
    // even when the sync status is ok: the effective observation age governs.
    const staleObservationWithOkStatus = makeReservesDb({
      composition: {
        fetched_at: 4_999_900,
        metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: 700 }),
      },
      syncState: { last_attempted_at: 4_999_900, last_success_at: 4_999_900 },
    });
    await expect(
      resolveReserveResult(staleObservationWithOkStatus, "iusd-infinifi", 5_000_000, 300),
    ).resolves.toMatchObject({ mode: "live-stale", sync: { stale: true } });

    // A degraded current attempt does not hide a still-fresh prior snapshot.
    const degradedFreshDb = makeReservesDb({ syncState: { last_status: "degraded" } });
    await expect(resolveReserveResult(degradedFreshDb, "iusd-infinifi", 1_200)).resolves.toMatchObject({
      mode: "live",
      sync: { status: "degraded", stale: false },
    });
  });

  it("does not mark unverified snapshots without explicit scoring exceptions as scoring eligible", async () => {
    const db = makeReservesDb({
      composition: {
        metadata: JSON.stringify({ freshnessMode: "unverified", sourceTimestamp: 1_000 }),
        adapter_source_model: "dynamic-mix",
        adapter_evidence_class: "independent",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

    expect(result?.mode).toBe("live");
    expect(result?.provenance).toMatchObject({
      evidenceClass: "independent",
      freshnessMode: "unverified",
      scoringEligible: false,
    });
  });

  it("keeps unverified snapshots non-score-grade even with legacy freshness exception flags", async () => {
    const db = makeReservesDb({
      composition: {
        metadata: JSON.stringify({
          freshnessMode: "unverified",
          sourceTimestamp: 1_000,
          scoringAllowsUnverifiedFreshness: true,
        }),
        adapter_source_model: "dynamic-mix",
        adapter_evidence_class: "independent",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

    expect(result?.provenance).toMatchObject({
      evidenceClass: "independent",
      freshnessMode: "unverified",
      scoringEligible: false,
    });
  });

  // Badge/provenance mapping is a pure function of the stored adapter columns, so
  // these cases vary only values — the wiring is identical.
  it.each([
    {
      label: "curated-validated adapters map to a curated-validated badge",
      stablecoinId: "frax-frax",
      adapterKey: "frax",
      slices: [{ name: "Reviewed baseline", pct: 100, risk: "low" }],
      freshnessMode: "unverified",
      sourceTimestamp: undefined,
      sourceModel: "validated-static",
      evidenceClass: "static-validated",
      badge: { kind: "curated-validated", label: "Curated-Validated" },
    },
    {
      label: "live-fed adapters keep live badge semantics even when evidence class is static-validated",
      stablecoinId: "usdd-tron-dao-reserve",
      adapterKey: "usdd-data-platform",
      slices: [{ name: "Tracked vaults", pct: 100, risk: "medium" }],
      freshnessMode: "verified",
      sourceTimestamp: 1_000,
      sourceModel: "dynamic-mix",
      evidenceClass: "static-validated",
      badge: { kind: "live", label: "Live" },
    },
    {
      label: "single-asset adapters map to a proof badge",
      stablecoinId: "pyusd-paypal",
      adapterKey: "single-asset",
      slices: [{ name: "Issuer reserves", pct: 100, risk: "very-low" }],
      freshnessMode: "not-applicable",
      sourceTimestamp: undefined,
      sourceModel: "single-bucket",
      evidenceClass: "weak-live-probe",
      badge: { kind: "proof", label: "Proof" },
    },
    {
      label: "Liquity v1 system collateral adapters map to a live badge",
      stablecoinId: "lusd-liquity",
      adapterKey: "liquity-v1",
      breakerKey: "live-reserves:lusd-liquity",
      slices: [{ name: "ETH", pct: 100, risk: "very-low" }],
      freshnessMode: "not-applicable",
      sourceTimestamp: undefined,
      sourceModel: "single-bucket",
      evidenceClass: "independent",
      badge: { kind: "live", label: "Live" },
    },
  ])("$label", async (testCase) => {
    const db = makeReservesDb({
      composition: {
        stablecoin_id: testCase.stablecoinId,
        slices: JSON.stringify(testCase.slices),
        source: testCase.adapterKey,
        metadata: JSON.stringify({
          freshnessMode: testCase.freshnessMode,
          ...(testCase.sourceTimestamp === undefined ? {} : { sourceTimestamp: testCase.sourceTimestamp }),
        }),
        adapter_source_model: testCase.sourceModel,
        adapter_evidence_class: testCase.evidenceClass,
      },
      syncState: {
        stablecoin_id: testCase.stablecoinId,
        adapter_key: testCase.adapterKey,
        breaker_key: testCase.breakerKey ?? `live-reserves:${testCase.adapterKey}`,
      },
    });

    const result = await resolveReserveResult(db, testCase.stablecoinId, 1_200);

    expect(result).toMatchObject({
      mode: "live",
      displayBadge: testCase.badge,
      provenance: {
        evidenceClass: testCase.evidenceClass,
        sourceModel: testCase.sourceModel,
        freshnessMode: testCase.freshnessMode,
      },
    });
  });

  it("treats inconsistent live snapshots as missing in the reserve overview", async () => {
    const emptyOverview = await computeReserveCompositionOverview(mockD1(), 2_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow()],
      },
      {
        match: "reserve_composition",
        rows: [{
          ...reserveCompositionRow({ fetched_at: 999 }),
        }],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, 2_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"));

    // Inconsistent snapshot (sync.last_success_at !== composition.fetched_at) is treated as missing.
    // The coin was already counted as missing in the empty overview, so counts don't change.
    // Before the double-count fix, this coin was counted in BOTH missing AND degraded.
    expect(overview.missingCoins).toBe(emptyOverview.missingCoins);
    expect(overview.freshCoins).toBe(0);
    expect(overview.degradedCoins).toBe(emptyOverview.degradedCoins);
  });

  it("rejects attempt-stamped snapshots when sync state points to a different successful attempt", async () => {
    const db = makeReservesDb({
      composition: {
        attempt_id: "attempt-a",
      },
      syncState: {
        last_attempt_id: "attempt-b",
        pending_attempt_id: null,
        last_success_attempt_id: "attempt-b",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.liveAt).toBeUndefined();
  });

  it.each([
    ["malformed slices", [
      { name: "Valid Farm", pct: 60, risk: "low" },
      { name: "Missing Risk", pct: 20 },
      { pct: 10, risk: "medium" },
      { name: "Bad Pct", pct: "fifty", risk: "low" },
      { name: "Valid Too", pct: 10, risk: "high" },
    ]],
    ["invalid risk", [{ name: "Good", pct: 60, risk: "low" }, { name: "Bad", pct: 40, risk: "bogus" }]],
    ["negative percentage", [
      { name: "Valid", pct: 80, risk: "medium" },
      { name: "Negative", pct: -10, risk: "low" },
      { name: "Zero", pct: 0, risk: "high" },
    ]],
  ])("fails closed on stored %s", async (_name, slices) => {
    const now = 1_800_000_000;
    const db = makeReservesDb({
      composition: { slices: JSON.stringify(slices), fetched_at: now },
      syncState: { last_attempted_at: now, last_success_at: now },
    });
    const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync?.status).toBe("degraded");
    expect(result?.sync?.lastError).toContain("Stored live reserve snapshot rejected");
  });

  it("treats an unknown stored adapter key as corrupt data instead of crashing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeReservesDb({
      composition: {
        fetched_at: now,
        source: "removed-adapter-key",
        attempt_id: "attempt-1",
        metadata: "{}",
        warning_count: 0,
      },
      syncState: {
        adapter_key: "removed-adapter-key",
        breaker_key: "live-reserves:removed-adapter-key",
        last_attempted_at: now,
        last_success_at: now,
        last_attempt_id: "attempt-1",
        pending_attempt_id: null,
        last_success_attempt_id: "attempt-1",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync?.status).toBe("degraded");
    expect(result?.sync?.lastError).toContain("Stored live reserve snapshot rejected");
  });

  it("separates error coins from degraded coins in the overview", async () => {
    const now = 2_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow({ last_attempted_at: now, last_success_at: now, last_status: "error", last_error: "HTTP 503" })],
      },
      {
        match: "reserve_composition",
        rows: [reserveCompositionRow({ fetched_at: now })],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now + 100, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    const empty = await computeReserveCompositionOverview(mockD1(), now + 100, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    expect(overview.errorCoins).toBe(empty.errorCoins + 1);
    expect(overview.degradedCoins).toBe(empty.degradedCoins);
    expect(overview.freshCoins + overview.staleCoins + overview.missingCoins
      + overview.degradedCoins + overview.errorCoins + overview.corruptCoins).toBe(overview.configuredCoins);
  });

  it("prioritizes active sync errors over stale classification in the overview", async () => {
    const now = 10_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [reserveSyncRow({ last_attempted_at: now, last_success_at: 1_000, last_status: "error", last_error: "HTTP 503" })],
      },
      {
        match: "reserve_composition",
        rows: [reserveCompositionRow()],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    expect(overview.errorCoins).toBeGreaterThanOrEqual(1);
    expect(overview.staleCoins).toBe(0);
  });

  it("includes lastError in sync view when sync state has an error", async () => {
    const db = makeReservesDb({
      composition: null,
      syncState: {
        last_success_at: null,
        last_status: "error",
        last_error: "HTTP 503 for https://api.example.com",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.reserves).not.toEqual(LIVE_SLICES);
    expect(result?.sync?.lastError).toBe("HTTP 503 for https://api.example.com");
  });

  it.each([
    {
      redemption: { capacityUsd: 100, capacityRatioOfSupply: 1.1, feeBps: -1 },
    },
    {
      immediateRedeemableUsd: 100, immediateRedeemableRatio: -0.1, redemptionFeeBps: 10_001,
    },
  ])("quarantines the entire stored redemption claim when its ratio or fee is invalid: %j", (raw) => {
    const metadata = parseSnapshotMetadata(JSON.stringify(raw));
    expect(decodeLiveReserveRedemptionTelemetry(metadata).status).toBe("invalid");
    expect(metadata.redemption).not.toHaveProperty("capacityUsd");
    expect(metadata.redemption).not.toHaveProperty("capacityRatioOfSupply");
    expect(metadata.redemption).not.toHaveProperty("feeBps");
    const serialized = JSON.parse(JSON.stringify(metadata));
    expect(serialized.redemption).not.toHaveProperty("capacityUsd");
  });


  it("quarantines legacy snapshots whose selected warning payload is malformed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeReservesDb({
      composition: {
        fetched_at: now,
      },
      syncState: {
        last_attempted_at: now,
        last_success_at: now,
        warning_count: 1,
        warnings: "{bad json",
        metadata: "{bad json",
      },
    });

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 60);

    expect(result).toMatchObject({
      mode: "curated-fallback",
      sync: {
        status: "degraded",
        bootstrap: false,
        stale: false,
      },
    });
    expect(result?.sync?.warnings).toHaveLength(1);
  });

  it("judges scoring on the snapshot's own warnings, not the latest attempt's status", async () => {
    const now = 10_000;
    const degradedThenErrored = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          // Latest attempt failed; the stored snapshot came from an earlier degraded run.
          reserveSyncRow({ last_attempted_at: now, last_success_at: now - 100, last_status: "error", last_error: "HTTP 502" }),
          reserveSyncRow({
            stablecoin_id: "lusd-liquity",
            adapter_key: "liquity-v1",
            breaker_key: "live-reserves:lusd-liquity",
            last_attempted_at: now,
            last_success_at: now - 100,
            last_status: "error",
            last_error: "HTTP 502",
          }),
        ],
      },
      {
        match: "reserve_composition",
        rows: [
          reserveCompositionRow({
            slices: JSON.stringify([{ name: "Known Farm", pct: 100, risk: "low" }]),
            fetched_at: now - 100,
            warnings: JSON.stringify([{ code: "stale-source-data", message: "old", severity: "warning", effect: "degraded" }]),
            metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: now - 100 }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          }),
          reserveCompositionRow({
            stablecoin_id: "lusd-liquity",
            slices: JSON.stringify([{ name: "ETH", pct: 100, risk: "very-low" }]),
            fetched_at: now - 100,
            source: "liquity-v1",
            metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
            adapter_source_model: "single-bucket",
            adapter_evidence_class: "independent",
          }),
        ],
      },
    ]);

    const scoringMap = await loadFreshIndependentLiveReserveMap(degradedThenErrored, now);
    expect(scoringMap.has("iusd-infinifi")).toBe(false);
    expect(scoringMap.has("lusd-liquity")).toBe(true);
  });

  it("keeps static-validated, weak-probe, and unverified active configs out of score-grade reserve maps", async () => {
    const now = 10_000;
    const configuredCoins = getConfiguredLiveReserveCoins();
    const coinsWithDefinitions = configuredCoins.map((coin) => {
      const definition = getLiveReserveAdapterDefinition(coin.liveReservesConfig?.adapter ?? "");
      expect(definition, `${coin.id} has a registered live reserve adapter`).not.toBeNull();
      return { coin, definition: definition! };
    });
    const nonScoringEvidenceCoins = coinsWithDefinitions.filter(
      ({ definition }) => definition.evidenceClass === "static-validated"
        || definition.evidenceClass === "weak-live-probe",
    );
    const independentCoins = coinsWithDefinitions.filter(
      ({ definition }) => definition.evidenceClass === "independent",
    );
    const independentVerified = independentCoins[0];
    const independentLatestState = independentCoins.find(
      ({ coin }) => coin.id !== independentVerified?.coin.id,
    );
    const independentUnverified = independentCoins.find(
      ({ coin }) =>
        coin.id !== independentVerified?.coin.id &&
        coin.id !== independentLatestState?.coin.id,
    );

    expect(
      nonScoringEvidenceCoins.some(({ definition }) => definition.evidenceClass === "static-validated"),
      "expected at least one active static-validated config",
    ).toBe(true);
    expect(
      nonScoringEvidenceCoins.some(({ definition }) => definition.evidenceClass === "weak-live-probe"),
      "expected at least one active weak-live-probe config",
    ).toBe(true);
    expect(independentVerified, "expected an active independent config for the verified control").toBeDefined();
    expect(independentLatestState, "expected a second active independent config for the latest-state control").toBeDefined();
    expect(independentUnverified, "expected a third active independent config for the unverified control").toBeDefined();

    const scoringRows = [
      {
        stablecoin_id: independentVerified!.coin.id,
        slices: JSON.stringify([{ name: "Verified independent reserves", pct: 100, risk: "low" }]),
        fetched_at: now,
        source: independentVerified!.coin.liveReservesConfig!.adapter,
        metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: now }),
        adapter_source_model: independentVerified!.definition.sourceModel,
        adapter_evidence_class: independentVerified!.definition.evidenceClass,
      },
      {
        stablecoin_id: independentLatestState!.coin.id,
        slices: JSON.stringify([{ name: "Latest-state reserves", pct: 100, risk: "medium" }]),
        fetched_at: now,
        source: independentLatestState!.coin.liveReservesConfig!.adapter,
        metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
        adapter_source_model: independentLatestState!.definition.sourceModel,
        adapter_evidence_class: independentLatestState!.definition.evidenceClass,
      },
    ];
    const nonScoringRows = [
      ...nonScoringEvidenceCoins.map(({ coin, definition }) => ({
        stablecoin_id: coin.id,
        slices: JSON.stringify([{ name: `${definition.evidenceClass} reserves`, pct: 100, risk: "low" }]),
        fetched_at: now,
        source: coin.liveReservesConfig!.adapter,
        metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: now }),
        adapter_source_model: definition.sourceModel,
        adapter_evidence_class: definition.evidenceClass,
      })),
      {
        stablecoin_id: independentUnverified!.coin.id,
        slices: JSON.stringify([{ name: "Legacy exception reserves", pct: 100, risk: "medium" }]),
        fetched_at: now,
        source: independentUnverified!.coin.liveReservesConfig!.adapter,
        metadata: JSON.stringify({
          freshnessMode: "unverified",
          sourceTimestamp: now,
          scoringAllowsUnverifiedFreshness: true,
        }),
        adapter_source_model: independentUnverified!.definition.sourceModel,
        adapter_evidence_class: independentUnverified!.definition.evidenceClass,
      },
    ];
    const allRows = [...scoringRows, ...nonScoringRows].map((row) => ({
      ...row, config_fingerprint: computeLiveReserveConfigFingerprint(WORKER_TRACKED_META_BY_ID.get(row.stablecoin_id)!.liveReservesConfig!),
    }));
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: allRows.map((row) => ({
          stablecoin_id: row.stablecoin_id,
          adapter_key: row.source,
          breaker_key: `live-reserves:${row.source}`,
          last_attempted_at: now,
          last_success_at: now,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        })),
      },
      {
        match: "reserve_composition",
        rows: allRows,
      },
    ]);

    const scoringMap = await loadFreshIndependentLiveReserveMap(db, now + 100);

    expect(scoringMap.get(independentVerified!.coin.id)).toEqual([
      { name: "Verified independent reserves", pct: 100, risk: "low" },
    ]);
    expect(scoringMap.get(independentLatestState!.coin.id)).toEqual([
      { name: "Latest-state reserves", pct: 100, risk: "medium" },
    ]);
    expect(scoringMap.has(independentUnverified!.coin.id)).toBe(false);
    for (const { coin, definition } of nonScoringEvidenceCoins) {
      expect(
        scoringMap.has(coin.id),
        `${coin.id} (${coin.liveReservesConfig!.adapter}/${definition.evidenceClass}) must not be score-grade`,
      ).toBe(false);
    }
  });

  it("rolls up fresh evidence quality and uncertain write states separately", async () => {
    const now = 10_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          reserveSyncRow({ stablecoin_id: "frax-frax", adapter_key: "frax", breaker_key: "live-reserves:frax", last_attempted_at: now, last_success_at: now }),
          reserveSyncRow({ last_attempted_at: now, last_success_at: now }),
          reserveSyncRow({ stablecoin_id: "gho-aave", adapter_key: "gho", breaker_key: "live-reserves:gho", last_attempted_at: now, last_success_at: now }),
          reserveSyncRow({ stablecoin_id: "pyusd-paypal", adapter_key: "single-asset", breaker_key: "live-reserves:single-asset", last_attempted_at: now, last_success_at: now }),
          reserveSyncRow({
            stablecoin_id: "crvusd-curve",
            adapter_key: "crvusd",
            breaker_key: "live-reserves:crvusd",
            last_attempted_at: now,
            last_success_at: null,
            last_status: "error",
            last_error: "D1 write timeout for crvusd-curve",
            metadata: JSON.stringify({ uncertainWrite: true, reason: "storage-write-timeout" }),
          }),
        ],
      },
      {
        match: "reserve_composition",
        rows: [
          reserveCompositionRow({
            stablecoin_id: "frax-frax",
            slices: JSON.stringify([{ name: "Reviewed baseline", pct: 100, risk: "very-low" }]),
            fetched_at: now,
            source: "frax",
            metadata: JSON.stringify({ freshnessMode: "unverified" }),
            adapter_source_model: "validated-static",
            adapter_evidence_class: "static-validated",
          }),
          reserveCompositionRow({
            slices: JSON.stringify([{ name: "Known Farm", pct: 100, risk: "low" }]),
            fetched_at: now,
            metadata: JSON.stringify({ freshnessMode: "unverified" }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          }),
          reserveCompositionRow({
            stablecoin_id: "gho-aave",
            slices: JSON.stringify([{ name: "Tracked GSM", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "gho",
            metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          }),
          reserveCompositionRow({
            stablecoin_id: "pyusd-paypal",
            slices: JSON.stringify([{ name: "Issuer reserves", pct: 100, risk: "very-low" }]),
            fetched_at: now,
            source: "single-asset",
            metadata: JSON.stringify({}),
            adapter_source_model: "single-bucket",
            adapter_evidence_class: "weak-live-probe",
          }),
        ],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now + 100, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    expect(overview.freshCoins).toBeGreaterThanOrEqual(4);
    expect(overview.independentFreshEligible).toBe(1);
    expect(overview.independentFreshUnverified).toBe(1);
    expect(overview.staticValidatedFresh).toBe(1);
    expect(overview.weakProbeFresh).toBe(1);
    expect(overview.writeTimeoutUncertain).toBe(1);
  });

  it("counts an uncertainWrite coin with no composition in a single primary bucket", async () => {
    const now = 10_000;
    const emptyOverview = await computeReserveCompositionOverview(mockD1(), now, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          {
            stablecoin_id: "crvusd-curve",
            adapter_key: "crvusd",
            breaker_key: "live-reserves:crvusd",
            last_attempted_at: now,
            last_success_at: null,
            last_status: "error",
            warning_count: 0,
            warnings: null,
            last_error: "D1 write timeout",
            metadata: JSON.stringify({ uncertainWrite: true, reason: "storage-write-timeout" }),
          },
        ],
      },
      {
        match: "reserve_composition",
        rows: [],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now, resolveScheduledSlotPolicy("fourHourlyReserveSync"));

    // Primary bucket increments by exactly 1 (errorCoins, because lastStatus=error + no composition).
    expect(overview.errorCoins).toBe(emptyOverview.errorCoins + 1);
    expect(overview.missingCoins).toBe(emptyOverview.missingCoins - 1);
    expect(overview.writeTimeoutUncertain).toBe(1);

    // Sum of primary buckets equals configured coins (no cross-counting).
    const primarySum = overview.freshCoins
      + overview.staleCoins
      + overview.missingCoins
      + overview.degradedCoins
      + overview.errorCoins
      + overview.corruptCoins;
    expect(primarySum).toBe(overview.configuredCoins);
  });

  it("requires the checkpoint's exact running producer slot before labeling its frontier in-progress", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await beginLiveReserveCheckpoint(db, { slotStartedAt: 9_600, invocationId: "producer", nowSec: 9_905 });
      sqlite.prepare(`UPDATE worker_scheduled_checkpoints
        SET next_item_key = 'coin-tail', items_done = 3, items_total = 12`).run();
      sqlite.prepare(`INSERT INTO cron_slot_executions
        (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
        VALUES ('fourHourlyReserveSync', 9500, 'running', 'older-producer', 1, 9500, 9905)`).run();
      expect(await computeReserveCompositionOverview(db, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
        inProgressCoins: 0, deferredCoins: 9, runBudgetTruncated: true,
      });
      sqlite.prepare(`INSERT INTO cron_slot_executions
        (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
        VALUES ('fourHourlyReserveSync', 9600, 'running', 'exact-producer', 1, 9600, 9905)`).run();
      expect(await computeReserveCompositionOverview(db, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
        inProgressCoins: 9, deferredCoins: 0, runBudgetTruncated: false,
      });
      sqlite.prepare(`UPDATE cron_slot_executions SET state = 'finished', finished_at = 9950
        WHERE slot_key = 'fourHourlyReserveSync' AND slot_started_at = 9600`).run();
      expect(await computeReserveCompositionOverview(db, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
        inProgressCoins: 0, deferredCoins: 9, runBudgetTruncated: true,
      });
    } finally {
      sqlite.close();
    }
  });

  it("persists full-cohort clocks including the consumer tail and computes p95 once per source slot", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      for (const slotStartedAt of [1000, 2000, 9600]) {
        await beginLiveReserveCheckpoint(db, { slotStartedAt, invocationId: `producer-${slotStartedAt}`, nowSec: slotStartedAt });
      }
      sqlite.prepare(`UPDATE worker_scheduled_checkpoints
        SET state = 'completed', next_item_key = NULL, items_done = items_total,
            completed_at = slot_started_at + CASE WHEN slot_started_at = 1000 THEN 1800 ELSE 1801 END
        WHERE slot_started_at < 9600`).run();
      sqlite.prepare(`UPDATE worker_scheduled_checkpoints
        SET state = 'ready', next_item_key = NULL, items_done = items_total,
            child_dispositions_json = json_set(child_dispositions_json, '$."sync-live-reserves"', 'completed')
        WHERE slot_started_at = 9600`).run();
      expect(await computeReserveCompositionOverview(db, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
        cohort: { slotStartedAt: 9600, completedAt: null, ageSec: 400,
          continuationPending: true, completedCohorts: 2, completionP95Sec: 1801, recentCompletionMaxSec: 1801 },
      });
      sqlite.prepare(`UPDATE worker_scheduled_checkpoints
        SET state = 'completed', completed_at = 10100 WHERE slot_started_at = 9600`).run();
      expect(await computeReserveCompositionOverview(db, 10_200, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
        cohort: { slotStartedAt: 9600, completedAt: 10100, ageSec: 500,
          continuationPending: false, completedCohorts: 3, completionP95Sec: 1801, recentCompletionMaxSec: 1801 },
      });
    } finally {
      sqlite.close();
    }
  });

  it("retains historical cohort breaches after a fast latest completion without counting replay attempts", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const now = 1_800_000_000;
    const latestSlot = now - 1_000;
    try {
      // Forty-one four-hour roots: the 95th percentile is the third slowest.
      for (let index = 0; index < 41; index++) {
        const slotStartedAt = latestSlot - (40 - index) * 14_400;
        const duration = [29_923, 15_829, 3_691][index] ?? 664;
        await beginLiveReserveCheckpoint(db, { slotStartedAt, invocationId: `producer-${index}`, nowSec: slotStartedAt });
        sqlite.prepare(`UPDATE worker_scheduled_checkpoints
          SET state = 'completed', next_item_key = NULL, items_done = items_total,
              completed_at = ? WHERE slot_started_at = ?`).run(slotStartedAt + duration, slotStartedAt);
      }
      // A second exhausted attempt of the slowest root must not add a sample.
      sqlite.prepare(`INSERT INTO worker_scheduled_checkpoints
        (schedule_key, slot_started_at, job, attempt_no, invocation_id, queue_hash, state,
         next_item_key, items_done, items_total, created_at, updated_at, completed_at)
        SELECT schedule_key, slot_started_at, job, 2, 'replay', queue_hash, state,
               next_item_key, items_done, items_total, created_at, updated_at, completed_at + 60
        FROM worker_scheduled_checkpoints ORDER BY slot_started_at LIMIT 1`).run();
      expect(await computeReserveCompositionOverview(db, now, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
        cohort: { slotStartedAt: latestSlot, completedAt: latestSlot + 664, ageSec: 664,
          continuationPending: false, completedCohorts: 41, completionP95Sec: 3_691, recentCompletionMaxSec: 664 },
      });
    } finally {
      sqlite.close();
    }
  });

  it("ages completed cohort evidence out by its original root slot, not its later completion clock", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const now = 1_800_000_000;
    const oldSlot = now - STATUS_RESERVE_COHORT_SLO.windowSec;
    const latestSlot = now - 1_000;
    try {
      for (const slotStartedAt of [oldSlot, latestSlot]) {
        await beginLiveReserveCheckpoint(db, { slotStartedAt, invocationId: `producer-${slotStartedAt}`, nowSec: slotStartedAt });
        sqlite.prepare(`UPDATE worker_scheduled_checkpoints
          SET state = 'completed', next_item_key = NULL, items_done = items_total,
              completed_at = ? WHERE slot_started_at = ?`)
          .run(slotStartedAt + (slotStartedAt === oldSlot ? 1_801 : 100), slotStartedAt);
      }
      expect(await computeReserveCompositionOverview(db, now, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
        cohort: { completedCohorts: 2, completionP95Sec: 1_801 },
      });
      expect(await computeReserveCompositionOverview(db, now + 1, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
        cohort: { completedCohorts: 1, completionP95Sec: 100 },
      });
      expect(await computeReserveCompositionOverview(
        db, latestSlot + STATUS_RESERVE_COHORT_SLO.windowSec + 1, resolveScheduledSlotPolicy("fourHourlyReserveSync"),
      )).toMatchObject({
        cohort: { completedCohorts: 0, completionP95Sec: null, recentCompletionMaxSec: null },
      });
    } finally {
      sqlite.close();
    }
  });

  it("uses completion clocks for the recovery window, including long-running older roots", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const now = 1_800_000_000;
    const oldSlot = now - STATUS_RESERVE_COHORT_SLO.windowSec - 100;
    const oldCompletedAt = now - STATUS_RESERVE_COHORT_SLO.recoveryWindowSec;
    try {
      for (const [slotStartedAt, completedAt] of [[oldSlot, oldCompletedAt], [now - 1000, now - 800]]) {
        await beginLiveReserveCheckpoint(db, { slotStartedAt, invocationId: `producer-${slotStartedAt}`, nowSec: slotStartedAt });
        sqlite.prepare(`UPDATE worker_scheduled_checkpoints
          SET state = 'completed', next_item_key = NULL, items_done = items_total,
              completed_at = ? WHERE slot_started_at = ?`).run(completedAt, slotStartedAt);
      }
      expect(await computeReserveCompositionOverview(db, now, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
        cohort: { completedCohorts: 1, completionP95Sec: 200, recentCompletionMaxSec: oldCompletedAt - oldSlot },
      });
      expect(await computeReserveCompositionOverview(db, now + 1, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
        cohort: { completedCohorts: 1, completionP95Sec: 200, recentCompletionMaxSec: 200 },
      });
    } finally {
      sqlite.close();
    }
  });

  it("keeps intentional ready and actively recovering suffixes out of budget truncation", async () => {
    const db = mockD1([{ match: "FROM worker_scheduled_checkpoints", rows: [], first: pendingCheckpoint({
      state: "ready", producer_disposition: "continuation_pending", producer_state: "finished", producer_finished_at: 9900,
    }) }]);
    expect(await computeReserveCompositionOverview(db, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
      inProgressCoins: 0, deferredCoins: 0, runBudgetTruncated: false,
      cohort: { continuationPending: true, ageSec: 400 },
    });
    const recovering = mockD1([{ match: "FROM worker_scheduled_checkpoints", rows: [], first: pendingCheckpoint({
      state: "recovering", producer_disposition: "running", recovery_lease_until: 10500,
      producer_state: "finished", producer_finished_at: 9900, slot_started_at: 8000,
    }) }]);
    expect(await computeReserveCompositionOverview(recovering, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
      inProgressCoins: 9, deferredCoins: 0, runBudgetTruncated: false,
      cohort: { continuationPending: true, ageSec: 2000 },
    });
  });

  it("reports a fresh exact-slot running checkpoint as in-progress without inventing deferred coins", async () => {
    const db = mockD1([{ match: "FROM worker_scheduled_checkpoints", rows: [], first: pendingCheckpoint() }]);
    const overview = await computeReserveCompositionOverview(db, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    expect(overview).toMatchObject({
      inProgressCoins: 9, deferredCoins: 0, runBudgetTruncated: false, deferredAt: null,
      nextCursorStablecoinId: "coin-tail", cursorRecordedAt: 9_905,
    });
  });

  it.each([
    [-1, 1, 0],
    [0, 1, 9],
    [0, 0, 0],
  ] as const)("uses injected heartbeat/slot bounds at their exact boundaries (%s/%s)", async (heartbeatDelta, slotDelta, inProgressCoins) => {
    const now = 10_000;
    const checkpoint = pendingCheckpoint();
    const db = mockD1([{ match: "FROM worker_scheduled_checkpoints", rows: [], first: checkpoint }]);
    const overview = await computeReserveCompositionOverview(db, now, {
      slotSilenceSec: now - checkpoint.updated_at + heartbeatDelta,
      hardDeadSec: now - checkpoint.slot_started_at + slotDelta,
    });
    expect(overview).toMatchObject({
      inProgressCoins, deferredCoins: inProgressCoins > 0 ? 0 : 9, runBudgetTruncated: inProgressCoins === 0,
    });
  });

  it("retains actual per-coin budget deferrals while a producer is in progress", async () => {
    const states = getConfiguredLiveReserveCoins().slice(0, 2).map((coin) => reserveSyncRow({
      stablecoin_id: coin.id, last_status: "skipped",
      metadata: JSON.stringify({ failureCategory: "run-budget-exhausted" }),
    }));
    const db = mockD1([
      { match: "FROM worker_scheduled_checkpoints", rows: [], first: pendingCheckpoint() },
      { match: "FROM reserve_sync_state", rows: states },
    ]);
    expect(await computeReserveCompositionOverview(db, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
      deferredCoins: 2, inProgressCoins: 9, runBudgetTruncated: true, deferredAt: 9_905,
    });
  });

  const reservePolicy = resolveScheduledSlotPolicy("fourHourlyReserveSync");
  it.each([
    ["recovering", { state: "recovering" }],
    ["ready", { state: "ready" }],
    ["stale heartbeat", { updated_at: 10_000 - reservePolicy.slotSilenceSec - 1 }],
    ["missing producer", { producer_state: null }],
    ["reconciling producer", { producer_state: "reconciling" }],
    ["finished producer", { producer_state: "finished", producer_finished_at: 9_950 }],
    ["running producer with terminal clock", { producer_finished_at: 9_950 }],
    ["future heartbeat", { updated_at: 10_001 }],
    ["missing heartbeat", { updated_at: undefined }],
    ["nonfinite heartbeat", { updated_at: Number.NaN }],
    ["future slot", { slot_started_at: 10_001 }],
    ["invalid slot", { slot_started_at: 0 }],
    ["hard-dead boundary", { slot_started_at: 10_000 - reservePolicy.hardDeadSec, updated_at: 10_000 }],
    ["old slot with fresh heartbeat", { slot_started_at: 9_000 - reservePolicy.hardDeadSec, updated_at: 10_000 }],
  ] as const)("keeps non-live pending checkpoint tails deferred: %s", async (_label, overrides) => {
    const checkpoint = pendingCheckpoint(overrides);
    const db = mockD1([{ match: "FROM worker_scheduled_checkpoints", rows: [], first: checkpoint }]);
    expect(await computeReserveCompositionOverview(db, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
      inProgressCoins: 0, deferredCoins: 9, runBudgetTruncated: true,
      nextCursorStablecoinId: "coin-tail", cursorRecordedAt: checkpoint.updated_at,
    });
  });

  it.each([0, 1])("bounds checkpoint heartbeat silence at the exact policy boundary plus %s", async (extraSec) => {
    const checkpoint = pendingCheckpoint({ updated_at: 10_000 - reservePolicy.slotSilenceSec - extraSec });
    const db = mockD1([{ match: "FROM worker_scheduled_checkpoints", rows: [], first: checkpoint }]);
    expect(await computeReserveCompositionOverview(db, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
      inProgressCoins: extraSec === 0 ? 9 : 0,
      deferredCoins: extraSec === 0 ? 0 : 9,
      runBudgetTruncated: extraSec !== 0,
    });
  });

  it("distinguishes absent checkpoint from checkpoint read failure", async () => {
    expect(await computeReserveCompositionOverview(mockD1(), 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).toMatchObject({
      inProgressCoins: 0, deferredCoins: 0, runBudgetTruncated: false,
    });
    const db = mockD1([{
      match: "FROM worker_scheduled_checkpoints", rows: [], throwError: new Error("checkpoint-read-failed"),
    }]);
    await expect(computeReserveCompositionOverview(db, 10_000, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).rejects.toThrow("checkpoint-read-failed");
  });

  it("ignores stale pending pointers when the latest checkpoint is terminal", async () => {
    const db = mockD1([
      {
        match: "FROM worker_scheduled_checkpoints",
        rows: [],
        first: {
          state: "completed",
          next_item_key: null,
          items_done: 267,
          items_total: 267,
          updated_at: 10_000,
        },
      },
      {
        match: "FROM reserve_sync_state",
        rows: [reserveSyncRow({
          last_status: "skipped", metadata: JSON.stringify({ failureCategory: "run-budget-exhausted" }),
        })],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, 10_100, resolveScheduledSlotPolicy("fourHourlyReserveSync"));

    expect(overview.runBudgetTruncated).toBe(false);
    expect(overview.inProgressCoins).toBe(0);
    expect(overview.deferredCoins).toBe(1);
    expect(overview.deferredAt).toBeNull();
    expect(overview.nextCursorStablecoinId).toBeNull();
    expect(overview.cursorRecordedAt).toBeNull();
  });


  it("counts malformed stored slices as corruptCoins, not freshCoins", async () => {
    const now = Math.floor(Date.now() / 1000);
    const emptyOverview = await computeReserveCompositionOverview(mockD1(), now, resolveScheduledSlotPolicy("fourHourlyReserveSync"));

    // Stored slices array has invalid entries (missing risk, bad pct type) that
    // will fail the LiveReserveSnapshotSchema parse in parseReserveCompositionRow.
    const corruptSlices = [
      { name: "Missing Risk", pct: 20 },
      { name: "Bad Pct", pct: "fifty", risk: "low" },
    ];
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [
          {
            stablecoin_id: "iusd-infinifi",
            slices: JSON.stringify(corruptSlices),
            fetched_at: now,
            source: "infinifi",
            attempt_id: "attempt-1",
            metadata: "{}",
            warning_count: 0,
          },
        ],
      },
      {
        match: "reserve_sync_state",
        rows: [
          {
            stablecoin_id: "iusd-infinifi",
            adapter_key: "infinifi",
            breaker_key: "live-reserves:infinifi",
            last_attempted_at: now,
            last_success_at: now,
            last_status: "ok",
            warning_count: 0,
            warnings: null,
            last_error: null,
            metadata: "{}",
            last_attempt_id: "attempt-1",
            pending_attempt_id: null,
            last_success_attempt_id: "attempt-1",
          },
        ],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    expect(overview.corruptCoins).toBe(emptyOverview.corruptCoins + 1);
    // Corrupt snapshot must not be counted as fresh even though the sync state
    // reports lastStatus=ok and age=0.
    expect(overview.freshCoins).toBe(emptyOverview.freshCoins);
  });

  it.each([
    [15 * 86_400, "degraded", null, true],
    [15 * 86_400, "skipped", "circuit-open", true],
    [15 * 86_400, "skipped", "run-budget-exhausted", false],
    [13 * 86_400, "degraded", null, false],
    [20 * 86_400, "ok", null, false],
    [14 * 86_400, "degraded", null, false],
    [14 * 86_400 + 1, "degraded", null, true],
  ] as const)("classifies persistent staleness at age %i, %s, %s", async (age, status, failureCategory, expected) => {
    const now = 1_800_000_000;
    const db = mockD1([
      { match: "reserve_sync_state", rows: [reserveSyncRow({
        last_attempted_at: now, last_success_at: now - age, last_status: status,
        warning_count: status === "degraded" ? 1 : 0,
        last_error: failureCategory,
        metadata: JSON.stringify({ failureCategory }),
      })] },
      { match: "reserve_composition", rows: [] },
    ]);
    const overview = await computeReserveCompositionOverview(db, now, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
    const entries = overview.persistentlyStaleIndependentCoins.filter((entry) => entry.stablecoinId === "iusd-infinifi");
    expect(entries.map((entry) => ({ id: entry.stablecoinId, age: entry.ageSec })))
      .toEqual(expected ? [{ id: "iusd-infinifi", age }] : []);
  });
});
