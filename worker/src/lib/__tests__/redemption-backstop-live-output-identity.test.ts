import { encodeAbiParameters } from "viem/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { buildRedemptionBackstopEntry } from "../redemption-backstop/sources";
import { liveSnapshot } from "./redemption-backstop-sources.test-support";
import {
  evaluateAdapterSnapshotAdmission,
  resolveAdapterCoin,
  runAdapter,
  type AdapterNetworkSpec,
} from "../../cron/reserve-adapters/__tests__/reserve-adapter.test-support";

afterEach(() => vi.unstubAllGlobals());

const NOW = 1_780_000_000;

// Verified at Ethereum block 25737172: redemptionAvailable() returned
// 5,000,000.00 against a supply of 22,834,920.56 (config note, reviewed
// 2026-08-12). The throttle read is the route's direct redeemable bound.
const USD3_SUPPLY_USD = 22_834_920.56;
const REDEMPTION_AVAILABLE_RAW = 5_000_000n * 10n ** 18n;
const TOTAL_SUPPLY_RAW = 22_834_920_564_803_451_236_744_370n;
const ONE = 10n ** 18n;

const MAIN_SELECTOR = "0xdffeadd0";
const ASSET_REGISTRY_SELECTOR = "0x979d7e86";
const BASKET_HANDLER_SELECTOR = "0x2f2439b1";
const TO_ASSET_SELECTOR = "0xcde2be8a";
const BASKETS_NEEDED_SELECTOR = "0x7121c273";
const QUOTE_SELECTOR = "0x3913d11a";
const PRICE_SELECTOR = "0xa035b1fe";
const COLLATERAL_STATUS_SELECTOR = "0x200d2ed2";
const FULLY_COLLATERALIZED_SELECTOR = "0xe45a5b2d";
const REDEMPTION_AVAILABLE_SELECTOR = "0x9926020b";
const DECIMALS_SELECTOR = "0x313ce567";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

const RTOKEN = "0x0d86883faf4ffd7aeb116390af37746f45b6f378";
const MAIN = "0x81117e3e98910c3dcf956b5fc97a7212e047acf4";
const ASSET_REGISTRY = "0xd75c9768c8ec003b792afac35d0bbacb44b5e500";
const BASKET_HANDLER = "0x19835e5817a6fdc944100e86da2fce86327457b8";
const SUSDS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
const STATIC_AAVE_USDC = "0x0adc69041a2b086f8772acce2a754f410f211bed";
const WCUSDCV3 = "0x27f2f159fe990ba83d57f39fd69661764bebf37a";
const STEAK_USDC = "0xbeef01735c132ada46aa9aa4c54623caa92a64cb";
const SUSDS_ASSET = "0x4fd189996b5344eb4cf9c749b97c7424d399d24e";
const STATIC_AAVE_USDC_ASSET = "0x56bcd730040417b871cdf2549564ebb3c88730c9";
const WCUSDCV3_ASSET = "0x4d6f9a0f0f57a8179a146f37dd93d558073b814f";
const STEAK_USDC_ASSET = "0xb1327ead6ab9a1e363c4fc61648bd3131a587e39";

function addressArg(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function addressWord(address: string): `0x${string}` {
  return `0x${addressArg(address)}`;
}

function uintWord(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function usdPrice(): `0x${string}` {
  return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [ONE, ONE]);
}

function redemptionBasketQuote(): `0x${string}` {
  const entries: Array<[`0x${string}`, bigint]> = [
    [SUSDS, 25n * ONE],
    [STATIC_AAVE_USDC, 25_000_000n],
    [WCUSDCV3, 25_000_000n],
    [STEAK_USDC, 25n * ONE],
  ];
  return encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256[]" }],
    [entries.map(([address]) => address), entries.map(([, quantity]) => quantity)],
  );
}

/**
 * USD3's capacity is live-only: `reserve-protocol-dtf` reads the RToken's own
 * `redemptionAvailable()` throttle as the direct redeemable bound. The throttle
 * is a USD bound over RToken units and does not observe which receipt tokens the
 * basket pays out, so the unresolved receipt identities cannot gate it.
 */
describe("usd3-reserve-protocol live redemption throttle", () => {
  it("admits the fresh redemptionAvailable() bound instead of rejecting it as an unobserved output identity", async () => {
    const { coin, config } = resolveAdapterCoin("reserve-protocol-dtf", "usd3-reserve-protocol");
    expect(config.adapter).toBe("reserve-protocol-dtf");
    expect(config.inputs.primary).toMatchObject({ kind: "onchain-evm", chain: "ethereum" });

    const network: AdapterNetworkSpec = {
      block: { number: 25_737_172, timestamp: NOW - 12 },
      rpc: {
        [`${RTOKEN}:${MAIN_SELECTOR}`]: addressWord(MAIN),
        [`${RTOKEN}:${BASKETS_NEEDED_SELECTOR}`]: 100n * ONE,
        [`${RTOKEN}:${REDEMPTION_AVAILABLE_SELECTOR}`]: REDEMPTION_AVAILABLE_RAW,
        [`${RTOKEN}:${TOTAL_SUPPLY_SELECTOR}`]: TOTAL_SUPPLY_RAW,
        [`${RTOKEN}:${DECIMALS_SELECTOR}`]: 18n,
        [`${MAIN}:${ASSET_REGISTRY_SELECTOR}`]: addressWord(ASSET_REGISTRY),
        [`${MAIN}:${BASKET_HANDLER_SELECTOR}`]: addressWord(BASKET_HANDLER),
        [`${BASKET_HANDLER}:${FULLY_COLLATERALIZED_SELECTOR}`]: uintWord(1n),
        [`${BASKET_HANDLER}:${COLLATERAL_STATUS_SELECTOR}`]: uintWord(0n),
        [`${BASKET_HANDLER}:${QUOTE_SELECTOR}`]: redemptionBasketQuote(),
        [`${ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${addressArg(SUSDS)}`]: addressWord(SUSDS_ASSET),
        [`${ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${addressArg(STATIC_AAVE_USDC)}`]: addressWord(STATIC_AAVE_USDC_ASSET),
        [`${ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${addressArg(WCUSDCV3)}`]: addressWord(WCUSDCV3_ASSET),
        [`${ASSET_REGISTRY}:${TO_ASSET_SELECTOR}${addressArg(STEAK_USDC)}`]: addressWord(STEAK_USDC_ASSET),
        [`${SUSDS}:${DECIMALS_SELECTOR}`]: 18n,
        [`${STATIC_AAVE_USDC}:${DECIMALS_SELECTOR}`]: 6n,
        [`${WCUSDCV3}:${DECIMALS_SELECTOR}`]: 6n,
        [`${STEAK_USDC}:${DECIMALS_SELECTOR}`]: 18n,
        [`${SUSDS_ASSET}:${PRICE_SELECTOR}`]: usdPrice(),
        [`${STATIC_AAVE_USDC_ASSET}:${PRICE_SELECTOR}`]: usdPrice(),
        [`${WCUSDCV3_ASSET}:${PRICE_SELECTOR}`]: usdPrice(),
        [`${STEAK_USDC_ASSET}:${PRICE_SELECTOR}`]: usdPrice(),
        [`${SUSDS_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: uintWord(0n),
        [`${STATIC_AAVE_USDC_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: uintWord(0n),
        [`${WCUSDCV3_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: uintWord(0n),
        [`${STEAK_USDC_ASSET}:${COLLATERAL_STATUS_SELECTOR}`]: uintWord(0n),
      },
    };

    const run = await runAdapter("reserve-protocol-dtf", coin, { network, nowSec: NOW });
    expect(run.result.metadata?.redemption).toMatchObject({
      capacityUsd: 5_000_000,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "any-holder",
    });

    const admission = evaluateAdapterSnapshotAdmission(run, NOW);
    expect(admission).toMatchObject({ eligible: true, reasons: [] });

    const snapshot = liveSnapshot("usd3-reserve-protocol", run.result.metadata ?? {}, {
      fetchedAt: NOW,
      source: config.adapter,
      warnings: run.result.warnings ?? [],
      warningCount: run.result.warnings?.length ?? 0,
      admission,
    });

    const entry = await buildRedemptionBackstopEntry(
      mockD1Strict([]),
      "usd3-reserve-protocol",
      getRedemptionBackstopConfig("usd3-reserve-protocol")!,
      USD3_SUPPLY_USD,
      null,
      NOW,
      { reserveSnapshotMetadata: snapshot },
    );

    expect(entry.capacityRejectionReason).toBeUndefined();
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(5_000_000);
    expect(entry.immediateCapacityRatio).toBeCloseTo(5_000_000 / USD3_SUPPLY_USD, 12);
    expect(entry.capacityKind).toBe("live-direct");
    expect(entry.score).not.toBeNull();
  });
});

const WM_SUPPLY_USD = 82_000_000;
const WRAPPER_TOTAL_SUPPLY_RAW = 80_000_000_000000n;
const WRAPPER_M_BALANCE_RAW = 81_000_000_000000n;

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function balanceOf(owner: string): `0x${string}` {
  return `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}

/**
 * The wM config requires the exact `m-m0` payout identity. Its only telemetry
 * producer, `m0-wrapper-underlying` in `wrapped-m-token` mode, reads the
 * wrapper's M balance and must name that payout; otherwise every fresh read is
 * discarded as `route-output-identity-unobserved`.
 */
describe("wm-m0 exact M output identity", () => {
  it("admits the wrapper's fresh M balance as live capacity after publishing the m-m0 output key", async () => {
    const { coin, config } = resolveAdapterCoin("m0-wrapper-underlying", "wm-m0");
    const params = config.params as {
      mode?: string;
      wrapperAddress?: string;
      expectedMTokenAddress?: string;
      rpcUrl?: string;
    };
    expect(params.mode).toBe("wrapped-m-token");
    expect(config.inputs.primary).toMatchObject({ kind: "onchain-evm", chain: "ethereum" });

    const wrapper = params.wrapperAddress!;
    const mToken = params.expectedMTokenAddress!;
    const network: AdapterNetworkSpec = {
      ...(params.rpcUrl ? { chains: { ethereum: params.rpcUrl } } : {}),
      rpc: {
        [`ethereum:${wrapper}:0xc3b6f939`]: addressWord(mToken),
        [`ethereum:${wrapper}:0x18160ddd`]: word(WRAPPER_TOTAL_SUPPLY_RAW),
        [`ethereum:${wrapper}:0x313ce567`]: word(6n),
        [`ethereum:${mToken}:${balanceOf(wrapper)}`]: word(WRAPPER_M_BALANCE_RAW),
        [`ethereum:${mToken}:0x313ce567`]: word(6n),
      },
    };

    const run = await runAdapter("m0-wrapper-underlying", coin, { network, nowSec: NOW });
    const entry = await buildRedemptionBackstopEntry(
      mockD1Strict([]),
      "wm-m0",
      getRedemptionBackstopConfig("wm-m0")!,
      WM_SUPPLY_USD,
      null,
      NOW,
      { reserveSnapshotMetadata: liveSnapshot("wm-m0", run.result.metadata ?? {}, { fetchedAt: NOW - 60 }) },
    );

    expect(entry).toMatchObject({
      immediateCapacityUsd: 81_000_000,
      capacityKind: "live-direct",
      resolutionState: "resolved",
    });
    expect(entry.capacityRejectionReason).toBeUndefined();

    const redemption = (run.result.metadata as { redemption?: Record<string, unknown> } | undefined)?.redemption;
    expect(redemption?.outputAssetKeys).toEqual(["m-m0"]);
  });
});
