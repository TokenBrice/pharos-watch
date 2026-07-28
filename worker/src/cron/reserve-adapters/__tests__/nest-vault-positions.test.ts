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
              { symbol: "USDC", position: { value: 100 }, pendingTransactions: [] },
              {
                symbol: "USDT0",
                position: { value: 50 },
                pendingTransactions: [
                  { type: "PendingWithdrawal", amount: 0, price: 1, value: 0 },
                ],
              },
              { symbol: "pUSD", position: { value: 25 }, pendingTransactions: [] },
            ],
            yieldAssets: [
              {
                slug: "nest-treasury-vault",
                tokens: [{ symbol: "nTBILL", position: { value: 125 }, pendingTransactions: [] }],
              },
              {
                slug: "superstate-ustb",
                tokens: [{ symbol: "USTB", position: { value: 300 }, pendingTransactions: [] }],
              },
              {
                slug: "janus-henderson-fund",
                tokens: [{ symbol: "JTRSY", position: { value: 100 }, pendingTransactions: [] }],
              },
              {
                slug: "liquid-stone",
                tokens: [{
                  symbol: "OALS2T",
                  position: { value: 300 },
                  pendingTransactions: [
                    { type: "PendingDeposit", amount: 50, price: 1, value: 50 },
                  ],
                }],
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          nav: 1_075,
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

    const coin = TRACKED_META_BY_ID.get("nopal-nest");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchNestVaultPositionsReserves(
      coin!,
      coin!.liveReservesConfig!,
      AbortSignal.timeout(5_000),
    );

    expect(result.slices).toEqual([
      { name: "Superstate USTB Treasury Fund", pct: 27.9, risk: "low", coinId: "ustb-superstate" },
      { name: "Nest private and structured credit vaults", pct: 27.9, risk: "high" },
      { name: "Nest Treasury vault (nTBILL)", pct: 11.6, risk: "low", coinId: "ntbill-nest" },
      { name: "Liquid USDC balances", pct: 9.3, risk: "low", coinId: "usdc-circle" },
      { name: "Janus Henderson Anemoy Treasury Fund (JTRSY)", pct: 9.3, risk: "low", coinId: "jtrsy-anemoy" },
      { name: "Liquid USDT balances", pct: 4.7, risk: "low", coinId: "usdt-tether" },
      { name: "Nest pending deposits", pct: 4.7, risk: "high" },
      { name: "pUSD liquid balance", pct: 2.3, risk: "high", coinId: "pusd-plume" },
      { name: "Nest NAV reconciliation residual", pct: 2.3, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1778474625,
      totalReserveUsd: 1_075,
      settledPositionUsd: 1_000,
      pendingDepositUsd: 50,
      pendingWithdrawalUsd: 0,
      navReconciliationResidualUsd: 25,
      navUsd: 1_075,
      navCoverageRatio: 1_000 / 1_075,
      reconciledNavCoverageRatio: 1_050 / 1_075,
      details: {
        reconciliationKind: "settled-plus-pending-deposits-plus-residual-equals-nav",
        pendingTransactions: [
          {
            type: "PendingWithdrawal",
            positionKind: "liquid",
            symbol: "USDT0",
            amount: 0,
            price: 1,
            valueUsd: 0,
          },
          {
            type: "PendingDeposit",
            positionKind: "yield",
            symbol: "OALS2T",
            assetSlug: "liquid-stone",
            amount: 50,
            price: 1,
            valueUsd: 50,
          },
        ],
      },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "nest-nav-coverage-gap", effect: "degraded" }),
    ]);
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("nest-vault-positions") ?? undefined,
      now: 1778474625,
    }).valid).toBe(true);
  });

  it("keeps other Nest assets on settled-only accounting without pending transaction arrays", async () => {
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({
        data: {
          positions: {
            liquidAssets: [
              { symbol: "USDC", position: { value: 100 } },
            ],
            yieldAssets: [],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          nav: 100,
          price: 1,
          totalSupply: 100,
        },
      })
      .mockResolvedValueOnce({
        data: {
          lastPriceUpdates: [{ updatedAt: 1778474625 }],
        },
      });

    const coin = TRACKED_META_BY_ID.get("inalpha-nest");
    const result = await fetchNestVaultPositionsReserves(
      coin!,
      coin!.liveReservesConfig!,
      AbortSignal.timeout(5_000),
    );

    expect(result.slices).toEqual([
      { name: "Liquid USDC balances", pct: 100, risk: "low", coinId: "usdc-circle" },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 100,
      navUsd: 100,
      navCoverageRatio: 1,
    });
    expect(result.metadata?.pendingDepositUsd).toBeUndefined();
    expect(result.metadata?.navReconciliationResidualUsd).toBeUndefined();
  });

  it.each([
    {
      label: "a missing pendingTransactions array",
      pendingTransactions: undefined,
      error: "missing pendingTransactions array",
    },
    {
      label: "a missing pending transaction type",
      pendingTransactions: [{ amount: 1, price: 1, value: 1 }],
      error: "unsupported pending transaction type",
    },
    {
      label: "an unsupported pending transaction type",
      pendingTransactions: [{ type: "PendingTransfer", amount: 1, price: 1, value: 1 }],
      error: "unsupported pending transaction type",
    },
    {
      label: "an invalid pending transaction value",
      pendingTransactions: [{ type: "PendingDeposit", amount: 1, price: 1, value: "unknown" }],
      error: "invalid pending PendingDeposit value",
    },
    {
      label: "a positive pending withdrawal with unknown NAV treatment",
      pendingTransactions: [{ type: "PendingWithdrawal", amount: 1, price: 1, value: 1 }],
      error: "cannot reconcile positive nOPAL pending withdrawals",
    },
  ])("fails nOPAL closed for $label", async ({ pendingTransactions, error }) => {
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({
        data: {
          positions: {
            liquidAssets: [
              { symbol: "USDC", position: { value: 100 }, pendingTransactions },
            ],
            yieldAssets: [],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          nav: 100,
          price: 1,
          totalSupply: 100,
        },
      })
      .mockResolvedValueOnce({
        data: {
          lastPriceUpdates: [{ updatedAt: 1778474625 }],
        },
      });

    const coin = TRACKED_META_BY_ID.get("nopal-nest");
    await expect(fetchNestVaultPositionsReserves(
      coin!,
      coin!.liveReservesConfig!,
      AbortSignal.timeout(5_000),
    )).rejects.toThrow(error);
  });
});
