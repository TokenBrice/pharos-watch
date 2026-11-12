import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { RESERVE_FEED_REVIEW_MAX_AGE_SEC, STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC } from "@shared/lib/status-thresholds";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  buildSupplyIntegrityConditions,
  confirmSupplyIntegrityConditions,
  loadSupplyIntegrityReport,
  SUPPLY_INTEGRITY_CONFIRM_KEY,
  REVIEWED_SUPPLY_CARRIES,
  type SupplyIntegrityReport,
} from "../supply-integrity";
import { assessSupplyIntegrityQuality } from "../status/supply-integrity-quality";
import { STABLECOIN_PRICE_GAP_REVIEWS } from "../stablecoin-publication-coverage";
import {
  buildSupplySnapshotCompletionMarker,
  buildSupplySnapshotCoverageExpectation,
} from "../supply-snapshot-completion";

const fixtures = createLatestSchemaFixtureTracker();
const NOW = 1_790_000_000;
const TODAY = startOfUtcDaySec(new Date(NOW * 1000));
const ACTIVE = [...ACTIVE_IDS].slice(0, 14);
const SUPPLY_SOURCE = "defillama";
const CHARTS_MAX_AGE_SEC = 2 * CRON_INTERVALS["sync-stablecoin-charts"];

afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface AssetInput {
  id: string;
  current: number | null;
  previous: number | null;
  supplyRestored?: boolean;
  unavailableReason?: string;
  supplyObservedAt?: number;
  currentSource?: string;
  previousSource?: string;
  previousGuard?: boolean;
  guard?: boolean;
}

function asset(input: AssetInput) {
  return {
    id: input.id,
    name: input.id,
    symbol: input.id.slice(0, 4).toUpperCase(),
    price: 1,
    supplySource: input.currentSource ?? SUPPLY_SOURCE,
    supplyObservedAt: input.supplyObservedAt ?? NOW - 3600,
    ...(input.supplyRestored ? { supplyRestored: true } : {}),
    ...(input.unavailableReason ? { supplyUnavailableReason: input.unavailableReason } : {}),
    ...(input.guard ? { supplyChainGuard: { reason: "supply-chain-dropout", status: "quarantined", chains: [] } } : {}),
    circulating: input.current == null ? {} : { peggedUSD: input.current },
  };
}

function historyRow(input: AssetInput) {
  return {
    stablecoin_id: input.id,
    snapshot_date: TODAY - 86_400,
    circulating_usd: input.previous ?? 0,
    supply_provenance: JSON.stringify({
      supplySource: input.previousSource ?? SUPPLY_SOURCE,
      supplyObservedAt: NOW - 90_000,
      supplyChainGuard: input.previousGuard
        ? { reason: "supply-chain-dropout", status: "chains-unavailable", chains: [] }
        : null,
    }),
  };
}

function supplyRun(unavailable: number, observed: number, startedAt = NOW - 900) {
  return {
    started_at: startedAt,
    status: "ok",
    metadata: JSON.stringify({
      priceSourceHealth: {
        active: { supplyCoverage: { complete: unavailable === 0, observedCount: observed, unavailableCount: unavailable } },
      },
      supplyChainGuard: { quarantinedAssetCount: 8, unavailableAssetCount: 0 },
    }),
  };
}

function marker(overrides: {
  snapshotDate?: number;
  expectedActiveCount?: number;
  accountedActiveCount?: number;
  ownedRowIds?: string[];
  unavailableActiveIds?: string[];
} = {}) {
  const ids = overrides.ownedRowIds ?? ACTIVE;
  return {
    ...buildSupplySnapshotCompletionMarker({
      snapshotDate: overrides.snapshotDate ?? TODAY,
      coverage: buildSupplySnapshotCoverageExpectation(ids, []),
      accountedActiveCount: overrides.accountedActiveCount ?? ids.length,
      ownedRowIds: ids,
      missingActiveIds: [],
      unavailableActiveIds: overrides.unavailableActiveIds ?? [],
    }),
    writtenRows: ids.length,
  };
}

function database(options: {
  assets: AssetInput[];
  marker?: Record<string, unknown> | null;
  persistedRows?: number;
  syncRuns?: ReturnType<typeof supplyRun>[];
  cacheThrows?: boolean;
  historyThrows?: boolean;
  confirmState?: unknown;
}) {
  const row = (key: string, value: unknown) => ({ key, value: JSON.stringify(value), updated_at: NOW - 60 });
  return mockD1([
    { match: "FROM cache WHERE key = ?", rows: [
      ...(options.cacheThrows ? [] : [row("stablecoins", { peggedAssets: options.assets.map(asset) })]),
      ...(options.marker === null ? [] : [row("snapshot-supply:last-write", options.marker ?? marker())]),
      ...(options.confirmState === undefined ? [] : [row(SUPPLY_INTEGRITY_CONFIRM_KEY, options.confirmState)]),
    ], ...(options.cacheThrows ? { throwError: new Error("D1_ERROR") } : {}) },
    { match: "supply-integrity-previous-rows", rows: options.assets.map(historyRow),
      ...(options.historyThrows ? { throwError: new Error("D1_ERROR") } : {}) },
    { match: "WHERE job = 'sync-stablecoins'", rows: options.syncRuns ?? [] },
    { match: "WHERE job = 'sync-stablecoin-charts'", rows: [] },
    { match: "SELECT COUNT(*) AS count FROM supply_history", rows: [], first: {
      count: options.persistedRows ?? (Array.isArray(options.marker?.ownedRowIds) ? options.marker.ownedRowIds.length : 0),
    } },
  ]);
}

function normalAssets(): AssetInput[] {
  return ACTIVE.map((id) => ({ id, current: 100, previous: 100 }));
}

function timedDatabase() {
  vi.useFakeTimers({ now: NOW * 1000 });
  return fixtures.open();
}

function loadReport(options: Parameters<typeof database>[0]) {
  return loadSupplyIntegrityReport(database(options), NOW);
}

function conditionOf(report: SupplyIntegrityReport, id: string) {
  return buildSupplyIntegrityConditions(report).find((condition) => condition.id === id);
}

function codes(report: SupplyIntegrityReport) {
  return assessSupplyIntegrityQuality(report).causes.map(c => c.code);
}

function integrityReport(count = 100): SupplyIntegrityReport {
  return {
    observedAt: NOW,
    value: {
      status: "ok", reason: null, checkedCount: count, excludedCount: 0,
      driftFindings: [], heldDriftFindings: [], heldDriftBaselines: {}, heldDriftUnknownReason: null,
      aggregateCurrentUsd: 100, aggregatePreviousUsd: 100, aggregateRatio: 1, frozen: false,
      carryIds: [], carryOldestAgeSec: 3 * 86_400, carryUnclockedCount: 0,
      acknowledgedCarryReviews: [], expiredCarryReviewIds: [], unacknowledgedCarryIds: [],
      unacknowledgedCarryOldestAgeSec: 3 * 86_400, unacknowledgedCarryUnclockedCount: 0,
      expectedActiveCount: count, cacheUpdatedAt: NOW - 60, historyFromDate: TODAY - 7 * 86_400,
    },
    availability: {
      status: "ok", reason: null, observedCount: count, unavailableCount: 0, share: 0,
      consecutiveGenerations: 0, latestRunStartedAt: NOW - 900,
      charts: { status: "ok", reason: null, runStartedAt: NOW - 600, codes: [], maxAgeSec: CHARTS_MAX_AGE_SEC },
    },
    snapshot: {
      status: "ok", reason: null, expectedDate: TODAY, snapshotDate: TODAY, due: false, current: true,
      identityVerified: true, expectedActiveCount: count, accountedActiveCount: count,
      writtenRows: count, persistedRows: count, unavailableActiveIds: [], band: null,
    },
  };
}

describe("supply integrity", () => {
  it.each(REVIEWED_SUPPLY_CARRIES)("acknowledges only in-use $stablecoinId carries and re-arms at expiry", async (review) => {
    const { stablecoinId, reviewedAt, expiresAt } = review;
    expect(ACTIVE_IDS.has(stablecoinId)).toBe(true);
    expect(review.evidence).toBeTruthy();
    expect(expiresAt - reviewedAt).toBeGreaterThan(0);
    expect(expiresAt - reviewedAt).toBeLessThanOrEqual(RESERVE_FEED_REVIEW_MAX_AGE_SEC);
    if (review.stablecoinId === "said-gaib") {
      expect(reviewedAt).toBe(Date.UTC(2026, 10, 11, 23, 19, 58) / 1000);
      expect(expiresAt).toBeLessThanOrEqual(STABLECOIN_PRICE_GAP_REVIEWS.find(r => r.stablecoinId === "aid-gaib")!.expiresAt);
    }
    const carried = [{ id: stablecoinId, current: 0, previous: 100, supplyRestored: true,
      guard: review.reason === "defillama-list-fill-default-carry", currentSource: review.reason === "coingecko-cap-carry"
        ? "coingecko-fallback" : review.reason === "nav-parent-price-gap" ? "onchain-total-supply" : "defillama" }];
    const read = (now: number, assets: AssetInput[] = carried) => loadSupplyIntegrityReport(database({ assets }), now);
    const active = await read(reviewedAt);
    expect(active.value.carryIds).toHaveLength(1);
    expect(active.value.acknowledgedCarryReviews).toHaveLength(1);
    expect(active.value.unacknowledgedCarryIds).toEqual([]);
    expect(codes(active)).toContain("supply_carry_reviews_acknowledged");
    expect(codes(active)).not.toContain("supply_carry_stale");
    expect(conditionOf(active, "carry")?.active).toBe(false);
    for (const age of [3600, 3 * 86400]) {
      const mixed = await read(reviewedAt, [...carried, { ...carried[0], id: ACTIVE[0], supplyObservedAt: reviewedAt - age }]);
      expect(mixed.value.unacknowledgedCarryIds).toEqual([ACTIVE[0]]);
      expect(codes(mixed).includes("supply_carry_stale")).toBe(age > 48 * 3600);
      expect(conditionOf(mixed, "carry")?.active).toBe(age > 48 * 3600);
    }
    for (const offset of [STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC + 1, STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC, 1, 0]) {
      const report = await read(expiresAt - offset);
      expect(codes(report).includes("supply_carry_reviews_expiring")).toBe(offset > 0 && offset <= STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC);
      expect(codes(report).includes("supply_carry_reviews_expired")).toBe(offset === 0);
      expect(codes(report).includes("supply_carry_stale")).toBe(offset === 0);
    }
    for (const now of [reviewedAt - 1, expiresAt]) {
      expect((await read(now)).value.acknowledgedCarryReviews).toEqual([]);
    }
    for (const assets of [carried.map(a => ({ ...a, current: null })), carried.map(a => ({ ...a, supplyRestored: false })),
      carried.map(a => ({ ...a, guard: !a.guard, currentSource: a.guard ? "onchain-total-supply" : "defillama" })),
      carried.map(a => ({ ...a, guard: false, currentSource: a.currentSource === "coingecko-fallback"
        ? "onchain-total-supply" : "other" }))]) {
      for (const now of [expiresAt - 1, expiresAt]) {
        const report = await read(now, assets);
        expect(report.value.acknowledgedCarryReviews).toEqual([]);
        expect(codes(report).some(code => code.startsWith("supply_carry_reviews_"))).toBe(false);
      }
    }
  });
  it("reads bounded chart publication evidence behind completed buckets without hiding failures", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(
      "INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('sync-stablecoin-charts', ?, 0, ?, ?)",
    );
    const run = (metadata: unknown, age = 1800, status = "ok") => ({
      startedAt: NOW - age, status, metadata: typeof metadata === "string" ? metadata : JSON.stringify(metadata),
    });
    const published = run({ cacheWriteMode: "published", lastWriteAdvanced: true }, 3600);
    const skip = run({ reason: "cadence_bucket_completed" });
    const truncated = run({ quality: { reason: "chart-history-truncated", codes: ["point-count-drop"] } });
    const noEvidence = "no-publication-evidence";
    const stale = "publication-stale";
    const cases: [ReturnType<typeof run>[], string, string | null, number?, string[]?][] = [
      [[published, skip], "ok", null, published.startedAt],
      [[run({ cacheWriteMode: "skipped-newer", lastWriteAdvanced: true }, 3600), skip], "ok", null],
      [[run({ lastWriteAdvanced: true }, CHARTS_MAX_AGE_SEC), skip], "ok", null],
      [[run({ lastWriteAdvanced: true }, CHARTS_MAX_AGE_SEC + 1), skip], "unknown", stale],
      [[run({ lastWriteAdvanced: true }, CHARTS_MAX_AGE_SEC + 1)], "unknown", stale],
      [[run({ lastWriteAdvanced: true }, -1)], "unknown", stale],
      [[skip], "unknown", noEvidence],
      [[run({ reason: "cadence_bucket_completed", cacheWriteMode: "published", lastWriteAdvanced: true })], "unknown", noEvidence],
      [[published, truncated], "truncated", "chart-history-truncated", undefined, ["point-count-drop"]],
      [[published, truncated, run({ reason: "cadence_bucket_completed" }, 60)], "truncated", "chart-history-truncated"],
      [[published, run({}, 2400, "error"), skip], "unknown", "run-error"],
      [[published, run("unreadable", 2400), skip], "unknown", "metadata-unreadable"],
      [[published, run(null, 2400), skip], "unknown", "metadata-unavailable"],
      [[published, run({ cacheWriteMode: "skipped-newer", lastWriteAdvanced: false }, 2400), skip], "unknown", noEvidence],
      [[published, run({ reason: "cadence_bucket_in_progress" })], "unknown", noEvidence],
      [[published, run({ reason: "cadence_bucket_completed" }, 900, "error")], "unknown", "run-error"],
      [[published, ...Array.from({ length: 8 }, (_, i) => run({ reason: "cadence_bucket_completed" }, i * 60))], "unknown", noEvidence],
    ];
    for (const [runs, status, reason, runStartedAt, codes] of cases) {
      sqlite.exec("DELETE FROM cron_runs");
      for (const row of runs) insert.run(row.startedAt, row.status, row.metadata);
      const report = await loadSupplyIntegrityReport(db, NOW);
      expect(report.availability.charts, JSON.stringify(runs)).toMatchObject({
        status,
        reason: reason == null || status === "truncated" ? reason : `sync-stablecoin-charts-${reason}`,
        maxAgeSec: CHARTS_MAX_AGE_SEC,
        ...(runStartedAt == null ? {} : { runStartedAt }),
        ...(codes == null ? {} : { codes }),
      });
    }
    const failed = await loadSupplyIntegrityReport(mockD1([
      { match: "WHERE job = 'sync-stablecoin-charts'", rows: [], throwError: new Error("D1_ERROR") },
    ]), NOW);
    expect(failed.availability.charts).toMatchObject({ status: "unknown", reason: "sync-stablecoin-charts-read-failed" });
  });

  it("flags per-asset generation drift and excludes provenance-named carry/repair rows", async () => {
    const assets = normalAssets();
    assets[0] = { ...assets[0], current: 40 };
    assets[1] = { ...assets[1], current: 250 };
    assets[2] = { ...assets[2], current: 30, supplyRestored: true };
    assets[3] = { ...assets[3], current: 20, previousGuard: true };
    assets[4] = { ...assets[4], current: 20, previousSource: "coingecko-gap-fill" };
    const report = await loadReport({ assets });

    expect(report.value).toMatchObject({
      status: "ok", checkedCount: 11, excludedCount: 3, carryIds: [assets[2].id], frozen: false,
      driftFindings: [{ stablecoinId: assets[0].id, ratio: 0.4 }, { stablecoinId: assets[1].id, ratio: 2.5 }],
    });
  });

  it("flags frozen totals only for a representative cohort", async () => {
    for (const [ids, frozen] of [[ACTIVE_IDS, true], [ACTIVE, false]] as const) {
      const r = await loadReport({ assets: [...ids].map(id => ({ id, current: 100, previous: 100 })) });
      expect(r.value.checkedCount).toBe([...ids].length);
      expect(r.value.frozen).toBe(frozen);
      expect(conditionOf(r, "value-drift")?.active).toBe(frozen);
    }
  });

  it("marks value drift unknown when no comparable daily history exists", async () => {
    const noHistory = await loadSupplyIntegrityReport(mockD1([
      { match: "FROM cache WHERE key = ?", rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: normalAssets().map(asset) }), updated_at: NOW - 60 }] },
      ...["supply-integrity-previous-rows", "WHERE job = 'sync-stablecoins'", "WHERE job = 'sync-stablecoin-charts'"]
        .map(match => ({ match, rows: [] })),
    ]), NOW);
    expect(noHistory.value.status).toBe("unknown");
    expect(noHistory.value.reason).toBe("insufficient-comparable-history");
  });

  it("requires two consecutive unavailable-supply breaches", async () => {
    for (const previous of [0, 2]) {
      const r = await loadReport({ assets: normalAssets(), syncRuns: [supplyRun(2, 98), supplyRun(previous, 100 - previous, NOW - 1800)] });
      expect(r.availability).toMatchObject({ status: "ok", unavailableCount: 2, observedCount: 98, consecutiveGenerations: previous ? 2 : 1 });
      expect(conditionOf(r, "availability")?.active).toBe(previous > 0);
    }
  });

  it("flags overdue, partial and lost snapshot rows", async () => {
    for (const [snapshot, persistedRows, condition, label] of [
      [marker({ snapshotDate: TODAY - 86_400 }), 14, "snapshot-overdue", "snapshot overdue"],
      [marker({ unavailableActiveIds: [ACTIVE[0]], ownedRowIds: ACTIVE.slice(0, 13) }), 13, "snapshot-partial", "unavailable supply"],
      [marker(), 10, "snapshot-partial", "persisted 10 of 14"],
    ] as const) {
      const r = await loadReport({ assets: normalAssets(), marker: snapshot, persistedRows });
      expect(conditionOf(r, condition)).toMatchObject({ active: true, label: expect.stringContaining(label) });
      expect(r.snapshot).toMatchObject({ current: condition !== "snapshot-overdue", persistedRows: condition === "snapshot-overdue" ? null : persistedRows });
    }
  });

  it("keeps carry evidence when only the daily-history read fails", async () => {
    const assets = normalAssets();
    assets[0] = { ...assets[0], current: 30, supplyRestored: true };
    assets[1] = { ...assets[1], current: null, supplyRestored: true };
    const report = await loadReport({ assets, historyThrows: true });
    expect(report.value).toMatchObject({ status: "unknown", reason: "supply-history-read-failed", carryIds: [assets[0].id] });
    expect(conditionOf(report, "carry")?.active).toBe(false);
  });

  it("keeps every dimension unknown when the source reads fail", async () => {
    const report = await loadReport({
      assets: normalAssets(),
      cacheThrows: true,
    });
    expect(report.value.status).toBe("unknown");
    expect(report.snapshot.status).toBe("unknown");
    for (const id of ["value-drift", "carry", "snapshot-overdue"] as const) {
      expect(conditionOf(report, id)?.unknown).toBe(true);
    }
  });

  it("confirms twice, resetting on signature change or recovery", async () => {
    const { db } = timedDatabase();
    const c = { id: "value-drift" as const, label: "drift", active: true, unknown: false, signature: "a" };
    for (const [active, signature, confirmed] of [
      [true, "a", false], [true, "a", true], [true, "b", false], [false, "a", false], [true, "a", false],
    ] as const) expect((await confirmSupplyIntegrityConditions(db, [{ ...c, active, signature }]))[0].active).toBe(confirmed);
  });

  it("grades value/snapshot findings into ops-only data-quality causes", () => {
    const base = integrityReport(12);
    Object.assign(base.value, {
      driftFindings: [{ stablecoinId: "usdt-tether", currentUsd: 40, previousUsd: 100, ratio: 0.4 }],
      aggregateCurrentUsd: 1_100, aggregatePreviousUsd: 1_200, aggregateRatio: 1.1, carryOldestAgeSec: null,
    });
    Object.assign(base.snapshot, { snapshotDate: TODAY - 86_400, due: true, current: false, persistedRows: null });
    const assessment = assessSupplyIntegrityQuality(base);
    expect(assessment.status).toBe("degraded");
    expect(codes(base)).toEqual(
      expect.arrayContaining(["supply_value_drift", "supply_snapshot_overdue"]),
    );
    expect(assessSupplyIntegrityQuality(null).causes[0].code).toBe("supply_integrity_unknown");
    Object.assign(base.snapshot, { due: false });
    base.value.expectedActiveCount = 400;
    expect(assessSupplyIntegrityQuality(base).status).toBe("healthy");
    expect(codes(base)).toContain("supply_value_drift");
  });

  it("keeps known carry evidence when the value comparison is unknown", () => {
    const base = integrityReport();
    Object.assign(base.value, {
      status: "unknown", reason: "supply-history-read-failed", checkedCount: 0,
      aggregateCurrentUsd: null, aggregatePreviousUsd: null, aggregateRatio: null,
      unacknowledgedCarryIds: ["coin-a", "coin-b", "coin-c", "coin-d", "coin-e", "coin-f"], unacknowledgedCarryOldestAgeSec: 5 * 86_400,
    });
    const assessment = assessSupplyIntegrityQuality(base);
    expect(codes(base)).toEqual(expect.arrayContaining([
      "supply_carry_stale",
      "supply_integrity_unknown",
    ]));
    expect(assessment.status).toBe("degraded");
  });

  it("keeps carry confirmation when membership changes above the threshold", async () => {
    const { db } = timedDatabase();
    const reportWithCarry = (carryIds: string[]) => {
      const report = integrityReport();
      report.value.unacknowledgedCarryIds = carryIds;
      return report;
    };
    const carryOf = (conditions: ReturnType<typeof buildSupplyIntegrityConditions>) =>
      conditions.find((condition) => condition.id === "carry")!;
    const first = buildSupplyIntegrityConditions(reportWithCarry(["coin-a", "coin-b", "coin-c", "coin-d", "coin-e"]));
    const second = buildSupplyIntegrityConditions(reportWithCarry(["coin-a", "coin-b", "coin-c", "coin-d", "coin-f"]));
    expect(carryOf(first).signature).toBe(carryOf(second).signature);

    expect(carryOf(await confirmSupplyIntegrityConditions(db, first)).active).toBe(false);
    expect(carryOf(await confirmSupplyIntegrityConditions(db, second)).active).toBe(true);
  });

  it("persists held baselines with the confirmation state", async () => {
    const { db, sqlite } = timedDatabase();
    const condition = {
      id: "value-drift" as const,
      label: "drift",
      active: true,
      unknown: false,
      signature: "value-drift",
      held: { "coin-a": 100 },
    };
    await confirmSupplyIntegrityConditions(db, [condition]);
    await confirmSupplyIntegrityConditions(db, [condition]);
    const stored = sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(SUPPLY_INTEGRITY_CONFIRM_KEY) as { value: string };
    expect(JSON.parse(stored.value)["value-drift"]).toMatchObject({
      runs: 2,
      held: { "coin-a": 100 },
    });
  });

  it("holds drift across rollover, clearing only when the observed value returns", async () => {
    for (const current of [13, 100]) {
      const assets = normalAssets(), id = assets[0].id, active = current === 13;
      assets[0] = { ...assets[0], current, previous: 13 };
      const r = await loadReport({ assets, confirmState: {
        "value-drift": { signature: "value-drift", runs: 3, held: { [id]: 100 } },
      } });
      expect(r.value.driftFindings).toEqual([]);
      expect(r.value.heldDriftFindings.map(f => f.stablecoinId)).toEqual(active ? [id] : []);
      expect(r.value.heldDriftBaselines).toEqual(active ? { [id]: 100 } : {});
      expect(conditionOf(r, "value-drift")).toMatchObject({ active, unknown: false, held: active ? { [id]: 100 } : {} });
      const assessment = assessSupplyIntegrityQuality(r);
      if (active) expect(assessment.status).toBe("degraded");
      expect(codes(r).includes("supply_value_drift")).toBe(active);
    }
  });

  it.each(["supply-chain-dropout", undefined])("keeps a quarantined asset's held baseline (%s)", async (unavailableReason) => {
    const { db, sqlite } = timedDatabase();
    const assets = normalAssets();
    const drifted = assets[0].id;
    assets[0] = { ...assets[0], current: null, unavailableReason };
    const state = { "value-drift": { signature: "value-drift", runs: 3, held: { [drifted]: 100 } } };
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(SUPPLY_INTEGRITY_CONFIRM_KEY, JSON.stringify(state), NOW);
    const report = await loadReport({ assets, confirmState: state });
    expect(report.value.heldDriftBaselines).toEqual({ [drifted]: 100 });
    expect(report.value.heldDriftUnknownReason).toBe(unavailableReason ? null : "held-drift-value-unavailable");
    const condition = conditionOf(report, "value-drift")!;
    expect(condition).toMatchObject({ active: false, unknown: !unavailableReason, held: { [drifted]: 100 } });
    expect((await confirmSupplyIntegrityConditions(db, [condition]))[0])
      .toMatchObject({ active: false, unknown: !unavailableReason });
    const select = sqlite.prepare("SELECT value FROM cache WHERE key = ?");
    const confirmState = JSON.parse((select.get(SUPPLY_INTEGRITY_CONFIRM_KEY) as { value: string }).value);
    expect(confirmState["value-drift"]).toMatchObject({ runs: unavailableReason ? 0 : 3, held: { [drifted]: 100 } });
    for (const current of [13, 100]) {
      assets[0] = { ...assets[0], current, previous: 13, unavailableReason: undefined };
      const returned = await loadReport({ assets, confirmState });
      expect(returned.value.driftFindings).toEqual([]);
      const returning = conditionOf(returned, "value-drift")!;
      expect(returning).toMatchObject({ active: current === 13, unknown: false, held: current === 13 ? { [drifted]: 100 } : {} });
      expect((await confirmSupplyIntegrityConditions(db, [returning]))[0].active).toBe(current === 13 && !unavailableReason);
    }
    expect(JSON.parse((select.get(SUPPLY_INTEGRITY_CONFIRM_KEY) as { value: string }).value)).toEqual({});
  });

  it("honours reviewed re-baselines", async () => {
    const a = normalAssets();
    a[0] = { ...a[0], id: "iauon-ondo", current: 1_747_207.06, previous: 3_900_000 };
    a[1] = { ...a[1], id: "gtusdtp-gauntlet", current: 300_000, previous: 300_000 };
    const r = await loadSupplyIntegrityReport(database({
      assets: a,
      confirmState: { "value-drift": { signature: "x", runs: 2, held: { "iauon-ondo": 3_900_000, "gtusdtp-gauntlet": 2_900_000 } } },
    }), 1_793_836_800);
    expect(r.value).toMatchObject({ driftFindings: [], heldDriftFindings: [{ stablecoinId: "gtusdtp-gauntlet" }] });
    const reviewedAt = Date.parse("2026-11-07T19:48:00Z") / 1000;
    for (const [id, current, previous, reviewStart = reviewedAt] of [
      ["sparkusdtbc-spark", 850_692.45, 50_307_247.03],
      ["frnt-wyoming", 397_773.24, 967_404.4],
      ["wmxn-ripio", 176_488.15, 663_063.37],
      ["wcop-ripio", 193_650.25, 544_889.08],
      ["tryb-bilira", 698_792.67, 2_219_652.08, Date.parse("2026-11-07T20:27:00Z") / 1000],
      ["gbpa-agant", 1_191_268.85, 2_481_810, Date.parse("2026-11-07T21:10:00Z") / 1000],
      ["witry-brix", 1_543_091.36, 3_365_372.58, Date.parse("2026-11-11T23:21:24Z") / 1000],
    ] as const) {
      for (const [now, value, accepted] of [
        [reviewStart - 1, current, false], [reviewStart, current, true],
        [reviewStart, current * 0.97, false], [reviewStart + 7 * 86400 + 1, current, false],
      ] as const) {
        const report = await loadSupplyIntegrityReport(database({
          assets: [{ id, current: value, previous }],
          confirmState: { "value-drift": { signature: "x", runs: 2, held: { [id]: previous } } },
        }), now);
        expect(report.value.driftFindings.length + report.value.heldDriftFindings.length).toBe(accepted ? 0 : 1);
        expect(report.value.heldDriftBaselines[id]).toBe(accepted ? undefined : previous);
      }
    }
  });

  it("keeps sub-breadth carry, availability and partial-snapshot causes non-degrading", () => {
    const report = integrityReport();
    report.value.unacknowledgedCarryIds = ["coin-a"];
    Object.assign(report.availability, { observedCount: 99, unavailableCount: 1, share: 0.01, consecutiveGenerations: 2 });
    Object.assign(report.snapshot, { due: true, unavailableActiveIds: ["coin-a"], band: "elevated" });
    const assessment = assessSupplyIntegrityQuality(report);
    expect(assessment.status).toBe("healthy");
    expect(codes(report)).toEqual(expect.arrayContaining([
      "supply_carry_stale",
      "supply_availability_degraded",
      "supply_snapshot_partial",
    ]));
    expect(assessSupplyIntegrityQuality({
      ...report,
      snapshot: { ...report.snapshot, band: "systemic" },
    }).status).toBe("degraded");
  });
});
