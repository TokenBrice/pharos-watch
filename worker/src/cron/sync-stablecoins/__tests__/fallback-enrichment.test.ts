import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { createLatestSchemaFixtureTracker } from "../../../test-helpers/latest-schema-sqlite";
import { createValidationContextResolver } from "../pricing";
import { runFallbackPriceEnrichmentPhase } from "../fallback-enrichment";
import { makePeggedAsset } from "./_fixtures";

const fixtures = createLatestSchemaFixtureTracker();
const NOW_SEC = 1_800_000_000;

afterEach(() => {
  fixtures.closeAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runFallbackPriceEnrichmentPhase", () => {
  it("uses authenticated fallback enrichment but withholds an unreasonable candidate", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const assets = ["dllr-sovryn", "btcusd-btcfi"].map((id) => makePeggedAsset({
      id, geckoId: ACTIVE_META_BY_ID.get(id)!.geckoId, price: null,
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/simple/price")) {
        const authenticated = new Headers(init?.headers).get("x-cg-pro-api-key") === "cg-key";
        return Response.json(authenticated ? {
          [assets[0].geckoId!]: { usd: 1, last_updated_at: NOW_SEC },
          [assets[1].geckoId!]: { usd: 10, last_updated_at: NOW_SEC },
        } : {});
      }
      return Response.json({ coins: {}, pairs: [] });
    }));
    const { db } = fixtures.open();
    const input = {
      assets, db, syncStartSec: NOW_SEC, coingeckoApiKey: "cg-key",
      validationContexts: createValidationContextResolver(),
      previousTrustedPrices: new Map(),
      returnIfAborted: () => null,
      abortResult: () => ({ status: "degraded" as const, metadata: "{}", aborted: true as const }),
    };

    await runFallbackPriceEnrichmentPhase(input);

    expect(assets.map(({ id, price }) => ({ id, price }))).toEqual([
      { id: "dllr-sovryn", price: 1 },
      { id: "btcusd-btcfi", price: null },
    ]);
    const aborted = { status: "degraded" as const, metadata: "cancelled fallback enrichment", aborted: true as const };
    assets[0].price = null;
    expect(await runFallbackPriceEnrichmentPhase({
      ...input,
      returnIfAborted: (_signal, stage) => stage === "fallback-enrich-prices" ? aborted : null,
    })).toBe(aborted);
    expect(assets[0].price).toBeNull();
  });
});
