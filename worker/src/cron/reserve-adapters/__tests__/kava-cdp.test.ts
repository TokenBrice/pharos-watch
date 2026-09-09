import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
  };
});

import {
  adaptKavaCdpState,
  fetchKavaCdpReserves,
  type KavaBankSupplyPayload,
  type KavaBlockPayload,
  type KavaCdpParamsPayload,
  type KavaCdpPrincipalPayload,
  type KavaCdpTotalsPayload,
  type KavaPricefeedPricesPayload,
  type KavaCdpState,
} from "../kava-cdp";
import { fetchJsonWithRetry } from "../helpers";

const LCD_ORIGIN = "https://api.data.kava.io";
const TOTAL_COLLATERAL_URL = `${LCD_ORIGIN}/kava/cdp/v1beta1/totalCollateral`;

// Captured 2026-09-09 from the public Kava LCD (https://api.data.kava.io).
const TOTAL_COLLATERAL: KavaCdpTotalsPayload = {
  total_collateral: [
    { collateral_type: "bnb-a", amount: { denom: "bnb", amount: "249610005372" } },
    { collateral_type: "btcb-a", amount: { denom: "btcb", amount: "6256568578" } },
    { collateral_type: "busd-a", amount: { denom: "busd", amount: "86207769963709" } },
    { collateral_type: "busd-b", amount: { denom: "busd", amount: "10000000000" } },
    { collateral_type: "hard-a", amount: { denom: "hard", amount: "0" } },
    { collateral_type: "hbtc-a", amount: { denom: "hbtc", amount: "65000000000" } },
    { collateral_type: "swp-a", amount: { denom: "swp", amount: "0" } },
    { collateral_type: "ukava-a", amount: { denom: "ukava", amount: "40002642242977" } },
    { collateral_type: "usdt-a", amount: { denom: "erc20/tether/usdt", amount: "102797461579" } },
    { collateral_type: "xrpb-a", amount: { denom: "xrpb", amount: "172157183731604" } },
  ],
};

const TOTAL_PRINCIPAL: KavaCdpPrincipalPayload = {
  total_principal: [
    { collateral_type: "bnb-a", amount: { denom: "usdx", amount: "354264229965" } },
    { collateral_type: "btcb-a", amount: { denom: "usdx", amount: "1639014011659" } },
    { collateral_type: "busd-a", amount: { denom: "usdx", amount: "837987882801" } },
    { collateral_type: "busd-b", amount: { denom: "usdx", amount: "89533890" } },
    { collateral_type: "xrpb-a", amount: { denom: "usdx", amount: "744848610287" } },
    { collateral_type: "ukava-a", amount: { denom: "usdx", amount: "140555725875" } },
    { collateral_type: "hard-a", amount: { denom: "usdx", amount: "5804835" } },
    { collateral_type: "hbtc-a", amount: { denom: "usdx", amount: "3672104985666" } },
    { collateral_type: "swp-a", amount: { denom: "usdx", amount: "4889684" } },
    { collateral_type: "usdt-a", amount: { denom: "usdx", amount: "99397193555" } },
  ],
};

const CDP_PARAMS: KavaCdpParamsPayload = {
  params: {
    collateral_params: [
      { denom: "bnb", type: "bnb-a", spot_market_id: "bnb:usd", conversion_factor: "8", liquidation_ratio: "1.500000000000000000" },
      { denom: "btcb", type: "btcb-a", spot_market_id: "btc:usd", conversion_factor: "8", liquidation_ratio: "1.500000000000000000" },
      { denom: "busd", type: "busd-a", spot_market_id: "busd:usd", conversion_factor: "8", liquidation_ratio: "1.010000000000000000" },
      { denom: "busd", type: "busd-b", spot_market_id: "busd:usd", conversion_factor: "8", liquidation_ratio: "1.100000000000000000" },
      { denom: "xrpb", type: "xrpb-a", spot_market_id: "xrp:usd", conversion_factor: "8", liquidation_ratio: "1.500000000000000000" },
      { denom: "ukava", type: "ukava-a", spot_market_id: "kava:usd", conversion_factor: "6", liquidation_ratio: "1.500000000000000000" },
      { denom: "hard", type: "hard-a", spot_market_id: "hard:usd", conversion_factor: "6", liquidation_ratio: "1.500000000000000000" },
      { denom: "hbtc", type: "hbtc-a", spot_market_id: "btc:usd", conversion_factor: "8", liquidation_ratio: "1.500000000000000000" },
      { denom: "swp", type: "swp-a", spot_market_id: "swp:usd", conversion_factor: "6", liquidation_ratio: "1.500000000000000000" },
      { denom: "erc20/tether/usdt", type: "usdt-a", spot_market_id: "usdt:usd", conversion_factor: "6", liquidation_ratio: "1.010000000000000000" },
    ],
  },
};

const PRICEFEED_PRICES: KavaPricefeedPricesPayload = {
  prices: [
    { market_id: "bnb:usd", price: "741.384999999999977262" },
    { market_id: "btc:usd", price: "78662.295000000002910383" },
    { market_id: "busd:usd", price: "1.000000000000000000" },
    { market_id: "hard:usd", price: "0.001000000000000000" },
    { market_id: "kava:usd", price: "0.060665000000000001" },
    { market_id: "usdt:usd", price: "1.000000000000000000" },
    { market_id: "usdx:usd", price: "0.660000000000000000" },
    { market_id: "xrp:usd", price: "1.420849999999999976" },
  ],
};

const BANK_SUPPLY: KavaBankSupplyPayload = {
  amount: { denom: "usdx", amount: "10001377482335" },
};

const BLOCK_TIME_ISO = "2026-09-09T16:04:00.753265572Z";
const BLOCK_TIME_SEC = Math.floor(Date.parse(BLOCK_TIME_ISO) / 1000);

const LATEST_BLOCK: KavaBlockPayload = {
  block: { header: { chain_id: "kava_2222-10", height: "22494995", time: BLOCK_TIME_ISO } },
};

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
  return { id: "usdx-kava", name: "USDX", symbol: "USDX" } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "kava-cdp",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "http-json", url: TOTAL_COLLATERAL_URL },
    },
    params: {},
  } as unknown as LiveReservesConfig;
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

beforeEach(() => {
  vi.clearAllMocks();
});

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
    const round1 = (value: number) => Math.round(value * 10) / 10;
    expect(byName.get("BUSD")!.pct).toBeCloseTo(round1((expectedDenomValueUsd("busd") / expectedTotalCollateralUsd) * 100), 9);
    expect(byName.get("HBTC")!.pct).toBeCloseTo(round1((expectedDenomValueUsd("hbtc") / expectedTotalCollateralUsd) * 100), 9);
    expect(byName.get("USDT")!.pct).toBeCloseTo(round1((expectedDenomValueUsd("erc20/tether/usdt") / expectedTotalCollateralUsd) * 100), 9);
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

  it("degrades with quantified unknown exposure when a positive collateral type has no price market", () => {
    const state = makeState();
    state.collateral.total_collateral.find((row) => row.collateral_type === "swp-a")!.amount.amount = "1000000000";
    state.principal.total_principal.find((row) => row.collateral_type === "swp-a")!.amount.amount = "750000000000";

    const result = adaptKavaCdpState(state);

    const expectedPct = (750000 / (expectedPrincipalTokens - 4889684 / 1e6 + 750000)) * 100;
    expect(result.metadata!.unknownExposurePct).toBeCloseTo(expectedPct, 6);
    const warning = result.warnings!.find((entry) => entry.code === "unpriced-collateral-type");
    expect(warning).toMatchObject({ severity: "warning", effect: "degraded" });
    // SWP must not be priced with any proxy value.
    expect(result.slices.map((slice) => slice.name)).not.toContain("SWP");
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
});

describe("fetchKavaCdpReserves", () => {
  it("reads the six LCD endpoints and adapts the payloads", async () => {
    const payloads: Record<string, unknown> = {
      [TOTAL_COLLATERAL_URL]: TOTAL_COLLATERAL,
      [`${LCD_ORIGIN}/kava/cdp/v1beta1/totalPrincipal`]: TOTAL_PRINCIPAL,
      [`${LCD_ORIGIN}/kava/cdp/v1beta1/params`]: CDP_PARAMS,
      [`${LCD_ORIGIN}/kava/pricefeed/v1beta1/prices`]: PRICEFEED_PRICES,
      [`${LCD_ORIGIN}/cosmos/bank/v1beta1/supply/by_denom?denom=usdx`]: BANK_SUPPLY,
      [`${LCD_ORIGIN}/cosmos/base/tendermint/v1beta1/blocks/latest`]: LATEST_BLOCK,
    };
    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url: string) => {
      const payload = payloads[url];
      if (payload === undefined) throw new Error(`unexpected URL ${url}`);
      return payload;
    });

    const signal = new AbortController().signal;
    const result = await fetchKavaCdpReserves(makeCoin(), makeConfig(), signal, { nowSec: BLOCK_TIME_SEC });

    expect(result.metadata).toMatchObject({ freshnessMode: "not-applicable" });
    expect(result.slices.length).toBeGreaterThan(0);
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(6);
  });

  it("propagates the LCD failure", async () => {
    vi.mocked(fetchJsonWithRetry).mockRejectedValue(
      new Error(`HTTP 503 for ${TOTAL_COLLATERAL_URL}`),
    );

    await expect(fetchKavaCdpReserves(makeCoin(), makeConfig(), new AbortController().signal, { nowSec: BLOCK_TIME_SEC }))
      .rejects.toThrow("HTTP 503");
  });
});
