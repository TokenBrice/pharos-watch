import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  buildSupplyIntegrityConditions,
  confirmSupplyIntegrityConditions,
  loadSupplyIntegrityReport,
  SUPPLY_INTEGRITY_CONFIRM_KEY,
  type SupplyIntegrityReport,
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

function loadReport(options: Parameters<typeof database>[0]) {
  return loadSupplyIntegrityReport(database(options), NOW);
}

function conditionOf(report: SupplyIntegrityReport, id: string) {
  return buildSupplyIntegrityConditions(report).find((condition) => condition.id === id);
}

function integrityReport(count = 100): SupplyIntegrityReport {
  return {
    observedAt: NOW,
    value: {
      status: "ok", reason: null, checkedCount: count, excludedCount: 0,
      driftFindings: [], heldDriftFindings: [], heldDriftBaselines: {}, heldDriftUnknownReason: null,
      aggregateCurrentUsd: 100, aggregatePreviousUsd: 100, aggregateRatio: 1, frozen: false,
      carryIds: [], carryOldestAgeSec: 3 * 86_400, carryUnclockedCount: 0,
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
    const frozen = await loadReport({
      assets: [...ACTIVE_IDS].map((id) => ({ id, current: 100, previous: 100 })),
      syncRuns: [supplyRun(0, 12), supplyRun(0, 12)],
    });
    expect(frozen.value.checkedCount).toBe(ACTIVE_IDS.size);
    expect(frozen.value.frozen).toBe(true);
    expect(conditionOf(frozen, "value-drift")?.active)
      .toBe(true);

    const tooFew = await loadReport({ assets: normalAssets() });
    expect(tooFew.value.frozen).toBe(false);
  });

  it("marks value drift unknown when no comparable daily history exists", async () => {
    const report = await loadReport({
      assets: normalAssets(),
      marker: marker(),
      syncRuns: [supplyRun(0, 12), supplyRun(0, 12)],
    });
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
    const twoGenerations = await loadReport({
      assets: normalAssets(),
      syncRuns: [supplyRun(2, 98, NOW - 900), supplyRun(2, 98, NOW - 1800)],
    });
    expect(twoGenerations.availability).toMatchObject({
      status: "ok",
      unavailableCount: 2,
      observedCount: 98,
      consecutiveGenerations: 2,
    });
    expect(conditionOf(twoGenerations, "availability")?.active)
      .toBe(true);

    const oneGeneration = await loadReport({
      assets: normalAssets(),
      syncRuns: [supplyRun(2, 98, NOW - 900), supplyRun(0, 100, NOW - 1800)],
    });
    expect(oneGeneration.availability.consecutiveGenerations).toBe(1);
    expect(conditionOf(oneGeneration, "availability")?.active)
      .toBe(false);
  });

  it("flags an overdue daily snapshot and a partial snapshot with persisted-row loss", async () => {
    const overdue = await loadReport({
      assets: normalAssets(),
      marker: marker({ snapshotDate: TODAY - 86_400 }),
      syncRuns: [supplyRun(0, 12)],
    });
    expect(overdue.snapshot).toMatchObject({ current: false, due: true });
    expect(conditionOf(overdue, "snapshot-overdue")?.active)
      .toBe(true);

    const partial = await loadReport({
      assets: normalAssets(),
      marker: marker({ unavailableActiveIds: [ACTIVE[0]], ownedRowIds: ACTIVE.slice(0, 13) }),
      persistedRows: 13,
      syncRuns: [supplyRun(0, 14)],
    });
    expect(partial.snapshot).toMatchObject({ current: true, band: "elevated", persistedRows: 13, writtenRows: 13 });
    expect(conditionOf(partial, "snapshot-partial")?.active)
      .toBe(true);

    const rowsMissing = await loadReport({
      assets: normalAssets(),
      marker: marker(),
      persistedRows: 10,
      syncRuns: [supplyRun(0, 14)],
    });
    expect(conditionOf(rowsMissing, "snapshot-partial")?.label)
      .toContain("persisted 10 of 14");
  });

  it("keeps carry evidence when only the daily-history read fails", async () => {
    const assets = normalAssets();
    assets[0] = { ...assets[0], current: 30, supplyRestored: true };
    assets[1] = { ...assets[1], current: null, supplyRestored: true };
    const report = await loadReport({ assets, historyThrows: true });
    expect(report.value.status).toBe("unknown");
    expect(report.value.reason).toBe("supply-history-read-failed");
    expect(report.value.carryIds).toEqual([assets[0].id]);
    // One carried asset is below the active-cohort share budget; the evidence
    // is retained, not silently converted into a finding.
    expect(conditionOf(report, "carry")?.active).toBe(false);
  });

  it("keeps every dimension unknown when the source reads fail", async () => {
    const report = await loadReport({
      assets: normalAssets(),
      cacheThrows: true,
    });
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
    const base = integrityReport(12);
    Object.assign(base.value, {
      driftFindings: [{ stablecoinId: "usdt-tether", currentUsd: 40, previousUsd: 100, ratio: 0.4 }],
      aggregateCurrentUsd: 1_100, aggregatePreviousUsd: 1_200, aggregateRatio: 1.1, carryOldestAgeSec: null,
    });
    Object.assign(base.snapshot, { snapshotDate: TODAY - 86_400, due: true, current: false, persistedRows: null });
    const assessment = assessSupplyIntegrityQuality(base);
    expect(assessment.status).toBe("degraded");
    expect(assessment.causes.map((cause) => cause.code)).toEqual(
      expect.arrayContaining(["supply_value_drift", "supply_snapshot_overdue"]),
    );
    expect(assessSupplyIntegrityQuality(null).causes[0].code).toBe("supply_integrity_unknown");
  });

  it("keeps known carry evidence when the value comparison is unknown", () => {
    const base = integrityReport();
    Object.assign(base.value, {
      status: "unknown", reason: "supply-history-read-failed", checkedCount: 0,
      aggregateCurrentUsd: null, aggregatePreviousUsd: null, aggregateRatio: null,
      carryIds: ["coin-a", "coin-b", "coin-c", "coin-d", "coin-e", "coin-f"], carryOldestAgeSec: 5 * 86_400,
    });
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
    const reportWithCarry = (carryIds: string[]) => {
      const report = integrityReport();
      report.value.carryIds = carryIds;
      return report;
    };
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
    const report = await loadReport({
      assets,
      confirmState: {
        "value-drift": { signature: "value-drift", runs: 2, held: { [drifted]: 100 } },
      },
    });
    expect(report.value.driftFindings).toEqual([]);
    expect(report.value.heldDriftFindings.map((finding) => finding.stablecoinId)).toEqual([drifted]);
    const condition = conditionOf(report, "value-drift")!;
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
    const report = await loadReport({
      assets,
      confirmState: {
        "value-drift": { signature: "value-drift", runs: 3, held: { [drifted]: 100 } },
      },
    });
    // The move back to the pre-drop level is recovery evidence, not a new
    // upward finding against the bad snapshot.
    expect(report.value.driftFindings).toEqual([]);
    expect(report.value.heldDriftFindings).toEqual([]);
    expect(report.value.heldDriftBaselines).toEqual({});
    const condition = conditionOf(report, "value-drift")!;
    expect(condition.active).toBe(false);
    expect(condition.unknown).toBe(false);
  });

  it("keeps a quarantined asset's held baseline without marking value drift unknown", async () => {
    for (const unavailableReason of ["supply-chain-dropout", undefined]) {
      const assets = normalAssets();
      const drifted = assets[0].id;
      assets[0] = { ...assets[0], current: null, unavailableReason };
      const report = await loadReport({
        assets, confirmState: { "value-drift": { signature: "value-drift", runs: 3, held: { [drifted]: 100 } } },
      });
      expect(report.value.heldDriftBaselines).toEqual({ [drifted]: 100 });
      expect(report.value.heldDriftUnknownReason).toBe(unavailableReason ? null : "held-drift-value-unavailable");
      expect(conditionOf(report, "value-drift")).toMatchObject({ active: false, unknown: !unavailableReason, held: { [drifted]: 100 } });
    }
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
  });

  it("keeps sub-breadth carry, availability and partial-snapshot causes non-degrading", () => {
    const report = integrityReport();
    report.value.carryIds = ["coin-a"];
    Object.assign(report.availability, { observedCount: 99, unavailableCount: 1, share: 0.01, consecutiveGenerations: 2 });
    Object.assign(report.snapshot, { due: true, unavailableActiveIds: ["coin-a"], band: "elevated" });
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
