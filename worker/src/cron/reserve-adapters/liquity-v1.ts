import { pinnedBlockPlan } from "./evm-observation-plan";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { encodeUint256 } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import type { OnchainRateProbe } from "./helpers";
import { decodeUint256Word } from "./abi-decode";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchDefiLlamaPrices,
  fetchOnchainMulticall3,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  probeOptionalRedemptionRateBps,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";

const LIQUITY_V1_GET_ENTIRE_SYSTEM_COLL_SELECTOR = "0x887105d3";
const LIQUITY_V1_GET_ENTIRE_SYSTEM_DEBT_SELECTOR = "0x795d26c3";
const LIQUITY_V1_GET_TCR_SELECTOR = "0xb82f263d"; // getTCR(uint256 _price)
const LIQUITY_V1_MCR_SELECTOR = "0x794e5724"; // MCR()
const LIQUITY_V1_FETCH_PRICE_SELECTOR = "0x0fdb11cf"; // fetchPrice()
// Liquity V1 is immutable: `TroveManager.priceFeed()` has returned this PriceFeed
// since deployment, and `redeemCollateral()` gates on the price it reports —
// `_requireTCRoverMCR(priceFeed.fetchPrice())`. Reading the same feed keeps the
// published route status on the protocol's own price rather than a market proxy.
const LIQUITY_V1_PRICE_FEED_ADDRESS = "0x4c517D4e2C851CA76d7eC94B805269Df0f2201De";
const LIQUITY_V1_DEBT_DECIMALS = 18;
const LIQUITY_V1_COLLATERAL_DECIMALS = 18;
const LIQUITY_V1_RATIO_DECIMALS = 18;
// Use WETH as the DefiLlama price proxy for ETH/USD on Ethereum mainnet.
const WETH_ETHEREUM_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const LIQUITY_V1_CR_DEGRADED_THRESHOLD = 1.2;

interface LiquityV1Params {
  troveManagerAddress: string;
  slice: {
    name: ReserveSlice["name"];
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
  };
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  redemptionRateProbe?: OnchainRateProbe;
}

function readParams(config: LiveReservesConfig): LiquityV1Params {
  return parseLiveReserveAdapterParams("liquity-v1", config.params);
}

export async function fetchLiquityV1Reserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "liquity-v1");
  const params = readParams(config);
  const plan = await pinnedBlockPlan({ chain: input.chain, signal, ctx, ...params });
  ctx = plan.ctx;
  const timeoutMs = 12_000;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });

  const [protocolPriceRaw, redemptionFeeBps] = await Promise.all([
    onchain.uint256(LIQUITY_V1_PRICE_FEED_ADDRESS, LIQUITY_V1_FETCH_PRICE_SELECTOR),
    probeOptionalRedemptionRateBps(
      input,
      params.redemptionRateProbe,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
  ]);

  // `getTCR()` takes the protocol price, so the gate call is composed after the
  // feed read and then batched with the reserve reads: one Multicall3 block
  // carries collateral, debt and the redemption gate together.
  const tcrCallData = protocolPriceRaw != null && protocolPriceRaw > 0n
    ? `${LIQUITY_V1_GET_TCR_SELECTOR}${encodeUint256(protocolPriceRaw)}`
    : null;
  const batch = await fetchOnchainMulticall3({
    calls: [
      {
        label: "system:collateral",
        contract: params.troveManagerAddress,
        data: LIQUITY_V1_GET_ENTIRE_SYSTEM_COLL_SELECTOR,
        allowFailure: true,
      },
      {
        label: "system:debt",
        contract: params.troveManagerAddress,
        data: LIQUITY_V1_GET_ENTIRE_SYSTEM_DEBT_SELECTOR,
        allowFailure: true,
      },
      {
        label: "system:mcr",
        contract: params.troveManagerAddress,
        data: LIQUITY_V1_MCR_SELECTOR,
        allowFailure: true,
      },
      ...(tcrCallData
        ? [{
            label: "system:tcr",
            contract: params.troveManagerAddress,
            data: tcrCallData,
            allowFailure: true,
          }]
        : []),
    ],
    chain: input.chain,
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });
  if (!batch) {
    throw new Error("liquity-v1 TroveManager batch returned no results");
  }
  const rawByLabel: Record<string, string | null> = Object.fromEntries(
    batch.map((result) => [result.label, result.success ? result.returnData : null]),
  );
  const totalCollateralRaw = decodeUint256Word(rawByLabel["system:collateral"]);
  const totalDebtRaw = decodeUint256Word(rawByLabel["system:debt"]);
  const mcrRaw = decodeUint256Word(rawByLabel["system:mcr"]);
  const tcrRaw = decodeUint256Word(rawByLabel["system:tcr"]);

  if (totalCollateralRaw == null || totalCollateralRaw <= 0n) {
    throw new Error("liquity-v1 getEntireSystemColl() returned zero/unreadable collateral");
  }
  if (totalDebtRaw == null || totalDebtRaw <= 0n) {
    throw new Error("liquity-v1 getEntireSystemDebt() returned zero/unreadable debt");
  }

  const warnings: LiveReserveWarning[] = [];
  // `redeemCollateral()` reverts with "Cannot redeem when TCR < MCR", so the
  // route is open only while the protocol-priced TCR clears MCR at this block.
  let routeStatus: "open" | "paused" | "unknown";
  let routeStatusReason: string | undefined;
  if (tcrRaw == null || mcrRaw == null || mcrRaw <= 0n) {
    routeStatus = "unknown";
    routeStatusReason = "Could not read the Liquity V1 redemption gate (protocol price, getTCR or MCR) this run";
    warnings.push(reserveDegradedWarning("redemption-route-status-unreadable", routeStatusReason));
  } else if (tcrRaw >= mcrRaw) {
    routeStatus = "open";
  } else {
    routeStatus = "paused";
    routeStatusReason = `Liquity V1 reverts redemptions while the system TCR ${
      decimalNumberFromBigInt(tcrRaw, LIQUITY_V1_RATIO_DECIMALS).toFixed(4)
    } is below MCR ${decimalNumberFromBigInt(mcrRaw, LIQUITY_V1_RATIO_DECIMALS).toFixed(4)}`;
    warnings.push(reserveDegradedWarning("redemption-route-status-degraded", routeStatusReason));
  }
  const totalCollateralRatio = tcrRaw != null
    ? decimalNumberFromBigInt(tcrRaw, LIQUITY_V1_RATIO_DECIMALS)
    : undefined;
  const minimumCollateralRatio = mcrRaw != null && mcrRaw > 0n
    ? decimalNumberFromBigInt(mcrRaw, LIQUITY_V1_RATIO_DECIMALS)
    : undefined;

  const totalDebtUsd = decimalNumberFromBigInt(totalDebtRaw, LIQUITY_V1_DEBT_DECIMALS);
  const capacityUsd = totalDebtUsd;

  const totalCollateralEth = decimalNumberFromBigInt(totalCollateralRaw, LIQUITY_V1_COLLATERAL_DECIMALS);
  const ethPriceMap = await fetchDefiLlamaPrices(
    [{ key: "ETH", chain: "ethereum", address: WETH_ETHEREUM_ADDRESS }],
    signal,
    ctx,
    warnings,
  );
  const ethPriceUsd = ethPriceMap.get("ETH");
  let totalCollateralUsd: number | undefined;
  let collateralizationRatio: number | undefined;
  if (ethPriceUsd != null && ethPriceUsd > 0) {
    totalCollateralUsd = totalCollateralEth * ethPriceUsd;
    if (totalDebtUsd > 0) {
      collateralizationRatio = totalCollateralUsd / totalDebtUsd;
      if (collateralizationRatio < LIQUITY_V1_CR_DEGRADED_THRESHOLD) {
        warnings.push(reserveDegradedWarning(
          "liquity-v1-low-collateralization-ratio",
          `Liquity V1 system collateralization ratio ${collateralizationRatio.toFixed(3)} is below the ${LIQUITY_V1_CR_DEGRADED_THRESHOLD} stress threshold`,
        ));
      }
    }
  } else {
    warnings.push(reserveDegradedWarning(
      "liquity-v1-eth-price-unavailable",
      "Liquity V1 adapter could not fetch ETH/USD from DefiLlama; collateralization ratio omitted",
    ));
  }

  return {
    slices: [{
      sourceKey: "liquity-v1:eth",
      name: params.slice.name,
      pct: 100,
      risk: params.slice.risk,
      ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
      ...(params.slice.depType ? { depType: params.slice.depType } : {}),
    }],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      observedBlock: plan.observedBlock,
      ...notApplicableFreshnessMetadata({
        proofKind: "liquity-v1-system-collateral",
        protocolPriceRaw: protocolPriceRaw?.toString() ?? null,
        tcrRaw: tcrRaw?.toString() ?? null,
        mcrRaw: mcrRaw?.toString() ?? null,
      }),
      chain: input.chain,
      troveManagerAddress: params.troveManagerAddress,
      totalCollateralRaw: totalCollateralRaw.toString(),
      totalDebtRaw: totalDebtRaw.toString(),
      totalDebtUsd,
      ...(totalCollateralUsd != null ? { totalCollateralUsd } : {}),
      ...(ethPriceUsd != null ? { ethPriceUsd } : {}),
      ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
      ...(totalCollateralRatio != null ? { totalCollateralRatio } : {}),
      ...(minimumCollateralRatio != null ? { minimumCollateralRatio } : {}),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus,
        routeStatusSource: "onchain",
        ...(routeStatusReason ? { routeStatusReason } : {}),
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: [
          "https://docs.liquity.org/liquity-v1/faq/lusd-redemptions",
          "https://docs.liquity.org/liquity-v1/documentation/resources",
        ],
        feeBps: redemptionFeeBps,
      }),
    },
  };
}
