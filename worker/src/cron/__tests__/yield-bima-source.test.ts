import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { fetchBimaSusbdSource } from "../yield-sync/sources";

describe("fetchBimaSusbdSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("drops low-quality BIMA rows with negligible TVL and zero APR", async () => {
    mockFetch([
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
    mockFetch([
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
        currentApy: 5.5,
        apyBase: 4.25,
        apyReward: 1.25,
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
    mockFetch([
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
});
