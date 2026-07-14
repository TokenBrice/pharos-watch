import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
  };
});

import { fetchNestVaultPositionsReserves } from "../nest-vault-positions";
import { fetchJsonWithRetry } from "../helpers";

describe("fetchNestVaultPositionsReserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("groups Nest positions into stablecoin, treasury, and private credit slices", async () => {
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({
        data: {
          positions: {
            liquidAssets: [
              { symbol: "USDC", position: { value: 100 } },
              { symbol: "USDT0", position: { value: 50 } },
              { symbol: "pUSD", position: { value: 25 } },
            ],
            yieldAssets: [
              { slug: "nest-treasury-vault", tokens: [{ symbol: "nTBILL", position: { value: 125 } }] },
              { slug: "superstate-ustb", tokens: [{ symbol: "USTB", position: { value: 300 } }] },
              { slug: "janus-henderson-fund", tokens: [{ symbol: "JTRSY", position: { value: 100 } }] },
              { slug: "nest-opal-vault", tokens: [{ symbol: "nOPAL", position: { value: 300 } }] },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          nav: 1_000,
          price: 1.05,
          totalSupply: 950,
        },
      })
      .mockResolvedValueOnce({
        data: {
          lastPriceUpdates: [
            { updatedAt: 1778474591 },
            { updatedAt: 1778474625 },
          ],
        },
      });

    const coin = TRACKED_META_BY_ID.get("inalpha-nest");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchNestVaultPositionsReserves(
      coin!,
      coin!.liveReservesConfig!,
      AbortSignal.timeout(5_000),
    );

    expect(result.slices).toEqual([
      { name: "Superstate USTB Treasury Fund", pct: 30, risk: "very-low", coinId: "ustb-superstate" },
      { name: "Nest private and structured credit vaults", pct: 30, risk: "high" },
      { name: "Nest Treasury vault (nTBILL)", pct: 12.5, risk: "low", coinId: "ntbill-nest" },
      { name: "Liquid USDC balances", pct: 10, risk: "low", coinId: "usdc-circle" },
      { name: "Janus Henderson Anemoy Treasury Fund (JTRSY)", pct: 10, risk: "very-low", coinId: "jtrsy-anemoy" },
      { name: "Liquid USDT balances", pct: 5, risk: "low", coinId: "usdt-tether" },
      { name: "pUSD liquid balance", pct: 2.5, risk: "high", coinId: "pusd-plume" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1778474625,
      totalReserveUsd: 1_000,
      navUsd: 1_000,
      navCoverageRatio: 1,
    });
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("nest-vault-positions") ?? undefined,
      now: 1778474625,
    }).valid).toBe(true);
  });
});
