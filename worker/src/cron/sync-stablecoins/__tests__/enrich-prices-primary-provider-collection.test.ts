import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { buildPrimaryPricePlan } from "../enrich-prices-primary-provider-collection";
import type { PeggedAsset } from "../enrich-prices-shared";

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => false),
  recordOutcome: vi.fn(async () => {}),
  recordOutcomeDecision: vi.fn(async () => {}),
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

describe("buildPrimaryPricePlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not log all primary circuits open while the CG ticker circuit can still fetch", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.CG_TICKER);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const plan = await buildPrimaryPricePlan([TEST_ASSET], {} as D1Database);

    expect(plan.sourceAllowed.cgTicker).toBe(true);
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[primary-prices] All live primary fetch circuits are open; continuing with local DL/DEX inputs only",
    );
  });

  it("logs all primary circuits open when every live provider circuit is blocked", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await buildPrimaryPricePlan([TEST_ASSET], {} as D1Database);

    expect(warnSpy).toHaveBeenCalledWith(
      "[primary-prices] All live primary fetch circuits are open; continuing with local DL/DEX inputs only",
    );
  });
});
