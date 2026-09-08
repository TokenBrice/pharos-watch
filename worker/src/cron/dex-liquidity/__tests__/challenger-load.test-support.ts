import { createLatestSchemaFixtureTracker } from "../../../test-helpers/latest-schema-sqlite";

export const loaderFixtures = createLatestSchemaFixtureTracker();

export function loaderScenario(snapshotAt = 100, hasRows = 1) {
  const harness = loaderFixtures.open();
  harness.sqlite.prepare(`INSERT INTO dex_price_challenger_snapshots
    (stablecoin_id, snapshot_at, published_at, has_rows, source_coverage_complete)
    VALUES ('coin-a', ?, 110, ?, 1)`).run(snapshotAt, hasRows);
  harness.sqlite.prepare(`INSERT INTO dex_prices
    (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl, price_sources_json, updated_at)
    VALUES ('coin-a', 'A', 0.98, 1, 50000, ?, 1100)`).run(JSON.stringify([
    { protocol: "legacy", chain: "Base", price: 0.98, tvl: 50_000 },
  ]));
  const payload = (generation: number, poolId: string, price = 1, tvl = 20_000) => {
    harness.sqlite.prepare(`INSERT INTO dex_price_challengers
      (stablecoin_id, snapshot_at, pool_id, chain, protocol, source_family, price_usd, tvl_usd)
      VALUES ('coin-a', ?, ?, 'Ethereum', 'curve', 'published', ?, ?)`).run(generation, poolId, price, tvl);
  };
  return { ...harness, payload };
}
