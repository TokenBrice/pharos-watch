import { describe, expect, it } from "vitest";
import { expectWarnings, installAdapterNetwork, runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const NOPAL_POSITIONS_URL = "https://api.nest.credit/v1/vaults/nest-opal-vault/positions";
const NOPAL_PRICE_URL = "https://api.nest.credit/v1/vaults/nest-opal-vault/price";
const NOPAL_UPDATE_URL = "https://api.nest.credit/v1/vaults/nest-opal-vault/last-price-update";
const INALPHA_POSITIONS_URL = "https://api.nest.credit/v1/vaults/nest-alpha-lp-vault/positions";
const INALPHA_PRICE_URL = "https://api.nest.credit/v1/vaults/nest-alpha-lp-vault/price";
const INALPHA_UPDATE_URL = "https://api.nest.credit/v1/vaults/nest-alpha-lp-vault/last-price-update";
const FIXTURE_NOW = 1_778_474_625;

function nestNetwork(
  coinId: "nopal-nest" | "inalpha-nest",
  positions: unknown,
  price: unknown,
  lastPriceUpdate: unknown,
): AdapterNetworkSpec {
  const nopal = coinId === "nopal-nest";
  return {
    json: {
      [nopal ? NOPAL_POSITIONS_URL : INALPHA_POSITIONS_URL]: positions,
      [nopal ? NOPAL_PRICE_URL : INALPHA_PRICE_URL]: price,
      [nopal ? NOPAL_UPDATE_URL : INALPHA_UPDATE_URL]: lastPriceUpdate,
    },
  };
}

function runNest(
  coinId: "nopal-nest" | "inalpha-nest",
  positions: unknown,
  price: unknown,
  lastPriceUpdate: unknown,
  validate = true,
) {
  return runAdapter("nest-vault-positions", coinId, {
    network: installAdapterNetwork(nestNetwork(coinId, positions, price, lastPriceUpdate)),
    nowSec: FIXTURE_NOW,
    ...(validate ? {} : { validate: false as const }),
  });
}

describe("fetchNestVaultPositionsReserves", () => {
  it("groups Nest positions into stablecoin, treasury, and private credit slices", async () => {
    const { result } = await runNest(
      "nopal-nest",
      {
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
      },
      {
        data: {
          nav: 1_075,
          price: 1.05,
          totalSupply: 950,
        },
      },
      {
        data: {
          lastPriceUpdates: [
            { updatedAt: 1_778_474_591 },
            { updatedAt: FIXTURE_NOW },
          ],
        },
      },
    );

    expect(result.slices).toEqual([
      { sourceKey: "nest-vault-positions:ustb", name: "Superstate USTB Treasury Fund", pct: 27.9, risk: "low", coinId: "ustb-superstate" },
      { sourceKey: "nest-vault-positions:credit-vaults", name: "Nest private and structured credit vaults", pct: 27.9, risk: "high" },
      { sourceKey: "nest-vault-positions:ntbill", name: "Nest Treasury vault (nTBILL)", pct: 11.6, risk: "low", coinId: "ntbill-nest" },
      { sourceKey: "nest-vault-positions:usdc", name: "Liquid USDC balances", pct: 9.3, risk: "low", coinId: "usdc-circle" },
      { sourceKey: "nest-vault-positions:jtrsy", name: "Janus Henderson Anemoy Treasury Fund (JTRSY)", pct: 9.3, risk: "low", coinId: "jtrsy-anemoy" },
      { sourceKey: "nest-vault-positions:usdt", name: "Liquid USDT balances", pct: 4.7, risk: "low", coinId: "usdt-tether" },
      { sourceKey: "nest-vault-positions:pending-deposits", name: "Nest pending deposits", pct: 4.7, risk: "high" },
      { sourceKey: "nest-vault-positions:pusd", name: "pUSD liquid balance", pct: 2.3, risk: "high", coinId: "pusd-plume" },
      { sourceKey: "nest-vault-positions:nav-residual", name: "Nest NAV reconciliation residual", pct: 2.3, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: FIXTURE_NOW,
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
    expectWarnings(result, ["nest-nav-coverage-gap"]);
  });

  it("keeps other Nest assets on settled-only accounting without pending transaction arrays", async () => {
    const { result } = await runNest(
      "inalpha-nest",
      {
        data: {
          positions: {
            liquidAssets: [{ symbol: "USDC", position: { value: 100 } }],
            yieldAssets: [],
          },
        },
      },
      { data: { nav: 100, price: 1, totalSupply: 100 } },
      { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } },
    );

    expect(result.slices).toEqual([
      { sourceKey: "nest-vault-positions:usdc", name: "Liquid USDC balances", pct: 100, risk: "low", coinId: "usdc-circle" },
    ]);
    expectWarnings(result, []);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 100,
      navUsd: 100,
      navCoverageRatio: 1,
    });
    expect(result.metadata?.pendingDepositUsd).toBeUndefined();
    expect(result.metadata?.navReconciliationResidualUsd).toBeUndefined();
  });

  it("emits a NAV reconciliation residual and unknown exposure for non-nOPAL Nest vaults when positions cover less than NAV", async () => {
    const { result } = await runNest(
      "inalpha-nest",
      {
        data: {
          positions: {
            liquidAssets: [{ symbol: "pUSD", position: { value: 0.410183 } }],
            yieldAssets: [],
          },
        },
      },
      { data: { nav: 1.8890182896, price: 1, totalSupply: 2 } },
      { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } },
    );

    expect(result.slices).toEqual([
      { sourceKey: "nest-vault-positions:nav-residual", name: "Nest NAV reconciliation residual", pct: 78.3, risk: "high" },
      { sourceKey: "nest-vault-positions:pusd", name: "pUSD liquid balance", pct: 21.7, risk: "high", coinId: "pusd-plume" },
    ]);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 1.8890182896,
      settledPositionUsd: 0.410183,
      navReconciliationResidualUsd: expect.closeTo(1.4788352896, 6),
      unknownExposurePct: expect.closeTo(78.2859169623574, 3),
      navUsd: 1.8890182896,
      navCoverageRatio: expect.closeTo(0.410183 / 1.8890182896, 6),
    });
    expectWarnings(result, ["nest-nav-coverage-gap"]);
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
    await expect(runNest(
      "nopal-nest",
      {
        data: {
          positions: {
            liquidAssets: [{ symbol: "USDC", position: { value: 100 }, pendingTransactions }],
            yieldAssets: [],
          },
        },
      },
      { data: { nav: 100, price: 1, totalSupply: 100 } },
      { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } },
      false,
    )).rejects.toThrow(error);
  });

  it("rejects a renamed positions field instead of publishing a zero snapshot", async () => {
    await expect(runNest(
      "nopal-nest",
      {
        data: {
          positions: {
            liquidAssetsRenamed: [{ symbol: "USDC", position: { value: 100 }, pendingTransactions: [] }],
            yieldAssets: [],
          },
        },
      },
      { data: { nav: 100, price: 1, totalSupply: 100 } },
      { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } },
      false,
    )).rejects.toThrow("produced zero reserve value");
  });
});
