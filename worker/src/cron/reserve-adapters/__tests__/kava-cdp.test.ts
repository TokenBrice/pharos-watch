import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import usdx from "@shared/data/stablecoins/coins/usdx-kava.json";
import { adaptKavaCdpState, type KavaCdpState } from "../kava-cdp";
import {
  BANK_SUPPLY,
  BLOCK_TIME_ISO,
  BLOCK_TIME_SEC,
  CDP_PARAMS,
  LATEST_BLOCK,
  PRICEFEED_PRICES,
  TOTAL_COLLATERAL,
  TOTAL_COLLATERAL_URL,
  TOTAL_PRINCIPAL,
  kavaNetwork,
} from "./kava-cdp.test-support";
import { runAdapter } from "./reserve-adapter.test-support";

function makeState(overrides: Partial<KavaCdpState> = {}): KavaCdpState {
  return {
    collateral: structuredClone(TOTAL_COLLATERAL),
    principal: structuredClone(TOTAL_PRINCIPAL),
    params: structuredClone(CDP_PARAMS),
    prices: structuredClone(PRICEFEED_PRICES),
    supply: structuredClone(BANK_SUPPLY),
    block: structuredClone(LATEST_BLOCK),
    nowSec: BLOCK_TIME_SEC,
    ...overrides,
  };
}

function makeCoin(): StablecoinMeta {
  return { id: "usdx-kava", name: "USDX", symbol: "USDX", liveReservesConfig: structuredClone(usdx.liveReservesConfig) } as unknown as StablecoinMeta;
}

const PRICE = (marketId: string): number => Number(PRICEFEED_PRICES.prices.find((p) => p.market_id === marketId)!.price);

function expectedDenomValueUsd(denom: string): number {
  const rows = TOTAL_COLLATERAL.total_collateral.filter((row) => row.amount.denom === denom);
  const param = CDP_PARAMS.params.collateral_params.find((row) => row.denom === denom)!;
  const priceMicros = Math.round(PRICE(param.spot_market_id) * 1_000_000);
  const scale = 10n ** BigInt(Number(param.conversion_factor));
  return rows.reduce((sum, row) => sum
    + Number((BigInt(row.amount.amount) * BigInt(priceMicros) + scale / 2n) / scale) / 1_000_000, 0);
}

const expectedTotalCollateralUsd = ["bnb", "btcb", "busd", "hbtc", "ukava", "erc20/tether/usdt", "xrpb"]
  .reduce((sum, denom) => sum + expectedDenomValueUsd(denom), 0);

const expectedPrincipalTokens = TOTAL_PRINCIPAL.total_principal
  .reduce((sum, row) => sum + Number(BigInt(row.amount.amount)) / 1e6, 0);

const USDX_PRICE = PRICE("usdx:usd");


describe("adaptKavaCdpState", () => {
  it("publishes one slice per priced collateral denom with market-valued liability metrics", () => {
    const result = adaptKavaCdpState(makeState());

    expect(result.slices).toHaveLength(7);
    const byName = new Map(result.slices.map((slice) => [slice.name, slice]));
    expect(byName.get("HBTC")!.risk).toBe("medium");
    expect(byName.get("BTCB")!.risk).toBe("medium");
    expect(byName.get("XRPB")!.risk).toBe("medium");
    expect(byName.get("KAVA")!.risk).toBe("high");
    expect(byName.get("BNB")!.risk).toBe("high");
    expect(byName.get("BUSD")!.risk).toBe("low");
    expect(byName.get("USDT")!.risk).toBe("low");
    expect(byName.get("BUSD")!.pct).toBeCloseTo(((expectedDenomValueUsd("busd") / expectedTotalCollateralUsd) * 100), 9);
    expect(byName.get("HBTC")!.pct).toBeCloseTo(((expectedDenomValueUsd("hbtc") / expectedTotalCollateralUsd) * 100), 9);
    expect(byName.get("USDT")!.pct).toBeCloseTo(((expectedDenomValueUsd("erc20/tether/usdt") / expectedTotalCollateralUsd) * 100), 9);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 9);
    expect(byName.get("HBTC")!.sourceKey).toBe("kava-cdp:hbtc");

    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: expect.closeTo(expectedTotalCollateralUsd, 6),
      totalLiabilitiesUsd: expect.closeTo(expectedPrincipalTokens * USDX_PRICE, 6),
      supplyTokens: expect.closeTo(10001377482335 / 1e6, 6),
      supplyUsd: expect.closeTo((10001377482335 / 1e6) * USDX_PRICE, 6),
      collateralizationRatio: expect.closeTo(expectedTotalCollateralUsd / (expectedPrincipalTokens * USDX_PRICE), 6),
      details: expect.objectContaining({
        proofKind: "kava-cdp-module-totals",
        chainId: "kava_2222-10",
        blockHeight: 22494995,
        blockTimeIso: BLOCK_TIME_ISO,
        usdxPriceUsd: 0.66,
        principalUsdxTokens: expect.closeTo(expectedPrincipalTokens, 6),
      }),
    });
    // Every non-zero collateral type is priced today, so no warnings fire; the
    // zero-balance legacy types (HARD/SWP) are simply absent from the mix.
    expect(result.warnings ?? []).toEqual([]);
  });

  it("withholds the whole book when a positive collateral type has no price market", () => {
    const state = makeState();
    state.collateral.total_collateral.find((row) => row.collateral_type === "swp-a")!.amount.amount = "1000000000";
    state.principal.total_principal.find((row) => row.collateral_type === "swp-a")!.amount.amount = "750000000000";
    const result = adaptKavaCdpState(state);
    const expectedPct = (750000 / (expectedPrincipalTokens - 4889684 / 1e6 + 750000)) * 100;
    expect(result.slices).toEqual([]);
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata).not.toHaveProperty("unknownExposurePct");
    expect(result.metadata?.details).toMatchObject({
      measuredCollateralUsd: expect.closeTo(expectedTotalCollateralUsd, 6),
      unpricedCollateralTypes: ["swp-a"], unpricedPrincipalTokens: 750000,
      unpricedPrincipalPct: expect.closeTo(expectedPct, 6),
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "collateral-coverage-incomplete", effect: "fatal",
    }));
  });

  it.each(["missing params", "missing collateral total"] as const)("withholds unmeasurable positive scope with %s", (missing) => {
    const state = makeState();
    if (missing === "missing params") {
      state.params.params.collateral_params = state.params.params.collateral_params.filter((row) => row.type !== "bnb-a");
    } else {
      state.collateral.total_collateral = state.collateral.total_collateral.filter((row) => row.collateral_type !== "bnb-a");
    }
    const result = adaptKavaCdpState(state);
    expect(result.slices).toEqual([]);
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata?.details).toMatchObject({ unpricedCollateralTypes: ["bnb-a"] });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "collateral-coverage-incomplete", effect: "fatal" }));
  });

  it("accepts an observed zero contributor without its unavailable valuation params", () => {
    const state = makeState();
    state.params.params.collateral_params = state.params.params.collateral_params.filter((row) => row.type !== "swp-a");
    const result = adaptKavaCdpState(state);
    expect(result.slices).toHaveLength(7);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(expectedTotalCollateralUsd, 6);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("fails closed when the USDX liability price market is missing", () => {
    const state = makeState();
    state.prices.prices = state.prices.prices.filter((market) => market.market_id !== "usdx:usd");

    expect(() => adaptKavaCdpState(state)).toThrow("USDX liability price market usdx:usd is missing");
  });

  it("fails closed on a stale or future pinned block", () => {
    expect(() => adaptKavaCdpState(makeState({ nowSec: BLOCK_TIME_SEC + 10 * 60 })))
      .toThrow("latest block identity or freshness validation failed");
    expect(() => adaptKavaCdpState(makeState({ nowSec: BLOCK_TIME_SEC - 120 })))
      .toThrow("latest block identity or freshness validation failed");
  });

  it("fails closed when a principal row is not USDX-denominated", () => {
    const state = makeState();
    state.principal.total_principal[0]!.amount.denom = "kava";

    expect(() => adaptKavaCdpState(state)).toThrow("expected usdx");
  });

  it.each(["249610005372", "0"])("rejects a collateral denomination mismatch before scaling amount %s", (amount) => {
    const state = makeState();
    state.collateral.total_collateral[0]!.amount = { denom: "ukava", amount };
    expect(() => adaptKavaCdpState(state)).toThrow("expected bnb");
  });

  it.each(["collateral", "principal"] as const)("rejects conflicting duplicate %s identities", (ledger) => {
    const state = makeState();
    if (ledger === "collateral") {
      state.collateral.total_collateral.push({ collateral_type: "bnb-a", amount: { denom: "ukava", amount: "1" } });
    } else {
      state.principal.total_principal.push({ collateral_type: "bnb-a", amount: { denom: "usdx", amount: "1" } });
    }
    expect(() => adaptKavaCdpState(state)).toThrow(`duplicate ${ledger} row for type bnb-a`);
  });
});

describe("fetchKavaCdpReserves", () => {
  it("rejects incomplete valuation at the HTTP boundary without replacement weights", async () => {
    const collateral = structuredClone(TOTAL_COLLATERAL);
    collateral.total_collateral.find((row) => row.collateral_type === "swp-a")!.amount.amount = "1000000000";
    const { result, report } = await runAdapter("kava-cdp", makeCoin(), {
      network: kavaNetwork({ [TOTAL_COLLATERAL_URL]: collateral }),
      nowSec: BLOCK_TIME_SEC,
      validate: false,
    });
    expect(report.valid).toBe(false);
    expect(result.slices).toEqual([]);
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "collateral-coverage-incomplete", effect: "fatal" }));
  });

  it("fails closed when an upstream response drops a required field", async () => {
    await expect(runAdapter("kava-cdp", makeCoin(), {
      network: kavaNetwork({
        [TOTAL_COLLATERAL_URL]: { total_collateral: undefined },
      }),
      nowSec: BLOCK_TIME_SEC,
      validate: false,
    })).rejects.toThrow(/schema validation/);
  });
});
