import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

import { fetchReProtocolReusdeSource } from "../yield-sync/sources";

describe("fetchReProtocolReusdeSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("publishes the latest valid reUSDe NAV observation", async () => {
    mockFetch([{
      match: "api.re.xyz/price",
      body: {
        success: true,
        data: {
          reUSD: [{ apy: 8.1, date: "2026-07-15", price: 1.1 }],
          reUSDe: [
            { apy: 24.63, date: "2026-07-14", price: 1.388167 },
            { apy: 12.24, date: "2026-07-15", price: 1.388632 },
          ],
        },
      },
    }]);

    await expect(fetchReProtocolReusdeSource()).resolves.toEqual({
      currentApy: 12.24,
      apyBase: 12.24,
      apyReward: null,
      sourcePool: "0xdDC0f880ff6e4e22E4B74632fBb43Ce4DF6cCC5a",
      sourceTvlUsd: null,
      dataSource: "protocol-api",
      exchangeRate: 1.388632,
      sourceKey: "protocol-api:re-protocol-reusde",
      yieldSource: "Re Protocol Insurance Alpha (reUSDe)",
      yieldType: "nav-appreciation",
      sourceObservedAt: Date.parse("2026-07-15T00:00:00Z") / 1000,
      comparisonAnchorObservedAt: null,
    });
  });

  it("fails closed when reUSDe observations are stale", async () => {
    mockFetch([{
      match: "api.re.xyz/price",
      body: {
        success: true,
        data: { reUSDe: [{ apy: 15, date: "2026-07-12", price: 1.38 }] },
      },
    }]);

    await expect(fetchReProtocolReusdeSource()).resolves.toBeNull();
  });

  it("fails closed on malformed or out-of-envelope observations", async () => {
    mockFetch([{
      match: "api.re.xyz/price",
      body: {
        success: true,
        data: {
          reUSDe: [
            { apy: 501, date: "2026-07-15", price: 1.38 },
            { apy: 12, date: "not-a-date", price: 1.38 },
            { apy: 12, date: "2026-07-15", price: 0 },
          ],
        },
      },
    }]);

    await expect(fetchReProtocolReusdeSource()).resolves.toBeNull();
  });
});
