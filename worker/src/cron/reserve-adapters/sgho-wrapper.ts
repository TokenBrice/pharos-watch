import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { TOTAL_SUPPLY_SELECTOR, encodeUint256 } from "../../lib/evm-selectors";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import { resolveCoinContractAddress } from "./evm";
import type { AdapterContext, AdapterResult } from "./types";

const PREVIEW_REDEEM_SELECTOR = "0x4cdad506";

function readSlice(config: LiveReservesConfig): ReserveSlice {
  const params = parseLiveReserveAdapterParams("sgho-wrapper", config.params);
  return {
    name: params.slice.name,
    pct: 100,
    risk: params.slice.risk,
    ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
    ...(params.slice.depType ? { depType: params.slice.depType } : {}),
  };
}

export async function fetchSghoWrapperReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "sgho-wrapper");
  const params = parseLiveReserveAdapterParams("sgho-wrapper", config.params);
  const contractAddress = resolveCoinContractAddress(coin, input.chain);
  if (!contractAddress) {
    throw new Error(`No ${input.chain} contract configured for ${coin.id}`);
  }

  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });
  const totalSupplyRawHex = await onchain.raw(contractAddress, TOTAL_SUPPLY_SELECTOR);
  if (!totalSupplyRawHex) {
    throw new Error(`sgho-wrapper: totalSupply() call failed for ${coin.id}`);
  }
  const totalSupplyRaw = BigInt(totalSupplyRawHex);
  if (totalSupplyRaw <= 0n) {
    throw new Error(`sgho-wrapper: totalSupply() is zero for ${coin.id}`);
  }

  const previewRedeemRawHex = await onchain.raw(
    contractAddress,
    `${PREVIEW_REDEEM_SELECTOR}${encodeUint256(totalSupplyRaw)}`,
  );
  if (!previewRedeemRawHex) {
    throw new Error(`sgho-wrapper: previewRedeem(totalSupply) call failed for ${coin.id}`);
  }
  const previewRedeemRaw = BigInt(previewRedeemRawHex);
  if (previewRedeemRaw <= 0n) {
    throw new Error(`sgho-wrapper: previewRedeem(totalSupply) is zero for ${coin.id}`);
  }

  const previewRedeemUsd = decimalNumberFromBigInt(previewRedeemRaw, 18);
  const supplyUsd = decimalNumberFromBigInt(totalSupplyRaw, 18);
  const capacityRatioOfSupply = Math.min(1, previewRedeemUsd / supplyUsd);

  return {
    slices: [readSlice(config)],
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "aave-sgho-preview-redeem",
      }),
      chain: input.chain,
      contractAddress,
      totalSupplyRaw: totalSupplyRaw.toString(),
      previewRedeemRaw: previewRedeemRaw.toString(),
      supplyUsd,
      previewRedeemUsd,
      collateralizationRatio: previewRedeemUsd / supplyUsd,
      immediateRedeemableUsd: previewRedeemUsd,
      immediateRedeemableRatio: capacityRatioOfSupply,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: previewRedeemUsd,
        capacityRatioOfSupply,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: ["https://aave.com/docs/developers/smart-contracts/tokenization#stakedtoken"],
      }),
    },
  };
}
