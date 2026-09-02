import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupYieldSourceTest, mockYieldSourceFetchRetryModule, mockYieldSourceRoutes } from "./yield-source.test-support";

vi.mock("../../lib/fetch-retry", () => mockYieldSourceFetchRetryModule());

import { fetchZephyrZysSource } from "../yield-sync/sources";

describe("fetchZephyrZysSource", () => {
  afterEach(cleanupYieldSourceTest);

  it("parses Zephyr historical returns into a ZYS protocol-api source row", async () => {
    mockYieldSourceRoutes([
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

  it.each([
    ["10000000000", 10_000_000_000],
    ["10000000001", 10_000_000],
  ])("keeps the exclusive header epoch threshold for %s", async (header, expected) => {
    mockYieldSourceRoutes([{
      match: "zephyrprotocol.com/api/v1/historicalreturns",
      headers: { "x-last-success-at": header },
      body: { oneDay: { effectiveApy: 9.3084 } },
    }]);

    const result = await fetchZephyrZysSource();

    expect(result?.sourceObservedAt).toBe(expected);
  });

  it("returns null when the one-day effective APY is missing", async () => {
    mockYieldSourceRoutes([
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
    mockYieldSourceRoutes([{ match: "zephyrprotocol.com/api/v1/historicalreturns", status: 500, body: "" }]);

    await expect(fetchZephyrZysSource()).resolves.toBeNull();
  });
});
