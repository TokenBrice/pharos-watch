import { CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS } from "@shared/lib/measured-execution-deployment-policies";
import { buildDexMeasuredExecutionTargetId, DEX_MEASURED_TARGET_SCHEMA_VERSION } from "@shared/types/measured-execution";
import type { LiquidityMetrics } from "../types";

// Exact retained pools on chains without a protocol source API. Quote-time
// factory membership, bytecode, token order and decimals remain mandatory.
const PINNED_SHADOW_POOLS = [
  ...CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS.map((pool) => ({ ...pool, protocol: "curve", feePips: undefined })),
  {
    adapterProfileId: "uniswap-v3-quoter-v2", protocol: "uniswap-v3", chain: "xlayer",
    stablecoinId: "satusd-river", poolAddress: "0x849aea45a38e0ee2459be4cec52cb5d73bfc5761", feePips: 3000,
    poolTokens: [
      { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", symbol: "USDT", decimals: 6, trackedAssetId: "usdt-tether" },
      { address: "0xcef6c74ce218c0e1f48ca2430635d0a65cd3737a", symbol: "SATUSD", decimals: 18, trackedAssetId: "satusd-river" },
    ], inputIndex: 1, outputIndex: 0,
  },
] as const;

export function attachPinnedShadowExecutionTargets(input: {
  metrics: Map<string, LiquidityMetrics>;
  stablecoinPriceById: Map<string, number>;
  chainAddressToId: Map<string, string>;
  capturedAt: number;
}): void {
  for (const policy of PINNED_SHADOW_POOLS) {
    const poolId = `${policy.chain}:${policy.poolAddress}`;
    const pool = input.metrics.get(policy.stablecoinId)?.topPools.find((row) =>
      row.poolId.toLowerCase() === poolId && row.chain.toLowerCase() === policy.chain && row.project === policy.protocol);
    if (!pool || pool.extra?.measuredExecutionTarget) continue;
    const tokenIn = policy.poolTokens[policy.inputIndex]!;
    const tokenOut = policy.poolTokens[policy.outputIndex]!;
    const inputPrice = input.stablecoinPriceById.get(tokenIn.trackedAssetId);
    const outputPrice = input.stablecoinPriceById.get(tokenOut.trackedAssetId);
    if (!inputPrice || !outputPrice || !Number.isFinite(inputPrice) || !Number.isFinite(outputPrice) || inputPrice <= 0 || outputPrice <= 0) continue;
    if (policy.poolTokens.some((token) => input.chainAddressToId.get(`${policy.chain}:${token.address}`) !== token.trackedAssetId)) continue;
    const identity = {
      adapterProfileId: policy.adapterProfileId, stablecoinId: policy.stablecoinId,
      chain: policy.chain, protocol: policy.protocol, poolId,
      tokenInAddress: tokenIn.address, tokenOutAddress: tokenOut.address,
      poolTokenAddresses: policy.poolTokens.map((token) => token.address),
    };
    pool.extra = { ...pool.extra, measuredExecutionTarget: {
      schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
      targetId: buildDexMeasuredExecutionTargetId(identity),
      adapterProfileId: identity.adapterProfileId, stablecoinId: identity.stablecoinId,
      chain: identity.chain, protocol: identity.protocol, poolId,
      poolTokenAddresses: identity.poolTokenAddresses,
      ...(policy.feePips != null ? { feePips: policy.feePips } : {}),
      tokenIn: { ...tokenIn, referencePriceUsd: inputPrice },
      tokenOut: { ...tokenOut, referencePriceUsd: outputPrice },
      retainedTvlUsd: pool.tvlUsd, retainedPoolPriceUsd: inputPrice, capturedAt: input.capturedAt,
    }, measuredExecutionPhysicalPoolId: poolId };
  }
}
