import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

import { fetchReProtocolReusdSource } from "../yield-sync/sources";

describe("fetchReProtocolReusdSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("publishes the latest valid reUSD observation when both Re products are present", async () => {
    mockFetch([{
      match: "api.re.xyz/price",
      body: {
        success: true,
        data: {
          reUSD: [
            { apy: 8.4, date: "2026-07-14", price: 1.099 },
            { apy: 8.1, date: "2026-07-15", price: 1.1 },
          ],
          reUSDe: [
            { apy: 24.63, date: "2026-07-14", price: 1.388167 },
            { apy: 12.24, date: "2026-07-15", price: 1.388632 },
          ],
        },
      },
    }]);

    await expect(fetchReProtocolReusdSource()).resolves.toEqual({
      currentApy: 8.1,
      apyBase: 8.1,
      apyReward: null,
      sourcePool: "0x5086bf358635B81D8C47C66d1C8b9E567Db70c72",
      sourceTvlUsd: null,
      dataSource: "protocol-api",
      exchangeRate: 1.1,
      sourceKey: "protocol-api:re-protocol-reusd",
      yieldSource: "Re Protocol Basis-Plus (reUSD)",
      yieldType: "nav-appreciation",
      sourceObservedAt: Date.parse("2026-07-15T00:00:00Z") / 1000,
      comparisonAnchorObservedAt: null,
    });
  });

  it("does not substitute reUSDe when the reUSD series is absent", async () => {
    mockFetch([{
      match: "api.re.xyz/price",
      body: {
        success: true,
        data: { reUSDe: [{ apy: 15, date: "2026-07-15", price: 1.38 }] },
      },
    }]);

    await expect(fetchReProtocolReusdSource()).resolves.toBeNull();
  });

  it("fails closed when reUSD observations are stale", async () => {
    mockFetch([{
      match: "api.re.xyz/price",
      body: {
        success: true,
        data: { reUSD: [{ apy: 8, date: "2026-07-12", price: 1.09 }] },
      },
    }]);

    await expect(fetchReProtocolReusdSource()).resolves.toBeNull();
  });

  it("fails closed on malformed or out-of-envelope observations", async () => {
    mockFetch([{
      match: "api.re.xyz/price",
      body: {
        success: true,
        data: {
          reUSD: [
            { apy: 501, date: "2026-07-15", price: 1.09 },
            { apy: 8, date: "not-a-date", price: 1.09 },
            { apy: 8, date: "2026-07-15", price: 0 },
          ],
        },
      },
    }]);

    await expect(fetchReProtocolReusdSource()).resolves.toBeNull();
  });
});
