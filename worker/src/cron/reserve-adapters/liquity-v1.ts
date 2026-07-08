import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import type { OnchainRateProbe } from "./helpers";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchDefiLlamaPrices,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  probeOptionalRedemptionRateBps,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";

const LIQUITY_V1_GET_ENTIRE_SYSTEM_COLL_SELECTOR = "0x887105d3";
const LIQUITY_V1_GET_ENTIRE_SYSTEM_DEBT_SELECTOR = "0x795d26c3";
const LIQUITY_V1_DEBT_DECIMALS = 18;
const LIQUITY_V1_COLLATERAL_DECIMALS = 18;
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
  const timeoutMs = 12_000;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });

  const [totalCollateralRaw, totalDebtRaw, redemptionFeeBps] = await Promise.all([
    onchain.uint256(params.troveManagerAddress, LIQUITY_V1_GET_ENTIRE_SYSTEM_COLL_SELECTOR),
    onchain.uint256(params.troveManagerAddress, LIQUITY_V1_GET_ENTIRE_SYSTEM_DEBT_SELECTOR),
    probeOptionalRedemptionRateBps(
      input,
      params.redemptionRateProbe,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
  ]);

  if (totalCollateralRaw == null || totalCollateralRaw <= 0n) {
    throw new Error("liquity-v1 getEntireSystemColl() returned zero/unreadable collateral");
  }
  if (totalDebtRaw == null || totalDebtRaw <= 0n) {
    throw new Error("liquity-v1 getEntireSystemDebt() returned zero/unreadable debt");
  }

  const totalDebtUsd = decimalNumberFromBigInt(totalDebtRaw, LIQUITY_V1_DEBT_DECIMALS);
  const capacityUsd = totalDebtUsd;

  const totalCollateralEth = decimalNumberFromBigInt(totalCollateralRaw, LIQUITY_V1_COLLATERAL_DECIMALS);
  const ethPriceMap = await fetchDefiLlamaPrices(
    [{ key: "ETH", chain: "ethereum", address: WETH_ETHEREUM_ADDRESS }],
    signal,
    ctx,
  );
  const ethPriceUsd = ethPriceMap.get("ETH");
  const warnings: LiveReserveWarning[] = [];
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
      name: params.slice.name,
      pct: 100,
      risk: params.slice.risk,
      ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
      ...(params.slice.depType ? { depType: params.slice.depType } : {}),
    }],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "liquity-v1-system-collateral",
      }),
      chain: input.chain,
      troveManagerAddress: params.troveManagerAddress,
      totalCollateralRaw: totalCollateralRaw.toString(),
      totalDebtRaw: totalDebtRaw.toString(),
      totalDebtUsd,
      ...(totalCollateralUsd != null ? { totalCollateralUsd } : {}),
      ...(ethPriceUsd != null ? { ethPriceUsd } : {}),
      ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
      immediateRedeemableUsd: capacityUsd,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
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
