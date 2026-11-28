import { CURVE_LITE_DEPLOYMENTS } from "@shared/lib/dex-deployment-coverage";
import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
} from "@shared/types/exit-route-identity";
import type { DexAmmExecutionModel, DexExecutionCapabilityGate } from "@shared/types/dex-execution";
import { toTokenUnits } from "@shared/lib/math";
import {
  DEX_VOLUME_OBSERVATION_MAX_AGE_SEC,
  classifyDexPoolVolumeObservation,
} from "@shared/lib/dex-volume-availability";
import {
  WORKER_ACTIVE_META_BY_ID,
  WORKER_TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import { encodeFunctionData, parseAbi } from "viem/utils";

import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { isBlockedDexId } from "../../lib/dex-cron-constants";
import {
  getAdmittedDexMarketMark,
  getClosedReferenceDexValuation,
  type DexMarketMark,
  type DexValuationPrices,
} from "../../lib/dex-api-token-pricing";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import { pricesAgreeWithinBps } from "../../lib/price-divergence";
import {
  asEvmCaptureAddress,
  curveAmplificationFromContract,
  curveConservativeFeeRate,
  decodeEvmCaptureAddress,
  decodeEvmCaptureUint256,
  decodeEvmCaptureUint256Array,
  mapEvmCaptureResults,
  runPinnedBlockCapture,
} from "./evm-capture-helpers";
import { normalizeProtocol } from "./pool-helpers";
import { retainedPoolVolumeSanityRejection } from "./pool-volume-sanity";
import { readDexPriceLineage } from "./price-lineage";
import {
  classifyPoolCurveNavIntegrityFailure,
  hasIndependentNavMarkLineage,
  hasScoreFacingMeasuredExecution,
  hasVerifiedClockedVenueProof,
  isCurveNavSpotQuoteCandidateShape,
  isDeadPool,
  isP4OnlyPausedBalancerPool,
  normalizeCurveNavScoringRejectionReason,
  projectRetainedPoolPrice,
  type CurveNavQuoteRejectionRecord,
  type CurveNavQuoteScoringRejectionReason,
  type DexVolumeClock,
} from "./scoring-helpers";
import {
  CURVE_NAV_SPOT_QUOTE_POLICY,
  CURVE_NAV_SPOT_QUOTE_POLICY_ID,
  type CurveNavSpotQuoteCandidate,
  type CurveStableswapRateInputExecutionCandidate,
  type DexPriceObs,
  type SourcePoolGraph,
  type PoolEntry,
  type SymbolLookups,
} from "./types";

export { CURVE_NAV_SPOT_QUOTE_POLICY_ID };

/**
 * Fallback fee for legacy source-only Curve models where the pools endpoint
 * lacks pool-specific fee state. Curve NG admission captures fee state instead
 * of treating this as a per-pool bound.
 */
export const CURVE_STABLESWAP_FEE_BOUND = 0.001;
/** A source-stage capture must reflect the current head, not a reusable quote profile. */
export const CURVE_STABLESWAP_RATE_CAPTURE_MAX_AGE_SEC = CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec;
/**
 * Legacy source-model price spread gate. For StableSwap-NG this is only a
 * diagnostic: pinned `stored_rates()` decides whether to scale the balances.
 */
export const CURVE_STABLESWAP_MAX_COIN_PRICE_SPREAD = 1.01;

const STABLESWAP_NG_PRECISION = 10n ** 18n;
const STABLESWAP_NG_FEE_DENOMINATOR = 10n ** 10n;
const STABLESWAP_NG_A_PRECISION = 100n;
const STABLESWAP_NG_MAX_NEWTON_ITERATIONS = 255;
const MAX_UINT256 = (1n << 256n) - 1n;

function isUint256(value: bigint): boolean {
  return value >= 0n && value <= MAX_UINT256;
}

function uAdd(a: bigint, b: bigint): bigint | null {
  const result = a + b;
  return result >= 0n && result <= MAX_UINT256 ? result : null;
}

function uSub(a: bigint, b: bigint): bigint | null {
  return a >= b && a <= MAX_UINT256 && b >= 0n ? a - b : null;
}

function uMul(a: bigint, b: bigint): bigint | null {
  const result = a * b;
  return result >= 0n && result <= MAX_UINT256 ? result : null;
}

export interface CurveStableswapNgGetDyInput {
  balances: readonly bigint[];
  rates: readonly bigint[];
  amplification: bigint;
  fee: bigint;
  offpegFeeMultiplier: bigint;
  i: number;
  j: number;
  dx: bigint;
}

export interface CurveStableswapNgGetDyResult {
  dy: bigint;
  dynamicFee: bigint;
  feeAmountXp: bigint;
}

/**
 * Exact raw-token `get_dy(i, j, dx)` for Curve StableSwap-NG using pinned
 * on-chain `get_balances()`, `stored_rates()`, `A()`, `fee()`, and
 * `offpeg_fee_multiplier()`. Matches Vyper `CurveStableSwapNG.vy` midpoint
 * dynamic fee math and checked `uint256` arithmetic with zero scaling approximations.
 */
export function simulateCurveStableswapNgGetDy(
  input: CurveStableswapNgGetDyInput,
): CurveStableswapNgGetDyResult | null {
  const { balances, rates, amplification, fee, offpegFeeMultiplier, i, j, dx } = input;
  const nCoins = balances.length;
  if (
    nCoins < 2 ||
    nCoins > 8 ||
    rates.length !== nCoins ||
    !Number.isInteger(i) ||
    !Number.isInteger(j) ||
    i < 0 ||
    j < 0 ||
    i >= nCoins ||
    j >= nCoins ||
    i === j ||
    dx <= 0n ||
    !isUint256(dx) ||
    amplification <= 0n ||
    !isUint256(amplification) ||
    fee < 0n ||
    fee >= STABLESWAP_NG_FEE_DENOMINATOR ||
    offpegFeeMultiplier < 0n ||
    !isUint256(offpegFeeMultiplier) ||
    balances.some((balance) => balance <= 0n || !isUint256(balance)) ||
    rates.some((rate) => rate <= 0n || !isUint256(rate))
  ) {
    return null;
  }

  const xp: bigint[] = [];
  for (let index = 0; index < nCoins; index++) {
    const prod = uMul(balances[index]!, rates[index]!);
    if (prod == null) return null;
    const scaled = prod / STABLESWAP_NG_PRECISION;
    if (scaled <= 0n) return null;
    xp.push(scaled);
  }
  const dxProd = uMul(dx, rates[i]!);
  if (dxProd == null) return null;
  const dxXp = dxProd / STABLESWAP_NG_PRECISION;
  if (dxXp <= 0n) return null;
  const x = uAdd(xp[i]!, dxXp);
  if (x == null) return null;

  const n = BigInt(nCoins);
  const nPowN = n ** n;
  const amp = uMul(amplification, STABLESWAP_NG_A_PRECISION);
  if (amp == null) return null;
  const ann = uMul(amp, n);
  if (ann == null || ann <= STABLESWAP_NG_A_PRECISION) return null;

  let sum = 0n;
  for (const value of xp) {
    const nextSum = uAdd(sum, value);
    if (nextSum == null) return null;
    sum = nextSum;
  }
  if (sum <= 0n) return null;

  let d = sum;
  let dConverged = false;
  for (let iter = 0; iter < STABLESWAP_NG_MAX_NEWTON_ITERATIONS; iter++) {
    let dP = d;
    for (const value of xp) {
      const nextDpNum = uMul(dP, d);
      if (nextDpNum == null) return null;
      dP = nextDpNum / value;
    }
    dP /= nPowN;
    const dPrev = d;
    const annSum = uMul(ann, sum);
    const dPN = uMul(dP, n);
    if (annSum == null || dPN == null) return null;
    const numLeft = uAdd(annSum / STABLESWAP_NG_A_PRECISION, dPN);
    if (numLeft == null) return null;
    const num = uMul(numLeft, d);
    const annMinusA = uSub(ann, STABLESWAP_NG_A_PRECISION);
    if (num == null || annMinusA == null) return null;
    const denLeftNum = uMul(annMinusA, d);
    const denRight = uMul(n + 1n, dP);
    if (denLeftNum == null || denRight == null) return null;
    const den = uAdd(denLeftNum / STABLESWAP_NG_A_PRECISION, denRight);
    if (den == null || den <= 0n) return null;
    d = num / den;
    if (!isUint256(d)) return null;
    const diff = d > dPrev ? d - dPrev : dPrev - d;
    if (diff <= 1n) {
      dConverged = true;
      break;
    }
  }
  if (!dConverged || d <= 0n) return null;

  let c = d;
  let sOther = 0n;
  for (let k = 0; k < nCoins; k++) {
    if (k === j) continue;
    const leg = k === i ? x : xp[k]!;
    if (leg <= 0n) return null;
    const nextOther = uAdd(sOther, leg);
    const cNum = uMul(c, d);
    const cDen = uMul(leg, n);
    if (nextOther == null || cNum == null || cDen == null || cDen <= 0n) return null;
    sOther = nextOther;
    c = cNum / cDen;
  }
  const cStep1 = uMul(c, d);
  const annN = uMul(ann, n);
  if (cStep1 == null || annN == null || annN <= 0n) return null;
  const cStep2 = uMul(cStep1, STABLESWAP_NG_A_PRECISION);
  if (cStep2 == null) return null;
  c = cStep2 / annN;
  const dA = uMul(d, STABLESWAP_NG_A_PRECISION);
  if (dA == null) return null;
  const b = uAdd(sOther, dA / ann);
  if (b == null) return null;

  let y = d;
  let yConverged = false;
  for (let iter = 0; iter < STABLESWAP_NG_MAX_NEWTON_ITERATIONS; iter++) {
    const yPrev = y;
    const twoY = uMul(2n, y);
    if (twoY == null) return null;
    const twoYPlusB = uAdd(twoY, b);
    if (twoYPlusB == null) return null;
    const den = uSub(twoYPlusB, d);
    if (den == null || den <= 0n) return null;
    const ySq = uMul(y, y);
    if (ySq == null) return null;
    const yNum = uAdd(ySq, c);
    if (yNum == null) return null;
    y = yNum / den;
    if (!isUint256(y)) return null;
    const diff = y > yPrev ? y - yPrev : yPrev - y;
    if (diff <= 1n) {
      yConverged = true;
      break;
    }
  }
  const yPlusOne = uAdd(y, 1n);
  if (!yConverged || y < 0n || yPlusOne == null) return null;
  const dyXp = uSub(xp[j]!, yPlusOne);
  if (dyXp == null || dyXp <= 0n) return null;

  const xpiSum = uAdd(xp[i]!, x);
  const xpjSum = uAdd(xp[j]!, y);
  if (xpiSum == null || xpjSum == null) return null;
  const xpi = xpiSum / 2n;
  const xpj = xpjSum / 2n;
  let dynamicFee: bigint;
  if (offpegFeeMultiplier <= STABLESWAP_NG_FEE_DENOMINATOR) {
    dynamicFee = fee;
  } else {
    const xps = uAdd(xpi, xpj);
    if (xps == null) return null;
    const xps2 = uMul(xps, xps);
    const multDiff = uSub(offpegFeeMultiplier, STABLESWAP_NG_FEE_DENOMINATOR);
    if (xps2 == null || xps2 <= 0n || multDiff == null) return null;
    const f4 = uMul(multDiff, 4n);
    if (f4 == null) return null;
    const f4x = uMul(f4, xpi);
    if (f4x == null) return null;
    const f4xy = uMul(f4x, xpj);
    if (f4xy == null) return null;
    const denom = uAdd(f4xy / xps2, STABLESWAP_NG_FEE_DENOMINATOR);
    const feeNum = uMul(offpegFeeMultiplier, fee);
    if (denom == null || denom <= 0n || feeNum == null) return null;
    dynamicFee = feeNum / denom;
  }
  if (dynamicFee < 0n || dynamicFee >= STABLESWAP_NG_FEE_DENOMINATOR) return null;

  const feeXpNum = uMul(dynamicFee, dyXp);
  if (feeXpNum == null) return null;
  const feeAmountXp = feeXpNum / STABLESWAP_NG_FEE_DENOMINATOR;
  const dyAfterFee = uSub(dyXp, feeAmountXp);
  if (dyAfterFee == null || dyAfterFee <= 0n) return null;
  const dyNum = uMul(dyAfterFee, STABLESWAP_NG_PRECISION);
  if (dyNum == null) return null;
  const dy = dyNum / rates[j]!;
  if (dy <= 0n || !isUint256(dy)) return null;
  return { dy, dynamicFee, feeAmountXp };
}

/**
 * In-memory raw pinned StableSwap-NG pool state retained from the already-executed
 * execution-model capture so active-NAV spot quoting issues zero extra RPCs.
 * Never persisted into scoring-stage JSON (contains `bigint`).
 */
export interface CurveStableswapNgCapturedPoolState {
  stablecoinId: string;
  chain: string;
  poolAddress: `0x${string}`;
  trackedTokenIndex: number;
  coins: readonly {
    address: `0x${string}`;
    symbol: string;
    decimals: number;
    trackedAssetId?: string;
  }[];
  balances: readonly bigint[];
  rates: readonly bigint[];
  amplification: bigint;
  fee: bigint;
  offpegFeeMultiplier: bigint;
  capture: NonNullable<DexAmmExecutionModel["capture"]>;
  captureEvaluatedAtSec: number;
}

export type CurveNavSpotQuoteRejectionReason =
  | "capture-generation-mismatch"
  | "capture-future"
  | "capture-stale"
  | "capture-invalid"
  | "pool-ineligible"
  | "quote-mark-unavailable"
  | "quote-mark-future"
  | "quote-mark-stale"
  | "depth-test-failed"
  | "insufficient-support"
  | "insufficient-volume"
  | "uncorroborated";

export interface CurveNavSpotQuoteSummary {
  policyId: typeof CURVE_NAV_SPOT_QUOTE_POLICY_ID;
  evaluatedPools: number;
  stagedCandidates?: number;
  admittedPools: number;
  admittedSoleVenue: number;
  admittedCorroborated: number;
  rejectedByReason: Partial<Record<CurveNavSpotQuoteRejectionReason, number>>;
}

const CURVE_STABLESWAP_NG_ABI = parseAbi([
  "function get_balances() view returns (uint256[])",
  "function stored_rates() view returns (uint256[])",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function coins(uint256) view returns (address)",
]);
const CURVE_LITE_FACTORY_ABI = parseAbi([
  "function get_implementation_address(address) view returns (address)",
  "function get_decimals(address) view returns (uint256[])",
]);
const MAX_PROBES_PER_MULTICALL = 4;

interface CurveStableswapRateDependencies {
  fetchBlockNumber: typeof fetchEvmBlockNumber;
  fetchBlockHeader: typeof fetchEvmBlockHeader;
  fetchMulticall: typeof fetchEvmMulticall3Aggregate3AtBlock;
}

const DEFAULT_DEPENDENCIES: CurveStableswapRateDependencies = {
  fetchBlockNumber: fetchEvmBlockNumber,
  fetchBlockHeader: fetchEvmBlockHeader,
  fetchMulticall: fetchEvmMulticall3Aggregate3AtBlock,
};

interface CandidateReference {
  stablecoinId: string;
  pool: PoolEntry;
  candidate: CurveStableswapRateInputExecutionCandidate;
}

interface CurveRateProbe {
  candidate: CurveStableswapRateInputExecutionCandidate;
  references: CandidateReference[];
  incompatibleLayout: boolean;
}

interface CurveRatePoolState {
  balances: bigint[];
  rates: bigint[];
  amplification: bigint;
  fee: bigint;
  offpegFeeMultiplier: bigint;
  coinAddresses: `0x${string}`[];
}


function needsCurveNgCapture(pool: PoolEntry): boolean {
  const gate = pool.extra?.executionCapabilityGate;
  return gate?.family === "curve-stableswap" && gate.reason === "incomplete-exact-capture";
}

function clearCandidate(reference: CandidateReference, reason?: DexExecutionCapabilityGate["reason"]): void {
  if (!reference.pool.extra) return;
  delete reference.pool.extra.curveStableswapRateInputExecutionCandidate;
  delete reference.pool.extra.curveStableswapPlainAdmissionDiagnostic;
  if (reason) reference.pool.extra.executionCapabilityGate = { family: "curve-stableswap", reason };
}

function clearProbe(probe: CurveRateProbe, reason?: DexExecutionCapabilityGate["reason"]): void {
  for (const reference of probe.references) clearCandidate(reference, reason);
}

function sameCoinLayout(
  left: CurveStableswapRateInputExecutionCandidate,
  right: CurveStableswapRateInputExecutionCandidate,
): boolean {
  return (
    left.poolAddress === right.poolAddress &&
    left.coins.length === right.coins.length &&
    left.coins.every((coin, index) => {
      const other = right.coins[index];
      return other != null && coin.address === other.address && coin.decimals === other.decimals;
    })
  );
}


function parsePoolState(input: {
  chain: string;
  probe: CurveRateProbe;
  index: number;
  results: Map<string, EvmMulticall3Result>;
}): CurveRatePoolState | DexExecutionCapabilityGate["reason"] {
  const prefix = `curve-rate-${input.index}`;
  const balances = decodeEvmCaptureUint256Array(input.results.get(`${prefix}-balances`));
  const rates = decodeEvmCaptureUint256Array(input.results.get(`${prefix}-rates`));
  const amplification = decodeEvmCaptureUint256(input.results.get(`${prefix}-A`));
  const fee = decodeEvmCaptureUint256(input.results.get(`${prefix}-fee`));
  const offpegFeeMultiplier = decodeEvmCaptureUint256(input.results.get(`${prefix}-offpeg-fee-multiplier`));
  const expectedCoins = input.probe.candidate.coins;
  if (
    !balances ||
    !rates ||
    amplification == null ||
    amplification <= 0n ||
    fee == null ||
    offpegFeeMultiplier == null ||
    balances.length !== expectedCoins.length ||
    rates.length !== expectedCoins.length ||
    balances.some((balance) => balance <= 0n) ||
    rates.some((rate) => rate <= 0n)
  ) {
    return "incomplete-exact-capture";
  }

  const deployment = CURVE_LITE_DEPLOYMENTS.get(input.chain);
  if (deployment) {
    const implementation = decodeEvmCaptureAddress(input.chain, input.results.get(`${prefix}-implementation`));
    const decimals = decodeEvmCaptureUint256Array(input.results.get(`${prefix}-decimals`));
    if (!implementation || !decimals) return "incomplete-exact-capture";
    if (implementation !== deployment.plainImplementation) return "deployment-code-mismatch";
    if (decimals.length !== expectedCoins.length || decimals.some((value, i) => Number(value) !== expectedCoins[i]!.decimals)) {
      return "ambiguous-token-identity";
    }
  }

  const coinAddresses: `0x${string}`[] = [];
  for (let coinIndex = 0; coinIndex < expectedCoins.length; coinIndex++) {
    const address = decodeEvmCaptureAddress(input.chain, input.results.get(`${prefix}-coin-${coinIndex}`));
    if (!address) return "incomplete-exact-capture";
    if (address !== expectedCoins[coinIndex]!.address) return deployment ? "ambiguous-token-identity" : "incomplete-exact-capture";
    coinAddresses.push(address);
  }
  return { balances, rates, amplification, fee, offpegFeeMultiplier, coinAddresses };
}

function rateFactor(rate: bigint, decimals: number): number | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || rate <= 0n) return null;
  const baseRate = 10n ** BigInt(36 - decimals);
  const factor = Number(rate) / Number(baseRate);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

function sourcePriceSpreadRatio(candidate: CurveStableswapRateInputExecutionCandidate): number | null {
  const prices = candidate.coins.map((coin) => coin.referencePriceUsd ?? Number.NaN);
  if (prices.some((price) => !Number.isFinite(price) || price <= 0)) return null;
  return Math.max(...prices) / Math.min(...prices);
}

function buildRateAwareExecutionModel(input: {
  chain: string;
  stablecoinId: string;
  candidate: CurveStableswapRateInputExecutionCandidate;
  state: CurveRatePoolState;
  marketMarks?: readonly DexMarketMark[];
  chainAddressToId: SymbolLookups["chainAddressToId"];
}): { model: DexAmmExecutionModel; plain: boolean } | null {
  const { candidate, state } = input;
  const tokenCount = candidate.coins.length;
  if (tokenCount < 2 || tokenCount > 8) return null;
  const amplification = curveAmplificationFromContract(state.amplification, tokenCount);
  if (amplification == null) return null;
  // The shared closed-form model carries the off-balance maximum so its fee
  // remains a conservative lower bound on exit capacity.
  const feeRate = curveConservativeFeeRate(state.fee, state.offpegFeeMultiplier);
  if (feeRate == null) return null;

  let hasNonBaseRate = false;
  const tokens = candidate.coins.map((coin, index) => {
    if (!Number.isInteger(coin.decimals) || coin.decimals < 0 || coin.decimals > 36) return null;
    const balance = toTokenUnits(state.balances[index]!, coin.decimals);
    const factor = rateFactor(state.rates[index]!, coin.decimals);
    const baseRate = 10n ** BigInt(36 - coin.decimals);
    if (state.rates[index] !== baseRate) hasNonBaseRate = true;
    const mark = input.marketMarks?.[index];
    const referencePriceUsd = mark?.priceUsd ?? coin.referencePriceUsd;
    if (
      balance == null ||
      factor == null ||
      referencePriceUsd == null || !Number.isFinite(referencePriceUsd) || referencePriceUsd <= 0
    ) {
      return null;
    }
    const scaledBalance = balance * factor;
    const scaledReferencePrice = referencePriceUsd / factor;
    if (
      !Number.isFinite(scaledBalance) ||
      scaledBalance <= 0 ||
      !Number.isFinite(scaledReferencePrice) ||
      scaledReferencePrice <= 0
    ) {
      return null;
    }
    const assetKey = canonicalExitRouteAssetKey(input.chain, state.coinAddresses[index]!);
    const trackedAssetId = input.chainAddressToId.get(assetKey);
    return {
      address: state.coinAddresses[index]!,
      symbol: coin.symbol,
      decimals: coin.decimals,
      balance: scaledBalance,
      referencePriceUsd: scaledReferencePrice,
      ...(mark ? {
        referencePriceSource: "tracked-market" as const,
        referencePriceSourceId: mark.source,
        referencePriceObservedAt: mark.observedAtSec,
      } : { referencePriceSource: "source-token-usd" as const }),
      ...(trackedAssetId ? { trackedAssetId } : {}),
    };
  });
  if (tokens.some((token) => token == null)) return null;

  const exactTokens = tokens as NonNullable<typeof tokens[number]>[];
  const trackedIndexes = exactTokens
    .map((token, index) => (token.trackedAssetId === input.stablecoinId ? index : -1))
    .filter((index) => index >= 0);
  if (trackedIndexes.length !== 1) return null;
  const identities = exactTokens.map((token) => canonicalExitRouteAssetKey(input.chain, token.address));
  if (new Set(identities).size !== identities.length) return null;

  return {
    model: {
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex: trackedIndexes[0]!,
      feeRate,
      amplification,
      tokens: exactTokens,
    },
    plain: !hasNonBaseRate,
  };
}


function buildPoolCalls(chain: string, probes: readonly CurveRateProbe[], offset: number) {
  const deployment = CURVE_LITE_DEPLOYMENTS.get(chain);
  return probes.flatMap((probe, batchIndex) => {
    const index = offset + batchIndex;
    const prefix = `curve-rate-${index}`;
    return [
      {
        label: `${prefix}-balances`,
        target: probe.candidate.poolAddress,
        callData: encodeFunctionData({ abi: CURVE_STABLESWAP_NG_ABI, functionName: "get_balances" }),
      },
      {
        label: `${prefix}-rates`,
        target: probe.candidate.poolAddress,
        callData: encodeFunctionData({ abi: CURVE_STABLESWAP_NG_ABI, functionName: "stored_rates" }),
      },
      {
        label: `${prefix}-A`,
        target: probe.candidate.poolAddress,
        callData: encodeFunctionData({ abi: CURVE_STABLESWAP_NG_ABI, functionName: "A" }),
      },
      {
        label: `${prefix}-fee`,
        target: probe.candidate.poolAddress,
        callData: encodeFunctionData({ abi: CURVE_STABLESWAP_NG_ABI, functionName: "fee" }),
      },
      {
        label: `${prefix}-offpeg-fee-multiplier`,
        target: probe.candidate.poolAddress,
        callData: encodeFunctionData({ abi: CURVE_STABLESWAP_NG_ABI, functionName: "offpeg_fee_multiplier" }),
      },
      ...(deployment ? [
        { label: `${prefix}-implementation`, target: deployment.factory, callData: encodeFunctionData({
          abi: CURVE_LITE_FACTORY_ABI, functionName: "get_implementation_address", args: [probe.candidate.poolAddress],
        }) },
        { label: `${prefix}-decimals`, target: deployment.factory, callData: encodeFunctionData({
          abi: CURVE_LITE_FACTORY_ABI, functionName: "get_decimals", args: [probe.candidate.poolAddress],
        }) },
      ] : []),
      ...probe.candidate.coins.map((_, coinIndex) => ({
        label: `${prefix}-coin-${coinIndex}`,
        target: probe.candidate.poolAddress,
        callData: encodeFunctionData({
          abi: CURVE_STABLESWAP_NG_ABI,
          functionName: "coins",
          args: [BigInt(coinIndex)],
        }),
      })),
    ];
  });
}

/** API Core may derive USD prices from the modeled pool itself. */
function resolveLiteMarketMarks(
  poolAddress: string, coinAddresses: readonly string[],
  input: { chain: string; chainAddressToId: SymbolLookups["chainAddressToId"]; stablecoinPriceById?: DexValuationPrices },
  nowSec: number,
): DexMarketMark[] | null {
  const poolKey = canonicalExitRouteAssetKey(input.chain, poolAddress);
  const prices = input.stablecoinPriceById;
  const marks: DexMarketMark[] = [];
  for (const address of coinAddresses) {
    const id = input.chainAddressToId.get(canonicalExitRouteAssetKey(input.chain, address));
    if (!id || getClosedReferenceDexValuation(prices, id, nowSec)?.mark === null) return null;
    const mark = getAdmittedDexMarketMark(prices, id, nowSec) ??
      getAdmittedDexMarketMark(prices, id, nowSec, undefined, prices?.curveExecutionMarks);
    if (!mark) return null;
    const lineage = readDexPriceLineage(mark);
    if (lineage.upstreamKeys?.includes(poolKey) || lineage.pricePoolKeys?.includes(poolKey) ||
        lineage.upstreamKeys?.length === 0 || (lineage.pricePoolKeys?.length === 0 && !lineage.upstreamKeys)) return null;
    marks.push(mark);
  }
  return marks;
}

async function enrichChain(input: {
  chain: string;
  probes: CurveRateProbe[];
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  resolveNowSec: () => number;
  sourceGenerationId: string;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  dependencies: CurveStableswapRateDependencies;
  stablecoinPriceById?: DexValuationPrices;
  capturedPools: Map<PoolEntry, CurveStableswapNgCapturedPoolState>;
}): Promise<void> {
  const rpcOptions = {
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    timeoutMs: 15_000,
    maxRetries: 0,
  };
  const captureNowSec = input.resolveNowSec();
  let observedFutureHeader = false;
  const trackedFetchBlockHeader: typeof fetchEvmBlockHeader = async (chain, blockRef, options) => {
    const header = await input.dependencies.fetchBlockHeader(chain, blockRef, options);
    const checkNowSec = input.resolveNowSec();
    observedFutureHeader =
      header != null &&
      Number.isSafeInteger(header.timestamp) &&
      Number.isSafeInteger(checkNowSec) &&
      header.timestamp > checkNowSec;
    return header;
  };
  await runPinnedBlockCapture<{
    states: Map<CurveRateProbe, CurveRatePoolState | DexExecutionCapabilityGate["reason"]>;
    capture: NonNullable<DexAmmExecutionModel["capture"]>;
  }, DexExecutionCapabilityGate["reason"]>({
    chain: input.chain,
    rpcOptions,
    fetchBlockNumber: input.dependencies.fetchBlockNumber,
    fetchBlockHeader: trackedFetchBlockHeader,
    nowSec: captureNowSec,
    maxAgeSec: CURVE_STABLESWAP_RATE_CAPTURE_MAX_AGE_SEC,
    freshnessFailureReason: "stale-observation",
    verifyDeployment: async () => ({ ok: true }),
    buildCalls: async ({ blockNumber, header, rpcOptions: captureRpcOptions }) => {
      const states = new Map<CurveRateProbe, CurveRatePoolState | DexExecutionCapabilityGate["reason"]>();
      for (let start = 0; start < input.probes.length; start += MAX_PROBES_PER_MULTICALL) {
        throwIfAborted(input.signal);
        const probes = input.probes.slice(start, start + MAX_PROBES_PER_MULTICALL);
        const results = await input.dependencies.fetchMulticall(
          input.chain,
          buildPoolCalls(input.chain, probes, start),
          blockNumber,
          captureRpcOptions,
        );
        if (!results) return { ok: false, reason: "transport-unavailable" };
        const byLabel = mapEvmCaptureResults(results);
        for (let batchIndex = 0; batchIndex < probes.length; batchIndex++) {
          const probe = probes[batchIndex]!;
          states.set(
            probe,
            probe.incompatibleLayout
              ? "ambiguous-token-identity"
              : parsePoolState({ chain: input.chain, probe, index: start + batchIndex, results: byLabel }),
          );
        }
      }
      return { ok: true, value: {
        states,
        capture: { blockNumber, blockHash: header.hash, blockTimestamp: header.timestamp,
          sourceGenerationId: input.sourceGenerationId },
      } };
    },
    onResults: ({ states, capture }) => {
      // Stamp after the confirmed block-header read so sequential chains/L2 blocks
      // observed in (preRpcNowSec, postHeaderNowSec] do not trip capture-future,
      // while still enforcing strict zero future skew for the NAV quote consumer.
      const captureEvaluatedAtSec = input.resolveNowSec();
      const navCaptureRejectionReason: CurveNavSpotQuoteRejectionReason | null =
        !Number.isSafeInteger(captureEvaluatedAtSec) || captureEvaluatedAtSec <= 0
          ? "capture-invalid"
          : capture.blockTimestamp > captureEvaluatedAtSec
            ? "capture-future"
            : captureEvaluatedAtSec - capture.blockTimestamp > CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec
              ? "capture-stale"
              : null;
      for (const probe of input.probes) {
        const state = states.get(probe);
        if (!state || typeof state === "string") {
          clearProbe(probe, state);
          continue;
        }
        const lite = CURVE_LITE_DEPLOYMENTS.has(input.chain);
        if (lite && navCaptureRejectionReason) {
          clearProbe(probe, navCaptureRejectionReason === "capture-stale" ? "stale-observation" : "invalid-observation");
          continue;
        }
        const marketMarks = lite
          ? resolveLiteMarketMarks(probe.candidate.poolAddress, state.coinAddresses, input, captureEvaluatedAtSec)
          : undefined;
        if (marketMarks === null) {
          clearProbe(probe, "reference-price-unavailable");
          continue;
        }
        for (const reference of probe.references) {
          const built = buildRateAwareExecutionModel({
            chain: input.chain,
            stablecoinId: reference.stablecoinId,
            candidate: reference.candidate,
            marketMarks,
            state,
            chainAddressToId: input.chainAddressToId,
          });
          if (!built) {
            clearCandidate(reference);
            continue;
          }
          built.model.capture = capture;
          const extra = { ...(reference.pool.extra ?? {}) };
          delete extra.curveStableswapRateInputExecutionCandidate;
          delete extra.executionCapabilityGate;
          extra.ammExecutionModel = built.model;
          // A pinned model does not invent a directional balance statistic absent from the Lite source.
          extra.measurement = { ...(extra.measurement ?? {}), balanceMeasured: marketMarks ? extra.balanceRatio != null : true };
          // A high source spread on a verified plain pool is diagnostic only.
          const spreadRatio = built.plain
            ? sourcePriceSpreadRatio(reference.candidate)
            : null;
          if (spreadRatio != null && spreadRatio > CURVE_STABLESWAP_MAX_COIN_PRICE_SPREAD) {
            extra.curveStableswapPlainAdmissionDiagnostic = {
              stablecoinId: reference.stablecoinId,
              chain: input.chain,
              poolId: reference.pool.poolId,
              poolAddress: reference.candidate.poolAddress,
              sourcePriceSpreadRatio: spreadRatio,
            };
          }
          if (navCaptureRejectionReason === null) {
            reference.pool.extra = extra;
            input.capturedPools.set(reference.pool, {
              stablecoinId: reference.stablecoinId,
              chain: input.chain,
              poolAddress: reference.candidate.poolAddress,
              trackedTokenIndex: built.model.trackedTokenIndex,
              coins: built.model.tokens.map((token, index) => ({
                address: state.coinAddresses[index]!,
                symbol: token.symbol,
                decimals: token.decimals,
                ...(token.trackedAssetId ? { trackedAssetId: token.trackedAssetId } : {}),
              })),
              balances: state.balances,
              rates: state.rates,
              amplification: state.amplification,
              fee: state.fee,
              offpegFeeMultiplier: state.offpegFeeMultiplier,
              capture,
              captureEvaluatedAtSec,
            });
          } else {
            if (isActiveNavToken(reference.stablecoinId)) {
              extra.curveNavSpotQuoteRejectedReason = navCaptureRejectionReason;
            }
            reference.pool.extra = extra;
          }
        }
      }
    },
    onFailure: (reason) => {
      const isFutureClockFailure =
        observedFutureHeader && (reason === "stale-observation" || reason === undefined);
      for (const probe of input.probes) {
        clearProbe(probe, reason);
        if (isFutureClockFailure) {
          for (const reference of probe.references) {
            if (isActiveNavToken(reference.stablecoinId)) {
              reference.pool.extra = {
                ...(reference.pool.extra ?? {}),
                curveNavSpotQuoteRejectedReason: "capture-future",
              };
            }
          }
        }
      }
    },
  });
}

/**
 * Replace eligible Curve StableSwap-NG gates only after reading
 * balances, stored rates, amplification, fee state (priced at its off-balance
 * maximum), and coin order at one fresh, confirmed block. `stored_rates()`
 * decides the shape: a non-base rate scales the model, while a base-only array
 * shows a plain pool and admits the same exact model unscaled. Every failure
 * keeps a capability gate; a source-stage price spread on an
 * admitted plain pool remains a diagnostic.
 *
 * Returns an in-memory map of captured raw StableSwap-NG pool states so
 * active-NAV spot quoting can reuse the exact same pinned capture with zero
 * additional RPCs.
 */
export async function enrichCurveStableswapRateInputExecutionModels(input: {
  metrics: Map<string, SourcePoolGraph>;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  stablecoinPriceById?: DexValuationPrices;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  nowSec?: number;
  getNowSec?: () => number;
  sourceGenerationId?: string;
  dependencies?: CurveStableswapRateDependencies;
}): Promise<Map<PoolEntry, CurveStableswapNgCapturedPoolState>> {
  const capturedPools = new Map<PoolEntry, CurveStableswapNgCapturedPoolState>();
  const references: CandidateReference[] = [];
  for (const [stablecoinId, metric] of input.metrics) {
    for (const pool of metric.pools) {
      const candidate = pool.extra?.curveStableswapRateInputExecutionCandidate;
      if (!candidate) continue;
      const reference = { stablecoinId, pool, candidate };
      if (needsCurveNgCapture(pool) && !hasScoreFacingMeasuredExecution(pool)) references.push(reference);
      else clearCandidate(reference);
    }
  }
  if (references.length === 0) return capturedPools;
  if (!input.chainRpcs || !input.sourceGenerationId) {
    for (const reference of references) clearCandidate(reference, "transport-unavailable");
    return capturedPools;
  }

  const probesByChain = new Map<string, Map<string, CurveRateProbe>>();
  for (const reference of references) {
    const chain = canonicalExitRouteChain(reference.pool.chain);
    const poolAddress = asEvmCaptureAddress(chain, reference.candidate.poolAddress);
    if (!poolAddress || poolAddress !== reference.candidate.poolAddress) {
      clearCandidate(reference);
      continue;
    }
    if (CURVE_LITE_DEPLOYMENTS.has(chain) && reference.pool.poolId !== canonicalExitRouteAssetKey(chain, poolAddress)) {
      clearCandidate(reference, "exact-pool-join-unresolved");
      continue;
    }
    const probes = probesByChain.get(chain) ?? new Map<string, CurveRateProbe>();
    const existing = probes.get(poolAddress);
    if (existing) {
      existing.incompatibleLayout ||= !sameCoinLayout(existing.candidate, reference.candidate);
      existing.references.push(reference);
    } else {
      probes.set(poolAddress, {
        candidate: reference.candidate,
        references: [reference],
        incompatibleLayout: false,
      });
    }
    probesByChain.set(chain, probes);
  }

  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const resolveNowSec = input.getNowSec ?? (input.nowSec !== undefined ? () => input.nowSec! : () => Math.floor(Date.now() / 1000));
  for (const [chain, probes] of probesByChain) {
    try {
      await enrichChain({
        chain,
        probes: [...probes.values()],
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        resolveNowSec,
        sourceGenerationId: input.sourceGenerationId,
        chainAddressToId: input.chainAddressToId,
        dependencies,
        stablecoinPriceById: input.stablecoinPriceById,
        capturedPools,
      });
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      for (const probe of probes.values()) clearProbe(probe, "transport-unavailable");
    }
  }
  return capturedPools;
}

function humanUnitsToRawBigInt(amountHuman: number, decimals: number): bigint | null {
  if (!Number.isFinite(amountHuman) || amountHuman <= 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return null;
  }
  const [mantissa, expStr] = amountHuman.toExponential(8).split("e");
  if (!mantissa || !expStr) return null;
  const [intPart, fracPart = ""] = mantissa.split(".");
  if (!intPart) return null;
  const digits = `${intPart}${fracPart}`;
  const exp = Number(expStr) + decimals - fracPart.length;
  if (!Number.isSafeInteger(exp)) return null;
  if (exp >= 0) return BigInt(digits) * 10n ** BigInt(exp);
  const scaled = BigInt(digits) / 10n ** BigInt(-exp);
  return scaled > 0n ? scaled : null;
}

export type CurveStableswapNgSpotQuoteResult =
  | {
      ok: true;
      priceUsd: number;
      probePriceUsd: number;
      sellImpactBps: number;
      rawIn: bigint;
      rawOut: bigint;
      dynamicFee: bigint;
      counterReserveUsd: number;
    }
  | { ok: false; reason: "capture-invalid" | "depth-test-failed" };

/**
 * Compute an exact raw-token `$10K` sell USD quote from already-captured
 * StableSwap-NG pinned state without reusing the conservative scaled execution
 * model. Sizes the sell notional via a `$100` virtual-rate micro-probe (never
 * the tracked NAV token's cached/Curve-REST price) and enforces the depth test.
 */
export function quoteCurveStableswapNgSpotUsd(input: {
  state: CurveStableswapNgCapturedPoolState;
  counterTokenIndex: number;
  counterMarkPriceUsd: number;
  probeNotionalUsd?: number;
  sellNotionalUsd?: number;
  maxSellImpactBps?: number;
}): CurveStableswapNgSpotQuoteResult {
  const { state, counterTokenIndex, counterMarkPriceUsd } = input;
  const probeNotionalUsd = input.probeNotionalUsd ?? CURVE_NAV_SPOT_QUOTE_POLICY.probeNotionalUsd;
  const sellNotionalUsd = input.sellNotionalUsd ?? CURVE_NAV_SPOT_QUOTE_POLICY.sellNotionalUsd;
  const maxSellImpactBps = input.maxSellImpactBps ?? CURVE_NAV_SPOT_QUOTE_POLICY.maxSellImpactBps;
  const trackedIndex = state.trackedTokenIndex;
  const trackedCoin = state.coins[trackedIndex];
  const counterCoin = state.coins[counterTokenIndex];
  if (
    !trackedCoin ||
    !counterCoin ||
    counterTokenIndex === trackedIndex ||
    !Number.isFinite(counterMarkPriceUsd) ||
    counterMarkPriceUsd <= 0 ||
    state.balances.length !== state.coins.length ||
    state.rates.length !== state.coins.length
  ) {
    return { ok: false, reason: "capture-invalid" };
  }

  const counterBalanceHuman = toTokenUnits(state.balances[counterTokenIndex]!, counterCoin.decimals);
  if (counterBalanceHuman == null || counterBalanceHuman <= 0) {
    return { ok: false, reason: "capture-invalid" };
  }
  const counterReserveUsd = counterBalanceHuman * counterMarkPriceUsd;
  if (!Number.isFinite(counterReserveUsd) || counterReserveUsd < sellNotionalUsd) {
    return { ok: false, reason: "depth-test-failed" };
  }

  const trackedFactor = rateFactor(state.rates[trackedIndex]!, trackedCoin.decimals);
  const counterFactor = rateFactor(state.rates[counterTokenIndex]!, counterCoin.decimals);
  if (trackedFactor == null || counterFactor == null) {
    return { ok: false, reason: "capture-invalid" };
  }
  const approxTrackedUsd = (trackedFactor / counterFactor) * counterMarkPriceUsd;
  const probeRaw = humanUnitsToRawBigInt(probeNotionalUsd / approxTrackedUsd, trackedCoin.decimals);
  if (probeRaw == null) return { ok: false, reason: "capture-invalid" };

  const probeQuote = simulateCurveStableswapNgGetDy({
    balances: state.balances,
    rates: state.rates,
    amplification: state.amplification,
    fee: state.fee,
    offpegFeeMultiplier: state.offpegFeeMultiplier,
    i: trackedIndex,
    j: counterTokenIndex,
    dx: probeRaw,
  });
  if (!probeQuote) return { ok: false, reason: "depth-test-failed" };

  const probeInHuman = toTokenUnits(probeRaw, trackedCoin.decimals);
  const probeOutHuman = toTokenUnits(probeQuote.dy, counterCoin.decimals);
  if (probeInHuman == null || probeInHuman <= 0 || probeOutHuman == null || probeOutHuman <= 0) {
    return { ok: false, reason: "depth-test-failed" };
  }
  const probePriceUsd = (probeOutHuman * counterMarkPriceUsd) / probeInHuman;
  if (!Number.isFinite(probePriceUsd) || probePriceUsd <= 0) {
    return { ok: false, reason: "depth-test-failed" };
  }

  const sellRaw = humanUnitsToRawBigInt(sellNotionalUsd / probePriceUsd, trackedCoin.decimals);
  if (sellRaw == null) return { ok: false, reason: "depth-test-failed" };

  const sellQuote = simulateCurveStableswapNgGetDy({
    balances: state.balances,
    rates: state.rates,
    amplification: state.amplification,
    fee: state.fee,
    offpegFeeMultiplier: state.offpegFeeMultiplier,
    i: trackedIndex,
    j: counterTokenIndex,
    dx: sellRaw,
  });
  if (!sellQuote) return { ok: false, reason: "depth-test-failed" };

  const sellInHuman = toTokenUnits(sellRaw, trackedCoin.decimals);
  const sellOutHuman = toTokenUnits(sellQuote.dy, counterCoin.decimals);
  if (sellInHuman == null || sellInHuman <= 0 || sellOutHuman == null || sellOutHuman <= 0) {
    return { ok: false, reason: "depth-test-failed" };
  }
  const priceUsd = (sellOutHuman * counterMarkPriceUsd) / sellInHuman;
  const sellImpactBps = Math.max(0, ((probePriceUsd - priceUsd) / probePriceUsd) * 10_000);
  if (
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0 ||
    !Number.isFinite(sellImpactBps) ||
    sellImpactBps > maxSellImpactBps
  ) {
    return { ok: false, reason: "depth-test-failed" };
  }
  return {
    ok: true,
    priceUsd,
    probePriceUsd,
    sellImpactBps,
    rawIn: sellRaw,
    rawOut: sellQuote.dy,
    dynamicFee: sellQuote.dynamicFee,
    counterReserveUsd,
  };
}

function isActiveNavToken(stablecoinId: string): boolean {
  const meta = WORKER_ACTIVE_META_BY_ID.get(stablecoinId);
  return meta?.navToken === true || meta?.flags.navToken === true;
}

function isTrackedNavToken(stablecoinId: string): boolean {
  const meta = WORKER_TRACKED_META_BY_ID.get(stablecoinId);
  return meta?.navToken === true || meta?.flags.navToken === true;
}

function admittedPoolVolume24hUsd(pool: PoolEntry, volumeClock: DexVolumeClock): number | null {
  if (pool.volumeReading) {
    const status = classifyDexPoolVolumeObservation(
      { volumeUsd: pool.volumeReading.volume24hUsd, observedAtSec: pool.volumeReading.observedAtSec },
      volumeClock,
    );
    return status === "measured" &&
      typeof pool.volumeReading.volume24hUsd === "number" &&
      Number.isFinite(pool.volumeReading.volume24hUsd) &&
      pool.volumeReading.volume24hUsd >= 0
      ? pool.volumeReading.volume24hUsd
      : null;
  }
  if (
    pool.volumeObservation?.status === "measured" &&
    typeof pool.volumeUsd1d === "number" &&
    Number.isFinite(pool.volumeUsd1d) &&
    pool.volumeUsd1d >= 0
  ) {
    return pool.volumeUsd1d;
  }
  return null;
}

function isEligibleRetainedPoolForNavQuote(pool: PoolEntry, volume24hUsd: number | null): boolean {
  if (
    isBlockedDexId(pool.project) ||
    isP4OnlyPausedBalancerPool(pool) ||
    !Number.isFinite(pool.tvlUsd) ||
    pool.tvlUsd <= 0 ||
    retainedPoolVolumeSanityRejection(pool.tvlUsd, volume24hUsd) != null ||
    isDeadPool({ tvlUsd: pool.tvlUsd, volumeUsd1d: volume24hUsd, volumeReading: pool.volumeReading })
  ) {
    return false;
  }
  return true;
}

function resolveIndependentCounterMark(input: {
  counterId: string | undefined;
  trackedStablecoinId: string;
  stablecoinPriceById: DexValuationPrices | undefined;
  nowSec: number;
}):
  | { ok: true; counterId: string; mark: DexMarketMark }
  | { ok: false; reason: "quote-mark-unavailable" | "quote-mark-future" | "quote-mark-stale" } {
  const { counterId, trackedStablecoinId, stablecoinPriceById, nowSec } = input;
  if (!counterId || counterId === trackedStablecoinId || isTrackedNavToken(counterId)) {
    return { ok: false, reason: "quote-mark-unavailable" };
  }
  const closure = getClosedReferenceDexValuation(stablecoinPriceById, counterId, nowSec);
  if (closure && !closure.mark) return { ok: false, reason: "quote-mark-unavailable" };
  const mark = getAdmittedDexMarketMark(
    stablecoinPriceById,
    counterId,
    nowSec,
    CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec - 1,
  );
  if (mark) {
    if (mark.observedAtMode !== "upstream") {
      return { ok: false, reason: "quote-mark-unavailable" };
    }
    return { ok: true, counterId, mark };
  }
  const raw = stablecoinPriceById?.marketMarks?.get(counterId);
  if (
    raw &&
    !raw.fxReference &&
    raw.observedAtMode === "upstream" &&
    raw.priceUsd === stablecoinPriceById?.get(counterId) &&
    Number.isFinite(raw.priceUsd) &&
    raw.priceUsd > 0 &&
    raw.source.trim().length > 0 &&
    Number.isSafeInteger(raw.observedAtSec) &&
    raw.observedAtSec > 0
  ) {
    if (raw.observedAtSec > nowSec) return { ok: false, reason: "quote-mark-future" };
    if (nowSec - raw.observedAtSec >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec) {
      return { ok: false, reason: "quote-mark-stale" };
    }
  }
  return { ok: false, reason: "quote-mark-unavailable" };
}

function findVerifiedClockedCorroborators(input: {
  stablecoinId: string;
  primaryPool: PoolEntry;
  primaryObs: DexPriceObs;
  pools: readonly PoolEntry[];
  sourceGenerationId: string;
  volumeClock: DexVolumeClock;
  nowSec: number;
}): Array<{ poolId: string; tvlUsd: number }> {
  const seen = new Set<string>();
  const matches: Array<{ poolId: string; tvlUsd: number }> = [];
  for (const candidate of input.pools) {
    if (
      candidate === input.primaryPool ||
      candidate.poolId === input.primaryPool.poolId ||
      seen.has(candidate.poolId) ||
      normalizeProtocol(candidate.project) === "curve" ||
      (candidate.priceSource ?? candidate.source) !== "direct_api" ||
      candidate.extra?.executionCapabilityGate != null ||
      typeof candidate.price !== "number" ||
      !Number.isFinite(candidate.price) ||
      candidate.price <= 0
    ) {
      continue;
    }
    const candidateVol = admittedPoolVolume24hUsd(candidate, input.volumeClock);
    if (
      !isEligibleRetainedPoolForNavQuote(candidate, candidateVol) ||
      candidateVol == null ||
      candidateVol < CURVE_NAV_SPOT_QUOTE_POLICY.corroboratorMinVolume24hUsd
    ) {
      continue;
    }
    const candidateTvl = Math.min(candidate.tvlUsd, candidate.priceEvidenceTvlUsd ?? candidate.tvlUsd);
    if (!Number.isFinite(candidateTvl) || candidateTvl < CURVE_NAV_SPOT_QUOTE_POLICY.corroboratorMinTvlUsd) {
      continue;
    }
    if (
      candidate.priceCounterparty?.observedAtMode !== "upstream" ||
      !hasVerifiedClockedVenueProof(candidate, {
        stablecoinId: input.stablecoinId,
        nowSec: input.nowSec,
        sourceGenerationId: input.sourceGenerationId,
      })
    ) {
      continue;
    }
    const candidateObs = projectRetainedPoolPrice(candidate, input.stablecoinId);
    if (!candidateObs || !hasIndependentNavMarkLineage(input.primaryObs, candidateObs)) {
      continue;
    }
    if (!pricesAgreeWithinBps(input.primaryObs.price, candidate.price, CURVE_NAV_SPOT_QUOTE_POLICY.corroboratorMaxDivergenceBps)) {
      continue;
    }
    seen.add(candidate.poolId);
    matches.push({ poolId: candidate.poolId, tvlUsd: candidateTvl });
  }
  return matches;
}

export interface CurveNavCandidateAdmissionResult {
  admittedPools: number;
  admittedSoleVenue: number;
  admittedCorroborated: number;
  rejectedByReason: Partial<Record<CurveNavSpotQuoteRejectionReason, number>>;
  rejectionsByStablecoin: Map<string, CurveNavQuoteRejectionRecord[]>;
}

/**
 * Decide sole-venue vs corroborated admission for staged Curve StableSwap-NG
 * active-NAV spot quote candidates AFTER `measuredExecution` is attached in
 * scoring. Strips all internal candidate/rejection fields before persistence.
 */
export function admitCurveStableswapNgNavCandidates(input: {
  poolsByStablecoin: ReadonlyMap<string, readonly PoolEntry[]>;
  nowSec: number;
  volumeClock: DexVolumeClock;
}): CurveNavCandidateAdmissionResult {
  const result: CurveNavCandidateAdmissionResult = {
    admittedPools: 0,
    admittedSoleVenue: 0,
    admittedCorroborated: 0,
    rejectedByReason: {},
    rejectionsByStablecoin: new Map(),
  };
  const recordRejection = (
    stablecoinId: string,
    poolKey: string | null,
    chain: string | undefined,
    sourceReason: CurveNavSpotQuoteRejectionReason,
    scoringReason: CurveNavQuoteScoringRejectionReason,
  ) => {
    result.rejectedByReason[sourceReason] = (result.rejectedByReason[sourceReason] ?? 0) + 1;
    const list = result.rejectionsByStablecoin.get(stablecoinId) ?? [];
    list.push({ poolKey, ...(chain ? { chain } : {}), reason: scoringReason });
    result.rejectionsByStablecoin.set(stablecoinId, list);
  };

  for (const [stablecoinId, pools] of input.poolsByStablecoin) {
    for (const pool of pools) {
      const priorRejectedReason = pool.extra?.curveNavSpotQuoteRejectedReason;
      if (priorRejectedReason !== undefined && pool.extra) {
        delete pool.extra.curveNavSpotQuoteRejectedReason;
        const list = result.rejectionsByStablecoin.get(stablecoinId) ?? [];
        list.push({
          poolKey: pool.poolId,
          chain: pool.chain,
          reason: normalizeCurveNavScoringRejectionReason(priorRejectedReason),
        });
        result.rejectionsByStablecoin.set(stablecoinId, list);
      }

      const candidate = pool.extra?.curveNavSpotQuoteCandidate;
      if (candidate === undefined) continue;
      if (pool.extra) delete pool.extra.curveNavSpotQuoteCandidate;

      if (!isActiveNavToken(stablecoinId)) continue;
      if (pool.curveNavSpotQuote !== undefined) {
        // Never let a staged candidate overwrite an already-attached quote with an integrity failure.
        const existingIntegrity = classifyPoolCurveNavIntegrityFailure(pool, input.nowSec);
        if (existingIntegrity != null) {
          recordRejection(stablecoinId, pool.poolId, pool.chain, "capture-invalid", existingIntegrity);
          continue;
        }
      }
      const rawMarkMode =
        candidate != null && typeof candidate === "object"
          ? (candidate as { counterpartyPrice?: { observedAtMode?: unknown } }).counterpartyPrice?.observedAtMode
          : undefined;
      if (
        !isCurveNavSpotQuoteCandidateShape(candidate) ||
        candidate.poolId !== pool.poolId ||
        pool.extra?.executionCapabilityGate != null ||
        !Number.isSafeInteger(input.nowSec) ||
        input.nowSec <= 0
      ) {
        recordRejection(
          stablecoinId,
          pool.poolId,
          pool.chain,
          "capture-invalid",
          rawMarkMode !== "upstream" ? "invalid-clock" : "invalid-policy",
        );
        continue;
      }
      if (
        candidate.poolRatioObservedAt > input.nowSec ||
        candidate.quoteMarkObservedAt > input.nowSec ||
        candidate.counterpartyPrice.observedAtSec > input.nowSec ||
        candidate.captureEvaluatedAtSec > input.nowSec ||
        candidate.poolRatioObservedAt > candidate.captureEvaluatedAtSec
      ) {
        recordRejection(stablecoinId, pool.poolId, pool.chain, "capture-future", "future-timestamp");
        continue;
      }
      if (
        candidate.counterpartyPrice.observedAtMode !== "upstream" ||
        candidate.counterpartyPrice.observedAtSec !== candidate.quoteMarkObservedAt
      ) {
        recordRejection(stablecoinId, pool.poolId, pool.chain, "capture-invalid", "invalid-clock");
        continue;
      }
      if (
        candidate.captureEvaluatedAtSec - candidate.poolRatioObservedAt > CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec ||
        input.nowSec - candidate.poolRatioObservedAt > CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec
      ) {
        recordRejection(stablecoinId, pool.poolId, pool.chain, "capture-stale", "capture-stale");
        continue;
      }
      if (
        input.nowSec - candidate.poolRatioObservedAt >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec ||
        input.nowSec - candidate.quoteMarkObservedAt >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec
      ) {
        recordRejection(stablecoinId, pool.poolId, pool.chain, "quote-mark-stale", "quote-mark-stale");
        continue;
      }

      const admittedVol = admittedPoolVolume24hUsd(pool, input.volumeClock) ?? candidate.volume24hUsd;
      if (!isEligibleRetainedPoolForNavQuote(pool, admittedVol)) {
        recordRejection(stablecoinId, pool.poolId, pool.chain, "pool-ineligible", "pool-ineligible");
        continue;
      }
      const supportUsd = Math.min(pool.tvlUsd, candidate.supportUsd);
      if (!Number.isFinite(supportUsd) || supportUsd < CURVE_NAV_SPOT_QUOTE_POLICY.corroboratedPrimaryMinTvlUsd) {
        recordRejection(stablecoinId, pool.poolId, pool.chain, "insufficient-support", "insufficient-support");
        continue;
      }
      if (admittedVol == null || admittedVol < CURVE_NAV_SPOT_QUOTE_POLICY.corroboratedPrimaryMinVolume24hUsd) {
        recordRejection(stablecoinId, pool.poolId, pool.chain, "insufficient-volume", "insufficient-volume");
        continue;
      }

      const observedAt = Math.min(candidate.poolRatioObservedAt, candidate.quoteMarkObservedAt);
      const primaryObs: DexPriceObs = {
        price: candidate.priceUsd,
        observedAt,
        counterpartyPrice: candidate.counterpartyPrice,
        tvl: supportUsd,
        chain: pool.chain,
        protocol: pool.project,
        poolKey: pool.poolId,
        identityConfidence: "exact",
        sourceFamily: "direct_api",
      };
      const corroborators = findVerifiedClockedCorroborators({
        stablecoinId,
        primaryPool: pool,
        primaryObs,
        pools,
        sourceGenerationId: candidate.sourceGenerationId,
        volumeClock: input.volumeClock,
        nowSec: input.nowSec,
      });
      const combinedTvlUsd = supportUsd + corroborators.reduce((sum, entry) => sum + entry.tvlUsd, 0);
      const passesCorroborated =
        corroborators.length > 0 && combinedTvlUsd >= CURVE_NAV_SPOT_QUOTE_POLICY.corroboratedCombinedMinTvlUsd;
      const passesSoleVenue =
        supportUsd >= CURVE_NAV_SPOT_QUOTE_POLICY.soleVenueMinTvlUsd &&
        admittedVol >= CURVE_NAV_SPOT_QUOTE_POLICY.soleVenueMinVolume24hUsd;
      if (!passesCorroborated && !passesSoleVenue) {
        recordRejection(stablecoinId, pool.poolId, pool.chain, "uncorroborated", "corroborator-missing");
        continue;
      }

      const admissionMode = passesCorroborated ? "corroborated" : "sole-venue";
      pool.priceCounterparty = candidate.counterpartyPrice;
      pool.price = candidate.priceUsd;
      pool.priceObservedAt = observedAt;
      pool.priceSource = "direct_api";
      pool.priceEvidenceTvlUsd = supportUsd;
      pool.curveNavSpotQuote = {
        policyId: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
        poolId: pool.poolId,
        blockNumber: candidate.blockNumber,
        blockHash: candidate.blockHash,
        poolRatioObservedAt: candidate.poolRatioObservedAt,
        quoteMarkObservedAt: candidate.quoteMarkObservedAt,
        captureEvaluatedAtSec: candidate.captureEvaluatedAtSec,
        sourceGenerationId: candidate.sourceGenerationId,
        admissionMode,
        ...(passesCorroborated ? { corroboratorPoolIds: corroborators.map((entry) => entry.poolId) } : {}),
      };

      result.admittedPools++;
      if (admissionMode === "corroborated") result.admittedCorroborated++;
      else result.admittedSoleVenue++;
    }
  }
  return result;
}

/**
 * Compute and stage (or admit inline) clocked Curve StableSwap-NG spot quotes
 * for active NAV tokens directly from already-captured pinned NG state (zero
 * extra RPCs). Runs AFTER `refreshPoolPrices`; in production `stageOnly: true`
 * defers sole-venue vs corroborated admission to `scoring.ts` AFTER
 * `measuredExecution` joins onto corroborator pools.
 */
export function refreshCurveStableswapNgNavPrices(input: {
  metrics: ReadonlyMap<string, SourcePoolGraph>;
  capturedPools: ReadonlyMap<PoolEntry, CurveStableswapNgCapturedPoolState>;
  sourceGenerationId: string;
  stablecoinPriceById: DexValuationPrices | undefined;
  registryEvaluatedAtSec?: number;
  nowSec: number;
  stageOnly?: boolean;
}): CurveNavSpotQuoteSummary {
  const summary: CurveNavSpotQuoteSummary = {
    policyId: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
    evaluatedPools: 0,
    stagedCandidates: 0,
    admittedPools: 0,
    admittedSoleVenue: 0,
    admittedCorroborated: 0,
    rejectedByReason: {},
  };
  const reject = (pool: PoolEntry, reason: CurveNavSpotQuoteRejectionReason) => {
    summary.rejectedByReason[reason] = (summary.rejectedByReason[reason] ?? 0) + 1;
    pool.extra = { ...(pool.extra ?? {}), curveNavSpotQuoteRejectedReason: reason };
  };
  if (!Number.isSafeInteger(input.nowSec) || input.nowSec <= 0) {
    return summary;
  }

  const volumeClock: DexVolumeClock = {
    asOfSec: input.registryEvaluatedAtSec ?? input.nowSec,
    maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC,
  };

  for (const [stablecoinId, metric] of input.metrics) {
    if (!isActiveNavToken(stablecoinId)) continue;
    for (const pool of metric.pools) {
      const captured = input.capturedPools.get(pool);
      if (!captured) {
        const preRejected = pool.extra?.curveNavSpotQuoteRejectedReason;
        if (preRejected) {
          const key = preRejected as CurveNavSpotQuoteRejectionReason;
          summary.evaluatedPools++;
          summary.rejectedByReason[key] = (summary.rejectedByReason[key] ?? 0) + 1;
        }
        continue;
      }
      summary.evaluatedPools++;

      const { capture, captureEvaluatedAtSec } = captured;
      if (capture.sourceGenerationId !== input.sourceGenerationId) {
        reject(pool, "capture-generation-mismatch");
        continue;
      }
      if (
        captured.stablecoinId !== stablecoinId ||
        pool.extra?.executionCapabilityGate != null ||
        !Number.isSafeInteger(capture.blockNumber) ||
        capture.blockNumber <= 0 ||
        !capture.blockHash.trim() ||
        !Number.isSafeInteger(capture.blockTimestamp) ||
        capture.blockTimestamp <= 0 ||
        !Number.isSafeInteger(captureEvaluatedAtSec) ||
        captureEvaluatedAtSec <= 0
      ) {
        reject(pool, "capture-invalid");
        continue;
      }
      if (
        capture.blockTimestamp > input.nowSec ||
        capture.blockTimestamp > captureEvaluatedAtSec ||
        captureEvaluatedAtSec > input.nowSec
      ) {
        reject(pool, "capture-future");
        continue;
      }
      if (
        input.nowSec - capture.blockTimestamp > CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec ||
        captureEvaluatedAtSec - capture.blockTimestamp > CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec
      ) {
        reject(pool, "capture-stale");
        continue;
      }

      const admittedVol = admittedPoolVolume24hUsd(pool, volumeClock);
      if (!isEligibleRetainedPoolForNavQuote(pool, admittedVol)) {
        reject(pool, "pool-ineligible");
        continue;
      }

      let best: {
        counterIndex: number;
        counterId: string;
        mark: DexMarketMark;
        quote: Extract<CurveStableswapNgSpotQuoteResult, { ok: true }>;
      } | null = null;
      let sawDepthFailure = false;
      let sawMarkFuture = false;
      let sawMarkStale = false;
      const validCounterReserveUsdByIndex = new Map<number, number>();

      for (let index = 0; index < captured.coins.length; index++) {
        if (index === captured.trackedTokenIndex) continue;
        const resolvedMark = resolveIndependentCounterMark({
          counterId: captured.coins[index]!.trackedAssetId,
          trackedStablecoinId: stablecoinId,
          stablecoinPriceById: input.stablecoinPriceById,
          nowSec: input.nowSec,
        });
        if (!resolvedMark.ok) {
          if (resolvedMark.reason === "quote-mark-future") sawMarkFuture = true;
          else if (resolvedMark.reason === "quote-mark-stale") sawMarkStale = true;
          continue;
        }
        const legUnits = toTokenUnits(captured.balances[index]!, captured.coins[index]!.decimals);
        if (legUnits != null && legUnits > 0) {
          validCounterReserveUsdByIndex.set(index, legUnits * resolvedMark.mark.priceUsd);
        }
        const quoted = quoteCurveStableswapNgSpotUsd({
          state: captured,
          counterTokenIndex: index,
          counterMarkPriceUsd: resolvedMark.mark.priceUsd,
        });
        if (!quoted.ok) {
          if (quoted.reason === "depth-test-failed") sawDepthFailure = true;
          continue;
        }
        if (!best || quoted.counterReserveUsd > best.quote.counterReserveUsd) {
          best = {
            counterIndex: index,
            counterId: resolvedMark.counterId,
            mark: resolvedMark.mark,
            quote: quoted,
          };
        }
      }

      if (!best) {
        if (sawDepthFailure) reject(pool, "depth-test-failed");
        else if (sawMarkFuture) reject(pool, "quote-mark-future");
        else if (sawMarkStale) reject(pool, "quote-mark-stale");
        else reject(pool, "quote-mark-unavailable");
        continue;
      }

      const trackedUnits = toTokenUnits(
        captured.balances[captured.trackedTokenIndex]!,
        captured.coins[captured.trackedTokenIndex]!.decimals,
      );
      if (trackedUnits == null || trackedUnits <= 0) {
        reject(pool, "capture-invalid");
        continue;
      }
      let onchainPoolTvlUsd = trackedUnits * best.quote.priceUsd;
      for (const legUsd of validCounterReserveUsdByIndex.values()) onchainPoolTvlUsd += legUsd;
      const supportUsd = Math.min(pool.tvlUsd, onchainPoolTvlUsd);
      if (!Number.isFinite(supportUsd) || supportUsd < CURVE_NAV_SPOT_QUOTE_POLICY.corroboratedPrimaryMinTvlUsd) {
        reject(pool, "insufficient-support");
        continue;
      }
      if (admittedVol == null || admittedVol < CURVE_NAV_SPOT_QUOTE_POLICY.corroboratedPrimaryMinVolume24hUsd) {
        reject(pool, "insufficient-volume");
        continue;
      }

      const { corroboration: _corroboration, ...priceMark } = best.mark;
      const candidate: CurveNavSpotQuoteCandidate = {
        policyId: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
        poolId: pool.poolId,
        priceUsd: best.quote.priceUsd,
        supportUsd,
        volume24hUsd: admittedVol,
        blockNumber: capture.blockNumber,
        blockHash: capture.blockHash,
        poolRatioObservedAt: capture.blockTimestamp,
        quoteMarkObservedAt: best.mark.observedAtSec,
        captureEvaluatedAtSec,
        sourceGenerationId: capture.sourceGenerationId,
        counterpartyPrice: {
          ...priceMark,
          observedAtMode: "upstream",
          stablecoinId: best.counterId,
          ...readDexPriceLineage(best.mark),
        },
      };
      const extra = { ...(pool.extra ?? {}) };
      delete extra.curveNavSpotQuoteRejectedReason;
      extra.curveNavSpotQuoteCandidate = candidate;
      pool.extra = extra;
      summary.stagedCandidates = (summary.stagedCandidates ?? 0) + 1;
    }
  }

  if (!input.stageOnly) {
    const poolsByStablecoin = new Map<string, readonly PoolEntry[]>();
    for (const [id, graph] of input.metrics) poolsByStablecoin.set(id, graph.pools);
    const admitted = admitCurveStableswapNgNavCandidates({
      poolsByStablecoin,
      nowSec: input.nowSec,
      volumeClock,
    });
    summary.admittedPools = admitted.admittedPools;
    summary.admittedSoleVenue = admitted.admittedSoleVenue;
    summary.admittedCorroborated = admitted.admittedCorroborated;
    for (const [reason, count] of Object.entries(admitted.rejectedByReason)) {
      if (count) {
        const key = reason as CurveNavSpotQuoteRejectionReason;
        summary.rejectedByReason[key] = (summary.rejectedByReason[key] ?? 0) + count;
      }
    }
  }

  return summary;
}
