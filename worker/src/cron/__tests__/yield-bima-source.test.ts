import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupYieldSourceTest, mockYieldSourceFetchRetryModule, mockYieldSourceRoutes } from "./yield-source.test-support";

vi.mock("../../lib/fetch-retry", () => mockYieldSourceFetchRetryModule());

import { fetchBimaSusbdSource } from "../yield-sync/sources";

describe("fetchBimaSusbdSource", () => {
  afterEach(cleanupYieldSourceTest);

  it("drops low-quality BIMA rows with negligible TVL and zero APR", async () => {
    mockYieldSourceRoutes([
      {
        match: "bima.money/api/earn/pools",
        body: {
          success: true,
          data: [
            {
              id: "0x5F2283c7C8967c5Fb3a959E63ea89865B882d627",
              token: { title: "USBD", label: "USBD" },
              amountTVL: 11.840303226672772,
              unboostedAPR: 0,
              boostedAPR: 0,
            },
          ],
        },
      },
    ]);

    const result = await fetchBimaSusbdSource();
    expect(result).toBeNull();
  });

  it("parses materially live BIMA earn rows into a protocol-api source row", async () => {
    mockYieldSourceRoutes([
      {
        match: "bima.money/api/earn/pools",
        body: {
          success: true,
          data: [
            {
              id: "0x5F2283c7C8967c5Fb3a959E63ea89865B882d627",
              token: { title: "USBD", label: "USBD" },
              amountTVL: 250_000,
              unboostedAPR: 4.25,
              boostedAPR: 5.5,
            },
          ],
        },
      },
    ]);

    const result = await fetchBimaSusbdSource();

    expect(result).toEqual(
      expect.objectContaining({
        currentApy: 4.25,
        apyBase: 4.25,
        apyReward: null,
        sourcePool: "0x5F2283c7C8967c5Fb3a959E63ea89865B882d627",
        sourceTvlUsd: 250_000,
        dataSource: "protocol-api",
        sourceKey: "protocol-api:bima-susbd",
        yieldSource: "BIMA savings (sUSBD)",
        yieldType: "lending-vault",
      }),
    );
  });

  it("returns null when the earn feed has no USBD row", async () => {
    mockYieldSourceRoutes([
      {
        match: "bima.money/api/earn/pools",
        body: {
          success: true,
          data: [
            {
              id: "0x123",
              token: { title: "OTHER", label: "OTHER" },
              amountTVL: 10,
              unboostedAPR: 1,
              boostedAPR: 1.5,
            },
          ],
        },
      },
    ]);

    await expect(fetchBimaSusbdSource()).resolves.toBeNull();
  });

  it("does not publish boosted-only APR because boosts are user-specific", async () => {
    mockYieldSourceRoutes([
      {
        match: "bima.money/api/earn/pools",
        body: {
          success: true,
          data: [
            {
              id: "0x5F2283c7C8967c5Fb3a959E63ea89865B882d627",
              token: { title: "USBD", label: "USBD" },
              amountTVL: 250_000,
              boostedAPR: 5.5,
            },
          ],
        },
      },
    ]);

    await expect(fetchBimaSusbdSource()).resolves.toBeNull();
  });
});
