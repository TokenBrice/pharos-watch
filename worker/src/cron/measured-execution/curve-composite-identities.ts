// Leaf identity module: Curve source shaping imports this predicate, so keep it
// free of dex-liquidity or measured-execution runtime imports.
export const CURVE_DOLA_SUSDE_COMPOSITE_POOL_ADDRESS =
  "0x744793b5110f6ca9cc7cdfe1ce16677c3eb192ef" as const;
export const CURVE_USD1_COMPOSITE_POOL_ADDRESS =
  "0xc09e82f81cb811db0922dd48206fc2e212322caf" as const;

const REVIEWED_CURVE_COMPOSITE_POOLS = new Set<string>([
  `ethereum:${CURVE_DOLA_SUSDE_COMPOSITE_POOL_ADDRESS}`,
  `ethereum:${CURVE_USD1_COMPOSITE_POOL_ADDRESS}`,
]);

export function shouldRetainCurveCompositePoolIdentity(
  chain: string,
  poolAddress: string,
): boolean {
  return REVIEWED_CURVE_COMPOSITE_POOLS.has(
    `${chain.trim().toLowerCase()}:${poolAddress.trim().toLowerCase()}`,
  );
}
