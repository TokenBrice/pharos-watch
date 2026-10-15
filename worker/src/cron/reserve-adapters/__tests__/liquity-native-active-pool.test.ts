import type { AdapterNetworkSpec } from "./reserve-adapter.test-support";
import { describe, expect, it } from "vitest";
import { runAdapter } from "./reserve-adapter.test-support";
import usdfc from "@shared/data/stablecoins/coins/usdfc-secured-finance.json";

const ACTIVE_POOL = "0x3012C2fE1240e3754E5C200A0946bb0E07474876";
const PRICE_FEED = "0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88";
const TROVE_MANAGER = "0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193";
const BORROWER_OPERATIONS = "0x44b1bac67dDA612a41a58AAf779143B181dEe031";
const DEBT_SELECTOR = "0x14a6bf0f";
const COLLATERAL_SELECTOR = "0x1529a639";
const PRICE_SELECTOR = "0x0fdb11cf";
const MCR_SELECTOR = "0x794e5724";
const TCR_SELECTOR = "0xb82f263d";
const REDEMPTION_SELECTOR = "0x540385a3";
const WAD = 10n ** 18n;
const RATE_RAW = 75n * WAD / 10_000n;

function networkFor(
  tcr: bigint | null = 167n * 10n ** 16n,
  invalid?: { selector: string; value: bigint | null },
): AdapterNetworkSpec {
  return {
    chains: { mezo: "https://mainnet.mezo.public.validationcloud.io" },
    block: { number: 23_000_123, timestamp: 1_800_000_000 },
    rpc: {
      [`mezo:${ACTIVE_POOL}:${DEBT_SELECTOR}`]: invalid?.selector === DEBT_SELECTOR ? invalid.value : 3_500_000n * WAD,
      [`mezo:${ACTIVE_POOL}:${COLLATERAL_SELECTOR}`]: invalid?.selector === COLLATERAL_SELECTOR ? invalid.value : 90n * WAD,
      [`mezo:${PRICE_FEED}:${PRICE_SELECTOR}`]: invalid?.selector === PRICE_SELECTOR ? invalid.value : 65_000n * WAD,
      [`mezo:${TROVE_MANAGER}:${MCR_SELECTOR}`]: invalid?.selector === MCR_SELECTOR ? invalid.value : 110n * 10n ** 16n,
      [`mezo:${TROVE_MANAGER}:${TCR_SELECTOR}`]: tcr,
      [`mezo:${BORROWER_OPERATIONS}:${REDEMPTION_SELECTOR}`]: invalid?.selector === REDEMPTION_SELECTOR ? invalid.value : RATE_RAW,
    },
  };
}

function fetchPool(network = networkFor()) {
  return runAdapter("liquity-native-active-pool", "meusd-mezo", {
    network,
    nowSec: 1_800_000_000,
  });
}

describe("fetchLiquityNativeActivePoolReserves", () => {
  it("emits native collateral and route telemetry without equating gross debt to executable capacity", async () => {
    const { result } = await fetchPool();

    expect(result.slices).toEqual([
      { sourceKey: "liquity-native-active-pool:0x3012c2fe1240e3754e5c200a0946bb0e07474876", name: "BTC collateral in Mezo ActivePool", pct: 100, risk: "medium" },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      totalDebtUsd: 3_500_000,
      totalReserveUsd: 5_850_000,
      collateralizationRatio: 5_850_000 / 3_500_000,
      collateralPriceUsd: 65_000,
      totalCollateralRatio: 1.67,
      minimumCollateralRatio: 1.1,
      redemption: {
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        feeBps: 75,
      },
      details: {
        debtRaw: "3500000000000000000000000",
        collateralRaw: "90000000000000000000",
      },
    });
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.metadata?.redemption).not.toHaveProperty("capacityKind");
  });

  it("retains USDFC FIL backing and TroveManager fee telemetry without gross-debt capacity", async () => {
    const params = usdfc.liveReservesConfig.params;
    const { result } = await runAdapter("liquity-native-active-pool", "usdfc-secured-finance", {
      nowSec: 1_800_000_000,
      network: {
        chains: { filecoin: params.rpcUrl },
        block: { number: 6_458_485, timestamp: 1_800_000_000 },
        rpc: {
          [`filecoin:${params.activePoolAddress}:${params.debtSelector}`]: 1_000_000n * WAD,
          [`filecoin:${params.activePoolAddress}:${params.collateralBalanceSelector}`]: 2_000_000n * WAD,
          [`filecoin:${params.priceFeedAddress}:${params.priceSelector}`]: WAD,
          [`filecoin:${params.troveManagerAddress}:${params.mcrSelector}`]: 110n * 10n ** 16n,
          [`filecoin:${params.troveManagerAddress}:${params.tcrSelector}`]: 2n * WAD,
          [`filecoin:${params.borrowerOperationsAddress}:${params.redemptionRateSelector}`]: 50n * WAD / 10_000n,
        },
      },
    });
    expect(result.slices).toMatchObject([{
      sourceKey: `liquity-native-active-pool:${params.activePoolAddress}`,
      pct: 100, risk: "medium",
    }]);
    expect(result.metadata).toMatchObject({
      totalDebtUsd: 1_000_000,
      totalReserveUsd: 2_000_000,
      collateralizationRatio: 2,
      redemption: {
        routeStatus: "open", routeStatusSource: "onchain",
        freshnessKind: "same-run-onchain", holderEligibility: "any-holder",
        settlementDelaySec: 0, feeBps: 50,
      },
    });
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.metadata?.redemption).not.toHaveProperty("capacityKind");
    expect(result.metadata).not.toHaveProperty("immediateRedeemableUsd");
  });

  it.each([
    [110n * 10n ** 16n, "open"],
    [110n * 10n ** 16n - 1n, "degraded"],
  ] as const)("compares raw TCR %s against MCR without rounded-ratio loss", async (tcr, status) => {
    const { result } = await fetchPool(networkFor(tcr));
    expect(result.metadata?.redemption?.routeStatus).toBe(status);
    expect(result.warnings?.map(({ code }) => code) ?? []).toEqual(
      status === "open" ? [] : ["redemption-route-status-degraded"],
    );
  });

  it("distinguishes unreadable TCR from a degraded measured ratio", async () => {
    const { result } = await fetchPool(networkFor(null));
    expect(result.metadata?.redemption?.routeStatus).toBe("unknown");
    expect(result.metadata).not.toHaveProperty("totalCollateralRatio");
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "redemption-route-status-degraded", effect: "degraded" }),
    ]);
  });

  it("rejects each required read when zero or unreadable", async () => {
    for (const [selector, message] of [
      [DEBT_SELECTOR, "active-pool debt"], [COLLATERAL_SELECTOR, "native collateral balance"],
      [PRICE_SELECTOR, "collateral price"], [MCR_SELECTOR, "MCR"],
    ] as const) {
      for (const value of [0n, null] as const) {
        await expect(fetchPool(networkFor(undefined, { selector, value }))).rejects.toThrow(`${message} read is zero/unreadable`);
      }
    }
  });

  it("keeps valid reserves without inventing an unavailable optional fee", async () => {
    const { result } = await fetchPool(networkFor(undefined, { selector: REDEMPTION_SELECTOR, value: null }));
    expect(result.slices).toEqual([{ sourceKey: "liquity-native-active-pool:0x3012c2fe1240e3754e5c200a0946bb0e07474876", name: "BTC collateral in Mezo ActivePool", pct: 100, risk: "medium" }]);
    expect(result.metadata?.redemption?.routeStatus).toBe("open");
    expect(result.metadata).not.toHaveProperty("redemptionFeeBps");
    expect(result.metadata?.redemption).not.toHaveProperty("feeBps");
  });
});
