// Leaf identity module: Curve source shaping imports this predicate, so keep it
// free of dex-liquidity or measured-execution runtime imports.
export const CURVE_DOLA_SUSDE_COMPOSITE_POOL_ADDRESS =
  "0x744793b5110f6ca9cc7cdfe1ce16677c3eb192ef" as const;
export const CURVE_USD1_COMPOSITE_POOL_ADDRESS =
  "0xc09e82f81cb811db0922dd48206fc2e212322caf" as const;
export const CURVE_NXUSD_COMPOSITE_POOL_ADDRESS =
  "0x6bf6fc7eaf84174bb7e1610efd865f0ebd2aa96d" as const;
export const CURVE_ALUSD_3CRV_METAPOOL_ADDRESS =
  "0x43b4fdfd4ff969587185cdb6f0bd875c5fc83f8c" as const;
export const CURVE_DOLA_FRAXBP_METAPOOL_ADDRESS =
  "0xe57180685e3348589e9521aa53af0bcd497e884d" as const;
export const CURVE_EUSD_FRAXBP_METAPOOL_ADDRESS =
  "0xaeda92e6a3b1028edc139a4ae56ec881f3064d4f" as const;
export const CURVE_GUSD_3CRV_METAPOOL_ADDRESS =
  "0x4f062658eaaf2c1ccf8c8e36d6824cdf41167956" as const;
export const CURVE_LUSD_3CRV_METAPOOL_ADDRESS =
  "0xed279fdd11ca84beef15af5d39bb4d4bee23f0ca" as const;
export const CURVE_MAI_AM3CRV_METAPOOL_ADDRESS =
  "0x447646e84498552e62ecf097cc305eabfff09308" as const;
export const CURVE_MEUSD_CRV2POOL_METAPOOL_ADDRESS =
  "0xb5571e76693ba60110b5811dd650ffefce1c955f" as const;
export const CURVE_MSUSD_FRAXBP_METAPOOL_ADDRESS =
  "0xc3b19502f8c02be75f3f77fd673503520deb51dd" as const;
export const CURVE_OUSD_3CRV_METAPOOL_ADDRESS =
  "0x87650d7bbfc3a9f10587d7778206671719d9910d" as const;
export const CURVE_TUSD_AM3CRV_METAPOOL_ADDRESS =
  "0xadf577b69eeac9df325536cf1af106372f2da263" as const;

export const CURVE_R3_METAPOOL_POOL_IDENTITIES = [
  ["ethereum", CURVE_ALUSD_3CRV_METAPOOL_ADDRESS],
  ["ethereum", CURVE_DOLA_FRAXBP_METAPOOL_ADDRESS],
  ["ethereum", CURVE_EUSD_FRAXBP_METAPOOL_ADDRESS],
  ["ethereum", CURVE_GUSD_3CRV_METAPOOL_ADDRESS],
  ["ethereum", CURVE_LUSD_3CRV_METAPOOL_ADDRESS],
  ["polygon", CURVE_MAI_AM3CRV_METAPOOL_ADDRESS],
  ["ethereum", CURVE_MEUSD_CRV2POOL_METAPOOL_ADDRESS],
  ["ethereum", CURVE_MSUSD_FRAXBP_METAPOOL_ADDRESS],
  ["ethereum", CURVE_OUSD_3CRV_METAPOOL_ADDRESS],
  ["polygon", CURVE_TUSD_AM3CRV_METAPOOL_ADDRESS],
] as const;

const REVIEWED_CURVE_COMPOSITE_POOLS = new Set<string>([
  `ethereum:${CURVE_DOLA_SUSDE_COMPOSITE_POOL_ADDRESS}`,
  `ethereum:${CURVE_USD1_COMPOSITE_POOL_ADDRESS}`,
  `avalanche:${CURVE_NXUSD_COMPOSITE_POOL_ADDRESS}`,
  ...CURVE_R3_METAPOOL_POOL_IDENTITIES.map(([chain, address]) => `${chain}:${address}`),
]);

export function shouldRetainCurveCompositePoolIdentity(
  chain: string,
  poolAddress: string,
): boolean {
  return REVIEWED_CURVE_COMPOSITE_POOLS.has(
    `${chain.trim().toLowerCase()}:${poolAddress.trim().toLowerCase()}`,
  );
}
