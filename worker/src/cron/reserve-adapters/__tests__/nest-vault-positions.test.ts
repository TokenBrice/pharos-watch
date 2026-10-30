import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
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
  coinId: "nopal-nest" | "inalpha-nest" | "nbasis-nest",
  positions: unknown,
  price: unknown,
  lastPriceUpdate: unknown,
): AdapterNetworkSpec {
  const nopal = coinId === "nopal-nest";
  const basis = "https://api.nest.credit/v1/vaults/nest-basis-vault/";
  return {
    json: {
      [coinId === "nbasis-nest" ? `${basis}positions` : nopal ? NOPAL_POSITIONS_URL : INALPHA_POSITIONS_URL]: positions,
      [coinId === "nbasis-nest" ? `${basis}price` : nopal ? NOPAL_PRICE_URL : INALPHA_PRICE_URL]: price,
      [coinId === "nbasis-nest" ? `${basis}last-price-update` : nopal ? NOPAL_UPDATE_URL : INALPHA_UPDATE_URL]: lastPriceUpdate,
    },
  };
}

function runNest(
  coinId: "nopal-nest" | "inalpha-nest" | "nbasis-nest",
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
  it.each([
    ["USDC", "usdc", "Liquid USDC balances", "low", "usdc-circle"],
    ["USDC.e", "usdc", "Liquid USDC balances", "low", "usdc-circle"],
    ["USDT", "usdt", "Liquid USDT balances", "low", "usdt-tether"],
    ["USDT0", "usdt", "Liquid USDT balances", "low", "usdt-tether"],
    ["pUSD", "pusd", "pUSD liquid balance", "high", "pusd-plume"],
    ["USDG", "usdg", "USDG liquid balance", "low", "usdg-paxos"],
    ["constructor", "unknown", "constructor liquid balance", "high", undefined],
    [undefined, "unknown", "Unknown liquid balance", "high", undefined],
  ])("preserves liquid alias metadata for %s", async (symbol, key, name, risk, coinId) => {
    const { result } = await runNest("inalpha-nest", { data: { positions: {
      liquidAssets: [{ symbol, position: { value: 100 } }], yieldAssets: [],
    } } }, { data: { nav: 100 } }, { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } });
    expect(result.slices).toEqual([{
      sourceKey: `nest-vault-positions:${key}`, name, risk, pct: 100,
      ...(coinId ? { coinId, depType: "collateral" } : {}),
    }]);
    expect(result.metadata?.unknownExposurePct).toBe(coinId ? 0 : 100);
    expectWarnings(result, []);
  });

  it("preserves first-match slug OR symbol precedence for every yield alias pair", async () => {
    const aliases = [
      { slug: "nest-treasury-vault", symbol: "nTBILL", key: "ntbill",
        name: "Nest Treasury vault (nTBILL)", coinId: "ntbill-nest" },
      { slug: "janus-henderson-fund", symbol: "JTRSY", key: "jtrsy",
        name: "Janus Henderson Anemoy Treasury Fund (JTRSY)", coinId: "jtrsy-anemoy" },
      { slug: "superstate-ustb", symbol: "USTB", key: "ustb",
        name: "Superstate USTB Treasury Fund", coinId: "ustb-superstate" },
      { slug: "superstate-uscc", symbol: "USCC", key: "uscc",
        name: "Superstate USCC cash-and-carry fund", coinId: undefined },
      { slug: "nest-basis-vault", symbol: "nBASIS", key: "nbasis",
        name: "Nest Basis vault (nBASIS)", coinId: "nbasis-nest" },
      { slug: "unfamiliar", symbol: "unfamiliar", key: "credit-vaults",
        name: "Nest private and structured credit vaults", coinId: undefined },
    ];
    for (const [slugIndex, { slug }] of aliases.entries()) {
      for (const [symbolIndex, { symbol }] of aliases.entries()) {
        const expected = aliases[Math.min(slugIndex, symbolIndex)];
        const unknown = expected.key === "credit-vaults";
        const { result } = await runNest("inalpha-nest", { data: { positions: {
          liquidAssets: [], yieldAssets: [{ slug, tokens: [{ symbol, position: { value: 100 } }] }],
        } } }, { data: { nav: 100 } }, { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } });
        expect(result.slices, `${slug} / ${symbol}`).toEqual([{
          sourceKey: `nest-vault-positions:${expected.key}`, name: expected.name,
          risk: unknown ? "high" : "low", pct: 100,
          ...(expected.coinId ? { coinId: expected.coinId, depType: "collateral" } : {}),
        }]);
        expect(result.metadata?.unknownExposurePct).toBe(unknown ? 100 : 0);
        expectWarnings(result, []);
      }
    }
  });

  it.each(["nopal-nest", "nbasis-nest", "inalpha-nest"] as const)(
    "rejects publisher position errors without pending withdrawals for %s",
    async (coinId) => {
      for (const errors of [["yield backend unavailable"], null, {}, "unavailable"]) {
        await expect(runNest(
          coinId,
          { data: { errors, positions: {
            liquidAssets: [{ symbol: "USDC", position: { value: 100 }, pendingTransactions: [] }],
            yieldAssets: [],
          } } },
          { data: { nav: 100 } },
          { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } },
        )).rejects.toThrow("positions-errors");
      }
    },
  );

  it.each(["liquidAssets", "yieldAssets", "tokens"] as const)(
    "rejects absent or malformed %s before accepting the surviving holdings",
    async (collection) => {
      for (const value of [undefined, null, {}]) {
        const positions = {
          liquidAssets: [{ symbol: "USDC", position: { value: 100 }, pendingTransactions: [] }],
          yieldAssets: [{ slug: "superstate-ustb", tokens: [] }],
        };
        if (collection === "tokens") {
          Reflect.set(positions.yieldAssets[0], "tokens", value);
        } else {
          Reflect.set(positions, collection, value);
        }
        await expect(runNest(
          "inalpha-nest", { data: { positions } }, { data: { nav: 100 } },
          { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } },
        )).rejects.toThrow(/missing or invalid .*array/);
      }
    },
  );

  it("accepts explicit empty liquid and yield-token legs with a clean publisher error list", async () => {
    const { result } = await runNest(
      "inalpha-nest",
      { data: { errors: [], positions: {
        liquidAssets: [],
        yieldAssets: [
          { slug: "empty-vault", tokens: [] },
          { slug: "superstate-ustb", tokens: [{ symbol: "USTB", position: { value: 100 } }] },
        ],
      } } },
      { data: { nav: 100 } },
      { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } },
    );
    expect(result.slices).toMatchObject([{ coinId: "ustb-superstate", pct: 100 }]);
    expect(result.metadata).toMatchObject({ totalReserveUsd: 100, unknownExposurePct: 0 });
    expectWarnings(result, []);
  });

  it("keys USDG liquid balances specifically while keeping unfamiliar symbols unknown", async () => {
    const { result } = await runNest(
      "nopal-nest",
      {
        data: {
          positions: {
            liquidAssets: [
              { symbol: "USDG", position: { value: 75 }, pendingTransactions: [] },
              { symbol: "UNRECOGNIZED", position: { value: 25 }, pendingTransactions: [] },
            ],
            yieldAssets: [],
          },
        },
      },
      { data: { nav: 100, price: 1, totalSupply: 100 } },
      { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } },
    );

    expect(result.slices).toHaveLength(2);
    expect(result.slices.find((slice) => slice.sourceKey === "nest-vault-positions:usdg")).toMatchObject({
      name: "USDG liquid balance",
      pct: 75,
      risk: "low",
      coinId: "usdg-paxos",
      depType: "collateral",
    });
    const unknown = result.slices.find((slice) => slice.sourceKey === "nest-vault-positions:unknown");
    expect(unknown).toMatchObject({ name: "UNRECOGNIZED liquid balance", pct: 25, risk: "high" });
    expect(unknown?.coinId).toBeUndefined();
    expect(unknown?.depType).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBe(25);
    expectWarnings(result, []);
  });

  it("retains saved positive Nest dust and sub-six-decimal tracked balances", async () => {
    const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "nest-precision-2026-09-29.json"), "utf8")) as {
      vaults: Array<{
        id: string;
        positions: { data: { positions: { liquidAssets: Array<{ symbol: string; position: { value: number }; pendingTransactions?: unknown[] }> } } };
        price: { data: { nav: number } };
        lastPriceUpdate: { data: { lastPriceUpdates: Array<{ updatedAt: number }> } };
      }>;
    };
    for (const vault of fixture.vaults) {
      const config = TRACKED_META_BY_ID.get(vault.id)!.liveReservesConfig!;
      if (config.inputs.primary.kind !== "http-json") throw new Error("Nest replay requires HTTP JSON");
      const params = config.params as { priceUrl: string; lastPriceUpdateUrl: string };
      const network = {
        json: {
          [config.inputs.primary.url]: vault.positions,
          [params.priceUrl]: vault.price,
          [params.lastPriceUpdateUrl]: vault.lastPriceUpdate,
        },
      };
      const { result } = await runAdapter("nest-vault-positions", vault.id, {
        network: installAdapterNetwork(network),
        nowSec: vault.lastPriceUpdate.data.lastPriceUpdates[0].updatedAt + 600,
      });
      const liquidValue = vault.positions.data.positions.liquidAssets
        .filter((token) => token.symbol === "USDT" || token.symbol === "USDT0")
        .reduce((sum, token) => sum + token.position.value, 0);
      const shareBasis = result.slices.reduce((sum, slice) => sum + slice.pct, 0);
      expect(shareBasis).toBeCloseTo(100, 10);
      const usdBasis = Math.max(result.metadata!.totalReserveUsd!, Number(result.metadata!.settledPositionUsd));
      expect(result.slices.find((slice) => slice.coinId === "usdt-tether")?.pct)
        .toBeCloseTo(liquidValue / usdBasis * 100, 12);

      const tiny = structuredClone(vault.positions);
      tiny.data.positions.liquidAssets = tiny.data.positions.liquidAssets.filter((token) => token.symbol !== "USDC" && token.symbol !== "USDC.e");
      tiny.data.positions.liquidAssets.push({ symbol: "USDC", position: { value: 1e-6 }, pendingTransactions: [] });
      const { result: tinyResult } = await runAdapter("nest-vault-positions", vault.id, {
        network: installAdapterNetwork({ json: { ...network.json, [config.inputs.primary.url]: tiny } }),
        nowSec: vault.lastPriceUpdate.data.lastPriceUpdates[0].updatedAt + 600,
      });
      const slice = tinyResult.slices.find((row) => row.coinId === "usdc-circle");
      expect(slice?.pct).toBe(1e-6 / tinyResult.metadata!.totalReserveUsd! * 100);
      expect(slice?.depType).toBe("collateral");
    }
  });

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

    const reserveUsd = result.metadata!.totalReserveUsd!;
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")!.pct * reserveUsd / 100).toBeCloseTo(100, 10);
    expect(result.slices.find((slice) => slice.coinId === "ustb-superstate")!.pct * reserveUsd / 100).toBeCloseTo(300, 10);
    expect(result.slices.find((slice) => slice.sourceKey === "nest-vault-positions:pending-deposits")!.pct * reserveUsd / 100).toBeCloseTo(50, 10);
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

  it("accounts for nBASIS subscriptions separately from settled USCC without inventing a NAV shortfall", async () => {
    const { result } = await runNest(
      "nbasis-nest",
      { data: { positions: {
        liquidAssets: [{ symbol: "USDC", position: { value: 20513.83421829615 }, pendingTransactions: [] }],
        yieldAssets: [{ slug: "superstate-uscc", tokens: [{
          symbol: "USCC", position: { value: 115368.59675977795 },
          pendingTransactions: [{ type: "PendingDeposit", amount: 1, price: 50000, value: 50000 }],
        }] }],
      } } },
      { data: { nav: 185865.35913807683, price: 1.073847, totalSupply: 173083.650779 } },
      { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } },
    );
    expectWarnings(result, []);
    expect(result.metadata).toMatchObject({
      pendingDepositUsd: 50000,
      pendingWithdrawalUsd: 0,
      unknownExposurePct: expect.closeTo(26.899, 2),
      reconciledNavCoverageRatio: expect.closeTo(1.000092, 5),
    });
    expect(result.metadata?.navReconciliationResidualUsd).toBeUndefined();
  });

  it.each([
    { pendingTransactions: undefined, error: "missing pendingTransactions array" },
    { pendingTransactions: [{ type: "PendingWithdrawal", amount: 1, price: 50000, value: 50000 }], error: "cannot reconcile positive nBASIS pending withdrawals" },
    { pendingTransactions: [{ type: "PendingDeposit", amount: 1, price: 1, value: "unknown" }], error: "invalid pending PendingDeposit value" },
  ])("keeps nBASIS pending accounting fail-closed: $error", async ({ pendingTransactions, error }) => {
    await expect(runNest("nbasis-nest", { data: { positions: {
      liquidAssets: [{ symbol: "USDC", position: { value: 100 }, pendingTransactions }], yieldAssets: [],
    } } }, { data: { nav: 100 } }, { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } }))
      .rejects.toThrow(error);
  });

  it.each([
    { label: "reconciled", gross: 120, net: 119, fees: 1, errors: [], positionErrors: [], symbol: "USCC", accepted: true },
    { label: "omitted receivable", gross: 100, net: 99, fees: 1, errors: [], positionErrors: [], symbol: "USCC", accepted: false },
    { label: "double counted", gross: 140, net: 139, fees: 1, errors: [], positionErrors: [], symbol: "USCC", accepted: false },
    { label: "wrong fees", gross: 120, net: 120, fees: 1, errors: [], positionErrors: [], symbol: "USCC", accepted: false },
    { label: "negative fees", gross: 120, net: 121, fees: -1, errors: [], positionErrors: [], symbol: "USCC", accepted: false },
    { label: "missing gross", gross: null, net: 119, fees: 1, errors: [], positionErrors: [], symbol: "USCC", accepted: false },
    { label: "calculation error", gross: 120, net: 119, fees: 1, errors: ["timeout"], positionErrors: [], symbol: "USCC", accepted: false },
    { label: "positions error", gross: 120, net: 119, fees: 1, errors: [], positionErrors: ["timeout"], symbol: "USCC", accepted: false },
    { label: "unreviewed token", gross: 120, net: 119, fees: 1, errors: [], positionErrors: [], symbol: "USTB", accepted: false },
  ])("corroborates nBASIS redemption receivables: $label", async (fixture) => {
    const network = nestNetwork("nbasis-nest", { data: { errors: fixture.positionErrors, positions: {
      liquidAssets: [], yieldAssets: [{ slug: "superstate-uscc", tokens: [{
        symbol: fixture.symbol, position: { value: 100 },
        pendingTransactions: [{ type: "PendingWithdrawal", amount: 2, price: 10, value: 20 }],
      }] }],
    } } }, { data: { nav: 119, price: 1, totalSupply: 119 } }, { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } });
    network.json!["https://api.nest.credit/v1/vaults/nest-basis-vault/calculated-price"] = { data: {
      grossCalculatedNav: fixture.gross, calculatedNav: fixture.net, claimableFees: fixture.fees,
      claimableFeesAdjusted: true, unrealizedDividends: 0, calculatedPrice: 1, errors: fixture.errors,
    } };
    const attempt = runAdapter("nest-vault-positions", "nbasis-nest", {
      network: installAdapterNetwork(network), nowSec: FIXTURE_NOW,
    });
    if (!fixture.accepted) {
      await expect(attempt).rejects.toThrow(fixture.positionErrors.length > 0 ? "positions-errors" : /reconcil/);
      return;
    }
    const { result } = await attempt;
    expect(result.metadata).toMatchObject({ totalReserveUsd: 120, calculatedNavUsd: 119,
      claimableFeesUsd: 1, pendingWithdrawalUsd: 20, unknownExposurePct: expect.closeTo(100 / 6, 5) });
    expect(result.metadata?.navReconciliationResidualUsd).toBeUndefined();
    expectWarnings(result, []);
  });

  it.each([
    { label: "accepts sub-dollar published-NAV drift", nav: 119.5, rejected: false },
    { label: "rejects a published NAV that contradicts the calculated net NAV", nav: 1_000, rejected: true },
  ])("cross-checks the nBASIS calculated NAV against the published NAV: $label", async ({ nav, rejected }) => {
    const network = nestNetwork("nbasis-nest", { data: { positions: {
      liquidAssets: [], yieldAssets: [{ slug: "superstate-uscc", tokens: [{
        symbol: "USCC", position: { value: 100 },
        pendingTransactions: [{ type: "PendingWithdrawal", amount: 2, price: 10, value: 20 }],
      }] }],
    } } }, { data: { nav, price: 1, totalSupply: nav } }, { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } });
    network.json!["https://api.nest.credit/v1/vaults/nest-basis-vault/calculated-price"] = { data: {
      grossCalculatedNav: 120, calculatedNav: 119, claimableFees: 1, claimableFeesAdjusted: true, unrealizedDividends: 0,
      calculatedPrice: 1,
    } };
    const attempt = runAdapter("nest-vault-positions", "nbasis-nest", {
      network: installAdapterNetwork(network), nowSec: FIXTURE_NOW,
    });
    if (rejected) {
      await expect(attempt).rejects.toThrow(/does not match the published NAV/);
      return;
    }
    const { result } = await attempt;
    expect(result.metadata).toMatchObject({ calculatedNavUsd: 119, navUsd: nav, totalReserveUsd: 120 });
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

    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")).toMatchObject({ pct: 100, depType: "collateral" });
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

    expect(result.slices.find((slice) => slice.sourceKey === "nest-vault-positions:nav-residual")!.pct * 1.8890182896 / 100).toBeCloseTo(1.4788352896, 10);
    expect(result.slices.find((slice) => slice.coinId === "pusd-plume")!.pct * 1.8890182896 / 100).toBeCloseTo(0.410183, 10);
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

  it.each([
    { label: "corroborated liquid-stone redemption", gross: 120, net: 119, fees: 1, nav: 119, accepted: true },
    { label: "omitted receivable", gross: 100, net: 99, fees: 1, nav: 119, accepted: false },
    { label: "missing gross NAV", gross: null, net: 119, fees: 1, nav: 119, accepted: false },
    { label: "published NAV contradiction", gross: 120, net: 119, fees: 1, nav: 1_000, accepted: false },
  ])("corroborates nOPAL pending redemption receivables: $label", async (fixture) => {
    const network = nestNetwork("nopal-nest", { data: { positions: {
      liquidAssets: [], yieldAssets: [{ slug: "liquid-stone", tokens: [{
        symbol: "OALS2T", position: { value: 100 },
        pendingTransactions: [{ type: "PendingWithdrawal", amount: 2, price: 10, value: 20 }],
      }] }],
    } } }, { data: { nav: fixture.nav, price: 1, totalSupply: fixture.nav } }, { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } });
    network.json!["https://api.nest.credit/v1/vaults/nest-opal-vault/calculated-price"] = { data: {
      grossCalculatedNav: fixture.gross, calculatedNav: fixture.net, claimableFees: fixture.fees,
      claimableFeesAdjusted: true, unrealizedDividends: 0, calculatedPrice: 1,
    } };
    const attempt = runAdapter("nest-vault-positions", "nopal-nest", {
      network: installAdapterNetwork(network), nowSec: FIXTURE_NOW,
    });
    if (!fixture.accepted) {
      await expect(attempt).rejects.toThrow(/reconcil|does not match the published NAV/);
      return;
    }
    const { result } = await attempt;
    expect(result.metadata).toMatchObject({ totalReserveUsd: 120, calculatedNavUsd: 119,
      claimableFeesUsd: 1, pendingWithdrawalUsd: 20, unknownExposurePct: 100 });
    expect(result.metadata?.navBasisSpreadUsd).toBe(0);
    expect(result.metadata?.navReconciliationResidualUsd).toBeUndefined();
    expectWarnings(result, []);
  });

  it("admits a reconciling live payload whose published NAV is on a different price basis", async () => {
    // 2026-10-30 nest-opal-vault: two queued OALS2T withdrawals reconcile the
    // gross NAV exactly, while /price.nav is the pushed accountant price
    // (1.11044) and /calculated-price is the live assetNav (1.1107696967).
    const totalSupply = 106_842_510.14416999;
    const network = nestNetwork("nopal-nest", { data: { positions: {
      liquidAssets: [], yieldAssets: [{ slug: "liquid-stone", tokens: [{
        symbol: "OALS2T", position: { value: 113_877_063.45276515 },
        pendingTransactions: [
          { type: "PendingWithdrawal", amount: 2_444_053, price: 1.0231981631960003, value: 2_500_750.540353674, requestId: 12 },
          { type: "PendingWithdrawal", amount: 2_248_528, price: 1.0231981631960003, value: 2_300_689.7194947763, requestId: 13 },
        ],
      }] }],
    } } }, { data: { nav: 118_642_196.96449214, price: 1.11044, totalSupply } }, { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } });
    network.json!["https://api.nest.credit/v1/vaults/nest-opal-vault/calculated-price"] = { data: {
      grossCalculatedNav: 118_678_503.7126136,
      claimableFees: 1_081.121811,
      claimableFeesAdjusted: true,
      calculatedNav: 118_677_422.5908026,
      calculatedPrice: 1.1107696967308514,
      unrealizedDividends: 0,
      totalSupply,
      yieldStrategyPrices: { ewma: 1.1104659802430388, assetNav: 1.1107696967308514 },
    } };
    const { result } = await runAdapter("nest-vault-positions", "nopal-nest", {
      network: installAdapterNetwork(network), nowSec: FIXTURE_NOW,
    });

    expect(result.metadata).toMatchObject({
      totalReserveUsd: 118_678_503.7126136,
      calculatedNavUsd: 118_677_422.5908026,
      navUsd: 118_642_196.96449214,
      pendingWithdrawalUsd: expect.closeTo(4_801_440.25984845, 6),
    });
    expect(result.metadata?.navBasisSpreadUsd).toBeCloseTo(35_225.6263, 3);
    expect(result.metadata?.navReconciliationResidualUsd).toBeUndefined();
    expectWarnings(result, []);
  });

  it.each([
    { positionKind: "liquid", slug: "liquid-stone", symbol: "OALS2T" },
    { positionKind: "yield", slug: "nest-treasury-vault", symbol: "nTBILL" },
    { positionKind: "yield", slug: "liquid-stone", symbol: "UNREVIEWED" },
    { positionKind: "yield", slug: "unreviewed-vault", symbol: "OALS2T" },
  ])("rejects nOPAL pending withdrawals outside the reviewed underlying: $positionKind/$slug/$symbol", async (fixture) => {
    const token = {
      symbol: fixture.symbol, position: { value: 100 },
      pendingTransactions: [{ type: "PendingWithdrawal", amount: 20, price: 1, value: 20 }],
    };
    await expect(runNest("nopal-nest", { data: { positions: {
      liquidAssets: fixture.positionKind === "liquid" ? [token] : [],
      yieldAssets: fixture.positionKind === "yield" ? [{ slug: fixture.slug, tokens: [token] }] : [],
    } } }, { data: { nav: 119 } }, { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } }))
      .rejects.toThrow("cannot reconcile positive nOPAL pending withdrawals");
  });

  it("reconciles the saved nOPAL $60,000 dividend gap without assigning a held-asset identity", async () => {
    const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "nest-dividends-2026-10-18.json"), "utf8")) as {
      positions: unknown;
      calculatedPrice: { data: { grossCalculatedNav: number; calculatedNav: number; claimableFees: number; calculatedPrice: number; totalSupply: number } };
    };
    const network = nestNetwork("nopal-nest", fixture.positions,
      {
        data: {
          nav: fixture.calculatedPrice.data.calculatedNav,
          price: fixture.calculatedPrice.data.calculatedPrice,
          totalSupply: fixture.calculatedPrice.data.totalSupply,
        },
      },
      { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } });
    network.json!["https://api.nest.credit/v1/vaults/nest-opal-vault/calculated-price"] = fixture.calculatedPrice;
    const { result } = await runAdapter("nest-vault-positions", "nopal-nest", {
      network: installAdapterNetwork(network), nowSec: FIXTURE_NOW,
    });
    const gross = fixture.calculatedPrice.data.grossCalculatedNav;
    const dividend = result.slices.find((slice) => slice.sourceKey === "nest-vault-positions:unrealized-dividends");
    expect(dividend).toMatchObject({ name: "Nest unrealized dividend receivables", risk: "high" });
    expect(dividend).not.toHaveProperty("coinId");
    expect(dividend).not.toHaveProperty("depType");
    expect(dividend).not.toHaveProperty("assetClass");
    expect(dividend!.pct * gross / 100).toBeCloseTo(60_000, 6);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: FIXTURE_NOW,
      freshnessMode: "verified",
      totalReserveUsd: gross,
      grossNavUsd: gross,
      calculatedNavUsd: fixture.calculatedPrice.data.calculatedNav,
      claimableFeesUsd: fixture.calculatedPrice.data.claimableFees,
      unrealizedDividendsUsd: 60_000,
      settledPositionUsd: expect.closeTo(114_248_764.55020815, 6),
      pendingWithdrawalUsd: expect.closeTo(8_782_731.729332542, 6),
      reconciledNavCoverageRatio: expect.closeTo(1, 10),
      details: {
        calculatedPriceUrl: "https://api.nest.credit/v1/vaults/nest-opal-vault/calculated-price",
        reconciliationKind: "settled-plus-pending-plus-dividends-equals-gross-nav-less-fees-equals-net-nav",
      },
    });
    const unknownUsd = 51_904_441.01303975 + 39_200_715.45721803 + 11_571_316.763970664
      + 5_107_762.4085464375 + 8_782_731.729332542 + 60_000;
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(unknownUsd / gross * 100, 10);
    expect(result.metadata?.navReconciliationResidualUsd).toBeUndefined();
    expectWarnings(result, []);
  });

  it.each([
    { label: "explicit zero", dividends: 0, settled: 100, gross: 120, net: 119, nav: 119, accepted: true },
    { label: "numeric-string dividends", dividends: "60000", settled: 100, gross: 60_120, net: 60_119, nav: 60_119, accepted: true },
    { label: "absent dividends", dividends: undefined, settled: 100, gross: 120, net: 119, nav: 119, accepted: false },
    { label: "null dividends", dividends: null, settled: 100, gross: 120, net: 119, nav: 119, accepted: false },
    { label: "malformed dividends", dividends: "unknown", settled: 100, gross: 120, net: 119, nav: 119, accepted: false },
    { label: "negative dividends", dividends: -60_000, settled: 100, gross: 120, net: 119, nav: 119, accepted: false },
    { label: "nonfinite dividends", dividends: Infinity, settled: 100, gross: 120, net: 119, nav: 119, accepted: false },
    { label: "dividends already in settled holdings", dividends: 60_000, settled: 60_100, gross: 60_120, net: 60_119, nav: 60_119, accepted: false },
    { label: "dividends added twice to gross", dividends: 60_000, settled: 100, gross: 120_120, net: 120_119, nav: 120_119, accepted: false },
    { label: "incorrect net fees", dividends: 60_000, settled: 100, gross: 60_120, net: 60_120, nav: 60_120, accepted: false },
    { label: "contradictory published NAV", dividends: 60_000, settled: 100, gross: 60_120, net: 60_119, nav: 70_000, accepted: false },
  ])("keeps dividend reconciliation fail-closed: $label", async (fixture) => {
    const network = nestNetwork("nopal-nest", { data: { positions: {
      liquidAssets: [{ symbol: "USDC", position: { value: fixture.settled }, pendingTransactions: [] }],
      yieldAssets: [{ slug: "liquid-stone", tokens: [{
        symbol: "OALS2T", position: { value: 0 },
        pendingTransactions: [{ type: "PendingWithdrawal", amount: 20, price: 1, value: 20 }],
      }] }],
    } } }, { data: { nav: fixture.nav, price: 1, totalSupply: fixture.nav } }, { data: { lastPriceUpdates: [{ updatedAt: FIXTURE_NOW }] } });
    network.json!["https://api.nest.credit/v1/vaults/nest-opal-vault/calculated-price"] = { data: {
      grossCalculatedNav: fixture.gross, calculatedNav: fixture.net, claimableFees: 1,
      claimableFeesAdjusted: true, unrealizedDividends: fixture.dividends, calculatedPrice: 1,
    } };
    const attempt = runAdapter("nest-vault-positions", "nopal-nest", {
      network: installAdapterNetwork(network), nowSec: FIXTURE_NOW,
    });
    if (!fixture.accepted) {
      await expect(attempt).rejects.toThrow(/unrealized dividends|reconcil|does not match the published NAV/);
      return;
    }
    const { result } = await attempt;
    expect(result.metadata).toMatchObject({
      unrealizedDividendsUsd: Number(fixture.dividends), totalReserveUsd: fixture.gross,
      reconciledNavCoverageRatio: 1, sourceTimestamp: FIXTURE_NOW,
    });
    expect(result.metadata?.unknownExposurePct).toBeCloseTo((20 + Number(fixture.dividends)) / fixture.gross * 100, 10);
    expectWarnings(result, []);
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
    )).rejects.toThrow("missing or invalid liquidAssets array");
  });
});
