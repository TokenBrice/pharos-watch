import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  buildSupplyIntegrityConditions,
  confirmSupplyIntegrityConditions,
  loadSupplyIntegrityReport,
  SUPPLY_INTEGRITY_CONFIRM_KEY,
  type SupplyIntegrityReport,
  type SupplyValueIntegrityReport,
} from "../supply-integrity";
import { assessSupplyIntegrityQuality } from "../status/supply-integrity-quality";
import {
  buildSupplySnapshotCompletionMarker,
  buildSupplySnapshotCoverageExpectation,
} from "../supply-snapshot-completion";

const fixtures = createLatestSchemaFixtureTracker();
const NOW = 1_790_000_000;
const TODAY = startOfUtcDaySec(new Date(NOW * 1000));
const ACTIVE = [...ACTIVE_IDS].slice(0, 14);
const SUPPLY_SOURCE = "defillama";

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
  supplyObservedAt?: number;
  currentSource?: string;
  previousSource?: string;
  previousGuard?: boolean;
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
  const assets = options.assets.map(asset);
  const history = options.assets.map(historyRow);
  const cacheRows = [
    ...(options.cacheThrows ? [] : [{
      key: "stablecoins",
      value: JSON.stringify({ peggedAssets: assets }),
      updated_at: NOW - 60,
    }]),
    ...(options.marker === null ? [] : [{
      key: "snapshot-supply:last-write",
      value: JSON.stringify(options.marker ?? marker()),
      updated_at: NOW - 60,
    }]),
    ...(options.confirmState === undefined ? [] : [{
      key: SUPPLY_INTEGRITY_CONFIRM_KEY,
      value: JSON.stringify(options.confirmState),
      updated_at: NOW - 60,
    }]),
  ];
  return mockD1([
    {
      match: "FROM cache WHERE key = ?",
      rows: cacheRows,
      ...(options.cacheThrows ? { throwError: new Error("D1_ERROR") } : {}),
    },
    {
      match: "supply-integrity-previous-rows",
      rows: history,
      ...(options.historyThrows ? { throwError: new Error("D1_ERROR") } : {}),
    },
    { match: "WHERE job = 'sync-stablecoins'", rows: options.syncRuns ?? [] },
    { match: "WHERE job = 'sync-stablecoin-charts'", rows: [] },
    {
      match: "SELECT COUNT(*) AS count FROM supply_history",
      first: {
        count: options.persistedRows
          ?? (Array.isArray(options.marker?.ownedRowIds) ? options.marker.ownedRowIds.length : 0),
      },
      rows: [],
    },
  ]);
}

function normalAssets(): AssetInput[] {
  return ACTIVE.map((id) => ({ id, current: 100, previous: 100 }));
}

describe("supply integrity", () => {
  it("flags per-asset generation drift and excludes provenance-named carry/repair rows", async () => {
    const assets = normalAssets();
    assets[0] = { ...assets[0], current: 40 };
    assets[1] = { ...assets[1], current: 250 };
    assets[2] = { ...assets[2], current: 30, supplyRestored: true };
    assets[3] = { ...assets[3], current: 20, previousGuard: true };
    assets[4] = { ...assets[4], current: 20, previousSource: "coingecko-gap-fill" };
    const report = await loadSupplyIntegrityReport(database({ assets }), NOW);

    expect(report.value.status).toBe("ok");
    expect(report.value.driftFindings.map((finding) => finding.stablecoinId)).toEqual([
      assets[0].id,
      assets[1].id,
    ]);
    expect(report.value.driftFindings.map((finding) => finding.ratio)).toEqual([0.4, 2.5]);
    expect(report.value.checkedCount).toBe(11);
    expect(report.value.excludedCount).toBe(3);
    expect(report.value.carryIds).toEqual([assets[2].id]);
    expect(report.value.frozen).toBe(false);
  });

  it("flags a whole-feed frozen cohort only when the comparable sample is representative", async () => {
    const frozen = await loadSupplyIntegrityReport(database({
      assets: [...ACTIVE_IDS].map((id) => ({ id, current: 100, previous: 100 })),
      syncRuns: [supplyRun(0, 12), supplyRun(0, 12)],
    }), NOW);
    expect(frozen.value.checkedCount).toBe(ACTIVE_IDS.size);
    expect(frozen.value.frozen).toBe(true);
    expect(buildSupplyIntegrityConditions(frozen).find((condition) => condition.id === "value-drift")?.active)
      .toBe(true);

    const tooFew = await loadSupplyIntegrityReport(database({ assets: normalAssets() }), NOW);
    expect(tooFew.value.frozen).toBe(false);
  });

  it("marks value drift unknown when no comparable daily history exists", async () => {
    const report = await loadSupplyIntegrityReport(database({
      assets: normalAssets(),
      marker: marker(),
      syncRuns: [supplyRun(0, 12), supplyRun(0, 12)],
    }), NOW);
    expect(report.value.status).toBe("ok");

    const noHistory = await loadSupplyIntegrityReport(mockD1([
      { match: "FROM cache WHERE key = ?", rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: normalAssets().map(asset) }), updated_at: NOW - 60 }] },
      { match: "supply-integrity-previous-rows", rows: [] },
      { match: "WHERE job = 'sync-stablecoins'", rows: [] },
      { match: "WHERE job = 'sync-stablecoin-charts'", rows: [] },
    ]), NOW);
    expect(noHistory.value.status).toBe("unknown");
    expect(noHistory.value.reason).toBe("insufficient-comparable-history");
  });

  it("requires two consecutive generations above the unavailable-supply budget", async () => {
    const twoGenerations = await loadSupplyIntegrityReport(database({
      assets: normalAssets(),
      syncRuns: [supplyRun(2, 98, NOW - 900), supplyRun(2, 98, NOW - 1800)],
    }), NOW);
    expect(twoGenerations.availability).toMatchObject({
      status: "ok",
      unavailableCount: 2,
      observedCount: 98,
      consecutiveGenerations: 2,
    });
    expect(buildSupplyIntegrityConditions(twoGenerations).find((condition) => condition.id === "availability")?.active)
      .toBe(true);

    const oneGeneration = await loadSupplyIntegrityReport(database({
      assets: normalAssets(),
      syncRuns: [supplyRun(2, 98, NOW - 900), supplyRun(0, 100, NOW - 1800)],
    }), NOW);
    expect(oneGeneration.availability.consecutiveGenerations).toBe(1);
    expect(buildSupplyIntegrityConditions(oneGeneration).find((condition) => condition.id === "availability")?.active)
      .toBe(false);
  });

  it("flags an overdue daily snapshot and a partial snapshot with persisted-row loss", async () => {
    const overdue = await loadSupplyIntegrityReport(database({
      assets: normalAssets(),
      marker: marker({ snapshotDate: TODAY - 86_400 }),
      syncRuns: [supplyRun(0, 12)],
    }), NOW);
    expect(overdue.snapshot).toMatchObject({ current: false, due: true });
    expect(buildSupplyIntegrityConditions(overdue).find((condition) => condition.id === "snapshot-overdue")?.active)
      .toBe(true);

    const partial = await loadSupplyIntegrityReport(database({
      assets: normalAssets(),
      marker: marker({ unavailableActiveIds: [ACTIVE[0]], ownedRowIds: ACTIVE.slice(0, 13) }),
      persistedRows: 13,
      syncRuns: [supplyRun(0, 14)],
    }), NOW);
    expect(partial.snapshot).toMatchObject({ current: true, band: "elevated", persistedRows: 13, writtenRows: 13 });
    expect(buildSupplyIntegrityConditions(partial).find((condition) => condition.id === "snapshot-partial")?.active)
      .toBe(true);

    const rowsMissing = await loadSupplyIntegrityReport(database({
      assets: normalAssets(),
      marker: marker(),
      persistedRows: 10,
      syncRuns: [supplyRun(0, 14)],
    }), NOW);
    expect(buildSupplyIntegrityConditions(rowsMissing).find((condition) => condition.id === "snapshot-partial")?.label)
      .toContain("persisted 10 of 14");
  });

  it("keeps carry evidence when only the daily-history read fails", async () => {
    const assets = normalAssets();
    assets[0] = { ...assets[0], current: 30, supplyRestored: true };
    const report = await loadSupplyIntegrityReport(database({ assets, historyThrows: true }), NOW);
    expect(report.value.status).toBe("unknown");
    expect(report.value.reason).toBe("supply-history-read-failed");
    expect(report.value.carryIds).toEqual([assets[0].id]);
    // One carried asset is below the active-cohort share budget; the evidence
    // is retained, not silently converted into a finding.
    expect(buildSupplyIntegrityConditions(report).find((condition) => condition.id === "carry")?.active).toBe(false);
  });

  it("keeps every dimension unknown when the source reads fail", async () => {
    const report = await loadSupplyIntegrityReport(database({
      assets: normalAssets(),
      cacheThrows: true,
    }), NOW);
    const conditions = buildSupplyIntegrityConditions(report);
    expect(report.value.status).toBe("unknown");
    expect(report.snapshot.status).toBe("unknown");
    for (const id of ["value-drift", "carry", "snapshot-overdue"] as const) {
      expect(conditions.find((condition) => condition.id === id)?.unknown).toBe(true);
    }
  });

  it("confirms a stable finding on a second run and resets when its signature changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const { db } = fixtures.open();
    const condition = {
      id: "value-drift" as const,
      label: "drift",
      active: true,
      unknown: false,
      signature: "usdt-tether|0.4",
    };
    const first = await confirmSupplyIntegrityConditions(db, [condition]);
    expect(first[0].active).toBe(false);

    const second = await confirmSupplyIntegrityConditions(db, [condition]);
    expect(second[0].active).toBe(true);

    const changed = await confirmSupplyIntegrityConditions(db, [{ ...condition, signature: "usdt-tether|0.3" }]);
    expect(changed[0].active).toBe(false);

    await confirmSupplyIntegrityConditions(db, [{ ...condition, active: false }]);
    const restarted = await confirmSupplyIntegrityConditions(db, [condition]);
    expect(restarted[0].active).toBe(false);
  });

  it("grades value/snapshot findings into ops-only data-quality causes", () => {
    const value = {
      status: "ok",
      reason: null,
      checkedCount: 12,
      excludedCount: 0,
      driftFindings: [{ stablecoinId: "usdt-tether", currentUsd: 40, previousUsd: 100, ratio: 0.4 }],
      heldDriftFindings: [],
      heldDriftBaselines: {},
      heldDriftUnknownReason: null,
      aggregateCurrentUsd: 1_100,
      aggregatePreviousUsd: 1_200,
      aggregateRatio: 1.1,
      frozen: false,
      carryIds: [],
      carryOldestAgeSec: null,
      carryUnclockedCount: 0,
      expectedActiveCount: 12,
      cacheUpdatedAt: NOW - 60,
      historyFromDate: TODAY - 7 * 86_400,
    } satisfies SupplyValueIntegrityReport;
    const base: SupplyIntegrityReport = {
      observedAt: NOW,
      value,
      availability: {
        status: "ok",
        reason: null,
        observedCount: 12,
        unavailableCount: 0,
        share: 0,
        consecutiveGenerations: 0,
        latestRunStartedAt: NOW - 900,
        charts: { status: "ok", reason: null, runStartedAt: NOW - 600, codes: [] },
      },
      snapshot: {
        status: "ok",
        reason: null,
        expectedDate: TODAY,
        snapshotDate: TODAY - 86_400,
        due: true,
        current: false,
        identityVerified: true,
        expectedActiveCount: 12,
        accountedActiveCount: 12,
        writtenRows: 12,
        persistedRows: null,
        unavailableActiveIds: [],
        band: null,
      },
    };
    const assessment = assessSupplyIntegrityQuality(base);
    expect(assessment.status).toBe("degraded");
    expect(assessment.causes.map((cause) => cause.code)).toEqual(
      expect.arrayContaining(["supply_value_drift", "supply_snapshot_overdue"]),
    );
    expect(assessSupplyIntegrityQuality(null).causes[0].code).toBe("supply_integrity_unknown");
  });

  it("keeps known carry evidence when the value comparison is unknown", () => {
    const base: SupplyIntegrityReport = {
      observedAt: NOW,
      value: {
        status: "unknown",
        reason: "supply-history-read-failed",
        checkedCount: 0,
        excludedCount: 0,
        driftFindings: [],
        heldDriftFindings: [],
        heldDriftBaselines: {},
        heldDriftUnknownReason: null,
        aggregateCurrentUsd: null,
        aggregatePreviousUsd: null,
        aggregateRatio: null,
        frozen: false,
        carryIds: ["coin-a", "coin-b", "coin-c", "coin-d", "coin-e", "coin-f"],
        carryOldestAgeSec: 5 * 86_400,
        carryUnclockedCount: 0,
        expectedActiveCount: 100,
        cacheUpdatedAt: NOW - 60,
        historyFromDate: TODAY - 7 * 86_400,
      },
      availability: {
        status: "ok",
        reason: null,
        observedCount: 100,
        unavailableCount: 0,
        share: 0,
        consecutiveGenerations: 0,
        latestRunStartedAt: NOW - 900,
        charts: { status: "ok", reason: null, runStartedAt: NOW - 600, codes: [] },
      },
      snapshot: {
        status: "ok",
        reason: null,
        expectedDate: TODAY,
        snapshotDate: TODAY,
        due: false,
        current: true,
        identityVerified: true,
        expectedActiveCount: 100,
        accountedActiveCount: 100,
        writtenRows: 100,
        persistedRows: 100,
        unavailableActiveIds: [],
        band: null,
      },
    };
    const assessment = assessSupplyIntegrityQuality(base);
    // The history read failure only hides the value comparison; the cache still
    // proves the carried cohort, which stays a warning and degrades at breadth.
    expect(assessment.causes.map((cause) => cause.code)).toEqual(expect.arrayContaining([
      "supply_carry_stale",
      "supply_integrity_unknown",
    ]));
    expect(assessment.status).toBe("degraded");
  });

  it("keeps carry confirmation when membership changes above the threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const { db } = fixtures.open();
    const reportWithCarry = (carryIds: string[]): SupplyIntegrityReport => ({
      observedAt: NOW,
      value: {
        status: "ok",
        reason: null,
        checkedCount: 100,
        excludedCount: 0,
        driftFindings: [],
        heldDriftFindings: [],
        heldDriftBaselines: {},
        heldDriftUnknownReason: null,
        aggregateCurrentUsd: 100,
        aggregatePreviousUsd: 100,
        aggregateRatio: 1,
        frozen: false,
        carryIds,
        carryOldestAgeSec: 3 * 86_400,
        carryUnclockedCount: 0,
        expectedActiveCount: 100,
        cacheUpdatedAt: NOW - 60,
        historyFromDate: TODAY - 7 * 86_400,
      },
      availability: {
        status: "ok",
        reason: null,
        observedCount: 100,
        unavailableCount: 0,
        share: 0,
        consecutiveGenerations: 0,
        latestRunStartedAt: NOW - 900,
        charts: { status: "ok", reason: null, runStartedAt: NOW - 600, codes: [] },
      },
      snapshot: {
        status: "ok",
        reason: null,
        expectedDate: TODAY,
        snapshotDate: TODAY,
        due: false,
        current: true,
        identityVerified: true,
        expectedActiveCount: 100,
        accountedActiveCount: 100,
        writtenRows: 100,
        persistedRows: 100,
        unavailableActiveIds: [],
        band: null,
      },
    });
    const carryOf = (conditions: Awaited<ReturnType<typeof confirmSupplyIntegrityConditions>>) =>
      conditions.find((condition) => condition.id === "carry")!;
    const first = buildSupplyIntegrityConditions(reportWithCarry(["coin-a", "coin-b", "coin-c", "coin-d", "coin-e"]));
    const second = buildSupplyIntegrityConditions(reportWithCarry(["coin-a", "coin-b", "coin-c", "coin-d", "coin-f"]));
    expect(carryOf(first).signature).toBe(carryOf(second).signature);

    expect(carryOf(await confirmSupplyIntegrityConditions(db, first)).active).toBe(false);
    // Membership changed but the count is still above the threshold: the
    // confirmed condition stays raised instead of resetting for one run.
    expect(carryOf(await confirmSupplyIntegrityConditions(db, second)).active).toBe(true);
  });

  it("persists held baselines with the confirmation state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const { db, sqlite } = fixtures.open();
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

  it("holds a value-drift finding across the daily snapshot rollover", async () => {
    const assets = normalAssets();
    const drifted = assets[0].id;
    // The midnight snapshot now carries the drifted value, so the cache-vs-row
    // comparison alone would look healthy; the retained pre-drop baseline
    // keeps the finding raised.
    assets[0] = { ...assets[0], current: 13, previous: 13 };
    const report = await loadSupplyIntegrityReport(database({
      assets,
      confirmState: {
        "value-drift": { signature: "value-drift", runs: 2, held: { [drifted]: 100 } },
      },
    }), NOW);
    expect(report.value.driftFindings).toEqual([]);
    expect(report.value.heldDriftFindings.map((finding) => finding.stablecoinId)).toEqual([drifted]);
    const condition = buildSupplyIntegrityConditions(report).find((entry) => entry.id === "value-drift")!;
    expect(condition.active).toBe(true);
    expect(condition.unknown).toBe(false);
    expect(condition.held).toEqual({ [drifted]: 100 });
    const assessment = assessSupplyIntegrityQuality(report);
    expect(assessment.status).toBe("degraded");
    expect(assessment.causes.map((cause) => cause.code)).toContain("supply_value_drift");
  });

  it("clears a held value-drift finding when the observed value returns", async () => {
    const assets = normalAssets();
    const drifted = assets[0].id;
    assets[0] = { ...assets[0], current: 100, previous: 13 };
    const report = await loadSupplyIntegrityReport(database({
      assets,
      confirmState: {
        "value-drift": { signature: "value-drift", runs: 3, held: { [drifted]: 100 } },
      },
    }), NOW);
    // The move back to the pre-drop level is recovery evidence, not a new
    // upward finding against the bad snapshot.
    expect(report.value.driftFindings).toEqual([]);
    expect(report.value.heldDriftFindings).toEqual([]);
    expect(report.value.heldDriftBaselines).toEqual({});
    const condition = buildSupplyIntegrityConditions(report).find((entry) => entry.id === "value-drift")!;
    expect(condition.active).toBe(false);
    expect(condition.unknown).toBe(false);
  });

  it("keeps sub-breadth carry, availability and partial-snapshot causes non-degrading", () => {
    const report: SupplyIntegrityReport = {
      observedAt: NOW,
      value: {
        status: "ok",
        reason: null,
        checkedCount: 100,
        excludedCount: 0,
        driftFindings: [],
        heldDriftFindings: [],
        heldDriftBaselines: {},
        heldDriftUnknownReason: null,
        aggregateCurrentUsd: 100,
        aggregatePreviousUsd: 100,
        aggregateRatio: 1,
        frozen: false,
        carryIds: ["coin-a"],
        carryOldestAgeSec: 3 * 86_400,
        carryUnclockedCount: 0,
        expectedActiveCount: 100,
        cacheUpdatedAt: NOW - 60,
        historyFromDate: TODAY - 7 * 86_400,
      },
      availability: {
        status: "ok",
        reason: null,
        observedCount: 99,
        unavailableCount: 1,
        share: 0.01,
        consecutiveGenerations: 2,
        latestRunStartedAt: NOW - 900,
        charts: { status: "ok", reason: null, runStartedAt: NOW - 600, codes: [] },
      },
      snapshot: {
        status: "ok",
        reason: null,
        expectedDate: TODAY,
        snapshotDate: TODAY,
        due: true,
        current: true,
        identityVerified: true,
        expectedActiveCount: 100,
        accountedActiveCount: 100,
        writtenRows: 100,
        persistedRows: 100,
        unavailableActiveIds: ["coin-a"],
        band: "elevated",
      },
    };
    const assessment = assessSupplyIntegrityQuality(report);
    expect(assessment.status).toBe("healthy");
    expect(assessment.causes.map((cause) => cause.code)).toEqual(expect.arrayContaining([
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
