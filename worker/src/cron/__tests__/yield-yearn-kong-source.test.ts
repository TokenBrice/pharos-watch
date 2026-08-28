import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

import { fetchYearnKongSources } from "../yield-sync/sources";

describe("fetchYearnKongSources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("extracts stablecoin vault APYs from Kong GraphQL", async () => {
    mockFetch([
      {
        match: "kong.yearn.fi",
        body: {
          data: {
            vaults: [
              {
                address: "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204",
                name: "USDC-1 yVault",
                yearn: true,
                asset: { symbol: "USDC" },
                tvl: { close: 31_708_022 },
                apy: { net: 0.0312, monthlyNet: 0.0312 },
                meta: { category: "Stablecoin", isRetired: false },
              },
            ],
          },
        },
      },
    ]);

    const results = await fetchYearnKongSources();
    expect(results.length).toBe(1);
    expect(results[0]).toEqual(
      expect.objectContaining({
        symbol: "USDC",
        chain: "ethereum",
        yield: expect.objectContaining({
          currentApy: expect.closeTo(3.12, 1),
          dataSource: "protocol-api",
          sourceKey: expect.stringContaining("protocol-api:yearn:ethereum:"),
          yieldSource: expect.stringContaining("Yearn"),
        }),
      }),
    );
  });

  it("skips retired vaults", async () => {
    mockFetch([
      {
        match: "kong.yearn.fi",
        body: {
          data: {
            vaults: [
              {
                address: "0x123",
                name: "Old USDC",
                yearn: true,
                asset: { symbol: "USDC" },
                tvl: { close: 1_000_000 },
                apy: { net: 0.02, monthlyNet: 0.02 },
                meta: { category: "Stablecoin", isRetired: true },
              },
            ],
          },
        },
      },
    ]);
    expect(await fetchYearnKongSources()).toEqual([]);
  });

  it("labels non-Yearn vaults as Kong", async () => {
    mockFetch([
      {
        match: "kong.yearn.fi",
        body: {
          data: {
            vaults: [
              {
                address: "0xabc",
                name: "Steakhouse USDC",
                yearn: false,
                asset: { symbol: "USDC" },
                tvl: { close: 50_000_000 },
                apy: { net: 0.03, monthlyNet: 0.03 },
                meta: { category: "Stablecoin", isRetired: false },
              },
            ],
          },
        },
      },
    ]);
    const results = await fetchYearnKongSources();
    expect(results[0].yield.yieldSource).toContain("Kong");
    expect(results[0].yield.sourceKey).toContain("protocol-api:kong:");
  });

  it("uses current net APY instead of monthly net APY", async () => {
    mockFetch([
      {
        match: "kong.yearn.fi",
        body: {
          data: {
            vaults: [
              {
                address: "0xabc",
                name: "USDC yVault",
                yearn: true,
                asset: { symbol: "USDC" },
                tvl: { close: 50_000_000 },
                apy: { net: 0.025, monthlyNet: 0.1 },
                meta: { category: "Stablecoin", isRetired: false },
              },
            ],
          },
        },
      },
    ]);

    const results = await fetchYearnKongSources();
    expect(results[0].yield.currentApy).toBeCloseTo(2.5);
    expect(results[0].yield.apyBase).toBeCloseTo(2.5);
  });

  it("maps Staked yBOLD to sBOLD as a native K3 source", async () => {
    mockFetch([
      {
        match: "kong.yearn.fi",
        body: {
          data: {
            vaults: [
              {
                address: "0x23346B04a7f55b8760E5860AA5A77383D63491cD",
                name: "Staked yBOLD",
                yearn: true,
                asset: {
                  symbol: "yBOLD",
                  address: "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8",
                },
                tvl: { close: 4_434_056 },
                apy: { net: 0.0316603818860981, monthlyNet: 0.0316603818860981 },
                meta: { category: "Stablecoin", isRetired: false },
              },
            ],
          },
        },
      },
    ]);

    const results = await fetchYearnKongSources();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({
        stablecoinId: "sbold-k3-capital",
        symbol: "yBOLD",
        chain: "ethereum",
        address: "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8",
        yield: expect.objectContaining({
          currentApy: expect.closeTo(3.17, 1),
          sourceKey: "protocol-api:k3:ethereum:0x23346b04a7f55b8760e5860aa5a77383d63491cd",
          yieldSource: "K3: sBOLD",
          yieldType: "lending-vault",
        }),
      }),
    );
  });
});
