import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
  };
});

import { adaptSpikoShareClassTotals, fetchSpikoApiReserves, type SpikoShareClassTotals } from "../spiko-api";
import { fetchJsonWithRetry } from "../helpers";

const signal = AbortSignal.timeout(5000);

function makeCoin(): StablecoinMeta {
  return { id: "eursafo-spiko", name: "Spiko Euro", ticker: "EURSAFO" } as unknown as StablecoinMeta;
}

function makeConfig(shareClassSymbol: string, slice: { name: string; risk: string }): LiveReservesConfig {
  return {
    adapter: "spiko-api",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: { kind: "http-json", url: `https://public-api.spiko.io/share-classes/${shareClassSymbol}/totals` },
    },
    params: { shareClassSymbol, slice },
  } as unknown as LiveReservesConfig;
}

// Captured 2026-07-09 from GET https://public-api.spiko.io/share-classes/eurSAFO/totals
const EURSAFO_TOTALS: SpikoShareClassTotals = {
  totalShares: "660017933.22353",
  totalAssets: { value: "665195773.91", currency: "EUR" },
  numberOfHolders: 5939,
  netAssetValue: {
    day: "2026-07-09T00:00:00.000Z",
    amount: { value: "1.007845", currency: "EUR" },
    updatedAt: "2026-07-09T13:40:41.205Z",
  },
  totalYield: { value: "2378871.28155423176", currency: "EUR" },
  totalOrders: { value: "1044109801.21096311127", currency: "EUR" },
} as unknown as SpikoShareClassTotals;

// Captured 2026-07-09 from GET https://public-api.spiko.io/share-classes/UKTBL/totals
const UKTBL_TOTALS: SpikoShareClassTotals = {
  totalShares: "15123970.85033",
  totalAssets: { value: "15480820.94", currency: "GBP" },
  numberOfHolders: 395,
  netAssetValue: {
    day: "2026-07-09T00:00:00.000Z",
    amount: { value: "1.023595", currency: "GBP" },
    updatedAt: "2026-07-09T14:28:07.525Z",
  },
} as unknown as SpikoShareClassTotals;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adaptSpikoShareClassTotals", () => {
  it("computes the honest ratio and verified freshness for a EUR fund with no FX conversion", () => {
    const result = adaptSpikoShareClassTotals(EURSAFO_TOTALS, "eurSAFO", {
      name: "Fully collateralized overnight total-return swap exposure",
      risk: "medium",
    });

    expect(result.slices).toEqual([
      { name: "Fully collateralized overnight total-return swap exposure", pct: 100, risk: "medium" },
    ]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse("2026-07-09T13:40:41.205Z") / 1000),
      freshnessMode: "verified",
      details: {
        shareClassSymbol: "eurSAFO",
        fundCurrency: "EUR",
        navDay: "2026-07-09T00:00:00.000Z",
      },
    });
    const expectedRatio = 665195773.91 / (660017933.22353 * 1.007845);
    expect(result.metadata!.collateralizationRatio).toBeCloseTo(expectedRatio, 9);
    // Non-USD fund: no USD totals should be persisted.
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("supplyUsd");
  });

  it("persists totalReserveUsd/supplyUsd only when the fund currency is USD", () => {
    const usdTotals: SpikoShareClassTotals = {
      totalShares: "1000000",
      totalAssets: { value: "1010000", currency: "USD" },
      netAssetValue: {
        amount: { value: "1.0", currency: "USD" },
        updatedAt: "2026-07-09T12:00:00.000Z",
      },
    } as unknown as SpikoShareClassTotals;

    const result = adaptSpikoShareClassTotals(usdTotals, "SAFO", {
      name: "Fully collateralized overnight total-return swap exposure",
      risk: "medium",
    });

    expect(result.metadata).toMatchObject({
      totalReserveUsd: 1010000,
      supplyUsd: 1000000,
      collateralizationRatio: 1.01,
    });
  });

  it("emits the configured UK T-Bills slice at 100% for UKTBL", () => {
    const result = adaptSpikoShareClassTotals(UKTBL_TOTALS, "UKTBL", {
      name: "UK Treasury Bills and cash",
      risk: "very-low",
      coinId: "uktbl-spiko",
    });

    expect(result.slices).toEqual([
      { name: "UK Treasury Bills and cash", pct: 100, risk: "very-low", coinId: "uktbl-spiko" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      details: { shareClassSymbol: "UKTBL", fundCurrency: "GBP" },
    });
  });

  it("still parses a stale NAV update into a verified but old sourceTimestamp", () => {
    const staleTotals: SpikoShareClassTotals = {
      ...EURSAFO_TOTALS,
      netAssetValue: {
        ...EURSAFO_TOTALS.netAssetValue,
        updatedAt: "2026-06-01T08:00:00.000Z",
      },
    };

    const result = adaptSpikoShareClassTotals(staleTotals, "eurSAFO", {
      name: "Fully collateralized overnight total-return swap exposure",
      risk: "medium",
    });

    // The adapter reports the real disclosure timestamp honestly; the cron's
    // BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC policy (not the adapter) is what
    // later marks a sync built from this snapshot as degraded once stale.
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse("2026-06-01T08:00:00.000Z") / 1000),
      freshnessMode: "verified",
    });
  });

  it("throws on a malformed payload missing totalShares", () => {
    const malformed = {
      totalAssets: { value: "665195773.91", currency: "EUR" },
      netAssetValue: { amount: { value: "1.007845", currency: "EUR" }, updatedAt: "2026-07-09T13:40:41.205Z" },
    } as unknown as SpikoShareClassTotals;

    expect(() => adaptSpikoShareClassTotals(malformed, "eurSAFO", { name: "Test", risk: "medium" }))
      .toThrow("invalid totalShares");
  });

  it("throws on a malformed payload with an unreadable NAV timestamp", () => {
    const malformed: SpikoShareClassTotals = {
      ...EURSAFO_TOTALS,
      netAssetValue: { ...EURSAFO_TOTALS.netAssetValue, updatedAt: "" },
    };

    expect(() => adaptSpikoShareClassTotals(malformed, "eurSAFO", { name: "Test", risk: "medium" }))
      .toThrow("unreadable netAssetValue.updatedAt");
  });
});

describe("fetchSpikoApiReserves", () => {
  it("fetches the configured totals endpoint and adapts the payload", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(EURSAFO_TOTALS);
    const config = makeConfig("eurSAFO", {
      name: "Fully collateralized overnight total-return swap exposure",
      risk: "medium",
    });

    const result = await fetchSpikoApiReserves(makeCoin(), config, signal);

    expect(fetchJsonWithRetry).toHaveBeenCalledWith(
      "https://public-api.spiko.io/share-classes/eurSAFO/totals",
      signal,
      12_000,
      undefined,
    );
    expect(result.slices).toEqual([
      { name: "Fully collateralized overnight total-return swap exposure", pct: 100, risk: "medium" },
    ]);
  });

  it("propagates an error when the share class endpoint is missing (404)", async () => {
    vi.mocked(fetchJsonWithRetry).mockRejectedValue(
      new Error("HTTP 404 for https://public-api.spiko.io/share-classes/unknownSymbol/totals"),
    );
    const config = makeConfig("unknownSymbol", { name: "Test", risk: "medium" });

    await expect(fetchSpikoApiReserves(makeCoin(), config, signal)).rejects.toThrow("HTTP 404");
  });
});
