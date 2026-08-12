import { describe, expect, it } from "vitest";
import {
  adaptEthenaCollateral,
  buildEthenaRedemptionTelemetry,
  listUnexpectedEthenaAssets,
  type EthenaCollateralResponse,
  type EthenaMintRedeemReads,
} from "../ethena";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

describe("adaptEthenaCollateral", () => {
  it("groups Ethena collateral into reserve buckets", () => {
    const payload: EthenaCollateralResponse = {
      totalBackingAssetsInUsd: 100,
      collateral: [
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 1, usdAmount: 35 },
        { asset: "BTC", exchange: "Binance", timestamp: 1, usdAmount: 20 },
        { asset: "ETH", exchange: "Binance", timestamp: 1, usdAmount: 15 },
        { asset: "WBETH", exchange: "Binance", timestamp: 1, usdAmount: 15 },
        { asset: "SOL", exchange: "Binance", timestamp: 1, usdAmount: 15 },
      ],
    };

    const result = adaptEthenaCollateral(payload);

    expect(result.slices).toEqual([
      { name: "Liquid Cash strategy basket", pct: 35, risk: "medium" },
      { name: "ETH / liquid staking collateral", pct: 30, risk: "medium" },
      { name: "BTC collateral", pct: 20, risk: "medium" },
      { name: "Other crypto collateral", pct: 15, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      assetCount: 5,
      totalBackingAssetsInUsd: 100,
      lastUpdatedAt: 1,
      sourceTimestamp: 1,
      freshnessMode: "verified",
    });
    expect(result.metadata?.immediateRedeemableUsd).toBeUndefined();
    expect(result.metadata?.immediateRedeemableRatio).toBeUndefined();
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("does not warn for known alt-collateral already bucketed into other", () => {
    const payload: EthenaCollateralResponse = {
      totalBackingAssetsInUsd: 100,
      collateral: [
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 1, usdAmount: 80 },
        { asset: "SOL", exchange: "Binance", timestamp: 1, usdAmount: 5 },
        { asset: "XRP", exchange: "Binance", timestamp: 1, usdAmount: 5 },
        { asset: "BNB", exchange: "Binance", timestamp: 1, usdAmount: 5 },
        { asset: "HYPE", exchange: "Binance", timestamp: 1, usdAmount: 5 },
      ],
    };

    expect(listUnexpectedEthenaAssets(payload)).toEqual([]);
  });

  it("still surfaces genuinely new Ethena assets", () => {
    const payload: EthenaCollateralResponse = {
      totalBackingAssetsInUsd: 100,
      collateral: [
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 1, usdAmount: 95 },
        { asset: "DOGE", exchange: "Binance", timestamp: 1, usdAmount: 5 },
      ],
    };

    expect(listUnexpectedEthenaAssets(payload)).toEqual(["DOGE"]);
  });

  it("uses the oldest material collateral timestamp as source freshness", () => {
    const payload: EthenaCollateralResponse = {
      totalBackingAssetsInUsd: 100,
      collateral: [
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 1_000, usdAmount: 60 },
        { asset: "BTC", exchange: "Binance", timestamp: 4_700, usdAmount: 40 },
        { asset: "ETH", exchange: "Binance", timestamp: 100, usdAmount: 0 },
      ],
    };

    const result = adaptEthenaCollateral(payload);

    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1_000,
      lastUpdatedAt: 4_700,
      latestRowUpdatedAt: 4_700,
      sourceTimestampSpreadSec: 3_700,
      sourceTimestampCount: 2,
    });
    expect(result.warnings?.some((warning) => warning.code === "source-timestamp-spread")).toBe(true);
  });

  it("does not treat the mixed Liquid Cash bucket as redemption capacity", () => {
    const payload: EthenaCollateralResponse = {
      totalBackingAssetsInUsd: 100,
      collateral: [
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 1, usdAmount: 100 },
      ],
    };

    const result = adaptEthenaCollateral(payload);

    expect(result.metadata).not.toHaveProperty("immediateRedeemableUsd");
    expect(result.metadata).not.toHaveProperty("immediateRedeemableRatio");
    expect(result.metadata).not.toHaveProperty("redemption");
  });
});

// Fixtures mirror the mainnet reads observed on 2026-08-12:
// usde() = 0x4c9e...68b3, globalMaxRedeemPerBlock = 10,000,000e18, both stables
// active with tokenType STABLE, USDT 21,573,293.566432 and USDC 30,653,831.67358.
const USDE_ADDRESS = "0x4c9edd5852cd905f086c759e8383e09bff1e68b3";
const MAX_MINT_PER_BLOCK = 200_000_000n * 10n ** 18n;
const MAX_REDEEM_PER_BLOCK = 10_000_000n * 10n ** 18n;
const USDT_BALANCE_RAW = 21_573_293_566_432n;
const USDC_BALANCE_RAW = 30_653_831_673_580n;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function addressWord(address: string): string {
  return address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

function tokenConfigWords(
  options: { tokenType?: bigint; isActive?: boolean; maxRedeemPerBlock?: bigint } = {},
): string {
  return `0x${word(options.tokenType ?? 0n)}${word(options.isActive === false ? 0n : 1n)}${word(MAX_MINT_PER_BLOCK)}${word(options.maxRedeemPerBlock ?? MAX_REDEEM_PER_BLOCK)}`;
}

function mintRedeemReads(overrides: Partial<EthenaMintRedeemReads> = {}): EthenaMintRedeemReads {
  return {
    usde: `0x${addressWord(USDE_ADDRESS)}`,
    globalConfig: `0x${word(MAX_MINT_PER_BLOCK)}${word(MAX_REDEEM_PER_BLOCK)}`,
    "tokenConfig:USDT": tokenConfigWords(),
    "tokenConfig:USDC": tokenConfigWords(),
    "balanceOf:USDT": `0x${word(USDT_BALANCE_RAW)}`,
    "balanceOf:USDC": `0x${word(USDC_BALANCE_RAW)}`,
    ...overrides,
  };
}

describe("buildEthenaRedemptionTelemetry", () => {
  it("sums the mint/redeem contract's active stablecoin balances as direct capacity", () => {
    const telemetry = buildEthenaRedemptionTelemetry(mintRedeemReads());

    expect(telemetry).not.toBeNull();
    expect(telemetry?.capacityUsd).toBeCloseTo(52_227_125.240012, 5);
    expect(telemetry).toMatchObject({
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "whitelisted-primary",
      mintRedeemContract: "0xe3490297a08d6fc8da46edb7b6142e4f461b62d3",
      globalMaxRedeemPerBlockUsde: 10_000_000,
    });
    expect(telemetry?.sourceUrls).toHaveLength(2);
  });

  it("passes adapter output validation with the ethena adapter definition", () => {
    const result = adaptEthenaCollateral({
      totalBackingAssetsInUsd: 100,
      collateral: [{ asset: "Liquid Cash", exchange: "Binance", timestamp: 1, usdAmount: 100 }],
    });
    const validation = validateAdapterOutput(
      {
        ...result,
        metadata: { ...result.metadata, redemption: buildEthenaRedemptionTelemetry(mintRedeemReads())! },
      },
      { adapter: getReserveAdapter("ethena") ?? undefined, now: 1 },
    );

    expect(validation.valid).toBe(true);
    expect(validation.warnings.some((warning) => warning.code.startsWith("redemption-capacity-kind"))).toBe(false);
  });

  it("emits no telemetry when a single read fails", () => {
    expect(buildEthenaRedemptionTelemetry(mintRedeemReads({ "balanceOf:USDC": null }))).toBeNull();
    expect(buildEthenaRedemptionTelemetry(mintRedeemReads({ "tokenConfig:USDT": null }))).toBeNull();
    expect(buildEthenaRedemptionTelemetry(mintRedeemReads({ globalConfig: null }))).toBeNull();
  });

  it("emits no telemetry when the contract is not the tracked USDe minter", () => {
    expect(
      buildEthenaRedemptionTelemetry(
        mintRedeemReads({ usde: `0x${addressWord("0x1111111111111111111111111111111111111111")}` }),
      ),
    ).toBeNull();
    expect(buildEthenaRedemptionTelemetry(mintRedeemReads({ usde: null }))).toBeNull();
  });

  it("emits no telemetry when collateral is not a STABLE token type", () => {
    expect(
      buildEthenaRedemptionTelemetry(mintRedeemReads({ "tokenConfig:USDC": tokenConfigWords({ tokenType: 1n }) })),
    ).toBeNull();
  });

  it("reports zero capacity as a degraded route rather than dropping telemetry", () => {
    const telemetry = buildEthenaRedemptionTelemetry(
      mintRedeemReads({ "balanceOf:USDT": `0x${word(0n)}`, "balanceOf:USDC": `0x${word(0n)}` }),
    );

    expect(telemetry).toMatchObject({ capacityUsd: 0, routeStatus: "degraded" });
  });

  it("excludes an inactive collateral asset and degrades the route", () => {
    const telemetry = buildEthenaRedemptionTelemetry(
      mintRedeemReads({ "tokenConfig:USDT": tokenConfigWords({ isActive: false }) }),
    );

    expect(telemetry?.capacityUsd).toBeCloseTo(30_653_831.67358, 5);
    expect(telemetry?.routeStatus).toBe("degraded");
    expect(telemetry?.routeStatusReason).toContain("USDT");
  });

  it("pauses the route when the gatekeeper zeroes the global redeem cap", () => {
    const telemetry = buildEthenaRedemptionTelemetry(
      mintRedeemReads({ globalConfig: `0x${word(0n)}${word(0n)}` }),
    );

    expect(telemetry).toMatchObject({ capacityUsd: 0, routeStatus: "paused" });
    expect(telemetry?.routeStatusReason).toContain("globalMaxRedeemPerBlock");
  });
});
