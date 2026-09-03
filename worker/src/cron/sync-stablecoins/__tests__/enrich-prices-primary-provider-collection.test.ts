import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { buildPrimaryPricePlan } from "../enrich-prices-primary-provider-collection";
import type { PeggedAsset } from "../enrich-prices-shared";

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => false),
  recordOutcome: vi.fn(async () => {}),
  recoverBreakerOnNoCandidate: vi.fn(async () => {}),
}));

vi.mock("../../../lib/depeg-helpers", () => ({
  createDexPriceSourceLoadTelemetry: vi.fn(() => ({
    staleRows: [],
    malformedRows: [],
  })),
  loadDexPriceRows: vi.fn(async () => new Map()),
  loadDexPriceSources: vi.fn(async () => new Map()),
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
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps all nine primary provider circuits in the 15-minute plan", async () => {
    await buildPrimaryPricePlan([TEST_ASSET], {} as D1Database);

    expect(shouldAttemptFetch).toHaveBeenCalledTimes(9);
    expect(vi.mocked(shouldAttemptFetch).mock.calls.map(([, source]) => source)).toEqual([
      CIRCUIT_SOURCE.CG_PRICES,
      CIRCUIT_SOURCE.CG_TICKER,
      CIRCUIT_SOURCE.BINANCE_PRICES,
      CIRCUIT_SOURCE.KRAKEN_PRICES,
      CIRCUIT_SOURCE.BITSTAMP_PRICES,
      CIRCUIT_SOURCE.COINBASE_PRICES,
      CIRCUIT_SOURCE.REDSTONE_PRICES,
      CIRCUIT_SOURCE.CURVE_ONCHAIN,
      CIRCUIT_SOURCE.CURVE_ORACLE,
    ]);
  });

  it("does not report every primary circuit open when the ticker lane is available", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.CG_TICKER);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const plan = await buildPrimaryPricePlan([TEST_ASSET], {} as D1Database);

    expect(plan.sourceAllowed.cgTicker).toBe(true);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("All live primary fetch circuits are open"),
    );
  });
});
