import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult, parseAbi } from "viem/utils";
import {
  getDexMeasuredExecutionProbeNotionals,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  CURVE_STABLESWAP_RATE_CAPTURE_MAX_AGE_SEC,
  type CurveStableswapNgCapturedPoolState,
} from "../../curve-stableswap-rates";
import {
  CURVE_NAV_SPOT_QUOTE_POLICY_ID,
  type CurveNavSpotQuoteEvidence,
  type CurveStableswapRateInputExecutionCandidate,
  type PoolEntry,
} from "../../types";
import { buildDexMeasuredExecutionProfile } from "../../../measured-execution/profiles";
import { encodeQuoterV2ExactInputSingle } from "../../../measured-execution/quoter-v2";
import { getDexMeasuredExecutionDeployment } from "../../../measured-execution/registry";
import { makeV3Target } from "../../../measured-execution/__tests__/measured-execution.test-support";
import type { DexMarketMark, DexValuationPrices } from "../../../../lib/dex-api-token-pricing";
import { makePool } from "../scoring-test-builders";

// Pinned Ethereum Curve StableSwap-NG pool addresses, ABIs, block metadata, and on-chain get_dy vectors.
export const CURVE_SFRXUSD = "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6" as const;
export const CURVE_FRXUSD = "0xcacd6fd266af91b8aed52accc382b4e165586e29" as const;
export const CURVE_POOL = "0xf292eb6c5dcb693eaaf392d0562a01c3710e5978" as const;

export const CURVE_STUSDS = "0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9" as const;
export const CURVE_USDS = "0xdc035d45d973e3ec169d2276ddab16f1e407384f" as const;
export const CURVE_STUSDS_POOL = "0x2c7c98a3b1582d83c43987202aeff638312478ae" as const;
export const CURVE_CORR_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

export const CURVE_BLOCK_NUMBER = 25_626_087;
export const CURVE_BLOCK_TIMESTAMP = 1_785_178_691;
export const CURVE_GEN = "dex-stage:fixture";
export const CURVE_BLOCK_HASH =
  "0x0305aed7bdf9bb7711ac23ad7322cd7569380b004b56408b4bec0a4a7a7eaf82" as const;

export const CURVE_PINNED_BALANCES = [
  6_226_811_020_583_753_593_486_721n,
  4_346_120_891_108_167_689_089_439n,
] as const;
export const CURVE_PINNED_RATES = [
  1_203_657_319_587_784_076n,
  1_000_000_000_000_000_000n,
] as const;
export const CURVE_PINNED_A = 10_000n;
export const CURVE_PINNED_FEE = 1_000_000n;
export const CURVE_PINNED_OFFPEG = 10_000_000_000n;

export const CURVE_NG_STUSDS_BAL = [
  400_000n * 10n ** 18n,
  2_000_000n * 10n ** 18n,
] as const;
export const CURVE_NG_STUSDS_RATES = [
  10n ** 18n,
  1_094_459_449_201_690_084n,
] as const;

export const CURVE_NG_ABI = parseAbi([
  "function get_balances() view returns (uint256[])",
  "function stored_rates() view returns (uint256[])",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function coins(uint256) view returns (address)",
]);

export const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256,uint160,uint32,uint256)",
  "function getPool(address,address,uint24) view returns (address)",
]);

export const CURVE_CANDIDATE: CurveStableswapRateInputExecutionCandidate = {
  poolAddress: CURVE_POOL,
  coins: [
    { address: CURVE_SFRXUSD, symbol: "sfrxUSD", decimals: 18, referencePriceUsd: 1.2038465312792253 },
    { address: CURVE_FRXUSD, symbol: "frxUSD", decimals: 18, referencePriceUsd: 1.000155068994295 },
  ],
};

export const CURVE_STUSDS_CANDIDATE: CurveStableswapRateInputExecutionCandidate = {
  poolAddress: CURVE_STUSDS_POOL,
  coins: [
    { address: CURVE_USDS, symbol: "USDS", decimals: 18, referencePriceUsd: 1 },
    { address: CURVE_STUSDS, symbol: "stUSDS", decimals: 18, referencePriceUsd: 1.01 },
  ],
};

export const CURVE_STUSDS_COINS = [
  { address: CURVE_USDS, symbol: "USDS", decimals: 18, trackedAssetId: "usds-sky" },
  { address: CURVE_STUSDS, symbol: "stUSDS", decimals: 18, trackedAssetId: "stusds-sky" },
] as const;

export const CURVE_DEFAULT_CAPTURE = {
  blockNumber: CURVE_BLOCK_NUMBER,
  blockHash: CURVE_BLOCK_HASH,
  blockTimestamp: CURVE_BLOCK_TIMESTAMP,
  sourceGenerationId: CURVE_GEN,
} as const;

export const CURVE_NG_POOL_BASE = {
  poolId: `ethereum:${CURVE_POOL}`,
  project: "curve",
  chain: "ethereum",
  tvlUsd: 11_842_920,
  symbol: "sfrxUSD-frxUSD",
  volumeUsd1d: 1_000_000,
  poolType: "curve-stableswap",
  source: "dl" as const,
  price: 1.2038,
  priceObservedAt: null,
  volumeReading: {
    volume24hUsd: 1_000_000,
    volume7dUsd: 7_000_000,
    observedAtSec: CURVE_BLOCK_TIMESTAMP,
  },
} as const;

export const CURVE_NG_NAV_POOL_BASE = {
  poolId: `ethereum:${CURVE_STUSDS_POOL}`,
  project: "curve",
  chain: "ethereum",
  tvlUsd: 2_500_000,
  symbol: "USDS-stUSDS",
  volumeUsd1d: 800_000,
  poolType: "curve-stableswap",
  source: "dl" as const,
  price: 1.01,
  priceObservedAt: null,
} as const;

export const CURVE_NG_CAP_STATE_BASE = {
  stablecoinId: "stusds-sky",
  chain: "ethereum",
  poolAddress: CURVE_STUSDS_POOL,
  trackedTokenIndex: 1,
  amplification: 500n,
  fee: 10_000_000n,
  offpegFeeMultiplier: 50_000_000_000n,
  captureEvaluatedAtSec: CURVE_BLOCK_TIMESTAMP + 60,
} as const;

export const CURVE_MIXED_DEC_COINS = [
  { address: "0x00000000000000000000000000000000000e0c06" as const, symbol: "EURC", decimals: 6, referencePriceUsd: 1.1166 },
  { address: "0x00000000000000000000000000000000000e0502" as const, symbol: "EURS", decimals: 2, referencePriceUsd: 1.1488 },
  { address: "0x00000000000000000000000000000000000e0a06" as const, symbol: "EURQ", decimals: 6, referencePriceUsd: 1.0775 },
] as const;

export const CURVE_NG_CORROBORATION_SPECS = [
  ["verified UniV3 measured + disjoint mark", { markSource: "binance", measured: "valid" }, true],
  ["shared mark lineage (both kraken)", { markSource: "kraken", measured: "valid" }, false],
  ["measured proof diverges from pool price", { markSource: "binance", measured: "divergent" }, false],
  ["no corroborator", null, false],
  ["untimestamped DL", { source: "dl", priceObservedAt: null, tvlUsd: 300_000, vol: 50_000 }, false],
  ["local-clock UniV3 (dl)", { source: "dl", priceObservedAtOffset: -10, tvlUsd: 300_000, vol: 50_000 }, false],
  ["cg_onchain", { source: "cg_onchain", priceSource: "cg_onchain", priceObservedAtOffset: -60, tvlUsd: 300_000, vol: 50_000 }, false],
  ["unverified Aerodrome", { project: "aerodrome", markSource: "binance", ammSource: "solidly-v2" }, false],
  ["unverified Balancer", { project: "balancer-v3", markSource: "binance", ammSource: "balancer" }, false],
  ["divergent >250bps", { markSource: "binance", measured: "valid", price: 1.02 }, false],
  ["combined <$500K", { markSource: "binance", measured: "valid", tvlUsd: 150_000 }, false],
] as const;

export const CURVE_NG_REJECTION_SPECS = [
  ["$89K thin pool", { tvlUsd: 89_000 }, {}, -60, "insufficient-support"],
  ["<$25K volume", { volume24h: 24_999 }, {}, -60, "insufficient-volume"],
  ["<$10K counter depth", {}, { lowCounterDepth: true }, -60, "depth-test-failed"],
  ["stale capture >600s", {}, { captureOffsetSec: -601, evalOffsetSec: 0 }, -60, "capture-stale"],
  ["future capture", {}, { captureOffsetSec: 1, evalOffsetSec: 1 }, -60, "capture-future"],
  ["gen mismatch", {}, { sourceGenerationId: "other" }, -60, "capture-generation-mismatch"],
  ["stale mark >=4500s", {}, {}, -4500, "quote-mark-stale"],
  ["future mark", {}, {}, 1, "quote-mark-future"],
] as const;

export const CURVE_NAV_QUOTE_BASE = {
  policyId: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
  blockNumber: 26_500_642,
  blockHash: `0x${"11".repeat(32)}`,
  admissionMode: "sole-venue" as const,
} as const;

export const CURVE_CLOCKED_POOL_BASE = {
  project: "curve",
  chain: "ethereum",
  tvlUsd: 2_500_000,
  price: 0.42,
  priceSource: "direct_api" as const,
  source: "dl" as const,
} as const;

export const CURVE_CLOCKED_COUNTERPARTY_BASE = {
  stablecoinId: "usds-sky",
  priceUsd: 1,
  observedAtMode: "upstream" as const,
  source: "coingecko+pyth",
} as const;

export const CURVE_VERIFIED_CORR_POOL_BASE = {
  project: "uniswap-v3",
  chain: "ethereum",
  tvlUsd: 600_000,
  volumeUsd1d: 80_000,
  priceSource: "direct_api" as const,
  source: "direct_api" as const,
} as const;

export const CURVE_NG_GATE_CASES = [
  ["incomplete rates", { rates: [10n ** 18n] }, "incomplete-exact-capture", CURVE_BLOCK_TIMESTAMP + 60, 1, 2],
  ["fee >= 100%", { fee: 9_000_000_000n, offpegFeeMultiplier: 20_000_000_000n }, "incomplete-exact-capture", CURVE_BLOCK_TIMESTAMP + 60, 1, 2],
  ["coin order mismatch", { coinAddresses: [CURVE_FRXUSD, CURVE_SFRXUSD] }, "incomplete-exact-capture", CURVE_BLOCK_TIMESTAMP + 60, 1, 2],
  ["multicall failure", { rates: [10n ** 18n, 10n ** 18n], multicallFails: true }, "transport-unavailable", CURVE_BLOCK_TIMESTAMP + 60, 1, 1],
  [
    "stale block",
    { header: { timestamp: CURVE_BLOCK_TIMESTAMP - CURVE_STABLESWAP_RATE_CAPTURE_MAX_AGE_SEC - 1, hash: CURVE_BLOCK_HASH } },
    "stale-observation",
    CURVE_BLOCK_TIMESTAMP,
    0,
    1,
  ],
  ["block hash reorg", { confirmedHeader: { timestamp: CURVE_BLOCK_TIMESTAMP, hash: `0x${"22".repeat(32)}` as `0x${string}` } }, "incomplete-exact-capture", CURVE_BLOCK_TIMESTAMP + 60, 1, 2],
] as const;

// Live Ethereum pinned-block 0-wei get_dy parity vectors.
export const CURVE_NG_PARITY_VECTORS = [
  [
    "stUSDS/USDS 5x sell",
    [131_918_551_712_159_531_225_697n, 1_200_501_876_410_437_731_243_323n],
    [10n ** 18n, 1_094_459_449_201_690_084n],
    500n,
    10_000_000n,
    50_000_000_000n,
    1,
    0,
    10_000n * 10n ** 18n,
    10_581_459_570_967_310_392_488n,
  ],
  [
    "stUSDS/USDS 5x buy",
    [131_918_551_712_159_531_225_697n, 1_200_501_876_410_437_731_243_323n],
    [10n ** 18n, 1_094_459_449_201_690_084n],
    500n,
    10_000_000n,
    50_000_000_000n,
    0,
    1,
    10_000n * 10n ** 18n,
    9_367_115_719_535_286_509_921n,
  ],
  [
    "sfrxUSD/frxUSD static",
    [7_294_889_206_043_130_883_212_400n, 8_565_258_537_324_042_047_680_812n],
    [1_222_537_524_421_135_101n, 10n ** 18n],
    10_000n,
    1_000_000n,
    10_000_000_000n,
    0,
    1,
    10_000n * 10n ** 18n,
    12_224_101_593_126_212_232_201n,
  ],
  [
    "sfrxUSD/frxUSD rev",
    [7_294_889_206_043_130_883_212_400n, 8_565_258_537_324_042_047_680_812n],
    [1_222_537_524_421_135_101n, 10n ** 18n],
    10_000n,
    1_000_000n,
    10_000_000_000n,
    1,
    0,
    10_000n * 10n ** 18n,
    8_178_922_169_357_221_907_886n,
  ],
  [
    "sUSDS/USDT 18/6 20x",
    [81_053_904_320_541_977_252n, 1_137_757_508n],
    [1_117_701_094_366_732_060n, 10n ** 30n],
    20_000n,
    100_000n,
    200_000_000_000n,
    0,
    1,
    10_000n * 10n ** 18n,
    1_137_726_190n,
  ],
  [
    "sUSDS/USDT rev",
    [81_053_904_320_541_977_252n, 1_137_757_508n],
    [1_117_701_094_366_732_060n, 10n ** 30n],
    20_000n,
    100_000n,
    200_000_000_000n,
    1,
    0,
    10_000n * 10n ** 18n,
    81_037_693_539_677_868_855n,
  ],
  [
    "3-coin NG 12.5x",
    [1_428_518_484n, 1_699_457_783n, 1_474_268_778n],
    [10n ** 28n, 10n ** 28n, 10n ** 28n],
    100n,
    4_000_000n,
    125_000_000_000n,
    0,
    1,
    1_000_000_000_000n,
    1_691_573_012n,
  ],
] as const;

export const CURVE_NG_8COIN_OVERFLOW_VECTOR = {
  balances: [
    10n ** 18n, 10n ** 18n, 10n ** 18n, 10n ** 18n,
    10n ** 18n, 10n ** 18n, 10n ** 24n, 10n ** 24n,
  ],
  rates: [
    10n ** 18n, 10n ** 18n, 10n ** 18n, 10n ** 18n,
    10n ** 18n, 10n ** 18n, 10n ** 18n, 10n ** 18n,
  ],
  amplification: 100n,
  fee: 4_000_000n,
  offpegFeeMultiplier: 20_000_000_000n,
  i: 6,
  j: 7,
  dx: 10_000n * 10n ** 18n,
} as const;

type CurveNgFn = "get_balances" | "stored_rates" | "A" | "fee" | "offpeg_fee_multiplier" | "coins";

const CURVE_CALL_MAP: ReadonlyArray<readonly [string, CurveNgFn]> = [
  ["-balances", "get_balances"],
  ["-rates", "stored_rates"],
  ["-A", "A"],
  ["-fee", "fee"],
  ["-offpeg-fee-multiplier", "offpeg_fee_multiplier"],
];

function encodeCurveNgFn(label: string, functionName: CurveNgFn, result: unknown) {
  return {
    label,
    success: true as const,
    returnData: encodeFunctionResult({ abi: CURVE_NG_ABI, functionName, result: result as never }),
  };
}

export interface CurveNgMulticallInput {
  liteFactory?: { implementation: `0x${string}` | null; decimals: bigint[]; isMeta?: boolean };
  balances?: readonly bigint[];
  rates?: readonly bigint[];
  amplification?: bigint;
  fee?: bigint;
  offpegFeeMultiplier?: bigint;
  coinAddresses?: readonly `0x${string}`[];
}

export function encodeCurveNgMulticallResults(
  calls: readonly { label: string }[],
  input: CurveNgMulticallInput = {},
) {
  const coins = input.coinAddresses ?? [CURVE_SFRXUSD, CURVE_FRXUSD];
  const values: Record<Exclude<CurveNgFn, "coins">, unknown> = {
    get_balances: [...(input.balances ?? CURVE_PINNED_BALANCES)],
    stored_rates: [...(input.rates ?? CURVE_PINNED_RATES)],
    A: input.amplification ?? CURVE_PINNED_A,
    fee: input.fee ?? CURVE_PINNED_FEE,
    offpeg_fee_multiplier: input.offpegFeeMultiplier ?? CURVE_PINNED_OFFPEG,
  };
  return calls.map(({ label }) => {
    if (input.liteFactory && label.endsWith("-meta")) {
      return { label, success: true, returnData: encodeAbiParameters([{ type: "bool" }], [input.liteFactory.isMeta ?? false]) };
    }
    if (input.liteFactory && label.endsWith("-implementation")) {
      if (!input.liteFactory.implementation) return { label, success: false, returnData: "0x" as const };
      return { label, success: true, returnData: encodeAbiParameters([{ type: "address" }], [input.liteFactory.implementation]) };
    }
    if (input.liteFactory && label.endsWith("-decimals")) {
      return { label, success: true, returnData: encodeAbiParameters([{ type: "uint256[]" }], [input.liteFactory.decimals]) };
    }
    const hit = CURVE_CALL_MAP.find(([suffix]) => label.endsWith(suffix));
    if (hit) return encodeCurveNgFn(label, hit[1], values[hit[1] as Exclude<CurveNgFn, "coins">]);
    const match = label.match(/-coin-(\d+)$/);
    if (!match) throw new Error(`unexpected call ${label}`);
    return encodeCurveNgFn(label, "coins", coins[Number(match[1])]!);
  });
}

export function makeCurveNgPoolEntry(
  extra: Partial<PoolEntry["extra"]> = {},
  overrides: Partial<PoolEntry> = {},
): PoolEntry {
  return {
    ...CURVE_NG_POOL_BASE,
    volumeReading: { ...CURVE_NG_POOL_BASE.volumeReading },
    ...overrides,
    extra: {
      executionCapabilityGate: { family: "curve-stableswap", reason: "incomplete-exact-capture" },
      curveStableswapRateInputExecutionCandidate: CURVE_CANDIDATE,
      ...extra,
    },
  };
}

export function makeDexValuationPrices(entries: Array<[string, DexMarketMark]>): DexValuationPrices {
  return Object.assign(
    new Map(entries.map(([id, mark]) => [id, mark.priceUsd])),
    { marketMarks: new Map(entries) },
  );
}

export function makeCurveNgCapState(
  overrides: Partial<CurveStableswapNgCapturedPoolState> = {},
): CurveStableswapNgCapturedPoolState {
  return {
    ...CURVE_NG_CAP_STATE_BASE,
    coins: [...CURVE_STUSDS_COINS],
    balances: [...CURVE_NG_STUSDS_BAL],
    rates: [...CURVE_NG_STUSDS_RATES],
    capture: { ...CURVE_DEFAULT_CAPTURE },
    ...overrides,
  };
}

export function makeCurveNgNavPool(nowSec: number, overrides: Partial<PoolEntry> = {}): PoolEntry {
  return {
    ...CURVE_NG_NAV_POOL_BASE,
    volumeReading: { volume24hUsd: 800_000, volume7dUsd: 5_000_000, observedAtSec: nowSec - 60 },
    extra: { measurement: { balanceMeasured: true, priceMeasured: false } },
    ...overrides,
  };
}

export function makeStusdsMeasuredCorroboratorPacket(input: {
  poolId?: string;
  quotedAt: number;
  capturedAt?: number;
  priceUsd?: number;
  marginalOutputRatio?: number;
  retainedTvlUsd?: number;
}): { target: DexMeasuredExecutionTarget; profile: DexMeasuredExecutionProfile } {
  const poolId = input.poolId ?? `ethereum:${CURVE_CORR_POOL}`;
  const poolAddr = poolId.slice(poolId.indexOf(":") + 1) as `0x${string}`;
  const priceUsd = input.priceUsd ?? 1.07;
  const ratio = input.marginalOutputRatio ?? 1;
  const dep = getDexMeasuredExecutionDeployment("uniswap-v3-quoter-v2", "ethereum")!;
  const retainedTvlUsd = input.retainedTvlUsd ?? 250_000;
  const target = makeV3Target({
    stablecoinId: "stusds-sky",
    chain: "ethereum",
    protocol: "uniswap-v3",
    poolId,
    poolTokenAddresses: [CURVE_STUSDS, CURVE_USDS],
    tokenIn: { ...CURVE_STUSDS_COINS[1], referencePriceUsd: priceUsd },
    tokenOut: { ...CURVE_STUSDS_COINS[0], referencePriceUsd: 1 },
    feePips: 500,
    retainedTvlUsd,
    retainedPoolPriceUsd: priceUsd,
    capturedAt: input.capturedAt ?? input.quotedAt,
  });
  const encRes = (fn: "quoteExactInputSingle" | "getPool", result: unknown) =>
    encodeFunctionResult({ abi: QUOTER_V2_ABI, functionName: fn, result: result as never }).toLowerCase() as `0x${string}`;
  const notionals = [...new Set([1_000, ...getDexMeasuredExecutionProbeNotionals(retainedTvlUsd)])].sort((a, b) => a - b);
  const points = notionals.map((inputUsd) => {
    const outputUsd = inputUsd * ratio;
    const amountInRaw = BigInt(Math.round((inputUsd / priceUsd) * 1e6)) * 10n ** 12n;
    const amountOutRaw = BigInt(Math.round(outputUsd * 1e6)) * 10n ** 12n;
    return {
      amountInRaw: amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      callData: encodeQuoterV2ExactInputSingle(target, amountInRaw).toLowerCase() as `0x${string}`,
      returnData: encRes("quoteExactInputSingle", [amountOutRaw, 0n, 0, 100_000n]),
      inputUsd,
      outputUsd,
      costBps: Math.max(0, Math.round((1 - ratio) * 10_000)),
      passesCostBound: ratio >= 0.98,
    };
  });
  const profile = buildDexMeasuredExecutionProfile({
    blockHash: CURVE_BLOCK_HASH,
    target,
    targetGenerationId: "target-gen-1",
    quoteGenerationId: "quote-gen-1",
    quotedAt: input.quotedAt,
    blockNumber: CURVE_BLOCK_NUMBER,
    endpointAddress: dep.endpointAddress,
    endpointCodeHash: dep.expectedCodeHash,
    points,
    poolBindingProof: {
      factoryAddress: dep.factoryAddress!,
      factoryCodeHash: dep.expectedFactoryCodeHash!,
      resolvedPoolAddress: poolAddr,
      callData: encodeFunctionData({
        abi: QUOTER_V2_ABI,
        functionName: "getPool",
        args: [CURVE_STUSDS, CURVE_USDS, 500],
      }).toLowerCase() as `0x${string}`,
      returnData: encRes("getPool", poolAddr),
    },
  });
  return { target, profile };
}

export function makeClockedCurveNavPool(
  nowSec: number,
  overrides: Partial<PoolEntry> & {
    quoteOverrides?: Partial<CurveNavSpotQuoteEvidence>;
    generationId?: string;
  } = {},
): PoolEntry {
  const { quoteOverrides, generationId = "dex-gen-clock", ...poolOverrides } = overrides;
  const poolId = poolOverrides.poolId ?? `ethereum:${CURVE_STUSDS_POOL}`;
  const ratioAt = quoteOverrides?.poolRatioObservedAt ?? nowSec - 120;
  const markAt = quoteOverrides?.quoteMarkObservedAt ?? nowSec - 300;
  return makePool({
    ...CURVE_CLOCKED_POOL_BASE,
    poolId,
    priceObservedAt: Math.min(ratioAt, markAt),
    priceCounterparty: { ...CURVE_CLOCKED_COUNTERPARTY_BASE, observedAtSec: markAt },
    curveNavSpotQuote: {
      ...CURVE_NAV_QUOTE_BASE,
      poolId,
      poolRatioObservedAt: ratioAt,
      quoteMarkObservedAt: markAt,
      captureEvaluatedAtSec: nowSec - 60,
      sourceGenerationId: generationId,
      ...quoteOverrides,
    },
    ...poolOverrides,
  });
}

export function makeVerifiedMeasuredNonCurvePool(
  nowSec: number,
  overrides: Partial<PoolEntry> & {
    quotedAt?: number;
    markSource?: string;
    markPriceUsd?: number;
    markObservedAtSec?: number;
    measuredPoolId?: string;
  } = {},
): PoolEntry {
  const {
    quotedAt = nowSec - 180,
    markSource = "binance",
    markPriceUsd = 1,
    markObservedAtSec = nowSec - 90,
    measuredPoolId,
    ...poolOverrides
  } = overrides;
  const poolId = poolOverrides.poolId ?? `ethereum:${CURVE_CORR_POOL}`;
  const price = poolOverrides.price ?? 1.07;
  const { profile } = makeStusdsMeasuredCorroboratorPacket({
    poolId: measuredPoolId ?? poolId,
    quotedAt,
    priceUsd: price,
    retainedTvlUsd: poolOverrides.tvlUsd ?? 600_000,
  });
  return makePool({
    ...CURVE_VERIFIED_CORR_POOL_BASE,
    poolId,
    price,
    priceObservedAt: Math.min(markObservedAtSec, nowSec - 120),
    priceCounterparty: {
      ...CURVE_CLOCKED_COUNTERPARTY_BASE,
      priceUsd: markPriceUsd,
      observedAtSec: markObservedAtSec,
      source: markSource,
    },
    extra: { measuredExecution: profile },
    ...poolOverrides,
  });
}
