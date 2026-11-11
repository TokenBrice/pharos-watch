import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
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

const expectedTotalCollateralUsd = 63_740_454.117967;
const expectedPrincipalTokens = 7_488_272.868217;

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
    expect(byName.get("BUSD")!.pct).toBeCloseTo(1.352638150398699, 9);
    expect(byName.get("HBTC")!.pct).toBeCloseTo(80.21670453644833, 9);
    expect(byName.get("USDT")!.pct).toBeCloseTo(0.161275069344107, 9);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 9);
    expect(byName.get("HBTC")!.sourceKey).toBe("kava-cdp:hbtc");

    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: expect.closeTo(expectedTotalCollateralUsd, 6),
      totalLiabilitiesUsd: expect.closeTo(4_942_260.09302322, 6),
      supplyTokens: expect.closeTo(10_001_377.482335, 6),
      supplyUsd: expect.closeTo(6_600_909.1383411, 6),
      collateralizationRatio: expect.closeTo(12.897025433353196, 6),
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
    expect(result.slices).toEqual([]);
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata).not.toHaveProperty("unknownExposurePct");
    expect(result.metadata?.details).toMatchObject({
      measuredCollateralUsd: expect.closeTo(expectedTotalCollateralUsd, 6),
      unpricedCollateralTypes: ["swp-a"], unpricedPrincipalTokens: 750000,
      unpricedPrincipalPct: expect.closeTo(9.103855348652467, 6),
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
