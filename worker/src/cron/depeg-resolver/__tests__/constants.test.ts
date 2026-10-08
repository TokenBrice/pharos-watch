import { describe, expect, it } from "vitest";
import {
  CURRENT_PRICE_MAX_AGE_SEC,
  DDR_SNAPSHOT_TTL_SEC,
  DEWS_MAX_AGE_SEC,
  DEX_LIQUIDITY_MAX_AGE_SEC,
  TRAINING_WINDOW_SEC,
} from "../constants";
import { buildCurrentDeviationMap, emptyDdrLineage } from "../context";
import { buildDiagnosticSnapshot, buildDdrResponse } from "../public-projection";
import { resolveDdrIncidents } from "../incident-resolution";
import { activeInput, loadedContext, mockResolverD1, NOW_SEC, stablecoinsCache } from "./depeg-resolver.test-support";

describe("resolver source-owned time budgets", () => {
  it.each([0, 1])("admits producer-cadence current prices inclusively and rejects age budget + %s", async (extraAge) => {
    const updatedAt = NOW_SEC - CURRENT_PRICE_MAX_AGE_SEC - extraAge;
    const db = mockResolverD1([stablecoinsCache(updatedAt)]);
    const result = await buildCurrentDeviationMap(db, NOW_SEC);
    expect(result.dataAsOf).toBe(updatedAt);
    if (extraAge === 0) {
      expect(result.healthy).toBe(true);
      expect(result.degradedReason).toBeNull();
      expect(result.byCoin.get("usdc-circle")).toBe(-300);
    } else {
      expect(result.healthy).toBe(false);
      expect(result.degradedReason).toBe("stablecoins-cache-stale");
      expect(result.byCoin.size).toBe(0);
    }
  });

  it("carries the training window and publication TTL into diagnostic and public snapshots", () => {
    const lineage = emptyDdrLineage(NOW_SEC);
    expect(lineage.trainingWindow).toEqual({ start: NOW_SEC - TRAINING_WINDOW_SEC, end: NOW_SEC });
    const diagnostic = buildDiagnosticSnapshot({ rows: [], lineage, nowSec: NOW_SEC });
    const published = buildDdrResponse({ candidateRows: [], incidentsByEventId: new Map(), sealed: [], firstPublication: [],
      manifest: null, errata: [], lineage, nowSec: NOW_SEC });
    for (const snapshot of [diagnostic, published]) {
      expect(snapshot._meta.computedAt).toBe(NOW_SEC);
      expect(snapshot._meta.expiresAt).toBe(NOW_SEC + DDR_SNAPSHOT_TTL_SEC);
      expect(snapshot._meta.lineage?.trainingWindow).toEqual(lineage.trainingWindow);
    }
  });

  it.each([0, 1])("expires DEWS and liquidity context at each source budget + %s", (extraAge) => {
    const active = activeInput();
    const context = loadedContext({
      dewsByCoin: new Map([[active.stablecoinId, {
        stablecoin_id: active.stablecoinId, score: 80, band: "DANGER", signals_json: "{}",
        computed_at: NOW_SEC - DEWS_MAX_AGE_SEC - extraAge,
      }]]),
      liqByCoin: new Map([[active.stablecoinId, {
        stablecoin_id: active.stablecoinId, liquidity_score: 10, concentration_hhi: 0.9,
        total_tvl_usd: 10, total_volume_24h_usd: 5, updated_at: NOW_SEC - DEX_LIQUIDITY_MAX_AGE_SEC - extraAge,
      }]]),
    });
    const [row] = resolveDdrIncidents(context, NOW_SEC);
    expect(row.relatedContext.dewsScore).toBe(extraAge === 0 ? 80 : null);
    expect(row.relatedContext.dewsBand).toBe(extraAge === 0 ? "DANGER" : null);
    expect(row.relatedContext.liquidityScore).toBe(extraAge === 0 ? 10 : null);
  });
});
