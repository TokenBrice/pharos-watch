import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

import { fetchZephyrZysSource } from "../yield-sync/sources";

describe("fetchZephyrZysSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parses Zephyr historical returns into a ZYS protocol-api source row", async () => {
    mockFetch([
      {
        match: "zephyrprotocol.com/api/v1/historicalreturns",
        headers: { "x-last-success-at": "1778592715928" },
        body: {
          lastBlock: { return: 0.00003408784470093992, zsd_accrued: 0.1069333381892648, effectiveApy: 9.2377 },
          oneDay: { return: 0.02472608440340735, zsd_accrued: 78.0483693688002, effectiveApy: 9.3084 },
          oneWeek: { return: 0.1766115414394089, zsd_accrued: 556.5930792781874, effectiveApy: 9.4994 },
        },
      },
    ]);

    const result = await fetchZephyrZysSource();

    expect(result).toEqual(
      expect.objectContaining({
        currentApy: 9.3084,
        apyBase: 9.3084,
        apyReward: null,
        sourcePool: null,
        sourceTvlUsd: null,
        dataSource: "protocol-api",
        exchangeRate: null,
        sourceKey: "protocol-api:zys-zephyr-protocol",
        yieldSource: "Zephyr Scanner ZYS returns",
        yieldType: "nav-appreciation",
        sourceObservedAt: 1_778_592_715,
        comparisonAnchorObservedAt: null,
      }),
    );
  });

  it("returns null when the one-day effective APY is missing", async () => {
    mockFetch([
      {
        match: "zephyrprotocol.com/api/v1/historicalreturns",
        body: {
          lastBlock: { return: 0.00003408784470093992, zsd_accrued: 0.1069333381892648, effectiveApy: 9.2377 },
          oneDay: { return: 0.02472608440340735, zsd_accrued: 78.0483693688002 },
        },
      },
    ]);

    await expect(fetchZephyrZysSource()).resolves.toBeNull();
  });

  it("returns null on HTTP error", async () => {
    mockFetch([{ match: "zephyrprotocol.com/api/v1/historicalreturns", status: 500, body: "" }]);

    await expect(fetchZephyrZysSource()).resolves.toBeNull();
  });
});
