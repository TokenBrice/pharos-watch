import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import usdx from "@shared/data/stablecoins/coins/usdx-kava.json";
import { adaptKavaCdpState, type KavaCdpState } from "../kava-cdp";
import {
  ARCHIVE_KAVA_LCD_FIXTURES,
  ARCHIVE_LCD_ORIGIN,
  ARCHIVE_TOTAL_COLLATERAL_URL,
  BANK_SUPPLY,
  BLOCK_TIME_ISO,
  BLOCK_TIME_SEC,
  CDP_PARAMS,
  KAVA_LCD_FIXTURES,
  LATEST_BLOCK,
  LCD_ORIGIN,
  PRICEFEED_PRICES,
  TOTAL_COLLATERAL,
  TOTAL_COLLATERAL_URL,
  TOTAL_PRINCIPAL,
  kavaNetwork,
} from "./kava-cdp.test-support";
import { installAdapterNetwork, runAdapter, runAdapterWithFakeTimers } from "./reserve-adapter.test-support";

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
  it("reads from the primary pruning LCD origin first without touching the archive fallback", async () => {
    const { result, network } = await runAdapter("kava-cdp", makeCoin(), {
      network: kavaNetwork(),
      nowSec: BLOCK_TIME_SEC,
    });
    expect(result.slices).toHaveLength(7);
    expect(network.requests.map((request) => request.url)).toEqual(Object.keys(KAVA_LCD_FIXTURES));
    expect(network.requests.every((request) => request.url.startsWith(`${LCD_ORIGIN}/`))).toBe(true);
  });

  it("fails over to the archive fallback when primary returns HTTP 502, binding collateral and latest block to the same origin", async () => {
    const archiveBlock: KavaCdpState["block"] = {
      block: { header: { ...LATEST_BLOCK.block.header, height: "23626256" } },
    };
    const network = installAdapterNetwork({
      json: {
        [TOTAL_COLLATERAL_URL]: { status: 502, body: "Bad Gateway" },
        ...ARCHIVE_KAVA_LCD_FIXTURES,
        [`${ARCHIVE_LCD_ORIGIN}/cosmos/base/tendermint/v1beta1/blocks/latest`]: archiveBlock,
      },
    });
    const { result } = await runAdapterWithFakeTimers(() =>
      runAdapter("kava-cdp", makeCoin(), {
        network,
        nowSec: BLOCK_TIME_SEC,
      }),
    );
    expect(result.slices).toHaveLength(7);
    expect(result.metadata?.details).toMatchObject({ blockHeight: 23626256 });
    const archiveUrls = network.requests
      .map((request) => request.url)
      .filter((url) => url.startsWith(`${ARCHIVE_LCD_ORIGIN}/`));
    expect(archiveUrls).toEqual(Object.keys(ARCHIVE_KAVA_LCD_FIXTURES));
    expect(network.requests.some((request) => request.url === `${LCD_ORIGIN}/cosmos/base/tendermint/v1beta1/blocks/latest`)).toBe(false);
  });

  it("never mixes origins when a mid-sequence primary read fails with HTTP 502", async () => {
    const archiveBlock: KavaCdpState["block"] = {
      block: { header: { ...LATEST_BLOCK.block.header, height: "23626300" } },
    };
    const archiveCollateral = structuredClone(TOTAL_COLLATERAL);
    archiveCollateral.total_collateral.find((row) => row.collateral_type === "busd-a")!.amount.amount = "96207769963709";
    const network = installAdapterNetwork({
      json: {
        ...KAVA_LCD_FIXTURES,
        [`${LCD_ORIGIN}/cosmos/base/tendermint/v1beta1/blocks/latest`]: { status: 502, body: "Bad Gateway" },
        ...ARCHIVE_KAVA_LCD_FIXTURES,
        [ARCHIVE_TOTAL_COLLATERAL_URL]: archiveCollateral,
        [`${ARCHIVE_LCD_ORIGIN}/cosmos/base/tendermint/v1beta1/blocks/latest`]: archiveBlock,
      },
    });
    const { result } = await runAdapterWithFakeTimers(() =>
      runAdapter("kava-cdp", makeCoin(), {
        network,
        nowSec: BLOCK_TIME_SEC,
      }),
    );
    expect(result.metadata?.details).toMatchObject({ blockHeight: 23626300 });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(expectedTotalCollateralUsd + 100_000, 4);
    const urls = network.requests.map((request) => request.url);
    const firstArchiveIndex = urls.findIndex((url) => url.startsWith(`${ARCHIVE_LCD_ORIGIN}/`));
    expect(firstArchiveIndex).toBeGreaterThan(0);
    expect(urls.slice(firstArchiveIndex)).toEqual(Object.keys(ARCHIVE_KAVA_LCD_FIXTURES));
  });

  it("fails closed when every configured origin returns HTTP 502", async () => {
    await expect(
      runAdapterWithFakeTimers(() =>
        runAdapter("kava-cdp", makeCoin(), {
          network: {
            json: {
              [TOTAL_COLLATERAL_URL]: { status: 502, body: "Bad Gateway" },
              [ARCHIVE_TOTAL_COLLATERAL_URL]: { status: 502, body: "Bad Gateway" },
            },
          },
          nowSec: BLOCK_TIME_SEC,
          validate: false,
        }),
      ),
    ).rejects.toThrow(/502/);
  });

  it("propagates cancellation without probing the archive fallback", async () => {
    const controller = new AbortController();
    controller.abort(new Error("kava-cdp cancelled"));
    const network = installAdapterNetwork({
      json: { ...KAVA_LCD_FIXTURES, ...ARCHIVE_KAVA_LCD_FIXTURES },
    });

    await expect(runAdapter("kava-cdp", makeCoin(), {
      network,
      signal: controller.signal,
      nowSec: BLOCK_TIME_SEC,
      validate: false,
    })).rejects.toThrow("kava-cdp cancelled");
    expect(network.requests.every((request) => !request.url.startsWith(`${ARCHIVE_LCD_ORIGIN}/`))).toBe(true);
  });

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

  it("fails closed when an upstream response drops a required field on every origin", async () => {
    await expect(runAdapter("kava-cdp", makeCoin(), {
      network: kavaNetwork({
        [TOTAL_COLLATERAL_URL]: { total_collateral: undefined },
        [ARCHIVE_TOTAL_COLLATERAL_URL]: { total_collateral: undefined },
      }),
      nowSec: BLOCK_TIME_SEC,
      validate: false,
    })).rejects.toThrow(/schema validation/);
  });
});
