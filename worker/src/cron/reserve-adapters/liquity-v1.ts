import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchOnchainRateBps,
  fetchOnchainUint256,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";

const LIQUITY_V1_GET_ENTIRE_SYSTEM_COLL_SELECTOR = "0x887105d3";
const LIQUITY_V1_GET_ENTIRE_SYSTEM_DEBT_SELECTOR = "0x795d26c3";

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
  redemptionRateProbe?: {
    contract: string;
    selector: string;
    decimals?: number;
  };
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

  const [totalCollateralRaw, totalDebtRaw, redemptionFeeBps] = await Promise.all([
    fetchOnchainUint256({
      contract: params.troveManagerAddress,
      data: LIQUITY_V1_GET_ENTIRE_SYSTEM_COLL_SELECTOR,
      signal,
      ctx,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      rpcMode: input.rpcMode,
      chain: input.chain,
      timeoutMs,
    }),
    fetchOnchainUint256({
      contract: params.troveManagerAddress,
      data: LIQUITY_V1_GET_ENTIRE_SYSTEM_DEBT_SELECTOR,
      signal,
      ctx,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      rpcMode: input.rpcMode,
      chain: input.chain,
      timeoutMs,
    }),
    params.redemptionRateProbe
      ? fetchOnchainRateBps(
          input,
          params.redemptionRateProbe,
          signal,
          ctx,
          params.rpcUrl,
          params.fallbackRpcUrl,
        )
      : Promise.resolve(null),
  ]);

  if (totalCollateralRaw == null || totalCollateralRaw <= 0n) {
    throw new Error("liquity-v1 getEntireSystemColl() returned zero/unreadable collateral");
  }
  if (totalDebtRaw == null || totalDebtRaw <= 0n) {
    throw new Error("liquity-v1 getEntireSystemDebt() returned zero/unreadable debt");
  }

  return {
    slices: [{
      name: params.slice.name,
      pct: 100,
      risk: params.slice.risk,
      ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
      ...(params.slice.depType ? { depType: params.slice.depType } : {}),
    }],
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "liquity-v1-system-collateral",
      }),
      chain: input.chain,
      troveManagerAddress: params.troveManagerAddress,
      totalCollateralRaw: totalCollateralRaw.toString(),
      totalDebtRaw: totalDebtRaw.toString(),
      ...(redemptionFeeBps != null ? { redemptionFeeBps } : {}),
    },
  };
}
