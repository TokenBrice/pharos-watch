import type { DexAmmExecutionModel } from "@shared/types/market";
import type { DexMeasuredExecutionPublicProfile } from "@shared/types/measured-execution";
import type { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-capacity";

type RetainedPool = Parameters<typeof buildP4DexExitRouteObservations>[0]["retainedPools"][number];

export function retainedMeasuredPool(
  profile: DexMeasuredExecutionPublicProfile,
  overrides: Partial<RetainedPool> = {},
): RetainedPool {
  return {
    poolId: "defillama-yields-uuid",
    project: profile.protocol,
    chain: profile.chain,
    tvlUsd: profile.retainedTvlUsdAtQuote,
    symbol: `${profile.tokenIn.symbol}-${profile.tokenOut.symbol}`,
    poolType: profile.protocol,
    source: "dl",
    extra: { measuredExecution: profile, measuredExecutionPhysicalPoolId: profile.poolId },
    ...overrides,
  };
}

export function twoTokenReserveModel(
  input: Partial<DexAmmExecutionModel["tokens"][number]> = {},
  output: Partial<DexAmmExecutionModel["tokens"][number]> = {},
  overrides: Partial<DexAmmExecutionModel> = {},
): DexAmmExecutionModel {
  return {
    source: "raydium",
    invariant: "constant-product",
    trackedTokenIndex: 0,
    feeRate: 0.0025,
    tokens: [
      { address: "UsdcMint", symbol: "USDC", decimals: 6, balance: 2_000_000,
        referencePriceUsd: 1, referencePriceSource: "tracked-market", trackedAssetId: "usdc-circle", ...input },
      { address: "UsdtMint", symbol: "USDT", decimals: 6, balance: 2_000_000,
        referencePriceUsd: 1, referencePriceSource: "tracked-market", trackedAssetId: "usdt-tether", ...output },
    ],
    ...overrides,
  };
}
