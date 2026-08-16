import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";

vi.mock("@shared/lib/peg-rates", () => ({
  derivePegRates: vi.fn(() => ({
    rates: { peggedUSD: 1 },
    sources: { peggedUSD: "native-usd" },
    counts: { peggedUSD: 1 },
  })),
}));

vi.mock("../../lib/dews", () => ({
  computeDEWS: vi.fn(() => ({
    score: 67,
    band: "WARNING",
    signals: {},
  })),
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(async () => JSON.stringify({ completedAt: 1 })),
}));

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(async () => ({
    kind: "ok",
    payload: {
      peggedAssets: [
        {
          id: "usdt-tether",
          name: "Tether",
          symbol: "USDT",
          geckoId: "tether",
          pegType: "peggedUSD",
          pegMechanism: "fiat",
          price: 1,
          priceSource: "cache",
          priceConfidence: "high",
          circulating: { ethereum: 100_000_000 },
          circulatingPrevDay: { ethereum: 99_500_000 },
          circulatingPrevWeek: { ethereum: 98_000_000 },
          circulatingPrevMonth: { ethereum: 97_000_000 },
          chainCirculating: {},
          chains: ["ethereum"],
        },
        {
          id: "not-psi-eligible",
          name: "Excluded fixture",
          symbol: "NOPE",
          geckoId: "excluded-fixture",
          pegType: "peggedUSD",
          pegMechanism: "fiat",
          price: 1,
          priceSource: "cache",
          priceConfidence: "high",
          circulating: { ethereum: 1_000_000 },
          circulatingPrevDay: { ethereum: 1_000_000 },
          circulatingPrevWeek: { ethereum: 1_000_000 },
          circulatingPrevMonth: { ethereum: 1_000_000 },
          chainCirculating: {},
          chains: ["ethereum"],
        },
      ],
      fxFallbackRates: {},
    },
  })),
}));

vi.mock("../../lib/dews/source-state", () => ({
  loadDewsSourceState: vi.fn(async () => ({
    dexLiqRows: { results: [] },
    dexLiqMap: new Map(),
    dexLiqAgeSecById: new Map(),
    dexLiqStaleIds: new Set(),
    dexPriceMap: new Map(),
    dexPriceAgeSecById: new Map(),
    dexPriceStaleIds: new Set(),
    liqHist7dMap: new Map(),
    liqHistRowsRead: 0,
    blacklistCounts: new Map(),
    prevSignals: new Map(),
    prevSignalStaleIds: new Set(),
    mintBurnMap: new Map(),
    mintBurnAgeSecById: new Map(),
    mintBurnStaleIds: new Set(),
    yieldWarnings: new Map(),
    yieldSourceRisk: new Map(),
    yieldRankChangeAttribution: new Map(),
    latestPsiScore: null,
    sourceCoverage: { dexPrices: 1, dexLiquidity: 1 },
    dependencyDiagnostics: {
      dexLiquidity: {
        totalRows: 0,
        freshRows: 0,
        staleRows: 0,
        freshnessAgeSec: null,
        staleThresholdSec: 7200,
        latestGenerationId: null,
        latestGenerationState: null,
        latestGenerationStartedAt: null,
        latestGenerationPublishedAt: null,
        latestGenerationFailedAt: null,
        latestGenerationFailureReason: null,
        latestPublishedGenerationId: null,
        latestPublishedAt: null,
        latestPublishedAgeSec: null,
      },
    },
  })),
}));

vi.mock("../../lib/dews/scoring", () => ({
  buildDewsScoringResult: vi.fn(() => ({
    results: [
      { stablecoinId: "usdt-tether", score: 67, band: "WARNING", signals: {} },
      { stablecoinId: "usdc-circle", score: 18, band: "WATCH", signals: {} },
    ],
    liqHistCoverageCount: 0,
    insufficientDataCount: 1,
  })),
}));

vi.mock("../../lib/dews/service", () => ({
  computeAndStoreDEWS: vi.fn(async () => ({
    itemCount: 2,
    status: "degraded",
    metadata: JSON.stringify({
      rowsWritten: 2,
      rowsDropped: 3,
      sourceCoverage: { dexPrices: 1 },
      sourceFailures: [],
      validationFailures: 0,
    }),
  })),
}));

import { computeDEWS } from "../../lib/dews";
import { buildDewsScoringResult } from "../../lib/dews/scoring";
import { computeAndStoreDEWS } from "../../lib/dews/service";
import { handleBackfillDEWS } from "../backfill-dews";

stubCryptoForAuth();

describe("handleBackfillDEWS", () => {
  it("reconstructs inputs from circulating_usd and liquidity history schema columns", async () => {
    const startedAt = 1710000000;
    const day = Math.floor(startedAt / 86400) * 86400;
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            started_at: startedAt,
            ended_at: startedAt + 7200,
            peak_deviation_bps: -150,
          },
        ],
      },
      {
        match: "FROM supply_history",
        rows: [
          { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: day - 86400, circulating_usd: 99_500_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: day - 7 * 86400, circulating_usd: 98_000_000 },
        ],
      },
      {
        match: "FROM dex_liquidity_history",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            snapshot_date: day,
            liquidity_score: 81,
            total_tvl_usd: 2_200_000,
          },
          {
            stablecoin_id: "usdt-tether",
            snapshot_date: day - 7 * 86400,
            liquidity_score: 77,
            total_tvl_usd: 2_000_000,
          },
        ],
      },
    ]);

    const request = makeApiRequest("/api/backfill-dews", { adminKey: "secret" });
    const response = await handleBackfillDEWS({ db, url: makeApiUrl("/api/backfill-dews"), trustedAdmin: true, request });

    expect(response.status).toBe(200);
    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        circulatingCurrent: 100_000_000,
        circulatingPrevDay: 99_500_000,
        circulatingPrevWeek: 98_000_000,
        liquidityScore: 81,
        liquidityScore7dAgo: 77,
        tvlCurrent: 2_200_000,
        tvl7dAgo: 2_000_000,
      }),
    );
  });

  it("rejects GET repair mutations without dry-run", async () => {
    const db = mockD1();
    const request = makeApiRequest("/api/backfill-dews?repair=refresh-current", { adminKey: "secret" });

    const response = await handleBackfillDEWS({ db, url: makeApiUrl(request.url), trustedAdmin: true, request });
    expect(response.status).toBe(405);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("dry-run=true");
  });

  it("uses the producer's eligible asset universe and peg-reference provenance in refresh previews", async () => {
    const db = mockD1();
    const request = makeApiRequest("/api/backfill-dews?repair=refresh-current&dry-run=true", { adminKey: "secret" });

    const response = await handleBackfillDEWS({ db, url: makeApiUrl(request.url), trustedAdmin: true, request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      repair: string;
      dryRun: boolean;
      preview: { targetCoinCount: number; targetStablecoinIds: string[]; insufficientDataCount: number };
    };
    expect(body.repair).toBe("refresh-current");
    expect(body.dryRun).toBe(true);
    expect(body.preview.targetCoinCount).toBe(2);
    expect(body.preview.targetStablecoinIds).toEqual(["usdt-tether", "usdc-circle"]);
    expect(body.preview.insufficientDataCount).toBe(1);
    expect(buildDewsScoringResult).toHaveBeenCalledTimes(1);
    expect(buildDewsScoringResult).toHaveBeenCalledWith(
      expect.objectContaining({
        assetById: new Map([["usdt-tether", expect.objectContaining({ id: "usdt-tether" })]]),
        pegRates: { peggedUSD: 1 },
        pegRateSources: { peggedUSD: "native-usd" },
        pegRateContributorCounts: { peggedUSD: 1 },
      }),
    );
  });

  it("executes current DEWS refresh on POST repair", async () => {
    const db = mockD1();
    const request = makeApiRequest("/api/backfill-dews?repair=refresh-current", {
      adminKey: "secret",
      method: "POST",
    });

    const response = await handleBackfillDEWS({ db, url: makeApiUrl(request.url), trustedAdmin: true, request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      repair: string;
      dryRun: boolean;
      execution: { itemCount: number; status: string; metadata: { rowsWritten: number; rowsDropped: number } };
    };
    expect(body.repair).toBe("refresh-current");
    expect(body.dryRun).toBe(false);
    expect(body.execution).toMatchObject({
      itemCount: 2,
      status: "degraded",
      metadata: { rowsWritten: 2, rowsDropped: 3 },
    });
    expect(computeAndStoreDEWS).toHaveBeenCalledTimes(1);
  });

  it("previews bounded prune-history candidates with an optional stablecoin filter", async () => {
    const db = mockD1([
      {
        match: "SELECT COUNT(*) as cnt FROM stress_signal_history WHERE snapshot_date >= ? AND snapshot_date <= ? AND stablecoin_id = ?",
        matchBinds: [1_773_100_800, 1_773_273_600, "usdt-tether"],
        rows: [],
        first: { cnt: 2 },
      },
      {
        match: "ORDER BY snapshot_date ASC, stablecoin_id ASC",
        matchBinds: [1_773_100_800, 1_773_273_600, "usdt-tether"],
        rows: [
          { stablecoin_id: "usdt-tether", snapshot_date: 1_773_100_800 },
          { stablecoin_id: "usdt-tether", snapshot_date: 1_773_187_200 },
        ],
      },
      {
        match: "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history WHERE stablecoin_id = ?",
        matchBinds: ["usdt-tether"],
        rows: [],
        first: { min_day: 1_772_928_000 },
      },
      {
        match: "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history WHERE stablecoin_id = ? AND snapshot_date > ?",
        matchBinds: ["usdt-tether", 1_773_273_600],
        rows: [],
        first: { min_day: 1_773_360_000 },
      },
    ]);
    const request = makeApiRequest(
      "/api/backfill-dews?repair=prune-history&dry-run=true&stablecoin=usdt-tether&startDay=2026-03-10&endDay=2026-03-12",
      { adminKey: "secret" },
    );

    const response = await handleBackfillDEWS({ db, url: makeApiUrl(request.url), trustedAdmin: true, request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      repair: string;
      dryRun: boolean;
      stablecoinId: string | null;
      totalMatchingRows: number;
      candidateRowsSample: Array<{ stablecoinId: string; snapshotDate: number }>;
    };
    expect(body.repair).toBe("prune-history");
    expect(body.dryRun).toBe(true);
    expect(body.stablecoinId).toBe("usdt-tether");
    expect(body.totalMatchingRows).toBe(2);
    expect(body.candidateRowsSample).toEqual([
      { stablecoinId: "usdt-tether", snapshotDate: 1_773_100_800 },
      { stablecoinId: "usdt-tether", snapshotDate: 1_773_187_200 },
    ]);
  });

  it("accepts PSI shadow IDs for prune-history repair filters", async () => {
    const db = mockD1([
      {
        match: "SELECT COUNT(*) as cnt FROM stress_signal_history WHERE snapshot_date >= ? AND snapshot_date <= ? AND stablecoin_id = ?",
        matchBinds: [1_773_100_800, 1_773_273_600, "ust-terra"],
        rows: [],
        first: { cnt: 1 },
      },
      {
        match: "ORDER BY snapshot_date ASC, stablecoin_id ASC",
        matchBinds: [1_773_100_800, 1_773_273_600, "ust-terra"],
        rows: [{ stablecoin_id: "ust-terra", snapshot_date: 1_773_100_800 }],
      },
      {
        match: "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history WHERE stablecoin_id = ?",
        matchBinds: ["ust-terra"],
        rows: [],
        first: { min_day: 1_773_100_800 },
      },
      {
        match: "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history WHERE stablecoin_id = ? AND snapshot_date > ?",
        matchBinds: ["ust-terra", 1_773_273_600],
        rows: [],
        first: { min_day: null },
      },
    ]);
    const request = makeApiRequest(
      "/api/backfill-dews?repair=prune-history&dry-run=true&stablecoin=ust-terra&startDay=2026-03-10&endDay=2026-03-12",
      { adminKey: "secret" },
    );

    const response = await handleBackfillDEWS({ db, url: makeApiUrl(request.url), trustedAdmin: true, request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stablecoinId: string | null;
      candidateRowsSample: Array<{ stablecoinId: string; snapshotDate: number }>;
    };
    expect(body.stablecoinId).toBe("ust-terra");
    expect(body.candidateRowsSample).toEqual([{ stablecoinId: "ust-terra", snapshotDate: 1_773_100_800 }]);
  });

  it("deletes only the requested DEWS history window on POST prune repair", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));

    try {
    const db = mockD1([
      {
        match: "SELECT COUNT(*) as cnt FROM stress_signal_history WHERE snapshot_date >= ? AND snapshot_date <= ?",
        matchBinds: [1_773_014_400, 1_775_606_400],
        rows: [],
        first: { cnt: 4 },
      },
      {
        match: "ORDER BY snapshot_date ASC, stablecoin_id ASC",
        matchBinds: [1_773_014_400, 1_775_606_400],
        rows: [
          { stablecoin_id: "usdt-tether", snapshot_date: 1_773_014_400 },
          { stablecoin_id: "usdc-circle", snapshot_date: 1_773_100_800 },
        ],
      },
      {
        match: "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history",
        rows: [],
        first: { min_day: 1_772_323_200 },
      },
      {
        match: "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history WHERE snapshot_date > ?",
        matchBinds: [1_775_606_400],
        rows: [],
        first: { min_day: null },
      },
      {
        match: "DELETE FROM stress_signal_history WHERE snapshot_date >= ? AND snapshot_date <= ?",
        matchBinds: [1_773_014_400, 1_775_606_400],
        rows: [],
        runMeta: { changes: 4 },
      },
      {
        match: "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history",
        rows: [],
        first: { min_day: 1_772_323_200 },
      },
      {
        match: "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history WHERE snapshot_date > ?",
        matchBinds: [1_775_606_400],
        rows: [],
        first: { min_day: null },
      },
    ]);
    const request = makeApiRequest("/api/backfill-dews?repair=prune-history", {
      adminKey: "secret",
      method: "POST",
    });

    const response = await handleBackfillDEWS({ db, url: makeApiUrl(request.url), trustedAdmin: true, request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      repair: string;
      dryRun: boolean;
      prunedRows: number;
      usedDefaultWindow: boolean;
    };
    expect(body.repair).toBe("prune-history");
    expect(body.dryRun).toBe(false);
    expect(body.prunedRows).toBe(4);
    expect(body.usedDefaultWindow).toBe(true);
    expect(
      db.getHistory().some((entry) => entry.sql.includes("DELETE FROM stress_signal_history WHERE snapshot_date >= ? AND snapshot_date <= ?")),
    ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
