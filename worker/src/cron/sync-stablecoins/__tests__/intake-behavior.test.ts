import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { loadStablecoinsIntake } from "../intake";
import * as supplemental from "../supplemental-assets";
import * as reconciliation from "../supply-gap-reconciliation";
import * as transport from "../../../lib/fetch-retry";
import * as circuit from "../../../lib/circuit-breaker";
import { CIRCUIT_SOURCE, MIN_VALID_ASSET_COUNT } from "../../../lib/constants";
import { makePeggedAsset } from "./_fixtures";

const fixtures = createLatestSchemaFixtureTracker();
const cgData = { "fixture-usd": { usd: 1, usd_market_cap: 100, last_updated_at: 1_777_000_000 } };
const fallbackResult = { status: "degraded" as const, itemCount: 0, metadata: "fallback unavailable" };
beforeEach(() => {
  vi.spyOn(supplemental, "fetchCoinGeckoMarketData").mockResolvedValue(cgData);
  vi.spyOn(supplemental, "fetchSupplementalTrackedTokens").mockResolvedValue({ goldTokens: [], silverTokens: [], fiatCgTokens: [] });
  vi.spyOn(circuit, "shouldAttemptFetch").mockResolvedValue(true);
  vi.spyOn(circuit, "recordOutcome");
  vi.spyOn(reconciliation, "reconcileTrackedSupplyGaps").mockResolvedValue({
    reconciledIds: [], totalReconciled: 0,
    byReason: { "defillama-history-gap-fill": 0, "coingecko-gap-fill": 0, "onchain-total-supply": 0 },
    assets: [], baselineMismatches: [], gapFillRejections: [],
  });
});
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

function upstream(body: unknown) {
  return vi.spyOn(transport, "fetchTextWithRetry").mockResolvedValue({
    response: new Response(JSON.stringify(body)), body: JSON.stringify(body),
  });
}

describe("stablecoin intake admission", () => {
  it("publishes valid peers while quarantining a malformed row, preserving observed zero and upstream FX", async () => {
    const { db } = fixtures.open();
    const rows = Array.from({ length: MIN_VALID_ASSET_COUNT }, (_, index) => makePeggedAsset({
      id: `intake-fixture-${index}`, circulating: { peggedUSD: index === 0 ? 0 : 100 },
    }));
    upstream({ peggedAssets: [...rows, null], fxFallbackRates: { EUR: 1.1, BAD: "missing" } });
    const fallbackToCoingecko = vi.fn(async () => fallbackResult);
    const result = await loadStablecoinsIntake({ db, syncStartSec: 1_777_000_000, fallbackToCoingecko });
    expect(result.kind).toBe("main");
    if (result.kind !== "main") throw new Error("Expected the healthy intake cohort");
    expect(result.rawAssetCount).toBe(MIN_VALID_ASSET_COUNT + 1);
    expect(result.droppedMalformedAssets).toBe(1);
    expect(result.assets.find((asset) => asset.id === "intake-fixture-0")?.circulating).toEqual({ peggedUSD: 0 });
    expect(result.fxFallbackRates).toEqual({ EUR: 1.1 });
    expect(result.previousCacheState).toEqual({ state: "missing" });
    expect(result.cgData).toEqual(cgData);
    expect(fallbackToCoingecko).not.toHaveBeenCalled();
  });

  it.each([null, { peggedAssets: [] }])("takes an explicit fallback for a malformed or below-floor envelope", async (payload) => {
    const { db } = fixtures.open();
    upstream(payload);
    const fallbackToCoingecko = vi.fn(async () => fallbackResult);
    const result = await loadStablecoinsIntake({ db, syncStartSec: 1_777_000_000, fallbackToCoingecko });
    expect(result).toMatchObject({ kind: "fallback", result: fallbackResult });
    expect(fallbackToCoingecko).toHaveBeenCalledWith(cgData);
    expect(circuit.recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    expect(reconciliation.reconcileTrackedSupplyGaps).not.toHaveBeenCalled();
  });

  it("does not read the blocked DefiLlama provider and retains the fallback failure reason", async () => {
    const { db } = fixtures.open();
    vi.mocked(circuit.shouldAttemptFetch).mockResolvedValue(false);
    const fetch = upstream({ peggedAssets: [] });
    const result = await loadStablecoinsIntake({ db, syncStartSec: 1_777_000_000, fallbackToCoingecko: async () => fallbackResult });
    expect(result).toEqual({
      kind: "fallback", result: fallbackResult,
      errorMessage: "DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(supplemental.fetchSupplementalTrackedTokens).not.toHaveBeenCalled();
  });
});
