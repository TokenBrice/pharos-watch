import type { CurvePoolConfig } from "./curve-onchain";

/**
 * Curve pool configurations for on-chain price queries.
 *
 * Each config defines:
 * - Which pool to query
 * - Token indices (i=reference USDC/DAI, j=target stablecoin)
 * - Decimal precision for input/output normalization
 *
 * Pools should have >$1M TVL for meaningful prices.
 * 3pool indices: 0=DAI(18), 1=USDC(6), 2=USDT(6)
 */
export const CURVE_POOL_CONFIGS: CurvePoolConfig[] = [
  // 3pool: query USDT relative to USDC
  {
    stablecoinId: "usdt-tether",
    poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
    inputIndex: 1,  // USDC
    outputIndex: 2, // USDT
    inputDecimals: 6,
    outputDecimals: 6,
    chain: "ethereum",
  },
  // 3pool: query DAI relative to USDC
  {
    stablecoinId: "dai-makerdao",
    poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
    inputIndex: 1,  // USDC
    outputIndex: 0, // DAI
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },
  // crvUSD/USDC (factory-crvusd, ~$22M TVL)
  {
    stablecoinId: "crvusd-curve",
    poolAddress: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E",
    inputIndex: 0,  // USDC
    outputIndex: 1, // crvUSD
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },
  // PYUSD/USDC PayPool (factory-stable-ng, ~$47M TVL)
  {
    stablecoinId: "pyusd-paypal",
    poolAddress: "0x383E6b4437b59fff47B619CBA855CA29342A8559",
    inputIndex: 1,  // USDC
    outputIndex: 0, // PYUSD
    inputDecimals: 6,
    outputDecimals: 6,
    chain: "ethereum",
  },
  // FRAX/USDC (main registry, ~$7M TVL)
  {
    stablecoinId: "frax-frax",
    poolAddress: "0xDcEF968d416a41Cdac0ED8702fAC8128A64241A2",
    inputIndex: 1,  // USDC
    outputIndex: 0, // FRAX
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },
  // USDe/USDC (factory-stable-ng, ~$1.2M TVL)
  {
    stablecoinId: "usde-ethena",
    poolAddress: "0x02950460E2b9529D0E00284A5fA2d7bDF3fA4d72",
    inputIndex: 1,  // USDC
    outputIndex: 0, // USDe
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },
  // NOTE: GHO, frxUSD, LUSD omitted — no direct USDC pools on Curve.
  // GHO/frxUSD have pools via crvUSD (needs two-hop pricing).
  // LUSD has a 3Crv metapool (needs get_dy_underlying support).
];
