export type CurveRouteType = "direct" | "one-hop" | "trusted-wrapper" | "chained-hop";

export interface CurvePoolConfig {
  stablecoinId: string;
  poolAddress: string;
  inputIndex: number;    // coin index of the reference asset (e.g., USDC=1 in 3pool)
  outputIndex: number;   // coin index of the target stablecoin
  inputDecimals: number;
  outputDecimals: number;
  chain: string;
  /** Use get_dy_underlying selector for metapools (e.g., LUSD/3Crv) */
  useUnderlying?: boolean;
  /** Two-hop pricing: raw price is in intermediate token, multiply by via-token's USD price */
  hop?: { viaStablecoinId: string };
  /** Explicit route metadata for diagnostics and wrapper/chained-hop opt-in */
  routeType?: CurveRouteType;
  /** Maximum allowed dependency depth. Chained hops must opt in with maxHopDepth > 1. */
  maxHopDepth?: number;
}

function priceRoute(
  stablecoinId: string,
  poolAddress: string,
  overrides: Partial<Omit<CurvePoolConfig, "stablecoinId" | "poolAddress">> = {},
): CurvePoolConfig {
  const inputIndex = overrides.inputIndex ?? 1;
  return {
    stablecoinId,
    poolAddress,
    inputIndex,
    outputIndex: 1 - inputIndex,
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    ...overrides,
  };
}

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
 *
 * The on-chain get_dy fetch machinery that consumes these configs lives in
 * worker/src/lib/curve-onchain.ts (it needs RPC access, so it stays worker-side).
 */
export const CURVE_POOL_CONFIGS: CurvePoolConfig[] = [
  // ── USDC anchors and USDT-reference pools ──

  // 3pool: query USDT relative to USDC
  priceRoute("usdt-tether", "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7", {
    outputIndex: 2, outputDecimals: 6,
  }),
  // 3pool: query DAI relative to USDC
  priceRoute("dai-makerdao", "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7"),
  // crvUSD/USDC (factory-crvusd, ~$22M TVL)
  priceRoute("crvusd-curve", "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E", { inputIndex: 0 }),
  // PYUSD/USDC PayPool (factory-stable-ng, ~$47M TVL)
  priceRoute("pyusd-paypal", "0x383E6b4437b59fff47B619CBA855CA29342A8559", { outputDecimals: 6 }),
  // FRAX/USDC (main registry, ~$7M TVL)
  priceRoute("frax-frax", "0xDcEF968d416a41Cdac0ED8702fAC8128A64241A2"),
  // USDe/USDC (factory-stable-ng, ~$1.2M TVL)
  priceRoute("usde-ethena", "0x02950460E2b9529D0E00284A5fA2d7bDF3fA4d72"),
  // RLUSD/USDC (factory-stable-ng, ~$85M TVL)
  priceRoute("rlusd-ripple", "0xD001aE433f254283FeCE51d4ACcE8c53263aa186", { inputIndex: 0 }),
  // AUSD/USDC (factory-stable-ng, ~$25M TVL)
  priceRoute("ausd-agora", "0xE79C1C7E24755574438A26D5e062Ad2626C04662", {
    inputIndex: 0, outputDecimals: 6,
  }),
  // USDtb/USDC (factory-stable-ng, ~$20M TVL)
  priceRoute("usdtb-ethena", "0xC2921134073151490193AC7369313c8e0b08e1E7", { inputIndex: 0 }),
  // BOLD/USDC (factory-stable-ng, ~$7.4M TVL)
  priceRoute("bold-liquity", "0xEFc6516323FbD28e80B85A497B65A86243a54B3E"),
  // USDC/fxUSD (factory-stable-ng, ~$7.3M TVL)
  priceRoute("fxusd-f-x-protocol", "0x5018BE882DccE5E3F2f3B0913AE2096B9b3fB61f", { inputIndex: 0 }),
  // OUSD/USDC (factory-stable-ng, ~$3.3M TVL)
  priceRoute("ousd-origin-protocol", "0x6d18E1a7faeB1F0467A77C0d293872ab685426dc"),
  // USG/USDC (factory-stable-ng, ~$2.8M TVL)
  priceRoute("usg-tangent", "0x97BA10115da528c113462EDE9C20D7adc806D93f", { inputIndex: 0 }),
  // USDC/USDat (factory-stable-ng, ~$22.5M TVL)
  priceRoute("usdat-saturn", "0xF4d0CF32908b2C7f1021339c43Df0F77f06896d7", {
    inputIndex: 0, outputDecimals: 6, routeType: "direct",
  }),
  // apxUSD/USDC (factory-stable-ng, ~$39.5M TVL)
  priceRoute("apxusd-apyx", "0xE1B96555BbecA40E583BbB41a11C68Ca4706A414", { routeType: "direct" }),
  // USAT/USDT (factory-stable-ng, ~$10.0M TVL)
  priceRoute("usat-tether", "0x0Bdb2c3AF83EE1d3196FA64d3162e54624B5f6b0", {
    outputDecimals: 6, hop: { viaStablecoinId: "usdt-tether" }, routeType: "one-hop",
  }),
  // USDG/USDC (factory-stable-ng, ~$8.5M TVL)
  priceRoute("usdg-paxos", "0xc061caa073f3d95F80f8e5428d32D2d76F5e1622", {
    outputDecimals: 6, routeType: "direct",
  }),
  // NUSD/USDC (factory-stable-ng, ~$4.9M TVL)
  priceRoute("nusd-neutrl", "0x7E19F0253A564e026C63eeAA9338d6DBddeF3b09", { routeType: "direct" }),
  // USDC/USDf (factory-stable-ng, ~$3.6M TVL)
  priceRoute("usdf-falcon", "0x72310DAAed61321b02B08A547150c07522c6a976", {
    inputIndex: 0, routeType: "direct",
  }),
  // eUSD/USDC (factory-stable-ng, ~$3.2M TVL)
  priceRoute("eusd-electronic-usd", "0x08BfA22bB3e024CDfEB3eca53c0cb93bF59c4147", { routeType: "direct" }),
  // FIDD/USDC (factory-stable-ng, ~$2.7M TVL)
  priceRoute("fidd-fidelity", "0xE47E8Ced9D94AA43C922627782E29b41a93202AF", { routeType: "direct" }),
  // USDQ/USDT (factory-stable-ng, ~$1.0M TVL)
  priceRoute("usdq-quantoz", "0x5a8C7623FEe10542614e492c670a67e3DfE922F8", {
    outputDecimals: 6, hop: { viaStablecoinId: "usdt-tether" }, routeType: "one-hop",
  }),
  // sUSDS/USDT (factory-stable-ng, ~$50.0M TVL)
  priceRoute("susds-sky", "0x00836Fe54625BE242BcFA286207795405ca4fD10", {
    hop: { viaStablecoinId: "usdt-tether" }, routeType: "one-hop",
  }),
  // USDx/USDT (factory-stable-ng, ~$3.0M TVL; coins(0)=USDx 18dp, coins(1)=USDT 6dp)
  priceRoute("usdx-axis", "0xE521BA88837B2726E5343ccA91adA6f19F356C45", {
    hop: { viaStablecoinId: "usdt-tether" }, routeType: "one-hop",
  }),
  // ── Hop pools (paired against crvUSD or PYUSD, resolved via two-phase pricing) ──

  // pmUSD/crvUSD (factory-stable-ng, ~$19.4M TVL)
  priceRoute("pmusd-precious-metals", "0xEcb0F0d68C19BdAaDAEbE24f6752A4Db34e2c2cb", {
    inputDecimals: 18, hop: { viaStablecoinId: "crvusd-curve" }, routeType: "one-hop",
  }),
  // crvUSD/frxUSD (factory-stable-ng, ~$13.1M TVL)
  priceRoute("frxusd-frax", "0x13e12BB0E6A2f1A3d6901a59a9d585e89A6243e1", {
    inputDecimals: 18, hop: { viaStablecoinId: "crvusd-curve" }, routeType: "one-hop",
  }),
  // GHO/crvUSD (factory-stable-ng, ~$1.1M TVL)
  priceRoute("gho-aave", "0x635EF0056A597D13863B73825CcA297236578595", {
    inputDecimals: 18, hop: { viaStablecoinId: "crvusd-curve" }, routeType: "one-hop",
  }),
  // PYUSD/USDS (factory-stable-ng, ~$100M TVL)
  priceRoute("usds-sky", "0xA632D59b9B804a956BfaA9b48Af3A1b74808FC1f", {
    inputIndex: 0, inputDecimals: 6, hop: { viaStablecoinId: "pyusd-paypal" }, routeType: "one-hop",
  }),
  // apyUSD/apxUSD (factory-stable-ng, ~$14.9M TVL)
  priceRoute("apyusd-apyx", "0xe41be7B340f7c2EDA4DA1e99b42Ee1b228b526b7", {
    inputDecimals: 18, hop: { viaStablecoinId: "apxusd-apyx" }, routeType: "one-hop",
  }),
  // reUSD/fxUSD (factory-stable-ng, ~$2.0M TVL; coins(0)=reUSD 18dp, coins(1)=fxUSD 18dp)
  priceRoute("reusd-resupply", "0xb0ef04ACE97d350E24Efa5139d2590D26a61A8Dc", {
    inputDecimals: 18, hop: { viaStablecoinId: "fxusd-f-x-protocol" }, routeType: "one-hop",
  }),

  // ── Explicit chained-hop pools ──

  // DOLA/sUSDS (factory-stable-ng, ~$5.6M TVL)
  priceRoute("dola-inverse-finance", "0x8b83c4aA949254895507D09365229BC3a8c7f710", {
    inputDecimals: 18, hop: { viaStablecoinId: "susds-sky" }, routeType: "chained-hop", maxHopDepth: 2,
  }),
  // frxUSD/msUSD (factory-stable-ng, ~$14.3M TVL)
  priceRoute("msusd-metronome", "0x9A9e2e70919c75D80aAaA1D483c46CdBb8ac4d1b", {
    inputIndex: 0, inputDecimals: 18, hop: { viaStablecoinId: "frxusd-frax" },
    routeType: "chained-hop", maxHopDepth: 2,
  }),
  // sfrxUSD/frxUSD (factory-stable-ng, ~$11.8M TVL)
  priceRoute("sfrxusd-frax", "0xF292eB6c5dcb693Eaaf392D0562a01C3710E5978", {
    inputDecimals: 18, hop: { viaStablecoinId: "frxusd-frax" }, routeType: "chained-hop", maxHopDepth: 2,
  }),
  // USDS/stUSDS (factory-stable-ng, ~$7.2M TVL)
  priceRoute("stusds-sky", "0x2C7C98A3b1582D83c43987202aEFf638312478aE", {
    inputIndex: 0, inputDecimals: 18, hop: { viaStablecoinId: "usds-sky" },
    routeType: "chained-hop", maxHopDepth: 2,
  }),
  // alUSD/frxUSD (factory-stable-ng, ~$4.3M TVL)
  priceRoute("alusd-alchemix", "0x17F9682c9cd1a448b31C0428F1D0783eD13a9Fa3", {
    inputDecimals: 18, hop: { viaStablecoinId: "frxusd-frax" }, routeType: "chained-hop", maxHopDepth: 2,
  }),
  // avUSD/frxUSD (factory-stable-ng, ~$1.0M TVL)
  priceRoute("avusd-avant", "0xf76329c6dc10FdfbEe6CA520d0BF4d474E95E46E", {
    inputIndex: 0, inputDecimals: 18, hop: { viaStablecoinId: "frxusd-frax" },
    routeType: "chained-hop", maxHopDepth: 2,
  }),
  // frxUSD/USD3 (factory-stable-ng, ~$1.7M TVL)
  priceRoute("usd3-3jane", "0x7BA89Bc658c07569cfa6d7947adAA80181a24568", {
    inputIndex: 0, inputDecimals: 18, outputDecimals: 6, hop: { viaStablecoinId: "frxusd-frax" },
    routeType: "chained-hop", maxHopDepth: 2,
  }),
  // DOLA/sUSDe (factory-stable-ng, ~$59M TVL). sUSDe is rate-bearing inside the
  // pool, so raw get_dy is already DOLA per sUSDe; DOLA resolves through its
  // reviewed DOLA -> sUSDS -> USDT chain rather than at par.
  priceRoute("susde-ethena", "0x744793B5110f6ca9cC7CDfe1CE16677c3Eb192ef", {
    inputIndex: 0, inputDecimals: 18, hop: { viaStablecoinId: "dola-inverse-finance" },
    routeType: "chained-hop", maxHopDepth: 3,
  }),
  // frxUSD/trUSD (factory-stable-ng, ~$1.06M TVL; coins(0)=frxUSD 18dp, coins(1)=trUSD 18dp)
  priceRoute("trusd-tori", "0xd1D954BC94c843815EC7b8119f2de00AF27Fa6Ff", {
    inputIndex: 0, inputDecimals: 18, hop: { viaStablecoinId: "frxusd-frax" },
    routeType: "chained-hop", maxHopDepth: 2,
  }),
  // frxUSD/DUSD (factory-stable-ng, ~$4.2M TVL; coins(0)=frxUSD 18dp, coins(1)=DUSD 18dp)
  priceRoute("dusd-alto", "0x104d6a1b97A6CEf88D905d7b865A378d90BE932A", {
    inputIndex: 0, inputDecimals: 18, hop: { viaStablecoinId: "frxusd-frax" },
    routeType: "chained-hop", maxHopDepth: 2,
  }),
  // reUSD/scrvUSD (factory-stable-ng, ~$9.9M TVL; coins(0)=reUSD 18dp, coins(1)=scrvUSD 18dp)
  priceRoute("scrvusd-curve", "0xc522A6606BBA746d7960404F22a3DB936B6F4F50", {
    inputIndex: 0, inputDecimals: 18, hop: { viaStablecoinId: "reusd-resupply" },
    routeType: "chained-hop", maxHopDepth: 2,
  }),

  // ── Metapools (get_dy_underlying) ──
  // Underlying indices for 3Crv metapools: 0=metapool token, 1=DAI(18), 2=USDC(6), 3=USDT(6)

  // LUSD/3Crv metapool (~$12M TVL)
  priceRoute("lusd-liquity", "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA", {
    inputIndex: 2, outputIndex: 0, useUnderlying: true,
  }),
  // GUSD/3Crv metapool (~$1.9M TVL)
  priceRoute("gusd-gemini", "0x4f062658EaAF2C1ccf8C8e36D6824CDf41167956", {
    inputIndex: 2, outputIndex: 0, outputDecimals: 2, useUnderlying: true,
  }),
  // MUSD/crv2pool metapool (~$1.2M TVL, underlying 0=MUSD 18dp, 1=USDC 6dp, 2=USDT 6dp)
  priceRoute("meusd-mezo", "0xB5571E76693ba60110B5811DD650FFefce1C955f", {
    inputIndex: 1, outputIndex: 0, useUnderlying: true,
  }),
];
