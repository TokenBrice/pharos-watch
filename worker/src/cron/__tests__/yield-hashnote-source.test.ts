import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

import { fetchHashnoteUsycSource } from "../yield-sync/sources";
import { RATE_DERIVED_CONFIGS } from "../../lib/yield-config/yield-config";

describe("fetchHashnoteUsycSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("derives APY from USYC price reports", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const sevenDaysAgoSec = nowSec - 7 * 86400;
    mockFetch([
      {
        match: "usyc.hashnote.com/api/price-reports",
        body: {
          entity: "usyc_price_report",
          data: [
            {
              roundId: "392",
              price: "1.120246648414663082",
              timestamp: String(nowSec),
              principal: "2453604554.64",
              interest: "236175.55",
              balance: "2453840730.19",
              totalSupply: "2190425756.78094",
              decimals: 6,
              fee: "21082.459861",
              txhash: "0xabc",
            },
            {
              roundId: "385",
              price: "1.119046648414663082",
              timestamp: String(sevenDaysAgoSec),
              principal: "2400000000.00",
              interest: "200000.00",
              balance: "2400200000.00",
              totalSupply: "2190000000.00",
              decimals: 6,
              fee: "20000.00",
              txhash: "0xdef",
            },
          ],
        },
      },
    ]);

    const result = await fetchHashnoteUsycSource();
    expect(result).toEqual(
      expect.objectContaining({
        dataSource: "protocol-api",
        sourceKey: "protocol-api:hashnote-usyc",
        yieldSource: "Hashnote USYC",
      }),
    );
    expect(result!.currentApy).toBeGreaterThan(0);
  });

  it("returns null on HTTP error", async () => {
    mockFetch([{ match: "usyc.hashnote.com", status: 500, body: "" }]);
    await expect(fetchHashnoteUsycSource()).resolves.toBeNull();
  });

  it("returns null when the latest report is stale", async () => {
    const staleNowSec = 1_780_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(staleNowSec * 1000);
    mockFetch([
      {
        match: "usyc.hashnote.com/api/price-reports",
        body: {
          entity: "usyc_price_report",
          data: [
            { roundId: "100", price: "1.12", timestamp: String(staleNowSec - 4 * 86400) },
            { roundId: "99", price: "1.11", timestamp: String(staleNowSec - 11 * 86400) },
          ],
        },
      },
    ]);

    await expect(fetchHashnoteUsycSource()).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("does not keep a rate-derived USYC proxy that can outrank the live Hashnote feed", () => {
    expect(RATE_DERIVED_CONFIGS.some((config) => config.stablecoinId === "usyc-hashnote")).toBe(false);
  });
});
