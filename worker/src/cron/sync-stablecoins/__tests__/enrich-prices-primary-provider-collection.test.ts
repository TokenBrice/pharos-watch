import { beforeEach, describe, expect, it, vi } from "vitest";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { fetchCoingeckoSimplePrices } from "../../../lib/coingecko-simple-price";
import {
  buildPrimaryPricePlan,
  collectPrimaryProviderQuotes,
} from "../enrich-prices-primary-provider-collection";
import type { PeggedAsset } from "../enrich-prices-shared";

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

vi.mock("../../../lib/coingecko-simple-price", () => ({
  fetchCoingeckoSimplePrices: vi.fn(async () => ({
    kind: "ok",
    value: new Map([[
      "test-usd",
      { price: 1, observedAt: 1_800_000_000, observedAtMode: "upstream" },
    ]]),
  })),
}));

const TEST_ASSET: PeggedAsset = {
  id: "test-usd",
  name: "Test USD",
  symbol: "TUSD",
  geckoId: "test-usd",
  pegType: "peggedUSD",
};

describe("critical publication provider collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
  });

  it("checks only the CoinGecko circuit and admits only known DL/CG assets", async () => {
    const dlPrices = new Map([["dl-only", 1]]);
    const plan = await buildPrimaryPricePlan([
      TEST_ASSET,
      { id: "dl-only", name: "DL", symbol: "DL", pegType: "peggedUSD" },
      { id: "unknown", name: "Unknown", symbol: "UNK", pegType: "peggedUSD" },
    ], {} as D1Database, dlPrices);

    expect(plan.candidates.map((asset) => asset.id)).toEqual(["test-usd", "dl-only"]);
    expect(shouldAttemptFetch).toHaveBeenCalledTimes(1);
    expect(shouldAttemptFetch).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.CG_PRICES);
  });

  it("reduces the fixture's live primary fetch lanes from nine to one", async () => {
    const legacyFixtureFetchLanes = 9;
    const plan = await buildPrimaryPricePlan([TEST_ASSET], {} as D1Database);
    const result = await collectPrimaryProviderQuotes({
      plan,
      db: {} as D1Database,
      coingeckoApiKey: "cg-key",
    });

    expect(legacyFixtureFetchLanes).toBe(9);
    expect(fetchCoingeckoSimplePrices).toHaveBeenCalledTimes(1);
    expect(result.quoteMaps.cgPrices.get("test-usd")).toBe(1);
    expect(result.providerDiagnostics).toEqual([]);
  });
});
