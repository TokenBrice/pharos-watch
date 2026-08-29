import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  findPublishedYieldRow,
  fixtureGetCache,
  fixtureMockD1,
  fixtureMockFetch,
  fixtureShouldAttemptFetch,
  fixtureSyncYieldData,
  fixtureYieldConfigModule,
  getYieldRankingsCachePayload,
  makeDb,
  resetSyncYieldDataTest,
  cleanupSyncYieldDataTest,
} from "./sync-yield-data.test-support";
import { cacheRow, installYieldCacheReader } from "./yield-cache.test-support";
import { makeDlYieldPool } from "./yield-resolve.test-support";
import {
  appendOptionalYieldCandidate,
  appendPoolFamilyYieldSources,
  type YieldCandidateAppendStatus,
} from "../yield-sync/resolve-helpers";
import { loadOndoOracleAnchorRow } from "../yield-sync/tracked-optional-source-registry";
import { loadTier1PrevRateRows } from "../yield-sync/resolve-tracked-sources";
import type { ResolvedYieldCandidate, ResolvedYieldEntry } from "../yield-sync/types";

// --- Full-sync publication sentinels ---

describe("syncYieldData publication sentinels", () => {
  beforeEach(resetSyncYieldDataTest);
  afterEach(cleanupSyncYieldDataTest);

  it("publishes a resolved curated source and marks it best in D1 and rankings cache", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb();
    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      "dl-stablecoin-pools": cacheRow([
        makeDlYieldPool({ apy: 6.5, apyBase: 6.5, apyMean30d: 6.3 }),
      ], nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    expect(result.itemCount).toBeGreaterThanOrEqual(1);
    const published = findPublishedYieldRow(db, "100", (row) => row.source_key === "pool-sdai-native");
    expect(published).toMatchObject({
      data_source: "defillama",
      is_best: 1,
    });

    const rankings = getYieldRankingsCachePayload(db) as {
      rankings: Array<{
        id: string;
        sourceKey?: string;
        sourceRisk?: { venueProtocol?: string | null; venueChain?: string | null } | null;
      }>;
    };
    expect(rankings.rankings.find((row) => row.id === "100")).toMatchObject({
      sourceRisk: { venueProtocol: "maker", venueChain: "Ethereum" },
    });
  });

  it("selects fresh curated evidence over a deterministic modeled proxy", async () => {
    const configs = fixtureYieldConfigModule.RATE_DERIVED_CONFIGS as typeof fixtureYieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({
      stablecoinId: "100",
      spreadBps: 25,
      label: "T-bill proxy (net of 0.25% fee)",
    });

    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const db = makeDb();
      installYieldCacheReader(vi.mocked(fixtureGetCache), {
        risk_free_rate: cacheRow("5.0", nowSec),
        "dl-stablecoin-pools": cacheRow([
          makeDlYieldPool({ apy: 4.5, apyBase: 4.5, apyMean30d: 4.5 }),
        ], nowSec),
      });
      vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
      fixtureMockFetch([]);

      const result = await fixtureSyncYieldData(db);

      expect(result.itemCount).toBeGreaterThanOrEqual(2);
      const curated = findPublishedYieldRow(db, "100", (row) => row.source_key === "pool-sdai-native");
      const modeled = findPublishedYieldRow(db, "100", (row) => row.source_key === "rate-derived");
      expect(curated).toMatchObject({ is_best: 1, data_source: "defillama" });
      expect(modeled).toMatchObject({ is_best: 0, data_source: "rate-derived" });
    } finally {
      configs.length = 0;
    }
  });

  it("keeps the cron healthy when an optional source stalls past its budget", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb();
    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      "dl-stablecoin-pools": cacheRow([
        makeDlYieldPool({ apy: 6.5, apyBase: 6.5, apyMean30d: 6.3 }),
      ], nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([
      {
        match: () => true,
        respond: (request) => request.url.includes("api-v2.pendle.finance")
          ? { stall: true }
          : { body: { error: "Not found" }, status: 404, headers: { "Content-Type": "application/json" } },
      },
    ], { requireMatch: true });

    const resultPromise = fixtureSyncYieldData(db);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(result.status).not.toBe("error");
    expect(result.itemCount).toBeGreaterThanOrEqual(1);
    expect(findPublishedYieldRow(db, "100", (row) => row.source_key === "pool-sdai-native")).toBeDefined();
  });
});

// --- Tracked-source query contracts ---

describe("tracked optional source anchors", () => {
  it("loads deterministic on-chain anchors with one bounded query per candidate", async () => {
    const sevenDaysAgoSec = 1_747_000_000;
    const db = fixtureMockD1([
      {
        match: "pharos:yield-sync:tier1-previous-rate",
        matchBinds: ["usde-ethena", sevenDaysAgoSec],
        rows: [],
        first: { exchange_rate: 1.07, recorded_at: sevenDaysAgoSec - 3 },
      },
      {
        match: "pharos:yield-sync:tier1-previous-rate",
        matchBinds: ["100", sevenDaysAgoSec],
        rows: [],
        first: { exchange_rate: 1.01, recorded_at: sevenDaysAgoSec - 9 },
      },
    ], { requireMatch: true });

    const rows = await loadTier1PrevRateRows(db, ["usde-ethena", "100"], sevenDaysAgoSec);

    expect(rows.get("usde-ethena")).toEqual({ exchangeRate: 1.07, recordedAt: sevenDaysAgoSec - 3 });
    expect(rows.get("100")).toEqual({ exchangeRate: 1.01, recordedAt: sevenDaysAgoSec - 9 });
    const queries = db.getHistory().filter((entry) => entry.sql.includes("pharos:yield-sync:tier1-previous-rate"));
    expect(queries).toHaveLength(2);
    expect(queries.map((entry) => entry.binds)).toEqual([
      ["usde-ethena", sevenDaysAgoSec],
      ["100", sevenDaysAgoSec],
    ]);
    expect(queries.every((entry) => entry.sql.includes("stablecoin_id = ?"))).toBe(true);
    expect(queries.every((entry) => !entry.sql.includes("stablecoin_id IN"))).toBe(true);
    expect(queries.every((entry) => entry.sql.includes("ORDER BY recorded_at DESC"))).toBe(true);
    expect(queries.every((entry) => entry.sql.includes("LIMIT 1"))).toBe(true);
    expect(
      queries.every((entry) =>
        entry.sql.includes("publication_generation_id IS NULL OR publication_state = 'published'"),
      ),
    ).toBe(true);
    db.assertAllMatchesUsed();
  });

  it("ignores unpublished deterministic on-chain anchor rows when selecting prior rates", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const insertHistory = sqlite.prepare(
        `INSERT INTO yield_history (
          stablecoin_id, source_key, apy, data_source,
          exchange_rate, recorded_at, publication_generation_id, publication_state
        ) VALUES (?, 'tier1-anchor', 0, 'defillama', ?, ?, ?, ?)`,
      );
      const sevenDaysAgoSec = 1_747_000_000;
      insertHistory.run("100", 1.09, sevenDaysAgoSec - 1, "gen-failed", "failed");
      insertHistory.run("100", 1.08, sevenDaysAgoSec - 2, "gen-staged", "staged");
      insertHistory.run("100", 1.07, sevenDaysAgoSec - 3, "gen-published", "published");
      insertHistory.run("100", 1.06, sevenDaysAgoSec - 4, null, null);

      const rows = await loadTier1PrevRateRows(createSqliteD1(sqlite), ["100"], sevenDaysAgoSec);

      expect(rows.get("100")?.exchangeRate).toBe(1.07);
    } finally {
      sqlite.close();
    }
  });

  it("filters Ondo oracle anchors to legacy or published yield history rows", async () => {
    const nowSec = 1_747_000_000;
    const db = fixtureMockD1([{ match: "FROM yield_history", rows: [], first: null }], { requireMatch: true });

    await loadOndoOracleAnchorRow(db, nowSec);

    const anchorQueries = db.getHistory().filter((entry) => entry.sql.includes("FROM yield_history"));
    expect(anchorQueries).toHaveLength(2);
    expect(
      anchorQueries.every((entry) =>
        entry.sql.includes("publication_generation_id IS NULL OR publication_state = 'published'"),
      ),
    ).toBe(true);
  });

  it("ignores unpublished Ondo oracle anchor rows when selecting prior exchange rates", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const insertHistory = sqlite.prepare(
        `INSERT INTO yield_history (
          stablecoin_id, source_key, apy, data_source, exchange_rate, recorded_at,
          publication_generation_id, publication_state
        ) VALUES (?, ?, 0, 'defillama', ?, ?, ?, ?)`,
      );
      const nowSec = 1_747_000_000;
      insertHistory.run("usdy-ondo-finance", "protocol-api:ondo-usdy-oracle", 1.09, nowSec - 8 * 86_400, "gen-failed", "failed");
      insertHistory.run("usdy-ondo-finance", "protocol-api:ondo-usdy-oracle", 1.08, nowSec - 9 * 86_400, "gen-staged", "staged");
      insertHistory.run("usdy-ondo-finance", "protocol-api:ondo-usdy-oracle", 1.07, nowSec - 10 * 86_400, "gen-published", "published");
      insertHistory.run("usdy-ondo-finance", "protocol-api:ondo-usdy-oracle", 1.06, nowSec - 11 * 86_400, null, null);

      const row = await loadOndoOracleAnchorRow(createSqliteD1(sqlite), nowSec);

      expect(row?.exchange_rate).toBe(1.07);
    } finally {
      sqlite.close();
    }
  });
});

// --- Direct resolve-helper contracts ---

describe("auto-lending safety availability", () => {
  const usdcPool = makeDlYieldPool({
    pool: "pool-usdc-aave",
    project: "aave-v3",
    symbol: "USDC",
    tvlUsd: 10_000_000,
    apy: 3.5,
    apyBase: 3.5,
    apyMean30d: 3.4,
  });

  it("retains eligible lending candidates as unrated when the expected safety snapshot is unavailable", () => {
    const resolved: ResolvedYieldEntry[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const autoLendingPoolMap = fixtureYieldConfigModule.AUTO_LENDING_POOL_MAP as Record<string, string>;
    autoLendingPoolMap["usdc-circle"] = "pool-usdc-aave";

    try {
      appendPoolFamilyYieldSources({
        resolved,
        dlPools: [usdcPool],
        supplementalCandidates: [],
        safetyScores: new Map(),
        safetySnapshotAvailable: false,
        stablecoinSupplyById: new Map(),
      });

      expect(resolved).toEqual([
        expect.objectContaining({
          id: "usdc-circle",
          yield: expect.objectContaining({
            sourceKey: "pool-usdc-aave",
            dataSource: "defillama-auto",
          }),
        }),
      ]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("V9 safety snapshot unavailable"));
    } finally {
      delete autoLendingPoolMap["usdc-circle"];
      warnSpy.mockRestore();
    }
  });

  it("preserves the safety threshold for an available V9 snapshot", () => {
    const resolved: ResolvedYieldEntry[] = [];

    appendPoolFamilyYieldSources({
      resolved,
      dlPools: [usdcPool],
      supplementalCandidates: [],
      safetyScores: new Map([["usdc-circle", { score: 49, grade: "D" }]]),
      safetySnapshotAvailable: true,
      stablecoinSupplyById: new Map(),
    });

    expect(resolved).toHaveLength(0);
  });
});

describe("appendOptionalYieldCandidate", () => {
  function makeEntry(overrides: Partial<ResolvedYieldCandidate> = {}): ResolvedYieldCandidate {
    return {
      symbol: "USDe",
      yield: {
        currentApy: 3.2,
        apyBase: 3.2,
        apyReward: null,
        sourcePool: "pool-optional",
        sourceTvlUsd: 10_000_000_000,
        dataSource: "protocol-api",
        exchangeRate: null,
        sourceKey: "pool-optional",
        yieldType: "lending-opportunity",
        project: "proto",
        yieldSource: "aave-v3",
      },
      ...overrides,
    };
  }

  function makeCandidateInput(input: {
    resolved?: ResolvedYieldEntry[];
    stablecoinId?: string;
    chain?: string;
    yield?: Partial<ResolvedYieldCandidate["yield"]>;
    meta?: { id: string; symbol: string; contracts: Array<{ chain: string }> } | null;
    supply?: number | null;
  } = {}): Parameters<typeof appendOptionalYieldCandidate>[0] {
    const stablecoinId = input.stablecoinId ?? "usde-ethena";
    return {
      resolved: input.resolved ?? [],
      entry: makeEntry({
        stablecoinId,
        ...(input.chain ? { chain: input.chain } : {}),
        yield: {
          ...makeEntry({ stablecoinId }).yield,
          ...input.yield,
        },
      }),
      meta: input.meta === undefined
        ? { id: stablecoinId, symbol: "USDe", contracts: [{ chain: "ethereum" }] }
        : input.meta,
      stablecoinSupplyById: input.supply === undefined
        ? new Map([[stablecoinId, 2_000_000]])
        : input.supply === null
          ? new Map()
          : new Map([[stablecoinId, input.supply]]),
    };
  }

  const cases: Array<{
    label: string;
    input?: Parameters<typeof makeCandidateInput>[0];
    expected: YieldCandidateAppendStatus;
    expectedLength: number;
  }> = [
    {
      label: "returns appended when a candidate is accepted",
      input: { chain: "base" },
      expected: "appended",
      expectedLength: 1,
    },
    {
      label: "returns duplicate when an identical source key already exists",
      input: {
        resolved: [{
          id: "usde-ethena",
          symbol: "USDe",
          yield: {
            currentApy: 3.2,
            apyBase: 3.2,
            apyReward: null,
            sourcePool: "pool-optional",
            sourceTvlUsd: 1_000,
            dataSource: "protocol-api",
            exchangeRate: null,
            sourceKey: "pool-optional",
          },
        }],
        yield: { sourceKey: "pool-optional", sourceTvlUsd: 10_000_000_000 },
      },
      expected: "duplicate",
      expectedLength: 1,
    },
    {
      label: "returns size-gated when lending opportunity TVL fails threshold",
      input: { yield: { sourceTvlUsd: 1 } },
      expected: "size-gated",
      expectedLength: 0,
    },
    {
      label: "returns size-gated when fixed-yield TVL fails the external opportunity threshold",
      input: {
        yield: {
          sourceKey: "protocol-api:pendle:ethereum:0xpool",
          yieldSource: "Pendle fixed yield: USDe",
          yieldType: "fixed-yield",
          sourceTvlUsd: 1,
        },
      },
      expected: "size-gated",
      expectedLength: 0,
    },
    {
      label: "returns missing-meta when no stablecoin metadata is available",
      input: { yield: { sourceTvlUsd: 10_000_000_000 }, meta: null, supply: null },
      expected: "missing-meta",
      expectedLength: 0,
    },
  ];

  it.each(cases)("$label", ({ input, expected, expectedLength }) => {
    const resolved = input?.resolved ?? [];
    const status = appendOptionalYieldCandidate(makeCandidateInput({ ...input, resolved }));

    expect(status).toBe(expected);
    expect(resolved).toHaveLength(expectedLength);
    if (expected === "appended") {
      expect(resolved[0]?.yield?.chain).toBe("base");
    }
  });
});
