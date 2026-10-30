import { afterEach, describe, expect, it } from "vitest";
import { DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { loadPublishedDexPoolChallengers } from "../challenger-load";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { loaderFixtures, loaderScenario } from "./challenger-load.test-support";
import { loadDexPoolChallengers } from "../../../lib/depeg-helpers";
import { POOL_CHALLENGE_MIN_TVL } from "../../../lib/constants";
import { buildStoredChallengerPoolsJson } from "../challenger-publish";
import { filterRetainedPools } from "../scoring-helpers";
import type { PoolEntry } from "../types";
import { scorePoolGraph } from "./scoring-test-builders";

afterEach(() => loaderFixtures.closeAll());

describe("challenger load", () => {
  it("reads v2 head and exact payload coherently despite same-clock replacement and old-writer skew", async () => {
    const { db, sqlite, payload } = loaderScenario();
    payload(100, "old-worker");
    sqlite.exec(`INSERT INTO dex_price_challenger_publications_v2
      (publication_id, generation_id, snapshot_at, published_at, sealed)
      VALUES (1, 'liquidity', 100, 110, 1), (2, 'liquidity', 100, 120, 1);
      INSERT INTO dex_price_challenger_payloads_v2
      (publication_id, stablecoin_id, pool_id, chain, protocol, source_family, price_usd, tvl_usd, price_observed_at)
      VALUES (1, 'coin-a', 'accepted', 'Ethereum', 'curve', 'cg_onchain', 1, 20000, 90),
             (2, 'coin-a', 'staged', 'Base', 'balancer', 'dl', 0.9, 30000, 95);
      INSERT INTO dex_price_challenger_heads_v2 (stablecoin_id, publication_id, has_rows)
      VALUES ('coin-a', 1, 1);`);
    let switched = false;
    const reader = {
      ...db,
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.includes("SELECT heads.stablecoin_id")) return statement;
        const all = statement.all.bind(statement);
        statement.all = async <T>() => {
          const result = await all<T>();
          if (!switched) {
            sqlite.exec(`UPDATE dex_price_challenger_heads_v2 SET publication_id = 2;
              DELETE FROM dex_price_challenger_payloads_v2 WHERE publication_id = 1;
              UPDATE dex_price_challenger_snapshots SET snapshot_at = 200;`);
            payload(200, "new-old-worker");
            switched = true;
          }
          return result;
        };
        return statement;
      },
    } as D1Database;
    const first = await loadPublishedDexPoolChallengers(reader, 20_000, 1_000, 220);
    expect(first.challengersByStablecoin.get("coin-a")).toEqual([
      expect.objectContaining({ poolId: "accepted", sourceFamily: "cg_onchain", priceObservedAt: 90, snapshotAt: 100 }),
    ]);
    const next = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 220);
    expect(next.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["staged"]);
    expect((await loadDexPoolChallengers(db, 20_000, 1_000, 220)).get("coin-a")?.[0]?.observedAt).toBe(95);
    sqlite.exec("UPDATE dex_price_challenger_payloads_v2 SET price_observed_at = NULL WHERE publication_id = 2");
    expect((await loadDexPoolChallengers(db, 20_000, 1_000, 220)).get("coin-a")?.[0]?.observedAt).toBeUndefined();
    expect(next.diagnostics.legacyFallbackCoins).toEqual([]);
  });

  it("keeps v2 empty authoritative over old-writer rows, while missing, stale and incomplete v2 use explicit legacy fallback", async () => {
    const { db, sqlite, payload } = loaderScenario();
    payload(100, "old-worker");
    sqlite.exec(`INSERT INTO dex_price_challenger_publications_v2
      (publication_id, generation_id, snapshot_at, published_at, sealed)
      VALUES (1, 'liquidity', 100, 110, 1);
      INSERT INTO dex_price_challenger_heads_v2 (stablecoin_id, publication_id, has_rows)
      VALUES ('coin-a', 1, 0);`);
    const empty = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(empty.challengersByStablecoin.get("coin-a")).toEqual([]);
    expect(empty.diagnostics.emptyPublishedCoins).toEqual(["coin-a"]);
    sqlite.exec("UPDATE dex_price_challenger_heads_v2 SET has_rows = 1");
    const missing = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(missing.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["coin-a:legacy:Base"]);
    sqlite.exec("UPDATE dex_price_challenger_heads_v2 SET has_rows = 0, source_coverage_complete = 0");
    const incomplete = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(incomplete.diagnostics.incompletePublishedCoins).toEqual(["coin-a"]);
    expect(incomplete.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["coin-a:legacy:Base"]);
    const stale = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_101);
    expect(stale.diagnostics.staleSnapshotCoins).toEqual(["coin-a"]);
    expect(stale.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["coin-a:legacy:Base"]);
  });

  it("keeps a coherent generation when publication switches pointers and cleans old payloads", async () => {
    const { db, sqlite, payload } = loaderScenario();
    payload(100, "old");
    let published = false;
    const reader = {
      ...db,
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.includes("FROM dex_price_challenger_snapshots")) return statement;
        const all = statement.all.bind(statement);
        statement.all = async <T>() => {
          const result = await all<T>();
          if (!published) {
            payload(200, "new");
            sqlite.exec("UPDATE dex_price_challenger_snapshots SET snapshot_at = 200, published_at = 210; DELETE FROM dex_price_challengers WHERE snapshot_at = 100");
            published = true;
          }
          return result;
        };
        return statement;
      },
    } as D1Database;
    const result = await loadPublishedDexPoolChallengers(reader, 20_000, 1_000, 220);
    expect(published).toBe(true);
    expect(result.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["old"]);
    expect(result.diagnostics).toMatchObject({ mode: "published", legacyFallbackCoins: [] });
    expect((await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 220))
      .challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["new"]);
  });

  it("serves the exact freshness boundary but falls back one second later", async () => {
    const { db, payload } = loaderScenario();
    payload(100, "current");
    const fresh = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    const stale = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_101);
    expect(fresh.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["current"]);
    expect(fresh.diagnostics.staleSnapshotCoins).toEqual([]);
    expect(stale.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["coin-a:legacy:Base"]);
    expect(stale.diagnostics.staleSnapshotCoins).toEqual(["coin-a"]);
  });

  it("serves only the generation selected by the published pointer", async () => {
    const { db, payload } = loaderScenario();
    payload(99, "old", 0.5, 90_000);
    payload(100, "current");
    payload(101, "unpublished", 1.5, 100_000);
    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(result.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["current"]);
  });

  it("falls back for a missing payload generation but keeps an empty pointer authoritative", async () => {
    const { db, sqlite, payload } = loaderScenario();
    payload(99, "old");
    const missing = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(missing.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["coin-a:legacy:Base"]);
    sqlite.prepare("UPDATE dex_price_challenger_snapshots SET has_rows = 0").run();
    const empty = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(empty.challengersByStablecoin.get("coin-a")).toEqual([]);
    expect(empty.diagnostics.legacyFallbackCoins).toEqual([]);
  });

  it("filters invalid economics without replacing a complete generation with legacy data", async () => {
    const { db, sqlite, payload } = loaderScenario();
    payload(100, "zero", 0);
    payload(100, "negative", -1);
    payload(100, "nonfinite", Infinity);
    payload(100, "below-minimum", 1, 19_999);
    payload(100, "at-minimum", 1, 20_000);
    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(result.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["at-minimum"]);
    sqlite.prepare("DELETE FROM dex_price_challengers WHERE pool_id = 'at-minimum'").run();
    const filtered = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(filtered.challengersByStablecoin.get("coin-a")).toEqual([]);
    expect(filtered.diagnostics.legacyFallbackCoins).toEqual([]);
    expect(filtered.diagnostics.mode).toBe("published");
  });

  it("does not run the full legacy JSON load when published snapshots cover", async () => {
    const db = mockD1(
      [
        {
          match: "SELECT stablecoin_id\n     FROM dex_liquidity",
          rows: [],
        },
        {
          match: "SELECT stablecoin_id\n     FROM dex_prices",
          rows: [],
        },
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [
            {
              stablecoin_id: "coin-a",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 1,
              source_coverage_complete: 1,
              pool_id: "coin-a:published",
              chain: "Ethereum",
              protocol: "published-protocol",
              source_family: "published",
              price_usd: 0.998,
              tvl_usd: 50_000,
            },
          ],
        },
      ],
      { assertMatchesUsed: true },
    ) as MockD1Database;

    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120);

    expect(result.diagnostics.mode).toBe("published");
    expect(result.diagnostics.legacyFallbackCoins).toEqual([]);
    expect(result.challengersByStablecoin.get("coin-a")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-a",
        poolId: "coin-a:published",
        sourceFamily: "published",
        priceUsd: 0.998,
        tvlUsd: 50_000,
      }),
    ]);
    expect(
      db.getHistory().some((entry) =>
        entry.sql.includes("SELECT stablecoin_id, top_pools_json")
        || entry.sql.includes("SELECT stablecoin_id, price_sources_json"),
      ),
    ).toBe(false);
  });

  it("loads published challenger snapshots when present, falls back per coin, and keeps empty snapshots authoritative", async () => {
    const db = mockD1(
      [
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [
            {
              stablecoin_id: "coin-a",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 1,
              source_coverage_complete: 1,
              pool_id: "coin-a:published",
              chain: "Ethereum",
              protocol: "published-protocol",
              source_family: "published",
              price_usd: 0.998,
              tvl_usd: 50_000,
            },
            {
              stablecoin_id: "coin-b",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 0,
              source_coverage_complete: 1,
              pool_id: null,
            },
            {
              stablecoin_id: "coin-c",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 1,
              source_coverage_complete: 0,
              pool_id: "coin-c:published",
              chain: "Solana",
              protocol: "published-protocol",
              source_family: "published",
              price_usd: 0.996,
              tvl_usd: 30_000,
            },
          ],
        },
        {
          match: "FROM dex_liquidity",
          rows: [
            {
              stablecoin_id: "coin-b",
              top_pools_json: JSON.stringify([
                {
                  poolId: "coin-b:legacy-top",
                  chain: "Base",
                  project: "legacy-top",
                  tvlUsd: 45_000,
                  price: 0.991,
                },
              ]),
              updated_at: 100,
            },
            {
              stablecoin_id: "coin-c",
              top_pools_json: JSON.stringify([
                {
                  poolId: "coin-c:legacy-top",
                  chain: "Solana",
                  project: "legacy-top",
                  tvlUsd: 35_000,
                  price: 0.988,
                },
              ]),
              updated_at: 100,
            },
            {
              stablecoin_id: "coin-d",
              top_pools_json: JSON.stringify([
                {
                  poolId: "coin-d:legacy-top",
                  chain: "Ethereum",
                  project: "legacy-top",
                  tvlUsd: 25_000,
                  price: 0.985,
                },
              ]),
              updated_at: 100,
            },
          ],
        },
        {
          match: "FROM dex_prices",
          rows: [
            {
              stablecoin_id: "coin-e",
              price_sources_json: JSON.stringify([
                {
                  protocol: "legacy-source",
                  chain: "Arbitrum",
                  price: 0.982,
                  tvl: 60_000,
                },
              ]),
              updated_at: 100,
            },
          ],
        },
      ],
      { assertMatchesUsed: true },
    );

    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120);

    expect(result.diagnostics.mode).toBe("mixed");
    expect(result.diagnostics.emptyPublishedCoins).toEqual(["coin-b"]);
    expect(result.diagnostics.incompletePublishedCoins).toEqual(["coin-c"]);
    expect(new Set(result.diagnostics.legacyFallbackCoins)).toEqual(new Set(["coin-c", "coin-d", "coin-e"]));

    expect(result.challengersByStablecoin.get("coin-a")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-a",
        poolId: "coin-a:published",
        sourceFamily: "published",
        priceUsd: 0.998,
        tvlUsd: 50_000,
        snapshotAt: 100,
        publishedAt: 110,
      }),
    ]);
    expect(result.challengersByStablecoin.get("coin-b")).toEqual([]);
    expect(result.challengersByStablecoin.get("coin-c")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-c",
        poolId: "coin-c:legacy-top",
        sourceFamily: "legacy-top-pools",
        priceUsd: 0.988,
        tvlUsd: 35_000,
        snapshotAt: 100,
        publishedAt: 100,
      }),
    ]);
    expect(result.challengersByStablecoin.get("coin-d")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-d",
        poolId: "coin-d:legacy-top",
        sourceFamily: "legacy-top-pools",
        priceUsd: 0.985,
        tvlUsd: 25_000,
        snapshotAt: 100,
        publishedAt: 100,
      }),
    ]);
    expect(result.challengersByStablecoin.get("coin-e")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-e",
        poolId: "coin-e:legacy-source:Arbitrum",
        sourceFamily: "legacy-price-sources",
        priceUsd: 0.982,
        tvlUsd: 60_000,
        snapshotAt: 100,
        publishedAt: 100,
      }),
    ]);
  });

  it("keeps a qualifying large pool with no observed 24h flow when the published challenger snapshot is stale", async () => {
    const { sqlite, db } = loaderFixtures.open();
    const nowSec = 1_700_000_000;
    const staleSnapshotAt = nowSec - DEX_FRESHNESS_SEC - 60;
    const pool = (
      overrides: Partial<PoolEntry> & Pick<PoolEntry, "poolId" | "project" | "chain" | "tvlUsd">,
    ): PoolEntry => ({
      symbol: "USDC/USDT",
      volumeUsd1d: 500_000,
      volumeUsd7d: 3_500_000,
      poolType: "balancer-stable",
      source: "dl",
      price: 1,
      priceObservedAt: nowSec - 60,
      priceSource: "dl",
      ...overrides,
    });

    // Ten live pools with measured 24h flow outrank the dormant pool in the
    // display projection's volume ordering.
    const livePools = Array.from({ length: 10 }, (_, index) => pool({
      poolId: `base:0xlive${index}`,
      project: `live-dex-${index}`,
      chain: "Base",
      tvlUsd: 300_000,
      volumeUsd1d: 600_000 - index * 10_000,
      price: 0.9995,
    }));
    // Direct Aero state carries no trailing volume: null (unobserved), never a
    // measured zero. This is the largest retained pool and its quote is
    // depegged, so the >= $5M pool-challenger rule must still see it.
    const dormantPool = pool({
      poolId: "base:0xaero-dormant",
      project: "aerodrome-slipstream",
      chain: "Base",
      tvlUsd: 50_000_000,
      volumeUsd1d: null,
      volumeUsd7d: null,
      poolType: "aerodrome-slipstream",
      source: "direct_api",
      price: 0.9,
      priceSource: "direct_api",
    });

    // Retention, scoring and persistence projections are the production path:
    // scoring keeps filterRetainedPools -> rebuildMetricsFromPools and persists
    // the uncapped TVL-bounded challenger projection, not the display slice.
    const retainedPools = filterRetainedPools([...livePools, dormantPool]);
    expect(retainedPools.map((entry) => entry.poolId)).toContain(dormantPool.poolId);
    const metrics = scorePoolGraph({
      stablecoinId: "coin-a",
      symbol: "COINA",
      pools: retainedPools,
    });

    sqlite.prepare(
      `INSERT INTO dex_liquidity
         (stablecoin_id, symbol, total_tvl_usd, pool_count, top_pools_json,
          challenger_pools_json, updated_at)
       VALUES ('coin-a', 'COINA', ?, ?, ?, ?, ?)`,
    ).run(
      53_000_000,
      11,
      JSON.stringify(metrics.topPools.map(({ volumeReading: _volumeReading, ...entry }) => entry)),
      buildStoredChallengerPoolsJson("coin-a", retainedPools, POOL_CHALLENGE_MIN_TVL),
      nowSec - 60,
    );
    sqlite.prepare(
      `INSERT INTO dex_price_challenger_publications_v2
         (publication_id, generation_id, snapshot_at, published_at, sealed)
       VALUES (1, 'liquidity', ?, ?, 1)`,
    ).run(staleSnapshotAt, staleSnapshotAt + 30);
    sqlite.prepare(
      `INSERT INTO dex_price_challenger_heads_v2
         (stablecoin_id, publication_id, has_rows, source_coverage_complete)
       VALUES ('coin-a', 1, 1, 1)`,
    ).run();

    const challengers = await loadDexPoolChallengers(
      db,
      POOL_CHALLENGE_MIN_TVL,
      DEX_FRESHNESS_SEC,
      nowSec,
    );

    expect(challengers.get("coin-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        protocol: "aerodrome-slipstream",
        chain: "Base",
        price: 0.9,
        tvlUsd: 50_000_000,
      }),
    ]));
  });

  it("surfaces a missing mandatory challenger snapshot table", async () => {
    const db = mockD1(
      [
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [{
            stablecoin_id: "coin-z",
            snapshot_at: 100,
            published_at: 100,
            has_rows: 0,
            source_coverage_complete: 0,
          }],
          throwError: new Error("no such table: dex_price_challenger_snapshots"),
        },
      ],
      { assertMatchesUsed: true },
    );

    await expect(
      loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120),
    ).rejects.toThrow("no such table: dex_price_challenger_snapshots");
  });

  it("skips malformed legacy challenger JSON payloads", async () => {
    const db = mockD1(
      [
        {
          match: "SELECT stablecoin_id\n     FROM dex_liquidity",
          rows: [{ stablecoin_id: "coin-z" }],
        },
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [],
        },
        {
          match: "SELECT stablecoin_id, top_pools_json",
          rows: [
            {
              stablecoin_id: "coin-z",
              top_pools_json: "{bad-json",
              updated_at: 100,
            },
          ],
        },
        {
          match: "SELECT stablecoin_id, price_sources_json",
          rows: [
            {
              stablecoin_id: "coin-y",
              price_sources_json: "{bad-json",
              updated_at: 100,
            },
          ],
        },
      ],
      { assertMatchesUsed: true },
    );

    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120);

    expect(result.diagnostics.mode).toBe("absent");
    expect(result.challengersByStablecoin.size).toBe(0);
    const history = db.getHistory();
    const topPoolRead = history.find((entry) => entry.sql.includes("SELECT stablecoin_id, top_pools_json"));
    const priceSourceRead = history.find((entry) => entry.sql.includes("SELECT stablecoin_id, price_sources_json"));
    expect(topPoolRead?.binds).toEqual([-880]);
    expect(priceSourceRead?.binds).toEqual([-880]);
  });
});
