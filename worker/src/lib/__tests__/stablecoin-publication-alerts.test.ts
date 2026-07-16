import { beforeEach, describe, expect, it, vi } from "vitest";

const sendAlertMock = vi.fn(async () => true);
const logCronEventMock = vi.fn(async () => ({}));
const getCachesMock = vi.fn(async () => new Map<string, { value: string; updatedAt: number }>());
const setCacheManyMock = vi.fn(async () => undefined);

vi.mock("../alerts", () => ({ sendAlert: sendAlertMock }));
vi.mock("../cron-logger", () => ({ logCronEvent: logCronEventMock }));
vi.mock("../db-cache", () => ({
  getCaches: getCachesMock,
  setCacheMany: setCacheManyMock,
}));

const { alertOnMissingActiveStablecoinPrices } = await import("../stablecoin-publication-alerts");

function coverage(streak = 2) {
  return {
    complete: false,
    expectedActiveCount: 1,
    presentActiveCount: 1,
    pricedActiveCount: 0,
    missingPriceCount: 1,
    pricedActiveIds: [],
    missingActiveIds: ["missing-coin"],
    affectedMarketCapUsd: 10,
    missingActiveAssets: [{
      stablecoinId: "missing-coin",
      symbol: "MISS",
      marketCapUsd: 10,
      currentPrice: null,
      currentSource: null,
      currentObservedAt: null,
      currentConfidence: null,
      consecutiveMissingGenerations: streak,
      lastAcceptedPrice: 1,
      lastAcceptedSource: "coingecko",
      lastAcceptedObservedAt: 1_700_000_000,
      rejectionReason: "no-accepted-price",
      alertEligible: streak >= 2,
    }],
    alertEligibleCount: streak >= 2 ? 1 : 0,
    alertEligibleIds: streak >= 2 ? ["missing-coin"] : [],
    maxConsecutiveMissingGenerations: streak,
  };
}

describe("alertOnMissingActiveStablecoinPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendAlertMock.mockResolvedValue(true);
    getCachesMock.mockResolvedValue(new Map());
  });

  it("alerts with asset-attributable context after two missing generations", async () => {
    const result = await alertOnMissingActiveStablecoinPrices({} as D1Database, coverage(), "webhook");

    expect(result).toEqual({ eligibleCount: 1, dueCount: 1, sent: true, suppressedByCooldown: 0 });
    expect(sendAlertMock).toHaveBeenCalledWith(
      "webhook",
      "Active stablecoin prices missing",
      expect.stringContaining("MISS (missing-coin); missing generations=2; reason=no-accepted-price"),
    );
    expect(setCacheManyMock).toHaveBeenCalledTimes(1);
    expect(logCronEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
      eventType: "active-price-coverage-gap",
      severity: "warning",
    }));
  });

  it("retries when webhook delivery fails", async () => {
    sendAlertMock.mockResolvedValue(false);
    const result = await alertOnMissingActiveStablecoinPrices({} as D1Database, coverage(), "webhook");

    expect(result.sent).toBe(false);
    expect(setCacheManyMock).not.toHaveBeenCalled();
  });

  it("suppresses assets with a recent successful-delivery marker", async () => {
    getCachesMock.mockResolvedValue(new Map([[
      "sync-stablecoins:missing-active-price-alert:v1:missing-coin",
      { value: "{}", updatedAt: Math.floor(Date.now() / 1_000) },
    ]]));
    const result = await alertOnMissingActiveStablecoinPrices({} as D1Database, coverage(3), "webhook");

    expect(result).toEqual({ eligibleCount: 1, dueCount: 0, sent: false, suppressedByCooldown: 1 });
    expect(sendAlertMock).not.toHaveBeenCalled();
  });
});
