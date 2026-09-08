import { mintBurnScenario } from "../../test-helpers/__shared/mint-burn";

export function makeFlowHourlyRow(nowSec: number) {
  return {
    stablecoin_id: "usdt-tether", chain_id: "ethereum", hour_ts: nowSec - 3600,
    mint_count: 5, burn_count: 3, mint_volume_usd: 10000, burn_volume_usd: 5000, net_flow_usd: 5000,
  };
}

export function makeValidCachedAggregateFixture(updatedAt: number, safetyScoreIdentity: unknown) {
  return {
    gauge: {
      score: 10, band: "BUYING", intensitySemantics: "signed-v2", flightToQuality: true,
      flightIntensity: 20, classificationSource: "safety-score-v9-publication", safetyScoreIdentity,
      trackedCoins: 1, trackedMcapUsd: 1,
    },
    coins: [], hourly: [], updatedAt: updatedAt - 60,
    sync: {
      lastSuccessfulSyncAt: updatedAt - 120, freshnessStatus: "fresh", warning: null,
      classificationWarning: null, criticalLaneHealthy: true,
    },
  };
}

export function makeFlowFallbackScenario(nowSec: number, value: string, hours = 24) {
  const flowCache = { key: `mint-burn-flows:v3:aggregate:${hours}`, value, updatedAt: nowSec };
  const state = { cacheReads: 0, hourlyFailed: false };
  const queryFailure = new Error("simulated hourly execution failure");
  const db = mintBurnScenario({ nowSec, flowCache, overrides: [{
    match: "FROM mint_burn_hourly", rows: [],
    get throwError() { state.hourlyFailed = true; return queryFailure; },
  }] });
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes("SELECT value, updated_at FROM cache WHERE key = ?")) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...args: unknown[]) => {
      const bound = bind(...args);
      if (args[0] !== flowCache.key) return bound;
      const first = bound.first.bind(bound);
      bound.first = (async (...firstArgs: unknown[]) => {
        state.cacheReads += 1;
        return state.cacheReads === 1 ? null : first(...firstArgs as []);
      }) as typeof bound.first;
      return bound;
    };
    return statement;
  };
  return { db, state };
}
