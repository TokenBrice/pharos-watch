import { EXIT_ROUTE_SCORING_TABLES } from "./exit-route-scoring";
import type {
  DexAmmExecutionModel,
  DexAmmExecutionToken,
  DexExecutionCapabilityGate,
  ExitRouteCapacityPoint,
  ExitRouteConfidence,
  ExitRouteEvidenceKind,
  ExitRouteObservation,
  ExitRouteObservationCoverage,
  ExitRouteOutput,
  LiquidityPoolSourceFamily,
} from "../types/market";
import { MAX_DEX_EXIT_ROUTE_OBSERVATIONS } from "../types/exit-route";
import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
  canonicalExitRouteScopedId,
  canonicalExitRouteScopedKey,
  encodeExitRouteIdentityPart,
  normalizeExitRouteCorrelationKey,
} from "./exit-route-identity";
import {
  getDexMeasuredExecutionFreshnessMaxSec,
  DexMeasuredExecutionPublicProfileSchema,
  isDexMeasuredExecutionObservationHistoryMature,
  type DexMeasuredExecutionObservationHistory,
  type DexMeasuredExecutionPublicProfile,
} from "../types/measured-execution";
import {
  SolanaMeasuredExecutionPublicProfileSchema,
  type SolanaMeasuredExecutionPublicProfile,
} from "../types/solana-measured-execution";
import {
  TronMeasuredExecutionPublicProfileSchema,
  type TronMeasuredExecutionPublicProfile,
} from "../types/tron-measured-execution";

const DEX_ROUTE_CAPABILITY_MATRIX_VERSION = "p4a.8";

// The stress-request shape is owned by the one exit scoring engine
// (`exit-route-scoring.ts`); these are named views of it, not a second copy.
export const DEFAULT_NOTIONALS_USD: readonly number[] = EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd;
const REFERENCE_NOTIONAL_USD = EXIT_ROUTE_SCORING_TABLES.request.referenceNotionalUsd;
export const REFERENCE_COST_BPS = EXIT_ROUTE_SCORING_TABLES.request.maxCostBps;
export const IMMEDIATE_SETTLEMENT_HORIZON_SEC = EXIT_ROUTE_SCORING_TABLES.request.settlementHorizonSec;
const AMM_EXECUTION_COST_TOLERANCE_BPS = 0.02;
const CURVE_STABLESWAP_ADAPTER_PROFILE_ID = "curve-stableswap-main-registry-get-dy-v1";
const CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID = "curve-stableswap-ng-factory-get-dy-v2";
const CURVE_3POOL_ADDRESS = "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7";
const CURVE_MAIN_REGISTRY_ADDRESS = "0x90e00ace148ca3b23ac1bc8c240c2a7dd9c2d7f5";
const CURVE_MAIN_REGISTRY_CODE_HASH =
  "0x13d7cfcf1cef4bf310fa544567a427771c9be2c16bbf2c6be845d3d5f4cc5f22";
const CURVE_3POOL_LP_TOKEN = "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490";
const CURVE_3POOL_TOKEN_ADDRESSES = [
  "0x6b175474e89094c44da98b954eedeac495271d0f",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
] as const;
const CURVE_STABLESWAP_MIN_COMPLETE_CYCLES = 3;
const CURVE_STABLESWAP_MIN_SUCCESSFUL_OBSERVATIONS = 3;
const CURVE_STABLESWAP_NG_POOL_ADDRESS = "0xc061caa073f3d95f80f8e5428d32d2d76f5e1622";
const CURVE_STABLESWAP_NG_POOL_TOKEN_ADDRESSES = [
  "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
] as const;
const CURVE_STABLESWAP_NG_FACTORY_ADDRESS = "0x6a8cbed756804b16e05e741edabd5cb544ae21bf";
const CURVE_STABLESWAP_NG_FACTORY_CODE_HASH =
  "0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd";
const CURVE_STABLESWAP_NG_FACTORY_POOL_INDEX = 563;
const CURVE_DUSD_STABLESWAP_NG_POOL_ADDRESS = "0x32e616f4f17d43f9a5cd9be0e294727187064cb3";
const CURVE_DUSD_STABLESWAP_NG_POOL_TOKEN_ADDRESSES = [
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x1e33e98af620f1d563fcd3cfd3c75ace841204ef",
] as const;
const CURVE_DUSD_STABLESWAP_NG_FACTORY_POOL_INDEX = 580;
const CURVE_STABLESWAP_NG_MIN_COMPLETE_CYCLES = 3;
const CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS = 3;
export const P4_AMM_MODELED_TVL_MIN_RATIO = 0.5;
export const P4_AMM_MODELED_TVL_MAX_RATIO = 2;

interface CurveStableSwapNgReviewedPolicy {
  chain: "ethereum";
  stablecoinId: string;
  poolAddress: string;
  poolTokenAddresses: readonly string[];
  tokenInAddress: string;
  tokenOutAddress: string;
  factoryAddress: string;
  factoryCodeHash: string;
  factoryPoolIndex: number;
}

const CURVE_STABLESWAP_NG_REVIEWED_POLICIES: readonly CurveStableSwapNgReviewedPolicy[] = [
  {
    chain: "ethereum",
    stablecoinId: "usdg-paxos",
    poolAddress: CURVE_STABLESWAP_NG_POOL_ADDRESS,
    poolTokenAddresses: CURVE_STABLESWAP_NG_POOL_TOKEN_ADDRESSES,
    tokenInAddress: CURVE_STABLESWAP_NG_POOL_TOKEN_ADDRESSES[0],
    tokenOutAddress: CURVE_STABLESWAP_NG_POOL_TOKEN_ADDRESSES[1],
    factoryAddress: CURVE_STABLESWAP_NG_FACTORY_ADDRESS,
    factoryCodeHash: CURVE_STABLESWAP_NG_FACTORY_CODE_HASH,
    factoryPoolIndex: CURVE_STABLESWAP_NG_FACTORY_POOL_INDEX,
  },
  {
    chain: "ethereum",
    stablecoinId: "dusd-dialectic",
    poolAddress: CURVE_DUSD_STABLESWAP_NG_POOL_ADDRESS,
    poolTokenAddresses: CURVE_DUSD_STABLESWAP_NG_POOL_TOKEN_ADDRESSES,
    tokenInAddress: CURVE_DUSD_STABLESWAP_NG_POOL_TOKEN_ADDRESSES[1],
    tokenOutAddress: CURVE_DUSD_STABLESWAP_NG_POOL_TOKEN_ADDRESSES[0],
    factoryAddress: CURVE_STABLESWAP_NG_FACTORY_ADDRESS,
    factoryCodeHash: CURVE_STABLESWAP_NG_FACTORY_CODE_HASH,
    factoryPoolIndex: CURVE_DUSD_STABLESWAP_NG_FACTORY_POOL_INDEX,
  },
];

function reviewedCurveStableSwapNgPolicyForProfile(
  profile: P4MeasuredExecutionPublicProfile,
): CurveStableSwapNgReviewedPolicy | null {
  if (profile.adapterProfileId !== CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID) return null;
  const chain = canonicalExitRouteChain(profile.chain);
  const endpoint = "executionEndpoint" in profile ? profile.executionEndpoint.address : "";
  return CURVE_STABLESWAP_NG_REVIEWED_POLICIES.find(
    (policy) =>
      policy.chain === chain &&
      endpoint === policy.poolAddress &&
      canonicalExitRouteScopedKey(profile.chain, profile.poolId) ===
        canonicalExitRouteScopedKey(policy.chain, policy.poolAddress),
  ) ?? null;
}

type CapabilityLevel = "exact" | "partial" | "symbol-only" | "aggregate-only" | "absent";
type NativeMeasuredExecutionPublicProfile =
  | SolanaMeasuredExecutionPublicProfile
  | TronMeasuredExecutionPublicProfile;
type P4MeasuredExecutionPublicProfile =
  | DexMeasuredExecutionPublicProfile
  | NativeMeasuredExecutionPublicProfile;
type DexRouteEvidenceKind = Extract<
  ExitRouteEvidenceKind,
  | "measured-executable-depth"
  | "reserve-based-amm-simulation"
  | "direct-orderbook-depth"
  | "generic-tvl-proxy"
  | "synthetic-or-fallback"
  | "unobserved"
>;

export interface DexRouteSourceCapability {
  id: string;
  sourceFamilies: readonly LiquidityPoolSourceFamily[];
  model:
    | "direct-orderbook"
    | "constant-product"
    | "weighted-constant-mean"
    | "stableswap"
    | "measured-quote"
    | "curve-stableswap-retained"
    | "amm-tvl-proxy"
    | "synthetic-fallback";
  tokenIdentity: CapabilityLevel;
  exactBalancesOrReserves: CapabilityLevel;
  poolInvariantParameters: CapabilityLevel;
  outputIdentity: CapabilityLevel;
  fees: CapabilityLevel;
  observationTime: "producer-run" | "source-observed" | "absent";
  outputEvidenceKind: DexRouteEvidenceKind;
  confidence: ExitRouteConfidence;
  outputKinds: readonly ExitRouteOutput["kind"][];
  commonModeKeyKinds: readonly string[];
  scoreEligible: boolean;
  limitations: readonly string[];
}

/**
 * Audited capabilities of the pool fields that survive dedupe and shaping.
 * This intentionally describes retained evidence, not upstream capabilities.
 */
export const DEX_ROUTE_SOURCE_CAPABILITIES: readonly DexRouteSourceCapability[] = [
  {
    id: "quoter-v2-measured-exact",
    sourceFamilies: ["dl", "direct_api"],
    model: "measured-quote",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "absent",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "exact",
    observationTime: "source-observed",
    outputEvidenceKind: "measured-executable-depth",
    confidence: "high",
    outputKinds: ["tracked-stablecoin", "collateral"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: true,
    limitations: [
      "Activated only for consumer-validated Uniswap V3, PancakeSwap V3, and Aerodrome Slipstream QuoterV2 profiles.",
    ],
  },
  {
    id: "curve-cryptoswap-measured-exact",
    sourceFamilies: ["dl"],
    model: "measured-quote",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "absent",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "exact",
    observationTime: "source-observed",
    outputEvidenceKind: "measured-executable-depth",
    confidence: "high",
    outputKinds: ["tracked-stablecoin", "collateral"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: true,
    limitations: [
      "Activated only for consumer-validated Curve CryptoSwap get_dy profiles from the pinned active pool registry.",
    ],
  },
  {
    id: "curve-stableswap-main-registry-measured-exact",
    sourceFamilies: ["dl"],
    model: "measured-quote",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "absent",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "exact",
    observationTime: "source-observed",
    outputEvidenceKind: "measured-executable-depth",
    confidence: "high",
    outputKinds: ["tracked-stablecoin"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: true,
    limitations: [
      "Activated only for the reviewed Ethereum Curve 3pool after pool and main-registry provenance validation.",
      "High confidence requires three complete producer cycles and three successful observations.",
    ],
  },
  {
    id: "curve-stableswap-ng-factory-measured-exact",
    sourceFamilies: ["dl"],
    model: "measured-quote",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "absent",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "exact",
    observationTime: "source-observed",
    outputEvidenceKind: "measured-executable-depth",
    confidence: "high",
    outputKinds: ["tracked-stablecoin"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: true,
    limitations: [
      "Activated only for reviewed Ethereum Curve StableSwap-NG factory get_dy pools.",
      "High confidence requires three complete producer cycles and three successful observations.",
    ],
  },
  {
    id: "measured-adapter-shadow",
    sourceFamilies: ["direct_api", "dl"],
    model: "measured-quote",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "absent",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "partial",
    observationTime: "source-observed",
    outputEvidenceKind: "measured-executable-depth",
    confidence: "high",
    outputKinds: ["tracked-stablecoin", "collateral"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: false,
    limitations: ["Shadow-only measured adapters require an activation-pending gate and cannot satisfy completeness."],
  },
  {
    id: "native-measured-exact",
    sourceFamilies: ["direct_api", "dl"],
    model: "measured-quote",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "absent",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "exact",
    observationTime: "source-observed",
    outputEvidenceKind: "measured-executable-depth",
    confidence: "high",
    outputKinds: ["tracked-stablecoin", "collateral"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: true,
    limitations: [
      "Consumed only after the native registry marks the adapter active and the proof-bearing join validates the current target.",
    ],
  },
  {
    id: "raydium-constant-product-exact",
    sourceFamilies: ["direct_api"],
    model: "constant-product",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "exact",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "exact",
    observationTime: "producer-run",
    outputEvidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    outputKinds: ["tracked-stablecoin", "collateral"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: true,
    limitations: [
      "Supports only Raydium standard constant-product pools with complete retained inputs.",
      "Untracked counter-asset reference prices may be pool-implied: derived from the same response's spot price and the other token's direct reference.",
    ],
  },
  {
    id: "evm-v2-constant-product-exact",
    sourceFamilies: ["dl", "cg_onchain", "gecko_terminal", "dexscreener", "direct_api"],
    model: "constant-product",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "exact",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "exact",
    observationTime: "producer-run",
    outputEvidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    outputKinds: ["tracked-stablecoin", "collateral"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: true,
    limitations: [
      "Supports factory-verified Uniswap V2 pools on Ethereum, PancakeSwap V2 pools on BSC, and classic Aerodrome volatile pools on Base.",
      "Aerodrome requires the reviewed factory and implementation runtimes, exact volatile factory binding, an unpaused factory, and the same-block per-pool fee.",
      "Untracked counter-asset reference prices are pool-implied from same-block reserves and the tracked input's market price.",
    ],
  },
  {
    id: "balancer-weighted-constant-mean-exact",
    sourceFamilies: ["direct_api"],
    model: "weighted-constant-mean",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "exact",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "exact",
    observationTime: "producer-run",
    outputEvidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    outputKinds: ["tracked-stablecoin", "collateral"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: true,
    limitations: ["Requires complete positive normalized weights and supports direct token-to-token swaps only."],
  },
  {
    id: "curve-stableswap-exact",
    sourceFamilies: ["dl"],
    model: "stableswap",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "exact",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "partial",
    observationTime: "producer-run",
    outputEvidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    outputKinds: ["tracked-stablecoin", "collateral"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: true,
    limitations: [
      "Requires exact per-token balances, decimals, addresses, and the pool amplification coefficient.",
      "The source does not publish per-pool fees; the model carries a documented conservative fee bound, so capacity is an exact lower bound.",
      "Plain StableSwap pools only; metapools are excluded at capture.",
    ],
  },
  {
    id: "balancer-stableswap-exact",
    sourceFamilies: ["direct_api"],
    model: "stableswap",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "exact",
    poolInvariantParameters: "exact",
    outputIdentity: "exact",
    fees: "exact",
    observationTime: "producer-run",
    outputEvidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    outputKinds: ["tracked-stablecoin", "collateral"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "token"],
    scoreEligible: true,
    limitations: [
      "Requires exact per-token balances, decimals, addresses, rate-provider price rates, and the pool amplification.",
      "Hook-free stable-math pools with reviewed rate providers only; the phantom BPT of composable pools is excluded from the model.",
      "Balances are rate-scaled and the amplification is converted to the plain paper convention before simulation.",
      "Amp ramps and rate-cache refresh between producer runs bound residual error: ramps are protocol-capped at 2x/day and measured expired-cache drift was +0.09%.",
    ],
  },
  {
    id: "cg-tickers-orderbook-depth-2pct",
    sourceFamilies: ["cg_tickers"],
    model: "direct-orderbook",
    tokenIdentity: "exact",
    exactBalancesOrReserves: "absent",
    poolInvariantParameters: "absent",
    outputIdentity: "exact",
    fees: "absent",
    observationTime: "producer-run",
    outputEvidenceKind: "direct-orderbook-depth",
    confidence: "medium",
    outputKinds: ["fiat"],
    commonModeKeyKinds: ["venue", "protocol", "pool", "fiat"],
    scoreEligible: false,
    limitations: [
      "Retained depth supports only the source's 2% cost bound.",
      "This narrow CEX diagnostic is not eligible for Safety Score consumption.",
    ],
  },
  {
    id: "curve-stableswap-shaped",
    sourceFamilies: ["dl"],
    model: "curve-stableswap-retained",
    tokenIdentity: "symbol-only",
    exactBalancesOrReserves: "partial",
    poolInvariantParameters: "partial",
    outputIdentity: "symbol-only",
    fees: "absent",
    observationTime: "producer-run",
    outputEvidenceKind: "generic-tvl-proxy",
    confidence: "low",
    outputKinds: ["tracked-stablecoin", "collateral", "unresolved-asset", "unresolved-basket", "unknown"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "asset-symbol"],
    scoreEligible: false,
    limitations: [
      "Shaping retains balance percentages and amplification, but not exact balances, decimals, fees, or canonical output IDs.",
      "Reserve-based execution simulation is therefore unsupported after shaping.",
    ],
  },
  {
    id: "direct-api-amm-shaped",
    sourceFamilies: ["direct_api"],
    model: "amm-tvl-proxy",
    tokenIdentity: "symbol-only",
    exactBalancesOrReserves: "partial",
    poolInvariantParameters: "absent",
    outputIdentity: "symbol-only",
    fees: "partial",
    observationTime: "producer-run",
    outputEvidenceKind: "generic-tvl-proxy",
    confidence: "low",
    outputKinds: ["tracked-stablecoin", "collateral", "unresolved-asset", "unresolved-basket", "unknown"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset", "asset-symbol"],
    scoreEligible: false,
    limitations: ["Concentrated ranges, invariant parameters, and canonical output IDs are not retained."],
  },
  {
    id: "defillama-pool-shaped",
    sourceFamilies: ["dl"],
    model: "amm-tvl-proxy",
    tokenIdentity: "symbol-only",
    exactBalancesOrReserves: "aggregate-only",
    poolInvariantParameters: "absent",
    outputIdentity: "symbol-only",
    fees: "partial",
    observationTime: "producer-run",
    outputEvidenceKind: "generic-tvl-proxy",
    confidence: "low",
    outputKinds: ["unresolved-asset", "unresolved-basket", "unknown"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset-symbol"],
    scoreEligible: false,
    limitations: ["Aggregate TVL cannot prove executable depth."],
  },
  {
    id: "discovery-pool-shaped",
    sourceFamilies: ["cg_onchain", "gecko_terminal", "dexscreener"],
    model: "amm-tvl-proxy",
    tokenIdentity: "symbol-only",
    exactBalancesOrReserves: "aggregate-only",
    poolInvariantParameters: "absent",
    outputIdentity: "symbol-only",
    fees: "partial",
    observationTime: "producer-run",
    outputEvidenceKind: "generic-tvl-proxy",
    confidence: "low",
    outputKinds: ["unresolved-asset", "unresolved-basket", "unknown"],
    commonModeKeyKinds: ["chain", "protocol", "pool", "asset-symbol"],
    scoreEligible: false,
    limitations: ["Aggregate reserve or TVL rows do not retain an executable pool model."],
  },
  {
    id: "synthetic-or-fallback-shaped",
    sourceFamilies: ["cg_onchain", "gecko_terminal", "dexscreener", "cg_tickers", "direct_api", "dl"],
    model: "synthetic-fallback",
    tokenIdentity: "symbol-only",
    exactBalancesOrReserves: "absent",
    poolInvariantParameters: "absent",
    outputIdentity: "symbol-only",
    fees: "absent",
    observationTime: "producer-run",
    outputEvidenceKind: "synthetic-or-fallback",
    confidence: "low",
    outputKinds: ["fiat", "unresolved-asset", "unresolved-basket", "unknown"],
    commonModeKeyKinds: ["chain", "venue", "protocol", "pool", "fiat", "asset-symbol"],
    scoreEligible: false,
    limitations: ["Synthetic or fallback TVL is not measured executable depth."],
  },
];

export interface P4DexRoutePoolInput {
  poolId: string;
  project: string;
  chain: string;
  tvlUsd: number;
  symbol: string;
  poolType: string;
  source: LiquidityPoolSourceFamily;
  extra?: {
    amplificationCoefficient?: number;
    balanceDetails?: Array<{
      symbol: string;
      balancePct: number;
      isTracked: boolean;
    }>;
    orderbookDepthUsd?: number;
    measurement?: {
      synthetic?: boolean;
    };
    executionCapabilityGate?: DexExecutionCapabilityGate;
    ammExecutionModel?: DexAmmExecutionModel;
    measuredExecution?: DexMeasuredExecutionPublicProfile;
    measuredExecutions?: DexMeasuredExecutionPublicProfile[];
    measuredExecutionPhysicalPoolId?: string;
    nativeMeasuredExecution?: NativeMeasuredExecutionPublicProfile;
    nativeMeasuredExecutionPhysicalPoolId?: string;
  };
}

export interface P4DexRouteObservationResult {
  observations: ExitRouteObservation[];
  coverage: ExitRouteObservationCoverage;
}

/**
 * Exact-route scoring may replace the aggregate DEX path only when every
 * retained pool with a reviewed score-eligible capability produced an
 * observation. Shaped evidence that can never be executable remains visible
 * in diagnostics but is not part of an impossible completeness denominator.
 * Malformed or gated exact-capability pools stay in the denominator and fail
 * it closed.
 */
export function isDexExitRouteCoverageComplete(coverage: ExitRouteObservationCoverage | null | undefined): boolean {
  if (
    coverage?.status !== "populated" ||
    coverage.capabilityMatrixVersion !== DEX_ROUTE_CAPABILITY_MATRIX_VERSION ||
    coverage.scoreEligiblePoolCount == null ||
    coverage.scoreEligibleCapabilityPoolCount == null
  )
    return false;

  return (
    coverage.scoreEligibleCapabilityPoolCount > 0 &&
    coverage.scoreEligibleCapabilityPoolCount <= coverage.retainedPoolCount &&
    coverage.scoreEligiblePoolCount === coverage.scoreEligibleCapabilityPoolCount
  );
}

const MEASURED_QUOTE_FAILED_REASON = "executionCapabilityGate:measured-execution:quote-failed";

/**
 * Capability-pool counts that do not belong in the gap-accounting denominator
 * after the 2026-08-13 budget ruling: payload-budget omissions plus every
 * execution-capability gate except a measured `quote-failed`. Construction
 * failures (`target-unresolved`, `quote-missing`, incomplete exact captures),
 * quote-budget deferrals, shadow `activation-pending` rows, and reviewed
 * model limits (rate-bearing, unsupported invariant, metapool, paused) are
 * not missing budgeted observations. `quote-failed` stays in the denominator
 * unless the public observation bound is already saturated below.
 */
function carvedRouteBudgetCapabilityCount(coverage: ExitRouteObservationCoverage): number {
  const overflow = coverage.unsupportedReasons["routeObservationPayloadOverflow"] ?? 0;
  let gated = 0;
  for (const [reason, count] of Object.entries(coverage.unsupportedReasons)) {
    if (!reason.startsWith("executionCapabilityGate:")) continue;
    if (reason === MEASURED_QUOTE_FAILED_REASON) continue;
    gated += count;
  }
  return overflow + gated;
}

/**
 * Completeness for GAP ACCOUNTING only (owner rulings 2026-07-27 and
 * 2026-08-13): capability pools omitted solely by the bounded route-selection
 * budget are excluded from the completeness denominator — a surface whose
 * every budget-admitted capability pool carries a score-eligible observation
 * is fully covered by design, and the overflow count remains visible as
 * diagnostics in `unsupportedReasons.routeObservationPayloadOverflow` — the
 * key the sync-dex-liquidity payload-budget trim actually emits. Exact-route
 * SCORING eligibility keeps the strict predicate above: route-budget
 * completeness must never widen which portfolios may replace the aggregate
 * DEX path.
 *
 * Construction failures and reviewed model limits are carved on the same
 * ground as `budget-deferred`: they never entered the admitted observation
 * set. A surface that already published `MAX_DEX_EXIT_ROUTE_OBSERVATIONS`
 * score-eligible routes with leftover overflow is complete even when a few
 * non-admitted `quote-failed` attempts remain; `quote-failed` still fails
 * closed when the public bound is not full.
 */
export function isDexExitRouteCoverageWithinRouteBudget(
  coverage: ExitRouteObservationCoverage | null | undefined,
): boolean {
  if (
    coverage?.status !== "populated" ||
    coverage.capabilityMatrixVersion !== DEX_ROUTE_CAPABILITY_MATRIX_VERSION ||
    coverage.scoreEligiblePoolCount == null ||
    coverage.scoreEligibleCapabilityPoolCount == null
  )
    return false;

  const selectionOverflowCount = coverage.unsupportedReasons["routeObservationPayloadOverflow"] ?? 0;
  const budgetCapabilityPoolCount =
    coverage.scoreEligibleCapabilityPoolCount - carvedRouteBudgetCapabilityCount(coverage);
  if (
    coverage.scoreEligiblePoolCount <= 0 ||
    budgetCapabilityPoolCount <= 0 ||
    budgetCapabilityPoolCount > coverage.retainedPoolCount
  ) {
    return false;
  }
  if (coverage.scoreEligiblePoolCount === budgetCapabilityPoolCount) return true;
  return (
    coverage.scoreEligiblePoolCount >= MAX_DEX_EXIT_ROUTE_OBSERVATIONS &&
    selectionOverflowCount > 0 &&
    coverage.scoreEligiblePoolCount <= budgetCapabilityPoolCount
  );
}

function roundUsd(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

function normalizedKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function outputFromPool(pool: P4DexRoutePoolInput): ExitRouteOutput {
  if (pool.poolType === "orderbook") {
    return { kind: "fiat", currency: "USD" };
  }
  return { kind: "unknown" };
}

function capabilityById(id: string): DexRouteSourceCapability {
  const capability = DEX_ROUTE_SOURCE_CAPABILITIES.find((entry) => entry.id === id);
  if (!capability) throw new Error(`Missing DEX route capability: ${id}`);
  return capability;
}

function measuredExecutionProfilesForPool(
  pool: P4DexRoutePoolInput,
): P4MeasuredExecutionPublicProfile[] {
  const profiles: P4MeasuredExecutionPublicProfile[] = [
    ...(pool.extra?.measuredExecutions ?? []),
    ...(pool.extra?.measuredExecution ? [pool.extra.measuredExecution] : []),
  ];
  if (pool.extra?.nativeMeasuredExecution) profiles.push(pool.extra.nativeMeasuredExecution);
  return profiles;
}

function observationHistoryForProfile(
  profile: P4MeasuredExecutionPublicProfile,
): DexMeasuredExecutionObservationHistory | undefined {
  return "observationHistory" in profile ? profile.observationHistory : undefined;
}

function isNativeMeasuredExecutionAdapter(adapterProfileId: string): boolean {
  return (
    adapterProfileId === "raydium-clmm-trade-api-v1" ||
    adapterProfileId === "orca-whirlpool-jupiter-v1" ||
    adapterProfileId === "sunswap-v2-router-v1"
  );
}

function isQuoterV2MeasuredExecutionAdapter(adapterProfileId: string): boolean {
  return (
    adapterProfileId === "uniswap-v3-quoter-v2" ||
    adapterProfileId === "pancakeswap-v3-quoter-v2" ||
    adapterProfileId === "aerodrome-slipstream-quoter-v2"
  );
}

function capabilityForPool(
  pool: P4DexRoutePoolInput,
  options: { ignoreMeasured?: boolean } = {},
): DexRouteSourceCapability {
  const measuredProfile = options.ignoreMeasured
    ? undefined
    : measuredExecutionProfilesForPool(pool)[0];
  if (measuredProfile) {
    return capabilityById(
      isNativeMeasuredExecutionAdapter(measuredProfile.adapterProfileId)
        ? "native-measured-exact"
        : isQuoterV2MeasuredExecutionAdapter(measuredProfile.adapterProfileId)
        ? "quoter-v2-measured-exact"
        : measuredProfile.adapterProfileId === "curve-cryptoswap-get-dy-v1"
          ? "curve-cryptoswap-measured-exact"
        : measuredProfile.adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID
          ? "curve-stableswap-main-registry-measured-exact"
        : measuredProfile.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID
          ? "curve-stableswap-ng-factory-measured-exact"
        : "measured-adapter-shadow",
    );
  }
  if (
    pool.poolType === "orderbook" &&
    pool.source === "cg_tickers" &&
    pool.extra?.orderbookDepthUsd != null &&
    pool.extra.orderbookDepthUsd > 0
  ) {
    return capabilityById("cg-tickers-orderbook-depth-2pct");
  }
  if (pool.extra?.ammExecutionModel?.invariant === "constant-product") {
    return capabilityById(
      pool.extra.ammExecutionModel.source === "raydium"
        ? "raydium-constant-product-exact"
        : "evm-v2-constant-product-exact",
    );
  }
  if (pool.extra?.ammExecutionModel?.invariant === "weighted-constant-mean") {
    return capabilityById("balancer-weighted-constant-mean-exact");
  }
  if (pool.extra?.ammExecutionModel?.invariant === "stableswap") {
    return capabilityById(
      pool.extra.ammExecutionModel.source === "balancer" ? "balancer-stableswap-exact" : "curve-stableswap-exact",
    );
  }
  if (pool.extra?.measurement?.synthetic === true) {
    return capabilityById("synthetic-or-fallback-shaped");
  }
  if (
    pool.source === "dl" &&
    pool.poolType === "curve-stableswap" &&
    pool.extra?.amplificationCoefficient != null &&
    (pool.extra.balanceDetails?.length ?? 0) > 1
  ) {
    return capabilityById("curve-stableswap-shaped");
  }
  if (pool.source === "direct_api") return capabilityById("direct-api-amm-shaped");
  if (pool.source === "dl") return capabilityById("defillama-pool-shaped");
  return capabilityById("discovery-pool-shaped");
}

function requiresP4DexScoreEligibleCapabilityCoverage(pool: P4DexRoutePoolInput): boolean {
  if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd <= 0 || !pool.poolId || !pool.project || !pool.chain) return true;
  if (pool.extra?.executionCapabilityGate != null) return true;
  const capability = capabilityForPool(pool);
  if (capability.scoreEligible) return true;
  return (
    measuredExecutionProfilesForPool(pool).length > 0
  ) && pool.extra?.ammExecutionModel == null;
}

function buildCapacityPoint(
  requestedNotionalUsd: number,
  maxCostBps: number,
  capacityUsd: number,
): ExitRouteCapacityPoint {
  const executableUsd = roundUsd(Math.min(requestedNotionalUsd, Math.max(0, capacityUsd)));
  return {
    requestedNotionalUsd,
    maxCostBps,
    executableUsd,
    completionRatio: roundRatio(executableUsd / requestedNotionalUsd),
  };
}

function buildCapacityCurve(
  pool: P4DexRoutePoolInput,
  capability: DexRouteSourceCapability,
): ExitRouteCapacityPoint[] | null {
  if (capability.model === "direct-orderbook") {
    const capacityUsd = pool.extra?.orderbookDepthUsd ?? 0;
    return DEFAULT_NOTIONALS_USD.map((notional) => buildCapacityPoint(notional, REFERENCE_COST_BPS, capacityUsd));
  }
  return null;
}

function validateMeasuredExecutionProfile(
  profile: P4MeasuredExecutionPublicProfile,
  context: { pool: P4DexRoutePoolInput; stablecoinId: string; observedAt: number },
): string[] {
  const issues: string[] = [];
  const isNative = isNativeMeasuredExecutionAdapter(profile.adapterProfileId);
  const schemaValid =
    profile.adapterProfileId === "raydium-clmm-trade-api-v1" ||
    profile.adapterProfileId === "orca-whirlpool-jupiter-v1"
      ? SolanaMeasuredExecutionPublicProfileSchema.safeParse(profile).success
      : profile.adapterProfileId === "sunswap-v2-router-v1"
        ? TronMeasuredExecutionPublicProfileSchema.safeParse(profile).success
        : DexMeasuredExecutionPublicProfileSchema.safeParse(profile).success;
  if (!schemaValid) issues.push("invalid-profile-schema");
  if (!isNative) {
    if (
      !isQuoterV2MeasuredExecutionAdapter(profile.adapterProfileId) &&
      profile.adapterProfileId !== "curve-cryptoswap-get-dy-v1" &&
      profile.adapterProfileId !== CURVE_STABLESWAP_ADAPTER_PROFILE_ID &&
      profile.adapterProfileId !== CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID
    ) {
      issues.push("adapter-not-score-eligible");
    }
  }
  const projectKey = normalizedKey(context.pool.project);
  const profileProtocolKey = normalizedKey(profile.protocol);
  const protocolMatches =
    profile.adapterProfileId === "sunswap-v2-router-v1"
      ? projectKey === "sunswap" || projectKey === "sunswap-v2"
      : profile.adapterProfileId === "aerodrome-slipstream-quoter-v2"
        ? profileProtocolKey === "aerodrome-slipstream" &&
          (projectKey === "aerodrome" || projectKey === "aerodrome-slipstream")
        : profileProtocolKey === projectKey;
  if (
    canonicalExitRouteChain(profile.chain) !== canonicalExitRouteChain(context.pool.chain) ||
    !protocolMatches
  ) issues.push("pool-identity-mismatch");
  if (
    (
      profile.adapterProfileId === "raydium-clmm-trade-api-v1" ||
      profile.adapterProfileId === "orca-whirlpool-jupiter-v1"
    ) &&
    (
      !("poolType" in profile) ||
      (profile.adapterProfileId === "raydium-clmm-trade-api-v1" &&
        (profile.protocol !== "raydium" || profile.poolType !== "raydium-clmm")) ||
      (profile.adapterProfileId === "orca-whirlpool-jupiter-v1" &&
        (profile.protocol !== "orca" || profile.poolType !== "orca-whirlpool"))
    )
  ) issues.push("adapter-identity-mismatch");
  const measuredPhysicalPoolId = isNative
    ? context.pool.extra?.nativeMeasuredExecutionPhysicalPoolId
    : context.pool.extra?.measuredExecutionPhysicalPoolId;
  if (
    !measuredPhysicalPoolId ||
    canonicalExitRouteScopedKey(profile.chain, profile.poolId) !==
      canonicalExitRouteScopedKey(context.pool.chain, measuredPhysicalPoolId)
  )
    issues.push("retained-physical-pool-mismatch");
  if (profile.tokenIn.trackedAssetId !== context.stablecoinId) issues.push("tracked-input-mismatch");
  if (profile.tokenOut.trackedAssetId === context.stablecoinId) issues.push("self-output-asset");
  if (!isNative && profile.adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID) {
    const evmProfile = profile as DexMeasuredExecutionPublicProfile;
    if (
      evmProfile.chain !== "ethereum" ||
      evmProfile.poolId !== canonicalExitRouteAssetKey("ethereum", CURVE_3POOL_ADDRESS) ||
      evmProfile.poolTokenAddresses?.length !== CURVE_3POOL_TOKEN_ADDRESSES.length ||
      evmProfile.poolTokenAddresses.some((address, index) => address !== CURVE_3POOL_TOKEN_ADDRESSES[index])
    ) issues.push("invalid-curve-stableswap-identity");
    const provenance = evmProfile.registryProvenance;
    if (
      provenance == null ||
      provenance.registryAddress !== CURVE_MAIN_REGISTRY_ADDRESS ||
      provenance.registryCodeHash !== CURVE_MAIN_REGISTRY_CODE_HASH ||
      provenance.registeredPoolAddress !== CURVE_3POOL_ADDRESS ||
      provenance.lpTokenAddress !== CURVE_3POOL_LP_TOKEN ||
      provenance.poolTokenAddresses.length !== CURVE_3POOL_TOKEN_ADDRESSES.length ||
      provenance.poolTokenAddresses.some((address, index) => address !== CURVE_3POOL_TOKEN_ADDRESSES[index])
    ) issues.push("physical-pool-provenance-mismatch");
  } else if (!isNative && profile.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID) {
    const evmProfile = profile as DexMeasuredExecutionPublicProfile;
    const policy = reviewedCurveStableSwapNgPolicyForProfile(evmProfile);
    if (
      !policy ||
      evmProfile.chain !== policy.chain ||
      evmProfile.poolId !== canonicalExitRouteAssetKey(policy.chain, policy.poolAddress) ||
      evmProfile.poolTokenAddresses?.length !== policy.poolTokenAddresses.length ||
      evmProfile.poolTokenAddresses.some(
        (address, index) => address !== policy.poolTokenAddresses[index],
      ) ||
      evmProfile.tokenIn.address !== policy.tokenInAddress ||
      evmProfile.tokenOut.address !== policy.tokenOutAddress ||
      evmProfile.tokenIn.trackedAssetId !== policy.stablecoinId
    ) issues.push("invalid-curve-stableswap-ng-identity");
    const provenance = evmProfile.stableSwapNgFactoryProvenance;
    if (
      !policy ||
      provenance == null ||
      provenance.blockNumber !== evmProfile.blockNumber ||
      !/^0x[0-9a-f]{64}$/.test(provenance.blockHash) ||
      provenance.blockCommitment !== "finalized" ||
      provenance.factoryAddress !== policy.factoryAddress ||
      provenance.factoryCodeHash !== policy.factoryCodeHash ||
      provenance.poolIndex !== policy.factoryPoolIndex ||
      provenance.registeredPoolAddress !== policy.poolAddress ||
      provenance.poolTokenAddresses.length !== policy.poolTokenAddresses.length ||
      provenance.poolTokenAddresses.some(
        (address, index) => address !== policy.poolTokenAddresses[index],
      )
    ) issues.push("physical-pool-provenance-mismatch");
  } else if (!isNative) {
    const evmProfile = profile as DexMeasuredExecutionPublicProfile;
    if (evmProfile.poolTokenAddresses?.length !== 2) issues.push("invalid-cl-token-count");
    if (
      evmProfile.poolProvenance == null ||
      canonicalExitRouteAssetKey(evmProfile.chain, evmProfile.poolProvenance.resolvedPoolAddress) !==
        evmProfile.poolId
    ) issues.push("physical-pool-provenance-mismatch");
  }
  if (
    context.observedAt - profile.quotedAt >
    getDexMeasuredExecutionFreshnessMaxSec(profile.adapterProfileId)
  ) issues.push("stale-profile");
  if (profile.quotedAt > context.observedAt + 60) issues.push("future-profile");
  if (
    !Number.isFinite(profile.retainedTvlUsdAtQuote) ||
    Math.abs(profile.retainedTvlUsdAtQuote / context.pool.tvlUsd - 1) > 0.2
  )
    issues.push("retained-tvl-mismatch");
  if (profile.capacityCurve.some((point) => point.executableUsd > context.pool.tvlUsd * 1.5 + 0.01)) {
    issues.push("capacity-above-retained-tvl-bound");
  }
  if (profile.marginalOutputRatio < 0.98 && profile.capacityCurve.some((point) => point.executableUsd > 0)) {
    issues.push("marginal-failure-with-positive-capacity");
  }
  issues.push(...validateExitRouteCapacityCurve(profile.capacityCurve));
  const history = observationHistoryForProfile(profile);
  if (history) {
    const currentByPoint = new Map(
      profile.capacityCurve.map((point) => [`${point.requestedNotionalUsd}:${point.maxCostBps}`, point] as const),
    );
    if (history.observationWindowEndedAt < profile.quotedAt) issues.push("history-before-selected-quote");
    if (history.observationWindowEndedAt > context.observedAt + 60) issues.push("future-history");
    for (const point of history.conservativeCapacityCurve) {
      const current = currentByPoint.get(`${point.requestedNotionalUsd}:${point.maxCostBps}`);
      if (!current || point.executableUsd > current.executableUsd + 0.01) {
        issues.push("invalid-conservative-history");
        break;
      }
    }
    issues.push(
      ...validateExitRouteCapacityCurve(history.conservativeCapacityCurve).map(
        (issue) => `invalid-conservative-history:${issue}`,
      ),
    );
  }
  return [...new Set(issues)];
}

function isCompleteCurveStableSwapDirectionPacket(
  profiles: readonly P4MeasuredExecutionPublicProfile[],
): boolean {
  if (profiles.length !== 2) return false;
  const inputAddress = profiles[0]?.tokenIn.address;
  if (!inputAddress || !CURVE_3POOL_TOKEN_ADDRESSES.includes(inputAddress as typeof CURVE_3POOL_TOKEN_ADDRESSES[number])) {
    return false;
  }
  const expectedOutputs = CURVE_3POOL_TOKEN_ADDRESSES.filter((address) => address !== inputAddress).sort();
  const actualOutputs = profiles.map((profile) => profile.tokenOut.address).sort();
  return (
    new Set(profiles.map((profile) => profile.tokenIn.address)).size === 1 &&
    actualOutputs.length === expectedOutputs.length &&
    actualOutputs.every((address, index) => address === expectedOutputs[index])
  );
}

function validateAmmExecutionModel(
  model: DexAmmExecutionModel,
  context: { chain: string; stablecoinId: string; retainedTvlUsd: number },
): string[] {
  const issues: string[] = [];
  if (
    !Number.isInteger(model.trackedTokenIndex) ||
    model.trackedTokenIndex < 0 ||
    model.trackedTokenIndex >= model.tokens.length
  ) {
    issues.push("invalid-tracked-token-index");
  }
  if (!Number.isFinite(model.feeRate) || model.feeRate < 0 || model.feeRate >= 1) issues.push("invalid-fee");
  if (model.tokens.length < 2 || model.tokens.length > 8) issues.push("invalid-token-count");
  const identities = new Set<string>();
  for (const token of model.tokens) {
    if (!token.address?.trim() || !token.symbol?.trim()) issues.push("missing-token-identity");
    const identity = canonicalExitRouteScopedId(context.chain, token.address);
    if (identities.has(identity)) issues.push("duplicate-token-identity");
    identities.add(identity);
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255)
      issues.push("invalid-decimals");
    if (!Number.isFinite(token.balance) || token.balance <= 0) issues.push("invalid-balance");
    if (!Number.isFinite(token.referencePriceUsd) || token.referencePriceUsd <= 0)
      issues.push("invalid-reference-price");
  }
  const trackedToken = model.tokens[model.trackedTokenIndex];
  if (trackedToken && trackedToken.trackedAssetId !== context.stablecoinId) {
    issues.push("tracked-input-stablecoin-mismatch");
  }
  const modeledTvlUsd = model.tokens.reduce((total, token) => total + token.balance * token.referencePriceUsd, 0);
  if (Number.isFinite(modeledTvlUsd) && modeledTvlUsd > 0) {
    const modeledTvlRatio = modeledTvlUsd / context.retainedTvlUsd;
    if (modeledTvlRatio < P4_AMM_MODELED_TVL_MIN_RATIO) issues.push("modeled-tvl-below-retained-bound");
    if (modeledTvlRatio > P4_AMM_MODELED_TVL_MAX_RATIO) issues.push("modeled-tvl-above-retained-bound");
  }
  if (model.invariant === "constant-product") {
    if (
      !["raydium", "uniswap-v2", "pancakeswap-v2", "aerodrome-volatile"].includes(model.source) ||
      model.tokens.length !== 2
    ) {
      issues.push("invalid-constant-product-model");
    }
  } else if (model.invariant === "stableswap") {
    if (model.source !== "curve" && model.source !== "balancer") issues.push("invalid-stableswap-model-source");
    if (model.amplification == null || !Number.isFinite(model.amplification) || model.amplification <= 0) {
      issues.push("invalid-amplification");
    }
  } else {
    if (model.source !== "balancer") issues.push("invalid-weighted-model-source");
    const weights = model.tokens.map((token) => token.weight);
    if (weights.some((weight) => weight == null || !Number.isFinite(weight) || weight <= 0)) {
      issues.push("invalid-weights");
    } else {
      const sum = (weights as number[]).reduce((total, weight) => total + weight, 0);
      if (Math.abs(sum - 1) > 0.0001) issues.push("invalid-weight-sum");
    }
  }
  return [...new Set(issues)];
}

/** StableSwap invariant D for balances x under amplification A (plain paper convention). */
function stableswapInvariantD(balances: readonly number[], amplification: number): number {
  const n = balances.length;
  const sum = balances.reduce((total, balance) => total + balance, 0);
  if (sum <= 0) return 0;
  const ann = amplification * n ** n;
  let d = sum;
  for (let iteration = 0; iteration < 256; iteration++) {
    let dProduct = d;
    for (const balance of balances) dProduct = (dProduct * d) / (balance * n);
    const previous = d;
    d = ((ann * sum + dProduct * n) * d) / ((ann - 1) * d + (n + 1) * dProduct);
    if (Math.abs(d - previous) <= 1e-10 * d) return d;
  }
  return d;
}

/** Output-token balance that keeps the invariant after the input balance moves to newInputBalance. */
function stableswapOutputBalance(
  balances: readonly number[],
  inputIndex: number,
  outputIndex: number,
  newInputBalance: number,
  amplification: number,
): number {
  const n = balances.length;
  const d = stableswapInvariantD(balances, amplification);
  const ann = amplification * n ** n;
  let c = d;
  let sum = 0;
  for (let index = 0; index < n; index++) {
    if (index === outputIndex) continue;
    const balance = index === inputIndex ? newInputBalance : balances[index]!;
    sum += balance;
    c = (c * d) / (balance * n);
  }
  c = (c * d) / (ann * n);
  const b = sum + d / ann;
  let y = d;
  for (let iteration = 0; iteration < 256; iteration++) {
    const previous = y;
    y = (y * y + c) / (2 * y + b - d);
    if (Math.abs(y - previous) <= 1e-10 * Math.max(1, y)) return y;
  }
  return y;
}

function simulateAmmOutput(model: DexAmmExecutionModel, outputTokenIndex: number, inputAmount: number): number {
  const input = model.tokens[model.trackedTokenIndex]!;
  const output = model.tokens[outputTokenIndex]!;
  const effectiveInput = inputAmount * (1 - model.feeRate);
  if (!Number.isFinite(effectiveInput) || effectiveInput <= 0) return 0;

  if (model.invariant === "constant-product") {
    return (output.balance * effectiveInput) / (input.balance + effectiveInput);
  }

  if (model.invariant === "stableswap") {
    const balances = model.tokens.map((token) => token.balance);
    // Curve StableSwap/NG evaluates its invariant on the full input, then
    // deducts the (static) fee from output. Other modeled StableSwap sources
    // charge against input. Treating Curve as input-fee is optimistic because
    // its concave curve produces more than (1 - fee) of the full-input output.
    const invariantInput = model.source === "curve" ? inputAmount : effectiveInput;
    const newOutputBalance = stableswapOutputBalance(
      balances,
      model.trackedTokenIndex,
      outputTokenIndex,
      input.balance + invariantInput,
      model.amplification!,
    );
    const grossOutput = output.balance - newOutputBalance;
    return Math.max(0, model.source === "curve" ? grossOutput * (1 - model.feeRate) : grossOutput);
  }

  const inputWeight = input.weight!;
  const outputWeight = output.weight!;
  const balanceRatio = input.balance / (input.balance + effectiveInput);
  return output.balance * (1 - balanceRatio ** (inputWeight / outputWeight));
}

function executableAmmInputUsd(
  model: DexAmmExecutionModel,
  outputTokenIndex: number,
  requestedNotionalUsd: number,
  maxCostBps: number,
): number {
  const input = model.tokens[model.trackedTokenIndex]!;
  const output = model.tokens[outputTokenIndex]!;
  const minimumOutputRatio = Math.max(0, 1 - maxCostBps / 10_000);
  // StableSwap has no simple closed-form spot price; an epsilon trade through
  // the invariant gives the fee-inclusive marginal ratio deterministically.
  const stableswapMarginalRatio = () => {
    const epsilon = Math.max(input.balance * 1e-6, 1e-6);
    const marginalOutput = simulateAmmOutput(model, outputTokenIndex, epsilon);
    return ((marginalOutput / epsilon) * output.referencePriceUsd) / input.referencePriceUsd;
  };
  const marginalOutputRatio =
    model.invariant === "constant-product"
      ? ((output.balance / input.balance) * (1 - model.feeRate) * output.referencePriceUsd) / input.referencePriceUsd
      : model.invariant === "stableswap"
        ? stableswapMarginalRatio()
        : ((output.balance / input.balance) *
            (input.weight! / output.weight!) *
            (1 - model.feeRate) *
            output.referencePriceUsd) /
          input.referencePriceUsd;
  if (!Number.isFinite(marginalOutputRatio) || marginalOutputRatio + 1e-12 < minimumOutputRatio) return 0;

  const qualifies = (inputUsd: number): boolean => {
    if (inputUsd <= 0) return true;
    const inputAmount = inputUsd / input.referencePriceUsd;
    const outputUsd = simulateAmmOutput(model, outputTokenIndex, inputAmount) * output.referencePriceUsd;
    return Number.isFinite(outputUsd) && outputUsd + 0.000001 >= inputUsd * minimumOutputRatio;
  };
  if (qualifies(requestedNotionalUsd)) return requestedNotionalUsd;

  let lower = 0;
  let upper = requestedNotionalUsd;
  for (let iteration = 0; iteration < 64; iteration++) {
    const midpoint = (lower + upper) / 2;
    if (qualifies(midpoint)) lower = midpoint;
    else upper = midpoint;
  }
  return lower;
}

function realizedAmmExecutionCostBps(
  model: DexAmmExecutionModel,
  outputTokenIndex: number,
  requestedNotionalUsd: number,
  executableUsd: number,
  maxCostBps: number,
): number | null {
  if (!Number.isFinite(executableUsd) || executableUsd <= 0) return null;
  const input = model.tokens[model.trackedTokenIndex];
  const output = model.tokens[outputTokenIndex];
  if (!input || !output || !Number.isFinite(input.referencePriceUsd) || input.referencePriceUsd <= 0) return null;
  const inputAmount = executableUsd / input.referencePriceUsd;
  const outputAmount = simulateAmmOutput(model, outputTokenIndex, inputAmount);
  const outputUsd = outputAmount * output.referencePriceUsd;
  if (!Number.isFinite(outputUsd) || outputUsd < 0) return null;
  const realizedCostBps = Math.max(0, (1 - outputUsd / executableUsd) * 10_000);
  if (!Number.isFinite(realizedCostBps) || realizedCostBps > maxCostBps + AMM_EXECUTION_COST_TOLERANCE_BPS) {
    return null;
  }
  if (
    executableUsd + 0.01 < requestedNotionalUsd &&
    realizedCostBps >= maxCostBps - AMM_EXECUTION_COST_TOLERANCE_BPS
  ) {
    return null;
  }
  return Math.round(Math.min(maxCostBps, realizedCostBps) * 1_000_000) / 1_000_000;
}

function buildAmmCapacityCurve(model: DexAmmExecutionModel, outputTokenIndex: number): ExitRouteCapacityPoint[] {
  return DEFAULT_NOTIONALS_USD.map((notional) => {
    const point = buildCapacityPoint(
      notional,
      REFERENCE_COST_BPS,
      executableAmmInputUsd(model, outputTokenIndex, notional, REFERENCE_COST_BPS),
    );
    const executionCostBps = realizedAmmExecutionCostBps(
      model,
      outputTokenIndex,
      point.requestedNotionalUsd,
      point.executableUsd,
      point.maxCostBps,
    );
    return executionCostBps == null ? point : { ...point, executionCostBps };
  });
}

function outputFromAmmToken(
  chain: string,
  token: Pick<DexAmmExecutionToken, "address" | "symbol" | "trackedAssetId">,
): ExitRouteOutput {
  const assetKey = canonicalExitRouteAssetKey(chain, token.address);
  if (token.trackedAssetId) {
    return {
      kind: "tracked-stablecoin",
      trackedAssetIds: [token.trackedAssetId],
      assetKeys: [assetKey],
    };
  }
  return {
    kind: "collateral",
    assetKeys: [assetKey],
    basketWeights: [{ symbol: token.symbol, weight: 1 }],
  };
}

export function validateExitRouteCapacityCurve(points: readonly ExitRouteCapacityPoint[]): string[] {
  const issues: string[] = [];
  const byCost = new Map<number, ExitRouteCapacityPoint[]>();
  const byNotional = new Map<number, ExitRouteCapacityPoint[]>();

  for (const point of points) {
    if (point.executableUsd > point.requestedNotionalUsd + 0.01) {
      issues.push(`executable-exceeds-request:${point.requestedNotionalUsd}:${point.maxCostBps}`);
    }
    const expectedRatio = point.executableUsd / point.requestedNotionalUsd;
    if (Math.abs(expectedRatio - point.completionRatio) > 0.00001) {
      issues.push(`completion-ratio-mismatch:${point.requestedNotionalUsd}:${point.maxCostBps}`);
    }
    byCost.set(point.maxCostBps, [...(byCost.get(point.maxCostBps) ?? []), point]);
    byNotional.set(point.requestedNotionalUsd, [...(byNotional.get(point.requestedNotionalUsd) ?? []), point]);
  }

  for (const [cost, group] of byCost) {
    const sorted = [...group].sort((left, right) => left.requestedNotionalUsd - right.requestedNotionalUsd);
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (current.executableUsd + 0.01 < previous.executableUsd) {
        issues.push(`notional-executable-decreased:${cost}`);
      }
      if (current.completionRatio > previous.completionRatio + 0.00001) {
        issues.push(`notional-completion-increased:${cost}`);
      }
    }
  }

  for (const [notional, group] of byNotional) {
    const sorted = [...group].sort((left, right) => left.maxCostBps - right.maxCostBps);
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (current.executableUsd + 0.01 < previous.executableUsd) {
        issues.push(`cost-executable-decreased:${notional}`);
      }
      if (current.completionRatio + 0.00001 < previous.completionRatio) {
        issues.push(`cost-completion-decreased:${notional}`);
      }
    }
  }

  return issues;
}

function commonModeKeys(pool: P4DexRoutePoolInput, output: ExitRouteOutput): string[] {
  const keys = new Set<string>([
    `protocol:${normalizedKey(pool.project)}`,
    `pool:${canonicalExitRouteScopedKey(pool.chain, pool.poolId)}`,
  ]);
  if (pool.poolType === "orderbook") keys.add(`venue:${normalizedKey(pool.project)}`);
  else keys.add(`chain:${canonicalExitRouteChain(pool.chain)}`);
  if (output.currency) keys.add(`fiat:${normalizedKey(output.currency)}`);
  for (const assetId of output.trackedAssetIds ?? []) keys.add(`asset:${normalizedKey(assetId)}`);
  for (const assetKey of output.assetKeys ?? []) keys.add(`token:${assetKey}`);
  for (const item of output.basketWeights ?? []) {
    if (item.assetId) keys.add(`asset:${normalizedKey(item.assetId)}`);
    else if (item.symbol) keys.add(`asset-symbol:${normalizedKey(item.symbol)}`);
  }
  return [...keys].map(normalizeExitRouteCorrelationKey).filter(Boolean).sort();
}

function buildDexRouteId(parts: readonly string[]): string {
  return `dex:${parts.map(encodeExitRouteIdentityPart).join(":")}`;
}

export function buildP4DexExitRouteObservations(params: {
  stablecoinId: string;
  retainedPools: readonly P4DexRoutePoolInput[];
  observedAt: number;
}): P4DexRouteObservationResult {
  const observations: ExitRouteObservation[] = [];
  const evidenceCounts: Record<string, number> = {};
  const unsupportedReasons: Record<string, number> = {};
  let unsupportedPoolCount = 0;
  let scoreEligiblePoolCount = 0;
  let scoreEligibleCapabilityPoolCount = 0;

  for (const pool of params.retainedPools) {
    if (requiresP4DexScoreEligibleCapabilityCoverage(pool)) scoreEligibleCapabilityPoolCount++;
    if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd <= 0 || !pool.poolId || !pool.project || !pool.chain) {
      // An invalid retained row cannot prove that it belongs to a diagnostic-only
      // capability, so keep it in the executable denominator and fail closed.
      unsupportedPoolCount++;
      unsupportedReasons.invalidRetainedPool = (unsupportedReasons.invalidRetainedPool ?? 0) + 1;
      continue;
    }
    let capability = capabilityForPool(pool);
    const ammModel = pool.extra?.ammExecutionModel;
    const executionCapabilityGate = pool.extra?.executionCapabilityGate;
    if (executionCapabilityGate != null) {
      unsupportedPoolCount++;
      const reason =
        ammModel == null
          ? `executionCapabilityGate:${executionCapabilityGate.family}:${executionCapabilityGate.reason}`
          : "conflictingExecutionCapabilityEvidence";
      unsupportedReasons[reason] = (unsupportedReasons[reason] ?? 0) + 1;
      continue;
    }
    const measuredProfiles = measuredExecutionProfilesForPool(pool);
    if (measuredProfiles.length > 0) {
      const isCurveStableSwapPacket = measuredProfiles.every(
        (profile) => profile.adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
      );
      const isCurveStableSwapNgProfile =
        measuredProfiles.length === 1 &&
        measuredProfiles[0]!.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID;
      const curveStableSwapNgPolicy = isCurveStableSwapNgProfile
        ? reviewedCurveStableSwapNgPolicyForProfile(measuredProfiles[0]!)
        : null;
      if (
        isCurveStableSwapPacket &&
        (
          !isCompleteCurveStableSwapDirectionPacket(measuredProfiles) ||
          (ammModel != null &&
            (ammModel.source !== "curve" || ammModel.invariant !== "stableswap")) ||
          new Set(measuredProfiles.map((profile) => profile.poolId)).size !== 1 ||
          new Set(measuredProfiles.map((profile) => profile.quoteGenerationId)).size !== 1 ||
          new Set(measuredProfiles.map((profile) => "blockNumber" in profile ? profile.blockNumber : null)).size !== 1
        )
      ) {
        unsupportedPoolCount++;
        unsupportedReasons.invalidAtomicMeasuredPacket =
          (unsupportedReasons.invalidAtomicMeasuredPacket ?? 0) + 1;
        continue;
      }
      if (
        isCurveStableSwapNgProfile &&
        (
          curveStableSwapNgPolicy == null ||
          (ammModel != null &&
            (ammModel.source !== "curve" || ammModel.invariant !== "stableswap")) ||
          measuredProfiles[0]!.tokenIn.address !== curveStableSwapNgPolicy.tokenInAddress ||
          measuredProfiles[0]!.tokenOut.address !== curveStableSwapNgPolicy.tokenOutAddress
        )
      ) {
        unsupportedPoolCount++;
        unsupportedReasons.invalidAtomicMeasuredProfile =
          (unsupportedReasons.invalidAtomicMeasuredProfile ?? 0) + 1;
        continue;
      }
      if (
        !isCurveStableSwapPacket &&
        !isCurveStableSwapNgProfile &&
        (ammModel != null || measuredProfiles.length !== 1)
      ) {
        unsupportedPoolCount++;
        unsupportedReasons.conflictingExecutionCapabilityEvidence =
          (unsupportedReasons.conflictingExecutionCapabilityEvidence ?? 0) + 1;
        continue;
      }
      if (!capability.scoreEligible) {
        unsupportedPoolCount++;
        unsupportedReasons.shadowMeasuredProfileWithoutGate =
          (unsupportedReasons.shadowMeasuredProfileWithoutGate ?? 0) + 1;
        continue;
      }
      const profileIssues = measuredProfiles.flatMap((profile) =>
        validateMeasuredExecutionProfile(profile, {
          pool,
          stablecoinId: params.stablecoinId,
          observedAt: params.observedAt,
        })
      );
      if (profileIssues.length > 0) {
        unsupportedPoolCount++;
        for (const issue of profileIssues) {
          const reason = `invalidMeasuredExecution:${issue}`;
          unsupportedReasons[reason] = (unsupportedReasons[reason] ?? 0) + 1;
        }
        continue;
      }
      const measuredRows = measuredProfiles.map((profile) => {
        const capacityCurve =
          observationHistoryForProfile(profile)?.conservativeCapacityCurve ?? profile.capacityCurve;
        const referencePoint = capacityCurve.find(
          (point) =>
            point.requestedNotionalUsd === REFERENCE_NOTIONAL_USD &&
            point.maxCostBps === REFERENCE_COST_BPS,
        );
        return { profile, capacityCurve, referencePoint };
      });
      if (measuredRows.some(({ referencePoint }) => !referencePoint)) {
        unsupportedPoolCount++;
        unsupportedReasons.missingReferencePoint = (unsupportedReasons.missingReferencePoint ?? 0) + 1;
        continue;
      }
      const curveStableSwapMeasuredProfileIsMature =
        (isCurveStableSwapPacket || isCurveStableSwapNgProfile) &&
        measuredRows.every(({ profile }) => {
          const history = observationHistoryForProfile(profile);
          const freshnessMaxSec = getDexMeasuredExecutionFreshnessMaxSec(
            profile.adapterProfileId,
          );
          return (
            history != null &&
            params.observedAt - history.observationWindowEndedAt <= freshnessMaxSec &&
            history.observationWindowEndedAt <= params.observedAt + 60 &&
            history.completeProducerCycleCount >=
              (
                isCurveStableSwapNgProfile
                  ? CURVE_STABLESWAP_NG_MIN_COMPLETE_CYCLES
                  : CURVE_STABLESWAP_MIN_COMPLETE_CYCLES
              ) &&
            history.successfulObservationCount >=
              (
                isCurveStableSwapNgProfile
                  ? CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS
                  : CURVE_STABLESWAP_MIN_SUCCESSFUL_OBSERVATIONS
              )
          );
        });
      if (
        (isCurveStableSwapPacket || isCurveStableSwapNgProfile) &&
        !curveStableSwapMeasuredProfileIsMature
      ) {
        if (ammModel == null) {
          unsupportedPoolCount++;
          unsupportedReasons.immatureAtomicMeasuredPacket =
            (unsupportedReasons.immatureAtomicMeasuredPacket ?? 0) + 1;
          continue;
        }
        capability = capabilityForPool(pool, { ignoreMeasured: true });
      } else {
        for (const { profile, capacityCurve, referencePoint } of measuredRows) {
          const output = outputFromAmmToken(pool.chain, profile.tokenOut);
          const outputIdentity = canonicalExitRouteAssetKey(pool.chain, profile.tokenOut.address);
          const physicalPool = { ...pool, poolId: profile.poolId };
          const observationHistory = observationHistoryForProfile(profile);
          const freshnessMaxSec = getDexMeasuredExecutionFreshnessMaxSec(
            profile.adapterProfileId,
          );
          // The producer bounds every included cycle to its latest complete
          // publication. The selected quote and the summary end must both remain fresh.
          const historyIsFresh =
            observationHistory != null &&
            params.observedAt - observationHistory.observationWindowEndedAt <= freshnessMaxSec &&
            observationHistory.observationWindowEndedAt <= params.observedAt + 60;
          const historyIsMature =
            observationHistory != null &&
            (isCurveStableSwapPacket || isCurveStableSwapNgProfile
              ? curveStableSwapMeasuredProfileIsMature
              : isDexMeasuredExecutionObservationHistoryMature(observationHistory));
          const confidence =
            historyIsFresh && historyIsMature
              ? capability.confidence
              : "medium";
          observations.push({
            routeId: buildDexRouteId([
              normalizedKey(params.stablecoinId),
              normalizedKey(pool.source),
              canonicalExitRouteScopedKey(pool.chain, profile.poolId),
              outputIdentity,
            ]),
            routeFamily: "dex-amm",
            scope: {
              kind: "chain-contract",
              chain: pool.chain,
              contractOrPoolId: profile.poolId,
              protocol: pool.project,
            },
            requestedNotionalUsd: referencePoint!.requestedNotionalUsd,
            settlementHorizonSec: IMMEDIATE_SETTLEMENT_HORIZON_SEC,
            maxCostBps: referencePoint!.maxCostBps,
            executableUsd: referencePoint!.executableUsd,
            completionRatio: referencePoint!.completionRatio,
            output,
            evidenceKind: capability.outputEvidenceKind,
            adapterProfileId: profile.adapterProfileId,
            confidence,
            scoreEligible: true,
            observedAt: profile.quotedAt,
            freshnessSeconds: Math.max(0, params.observedAt - profile.quotedAt),
            commonModeKeys: commonModeKeys(physicalPool, output),
            capacityCurve,
            ...(observationHistory ? { observationHistory } : {}),
          });
          evidenceCounts[capability.outputEvidenceKind] =
            (evidenceCounts[capability.outputEvidenceKind] ?? 0) + 1;
        }
        scoreEligiblePoolCount++;
        continue;
      }
    }
    if (ammModel != null) {
      const modelIssues = validateAmmExecutionModel(ammModel, {
        chain: pool.chain,
        stablecoinId: params.stablecoinId,
        retainedTvlUsd: pool.tvlUsd,
      });
      if (modelIssues.length > 0) {
        unsupportedPoolCount++;
        for (const issue of modelIssues) {
          const reason = `invalidExecutionModel:${issue}`;
          unsupportedReasons[reason] = (unsupportedReasons[reason] ?? 0) + 1;
        }
        continue;
      }

      let emittedForPool = 0;
      for (let outputTokenIndex = 0; outputTokenIndex < ammModel.tokens.length; outputTokenIndex++) {
        if (outputTokenIndex === ammModel.trackedTokenIndex) continue;
        const outputToken = ammModel.tokens[outputTokenIndex]!;
        const curve = buildAmmCapacityCurve(ammModel, outputTokenIndex);
        if (validateExitRouteCapacityCurve(curve).length > 0) continue;
        const referencePoint = curve.find(
          (point) => point.requestedNotionalUsd === REFERENCE_NOTIONAL_USD && point.maxCostBps === REFERENCE_COST_BPS,
        );
        if (!referencePoint) continue;

        const output = outputFromAmmToken(pool.chain, outputToken);
        const outputIdentity = canonicalExitRouteAssetKey(pool.chain, outputToken.address);
        observations.push({
          routeId: buildDexRouteId([
            normalizedKey(params.stablecoinId),
            normalizedKey(pool.source),
            canonicalExitRouteScopedKey(pool.chain, pool.poolId),
            outputIdentity,
          ]),
          routeFamily: "dex-amm",
          scope: {
            kind: "chain-contract",
            chain: pool.chain,
            contractOrPoolId: pool.poolId,
            protocol: pool.project,
          },
          requestedNotionalUsd: referencePoint.requestedNotionalUsd,
          settlementHorizonSec: IMMEDIATE_SETTLEMENT_HORIZON_SEC,
          maxCostBps: referencePoint.maxCostBps,
          executableUsd: referencePoint.executableUsd,
          completionRatio: referencePoint.completionRatio,
          output,
          evidenceKind: capability.outputEvidenceKind,
          confidence: capability.confidence,
          scoreEligible: capability.scoreEligible,
          observedAt: params.observedAt,
          freshnessSeconds: 0,
          commonModeKeys: commonModeKeys(pool, output),
          capacityCurve: curve,
        });
        evidenceCounts[capability.outputEvidenceKind] = (evidenceCounts[capability.outputEvidenceKind] ?? 0) + 1;
        emittedForPool++;
      }
      if (emittedForPool === 0) {
        unsupportedPoolCount++;
        unsupportedReasons.noExecutableCounterAsset = (unsupportedReasons.noExecutableCounterAsset ?? 0) + 1;
      } else if (capability.scoreEligible) {
        scoreEligiblePoolCount++;
      }
      continue;
    }

    const curve = buildCapacityCurve(pool, capability);
    if (curve == null) {
      unsupportedPoolCount++;
      const reason = `nonExecutableEvidence:${capability.id}`;
      unsupportedReasons[reason] = (unsupportedReasons[reason] ?? 0) + 1;
      continue;
    }
    const curveIssues = validateExitRouteCapacityCurve(curve);
    if (curveIssues.length > 0) {
      unsupportedPoolCount++;
      unsupportedReasons.nonMonotonicCurve = (unsupportedReasons.nonMonotonicCurve ?? 0) + 1;
      continue;
    }
    const referencePoint = curve.find(
      (point) => point.requestedNotionalUsd === REFERENCE_NOTIONAL_USD && point.maxCostBps === REFERENCE_COST_BPS,
    );
    if (!referencePoint) {
      unsupportedPoolCount++;
      unsupportedReasons.missingReferencePoint = (unsupportedReasons.missingReferencePoint ?? 0) + 1;
      continue;
    }
    const output = outputFromPool(pool);
    const orderbook = capability.model === "direct-orderbook";
    observations.push({
      routeId: buildDexRouteId([
        normalizedKey(params.stablecoinId),
        normalizedKey(pool.source),
        canonicalExitRouteScopedKey(pool.chain, pool.poolId),
      ]),
      routeFamily: orderbook ? "dex-orderbook" : "dex-amm",
      scope: orderbook
        ? { kind: "venue", venue: pool.project, protocol: pool.project }
        : {
            kind: "chain-contract",
            chain: pool.chain,
            contractOrPoolId: pool.poolId,
            protocol: pool.project,
          },
      requestedNotionalUsd: referencePoint.requestedNotionalUsd,
      settlementHorizonSec: IMMEDIATE_SETTLEMENT_HORIZON_SEC,
      maxCostBps: referencePoint.maxCostBps,
      executableUsd: referencePoint.executableUsd,
      completionRatio: referencePoint.completionRatio,
      output,
      evidenceKind: capability.outputEvidenceKind,
      confidence: capability.confidence,
      scoreEligible: capability.scoreEligible,
      observedAt: params.observedAt,
      freshnessSeconds: 0,
      commonModeKeys: commonModeKeys(pool, output),
      capacityCurve: curve,
    });
    evidenceCounts[capability.outputEvidenceKind] = (evidenceCounts[capability.outputEvidenceKind] ?? 0) + 1;
    if (capability.scoreEligible) scoreEligiblePoolCount++;
  }

  return {
    observations,
    coverage: {
      status: observations.length > 0 ? "populated" : params.retainedPools.length > 0 ? "unsupported" : "unknown",
      capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
      retainedPoolCount: params.retainedPools.length,
      observationCount: observations.length,
      scoreEligibleObservationCount: observations.filter((observation) => observation.scoreEligible).length,
      scoreEligiblePoolCount,
      scoreEligibleCapabilityPoolCount,
      unsupportedPoolCount,
      evidenceCounts,
      unsupportedReasons,
    },
  };
}
