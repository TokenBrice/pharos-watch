import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 as baseMockD1 } from "@shared/test-utils/mock-d1";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeYieldRanking, makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import { buildStatusMessage } from "../telegram-webhook-messages";
import { loadStatusForCoin } from "../telegram-webhook-status";
import { buildDewsStablecoinIdsDigest } from "../../../lib/dews-publication-pointer";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../../test-helpers/report-cards-v9";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";

const mocks = vi.hoisted(() => ({
  loadActiveSafetyScoreSource: vi.fn(),
  handleYieldRankings: vi.fn(),
}));

vi.mock("../../../lib/safety-score-index", () => ({
  loadActiveSafetyScoreIndex: mocks.loadActiveSafetyScoreSource,
}));

vi.mock("../../../api/yield-rankings-cache", () => ({
  handleYieldRankings: mocks.handleYieldRankings,
}));

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "FROM dex_liquidity", rows: [], first: null },
    { match: "FROM depeg_events WHERE stablecoin_id = ?", rows: [], first: null },
    { match: "FROM yield_data", rows: [], first: null },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  ], options);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("loadStatusForCoin", () => {
  it("withholds invalid DEX coverage with an explicit reason", async () => {
    const row = { liquidity_score: 91, total_tvl_usd: 100, updated_at: 123,
      coverage_class: "primary", coverage_confidence: 1.1 };
    const status = await loadStatusForCoin(mockD1([
      { match: "FROM dex_liquidity", rows: [row], first: row },
    ]), "usdc-circle");
    expect(status.liquidity).toBeNull();
    expect(status.liquidityUnavailableReason).toBe("invalid-coverage-evidence");
  });

  it("withholds an unobserved DEX placeholder row instead of publishing DEX liquidity $0", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    // The published row the DEX pipeline writes for a tracked coin with no
    // observed pools: zero TVL, no score, unobserved coverage at confidence 0.
    const row = { liquidity_score: null, total_tvl_usd: 0, updated_at: nowSec - 60,
      coverage_class: "unobserved", coverage_confidence: 0 };
    const status = await loadStatusForCoin(mockD1([
      { match: "FROM dex_liquidity", rows: [row], first: row },
    ]), "aa-falconx-mev-capital");

    expect(status.liquidity).toBeNull();
    expect(status.liquidityUnavailableReason).toBe("unobserved-liquidity");
    const message = buildStatusMessage("AA_FalconXUSDC", status, nowSec);
    expect(message).toContain("DEX liquidity not available right now");
    expect(message).not.toContain("DEX liquidity $0");
  });

  it("does not resurrect a quote the current stablecoins publication withheld", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    // The publication revalidated this run's provider candidate and cleared the
    // asset's price; only the replay cache still carries the previous quote.
    const publicationRow = {
      value: JSON.stringify({
        peggedAssets: [{
          id: "usdc-circle",
          symbol: "USDC",
          price: null,
          priceSource: null,
          priceConfidence: null,
          priceUpdatedAt: null,
          priceObservedAt: null,
          priceObservedAtMode: null,
          circulating: { peggedUSD: 60_000_000_000 },
          supplyObservedAt: nowSec - 120,
        }],
      }),
      updated_at: nowSec - 60,
    };
    const staleCacheRow = {
      price: 0.98,
      updated_at: nowSec - 3600,
      source: "coingecko",
      confidence: "single-source",
      observed_at: nowSec - 3600,
    };
    const db = mockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [publicationRow], first: publicationRow },
      // Present only to prove the withdrawn cache quote is not read.
      { match: "FROM price_cache WHERE asset_id = ?", rows: [staleCacheRow], first: staleCacheRow, allowUnused: true },
    ]);

    const status = await loadStatusForCoin(db, "usdc-circle");

    expect(status.priceUsd).toBeNull();
    expect(status.priceUpdatedAt).toBeNull();
    const card = buildStatusMessage("USDC", status, nowSec);
    expect(card).toContain("no recent price");
    expect(card).not.toContain("$0.9800");
  });

  beforeEach(() => {
    mocks.handleYieldRankings.mockReset().mockImplementation(async () =>
      new Response(JSON.stringify({
        rankings: [makeYieldRanking({ pharosYieldScore: 73 })],
        riskFreeRate: 4.25,
        scalingFactor: 8,
        medianApy: 5,
        updatedAt: 123,
      })),
    );
  });
  beforeEach(() => {
    const snapshot = makeWorkerReportCardsV9Response({
      asOfSec: 122,
      updatedAt: 123,
      cards: [
        makeWorkerV9Card({
          id: "usdc-circle",
          grade: "B+",
          score: 66,
        }),
      ],
    });
    mocks.loadActiveSafetyScoreSource.mockReset().mockResolvedValue({
      kind: "v9",
      snapshot,
    });
  });

  it("returns DEWS + safety + depeg=stable when no active event", async () => {
    const stablecoinsRow = {
      value: JSON.stringify({
        peggedAssets: [{
          id: "usdc-circle",
          symbol: "USDC",
          price: 0.9997,
          priceSource: "coingecko",
          priceConfidence: "high",
          priceObservedAt: 1_700_000_000,
          priceUpdatedAt: 1_700_000_000,
          priceObservedAtMode: "upstream",
        }],
      }),
      updated_at: 1_700_000_000,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?", matchBinds: ["dews:published-generation"],
        rows: [{
          value: JSON.stringify({ updatedAt: 1700000000, source: "compute-dews", publishStatus: "published" }),
          updated_at: 1700000000,
        }],
      },
      { match: "FROM stress_signals", rows: [{ band: "ALERT", score: 42, computed_at: 1700000000 }] },
      { match: "FROM safety_grade_history", rows: [{ grade: "B+", score: 66, recorded_at: 1700000000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [stablecoinsRow], first: stablecoinsRow },
    ]);
    const status = await loadStatusForCoin(db, "usdc-circle");
    expect(status.dews?.band).toBe("ALERT");
    expect(status.safety?.grade).toBe("B+");
    expect(status.safety?.model).toBe("v9");
    expect(status.safety?.publicationGenerationId).toBe("report-cards:v9:1");
    expect(status.depeg.status).toBe("stable");
    expect(status.priceUsd).toBeCloseTo(0.9997);
  });

  it("uses an exact published DEWS row instead of an older latest-table row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const publishedAt = nowSec - 60;
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: publishedAt,
        source: "compute-dews",
        publishStatus: "published",
        coverageVersion: 2,
        expectedRowCount: 2,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdc-circle", "usdt-tether"]),
      }),
      updated_at: publishedAt,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "pharos:stress-signals:latest-one",
        matchBinds: ["usdc-circle", publishedAt],
        rows: [{ band: "CALM", score: 5, signals_json: "{}", computed_at: publishedAt - 60 }],
      },
      {
        match: "pharos:stress-signals:published-exact-one",
        matchBinds: ["usdc-circle", publishedAt],
        rows: [{ band: "WARNING", score: 72, signals_json: "{}", computed_at: publishedAt }],
      },
    ]);

    const status = await loadStatusForCoin(db, "usdc-circle");

    expect(status.dews).toEqual({ band: "WARNING", score: 72, computedAt: publishedAt });
    expect(db.getHistory().some((entry) => entry.sql.includes("legacy-latest-one"))).toBe(false);
  });

  it("surfaces an active depeg event with direction and deviation", async () => {
    const db = mockD1([
      { match: "FROM safety_grade_history", rows: [{ grade: "A", score: 80, recorded_at: 1700000000 }] },
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL",
        rows: [{ direction: "below", peak_deviation_bps: 180, started_at: 1700000000, peg_reference: 1.0 }],
      },
    ]);
    const status = await loadStatusForCoin(db, "usdc-circle");
    expect(status.depeg.status).toBe("active");
    if (status.depeg.status === "active") {
      expect(status.depeg.direction).toBe("below");
      expect(status.depeg.peakDeviationBps).toBe(180);
    }
  });

  it("handles a fully unseeded coin gracefully (null everywhere)", async () => {
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
    ]);
    const status = await loadStatusForCoin(db, "newcoin-xyz");
    expect(status.dews).toBeNull();
    expect(status.safety).toBeNull();
    expect(status.priceUsd).toBeNull();
    expect(status.yield).toBeNull();
    expect(status.yieldUnavailableReason).toBe("yield-ranking-not-found");
    expect(status.depeg.status).toBe("stable");
  });

  it("fails closed when canonical safety identity is unavailable", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValueOnce({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      detail: "missing",
      snapshot: null,
    });
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
    ]);

    const status = await loadStatusForCoin(db, "usdc-circle");

    expect(status.safety).toBeNull();
    expect(status.safetyUnavailableReason).toBe("v9-snapshot-unavailable");
    expect(db.getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
  });

  it("keeps missing supply unavailable and marks 30-day-old DEX liquidity not current", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const stablecoinsRow = {
      value: JSON.stringify({ peggedAssets: [{ id: "usdc-circle", symbol: "USDC", circulating: {} }] }),
      updated_at: nowSec - 60,
    };
    const liquidityRow = { liquidity_score: 91, total_tvl_usd: 123_000_000, updated_at: nowSec - 30 * 86_400 };
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [stablecoinsRow], first: stablecoinsRow },
      { match: "FROM dex_liquidity", rows: [liquidityRow], first: liquidityRow },
    ]);

    const status = await loadStatusForCoin(db, "usdc-circle");

    expect(status.supplyUsd).toBeNull();
    expect(status.supplyCurrent).toBe(true);
    expect(status.liquidity).toMatchObject({ score: 91, updatedAt: nowSec - 30 * 86_400, current: false });
  });

  it("reports an explicit zero supply with its observation clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const stablecoinsRow = {
      value: JSON.stringify({ peggedAssets: [{ id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 0 } }] }),
      updated_at: nowSec - 60,
    };
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [stablecoinsRow], first: stablecoinsRow },
    ]);

    const status = await loadStatusForCoin(db, "usdc-circle");

    expect(status).toMatchObject({ supplyUsd: 0, supplyObservedAt: nowSec - 60, supplyCurrent: true });
  });

  it("takes APY, venue, PYS and observation evidence from one canonical row despite a different raw best source", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const observedAt = 1_792_000_000;
    const ranking = makeYieldRanking({
      currentApy: 4.4, apy30d: 4.2, yieldSource: "Canonical venue", pharosYieldScore: 73,
      provenance: makeYieldProvenance({ sourceObservedAt: observedAt, sourceAgeSeconds: 60,
        sourceMaxAgeSeconds: 7200, sourceFreshness: "fresh" }),
    });
    mocks.handleYieldRankings.mockImplementationOnce(async () => new Response(JSON.stringify({
      rankings: [ranking], riskFreeRate: 4.25, scalingFactor: 8, medianApy: 4.2, updatedAt: observedAt + 60,
    })));
    try {
      sqlite.prepare(`INSERT INTO yield_data (
        stablecoin_id, source_key, symbol, is_best, current_apy, apy_7d, apy_30d, yield_source,
        yield_type, data_source, pharos_yield_score, updated_at, publication_generation_id, publication_state
      ) VALUES ('usdc-circle', 'raw-source', 'USDC', 1, 99, 99, 99, 'Raw venue',
        'lending', 'defillama', 999, ?, NULL, 'published')`).run(observedAt);
      const status = await loadStatusForCoin(createSqliteD1(sqlite), "usdc-circle");
      expect(status.yield).toMatchObject({
        currentApy: 4.4, apy30d: 4.2, source: "Canonical venue", pharosYieldScore: 73,
        pysUnavailableReason: null,
        provenance: { sourceObservedAt: observedAt, sourceAgeSeconds: 60, sourceFreshness: "fresh" },
      });
      expect(mocks.handleYieldRankings).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["missing cache", () => new Response("unavailable", { status: 503 }), "yield-rankings-unavailable"],
    ["missing accepted row", () => new Response(JSON.stringify({
      rankings: [], riskFreeRate: 4.25, scalingFactor: 8, medianApy: 0, updatedAt: 123,
    })), "yield-ranking-not-found"],
    ["malformed cache", () => new Response("{}"), "yield-rankings-malformed"],
  ] as const)("withholds seven-day-old generationless yield with %s", async (_label, response, reason) => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    mocks.handleYieldRankings.mockImplementationOnce(async () => response());
    try {
      sqlite.prepare(`INSERT INTO yield_data
        (stablecoin_id, source_key, symbol, is_best, current_apy, apy_7d, apy_30d,
         yield_source, yield_type, data_source, updated_at, publication_generation_id)
        VALUES ('usdc-circle', 'legacy', 'USDC', 1, 99, 99, 99, 'Legacy venue',
          'lending', 'defillama', ?, NULL)`).run(Math.floor(Date.now() / 1000) - 7 * 86400);
      const status = await loadStatusForCoin(createSqliteD1(sqlite), "usdc-circle");
      expect(status.yield).toBeNull();
      expect(status.yieldUnavailableReason).toBe(reason);
    } finally {
      sqlite.close();
    }
  });
});
