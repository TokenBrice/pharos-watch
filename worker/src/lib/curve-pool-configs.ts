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
  // ── Direct pools (get_dy, paired against USDC) ──

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
  // RLUSD/USDC (factory-stable-ng, ~$85M TVL)
  {
    stablecoinId: "rlusd-ripple",
    poolAddress: "0xD001aE433f254283FeCE51d4ACcE8c53263aa186",
    inputIndex: 0,  // USDC
    outputIndex: 1, // RLUSD
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },
  // AUSD/USDC (factory-stable-ng, ~$25M TVL)
  {
    stablecoinId: "ausd-agora",
    poolAddress: "0xE79C1C7E24755574438A26D5e062Ad2626C04662",
    inputIndex: 0,  // USDC
    outputIndex: 1, // AUSD
    inputDecimals: 6,
    outputDecimals: 6,
    chain: "ethereum",
  },
  // USDtb/USDC (factory-stable-ng, ~$20M TVL)
  {
    stablecoinId: "usdtb-ethena",
    poolAddress: "0xC2921134073151490193AC7369313c8e0b08e1E7",
    inputIndex: 0,  // USDC
    outputIndex: 1, // USDtb
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },
  // BOLD/USDC (factory-stable-ng, ~$7.4M TVL)
  {
    stablecoinId: "bold-liquity",
    poolAddress: "0xEFc6516323FbD28e80B85A497B65A86243a54B3E",
    inputIndex: 1,  // USDC
    outputIndex: 0, // BOLD
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },
  // USDC/fxUSD (factory-stable-ng, ~$7.3M TVL)
  {
    stablecoinId: "fxusd-f-x-protocol",
    poolAddress: "0x5018BE882DccE5E3F2f3B0913AE2096B9b3fB61f",
    inputIndex: 0,  // USDC
    outputIndex: 1, // fxUSD
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },
  // OUSD/USDC (factory-stable-ng, ~$3.3M TVL)
  {
    stablecoinId: "ousd-origin-protocol",
    poolAddress: "0x6d18E1a7faeB1F0467A77C0d293872ab685426dc",
    inputIndex: 1,  // USDC
    outputIndex: 0, // OUSD
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },

  // ── Hop pools (paired against crvUSD or PYUSD, resolved via two-phase pricing) ──

  // pmUSD/crvUSD (factory-stable-ng, ~$19.4M TVL)
  {
    stablecoinId: "pmusd-precious-metals",
    poolAddress: "0xEcb0F0d68C19BdAaDAEbE24f6752A4Db34e2c2cb",
    inputIndex: 1,  // crvUSD
    outputIndex: 0, // pmUSD
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "crvusd-curve" },
  },
  // crvUSD/frxUSD (factory-stable-ng, ~$13.1M TVL)
  {
    stablecoinId: "frxusd-frax",
    poolAddress: "0x13e12BB0E6A2f1A3d6901a59a9d585e89A6243e1",
    inputIndex: 1,  // crvUSD
    outputIndex: 0, // frxUSD
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "crvusd-curve" },
  },
  // GHO/crvUSD (factory-stable-ng, ~$1.1M TVL)
  {
    stablecoinId: "gho-aave",
    poolAddress: "0x635EF0056A597D13863B73825CcA297236578595",
    inputIndex: 1,  // crvUSD
    outputIndex: 0, // GHO
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "crvusd-curve" },
  },
  // PYUSD/USDS (factory-stable-ng, ~$100M TVL)
  {
    stablecoinId: "usds-sky",
    poolAddress: "0xA632D59b9B804a956BfaA9b48Af3A1b74808FC1f",
    inputIndex: 0,  // PYUSD
    outputIndex: 1, // USDS
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "pyusd-paypal" },
  },

  // ── Metapools (get_dy_underlying) ──
  // Underlying indices for 3Crv metapools: 0=metapool token, 1=DAI(18), 2=USDC(6), 3=USDT(6)

  // LUSD/3Crv metapool (~$12M TVL)
  {
    stablecoinId: "lusd-liquity",
    poolAddress: "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA",
    inputIndex: 2,  // USDC (underlying)
    outputIndex: 0, // LUSD (underlying)
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    useUnderlying: true,
  },
  // MIM/3Crv metapool (~$2M TVL)
  {
    stablecoinId: "mim-abracadabra",
    poolAddress: "0x5a6A4D54456819380173272A5E8E9B9904BdF41B",
    inputIndex: 2,  // USDC (underlying)
    outputIndex: 0, // MIM (underlying)
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    useUnderlying: true,
  },
  // GUSD/3Crv metapool (~$1.9M TVL)
  {
    stablecoinId: "gusd-gemini",
    poolAddress: "0x4f062658EaAF2C1ccf8C8e36D6824CDf41167956",
    inputIndex: 2,  // USDC (underlying)
    outputIndex: 0, // GUSD (underlying)
    inputDecimals: 6,
    outputDecimals: 2,
    chain: "ethereum",
    useUnderlying: true,
  },
];
