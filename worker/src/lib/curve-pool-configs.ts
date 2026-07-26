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
  // USG/USDC (factory-stable-ng, ~$2.8M TVL)
  {
    stablecoinId: "usg-tangent",
    poolAddress: "0x97BA10115da528c113462EDE9C20D7adc806D93f",
    inputIndex: 0,  // USDC
    outputIndex: 1, // USG
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },
  // USDC/USDat (factory-stable-ng, ~$22.5M TVL)
  {
    stablecoinId: "usdat-saturn",
    poolAddress: "0xF4d0CF32908b2C7f1021339c43Df0F77f06896d7",
    inputIndex: 0,  // USDC
    outputIndex: 1, // USDat
    inputDecimals: 6,
    outputDecimals: 6,
    chain: "ethereum",
    routeType: "direct",
  },
  // apxUSD/USDC (factory-stable-ng, ~$39.5M TVL)
  {
    stablecoinId: "apxusd-apyx",
    poolAddress: "0xE1B96555BbecA40E583BbB41a11C68Ca4706A414",
    inputIndex: 1,  // USDC
    outputIndex: 0, // apxUSD
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    routeType: "direct",
  },
  // USAT/USDT (factory-stable-ng, ~$10.0M TVL)
  {
    stablecoinId: "usat-tether",
    poolAddress: "0x0Bdb2c3AF83EE1d3196FA64d3162e54624B5f6b0",
    inputIndex: 1,  // USDT
    outputIndex: 0, // USAT
    inputDecimals: 6,
    outputDecimals: 6,
    chain: "ethereum",
    routeType: "direct",
  },
  // USDG/USDC (factory-stable-ng, ~$8.5M TVL)
  {
    stablecoinId: "usdg-paxos",
    poolAddress: "0xc061caa073f3d95F80f8e5428d32D2d76F5e1622",
    inputIndex: 1,  // USDC
    outputIndex: 0, // USDG
    inputDecimals: 6,
    outputDecimals: 6,
    chain: "ethereum",
    routeType: "direct",
  },
  // NUSD/USDC (factory-stable-ng, ~$4.9M TVL)
  {
    stablecoinId: "nusd-neutrl",
    poolAddress: "0x7E19F0253A564e026C63eeAA9338d6DBddeF3b09",
    inputIndex: 1,  // USDC
    outputIndex: 0, // NUSD
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    routeType: "direct",
  },
  // USDC/USDf (factory-stable-ng, ~$3.6M TVL)
  {
    stablecoinId: "usdf-falcon",
    poolAddress: "0x72310DAAed61321b02B08A547150c07522c6a976",
    inputIndex: 0,  // USDC
    outputIndex: 1, // USDf
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    routeType: "direct",
  },
  // eUSD/USDC (factory-stable-ng, ~$3.2M TVL)
  {
    stablecoinId: "eusd-electronic-usd",
    poolAddress: "0x08BfA22bB3e024CDfEB3eca53c0cb93bF59c4147",
    inputIndex: 1,  // USDC
    outputIndex: 0, // eUSD
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    routeType: "direct",
  },
  // FIDD/USDC (factory-stable-ng, ~$2.7M TVL)
  {
    stablecoinId: "fidd-fidelity",
    poolAddress: "0xE47E8Ced9D94AA43C922627782E29b41a93202AF",
    inputIndex: 1,  // USDC
    outputIndex: 0, // FIDD
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    routeType: "direct",
  },
  // USDQ/USDT (factory-stable-ng, ~$1.0M TVL)
  {
    stablecoinId: "usdq-quantoz",
    poolAddress: "0x5a8C7623FEe10542614e492c670a67e3DfE922F8",
    inputIndex: 1,  // USDT
    outputIndex: 0, // USDQ
    inputDecimals: 6,
    outputDecimals: 6,
    chain: "ethereum",
    routeType: "direct",
  },
  // sUSDS/USDT (factory-stable-ng, ~$50.0M TVL)
  {
    stablecoinId: "susds-sky",
    poolAddress: "0x00836Fe54625BE242BcFA286207795405ca4fD10",
    inputIndex: 1,  // USDT
    outputIndex: 0, // sUSDS
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    routeType: "direct",
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
    routeType: "one-hop",
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
    routeType: "one-hop",
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
    routeType: "one-hop",
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
    routeType: "one-hop",
  },
  // apyUSD/apxUSD (factory-stable-ng, ~$14.9M TVL)
  {
    stablecoinId: "apyusd-apyx",
    poolAddress: "0xe41be7B340f7c2EDA4DA1e99b42Ee1b228b526b7",
    inputIndex: 1,  // apxUSD
    outputIndex: 0, // apyUSD
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "apxusd-apyx" },
    routeType: "one-hop",
  },

  // ── Trusted-wrapper pools ──

  // DOLA/sUSDS (factory-stable-ng, ~$5.6M TVL)
  {
    stablecoinId: "dola-inverse-finance",
    poolAddress: "0x8b83c4aA949254895507D09365229BC3a8c7f710",
    inputIndex: 1,  // sUSDS
    outputIndex: 0, // DOLA
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "susds-sky" },
    routeType: "trusted-wrapper",
  },

  // ── Explicit chained-hop pools ──

  // frxUSD/msUSD (factory-stable-ng, ~$14.3M TVL)
  {
    stablecoinId: "msusd-metronome",
    poolAddress: "0x9A9e2e70919c75D80aAaA1D483c46CdBb8ac4d1b",
    inputIndex: 0,  // frxUSD
    outputIndex: 1, // msUSD
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "frxusd-frax" },
    routeType: "chained-hop",
    maxHopDepth: 2,
  },
  // sfrxUSD/frxUSD (factory-stable-ng, ~$11.8M TVL)
  {
    stablecoinId: "sfrxusd-frax",
    poolAddress: "0xF292eB6c5dcb693Eaaf392D0562a01C3710E5978",
    inputIndex: 1,  // frxUSD
    outputIndex: 0, // sfrxUSD
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "frxusd-frax" },
    routeType: "chained-hop",
    maxHopDepth: 2,
  },
  // USDS/stUSDS (factory-stable-ng, ~$7.2M TVL)
  {
    stablecoinId: "stusds-sky",
    poolAddress: "0x2C7C98A3b1582D83c43987202aEFf638312478aE",
    inputIndex: 0,  // USDS
    outputIndex: 1, // stUSDS
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "usds-sky" },
    routeType: "chained-hop",
    maxHopDepth: 2,
  },
  // alUSD/frxUSD (factory-stable-ng, ~$4.3M TVL)
  {
    stablecoinId: "alusd-alchemix",
    poolAddress: "0x17F9682c9cd1a448b31C0428F1D0783eD13a9Fa3",
    inputIndex: 1,  // frxUSD
    outputIndex: 0, // alUSD
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "frxusd-frax" },
    routeType: "chained-hop",
    maxHopDepth: 2,
  },
  // avUSD/frxUSD (factory-stable-ng, ~$1.0M TVL)
  {
    stablecoinId: "avusd-avant",
    poolAddress: "0xf76329c6dc10FdfbEe6CA520d0BF4d474E95E46E",
    inputIndex: 0,  // frxUSD
    outputIndex: 1, // avUSD
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "frxusd-frax" },
    routeType: "chained-hop",
    maxHopDepth: 2,
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
