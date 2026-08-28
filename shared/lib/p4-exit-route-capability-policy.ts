import { EXIT_ROUTE_SCORING_TABLES } from "./exit-route-scoring";
import { buildExitRouteCapacityPoint } from "./exit-route-capacity-point";
import type {
  DexAmmExecutionModel,
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
  canonicalExitRouteScopedKey,
} from "./exit-route-identity";
import {
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  type DexMeasuredExecutionObservationHistory,
  type DexMeasuredExecutionPublicProfile,
} from "../types/measured-execution";
import { UNISWAP_V4_DEPLOYMENT } from "./measured-execution-deployment-policies";

export const DEX_ROUTE_CAPABILITY_MATRIX_VERSION = "p4a.9";
export const REFERENCE_NOTIONAL_USD = EXIT_ROUTE_SCORING_TABLES.request.referenceNotionalUsd;
export const CURVE_STABLESWAP_ADAPTER_PROFILE_ID = DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap;
export const CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID = DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg;
const UNISWAP_V4_ADAPTER_PROFILE_ID = UNISWAP_V4_DEPLOYMENT.adapterProfileId;
export const CURVE_STABLESWAP_MIN_COMPLETE_CYCLES = 3;
export const CURVE_STABLESWAP_MIN_SUCCESSFUL_OBSERVATIONS = 3;
export const CURVE_STABLESWAP_NG_MIN_COMPLETE_CYCLES = 3;
export const CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS = 3;

type CapabilityLevel = "exact" | "partial" | "symbol-only" | "aggregate-only" | "absent";
export type P4MeasuredExecutionPublicProfile = DexMeasuredExecutionPublicProfile;
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
    id: "uniswap-v4-hook-free-measured-exact",
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
      "Activated only for exact hook-free Ethereum PoolKeys verified against the pinned PoolManager, StateView, and Quoter deployment.",
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

export function normalizedKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function outputFromPool(pool: P4DexRoutePoolInput): ExitRouteOutput {
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

export function measuredExecutionProfilesForPool(
  pool: P4DexRoutePoolInput,
): P4MeasuredExecutionPublicProfile[] {
  const profiles: P4MeasuredExecutionPublicProfile[] = [
    ...(pool.extra?.measuredExecutions ?? []),
    ...(pool.extra?.measuredExecution ? [pool.extra.measuredExecution] : []),
  ];
  return profiles;
}

export function observationHistoryForProfile(
  profile: P4MeasuredExecutionPublicProfile,
): DexMeasuredExecutionObservationHistory | undefined {
  return "observationHistory" in profile ? profile.observationHistory : undefined;
}

const MEASURED_EXECUTION_CAPABILITY_BY_PROFILE_ID: Readonly<Record<string, string>> = {
  "uniswap-v3-quoter-v2": "quoter-v2-measured-exact",
  "pancakeswap-v3-quoter-v2": "quoter-v2-measured-exact",
  "aerodrome-slipstream-quoter-v2": "quoter-v2-measured-exact",
  [UNISWAP_V4_ADAPTER_PROFILE_ID]: "uniswap-v4-hook-free-measured-exact",
  "curve-cryptoswap-get-dy-v1": "curve-cryptoswap-measured-exact",
  [CURVE_STABLESWAP_ADAPTER_PROFILE_ID]: "curve-stableswap-main-registry-measured-exact",
  [CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID]: "curve-stableswap-ng-factory-measured-exact",
};

export function isQuoterV2MeasuredExecutionAdapter(adapterProfileId: string): boolean {
  return MEASURED_EXECUTION_CAPABILITY_BY_PROFILE_ID[adapterProfileId] ===
    "quoter-v2-measured-exact";
}

export function isUniswapV4MeasuredExecutionAdapter(adapterProfileId: string): boolean {
  return MEASURED_EXECUTION_CAPABILITY_BY_PROFILE_ID[adapterProfileId] ===
    "uniswap-v4-hook-free-measured-exact";
}

export function capabilityForPool(
  pool: P4DexRoutePoolInput,
  options: { ignoreMeasured?: boolean } = {},
): DexRouteSourceCapability {
  const measuredProfile = options.ignoreMeasured
    ? undefined
    : measuredExecutionProfilesForPool(pool)[0];
  if (measuredProfile) {
    return capabilityById(
      MEASURED_EXECUTION_CAPABILITY_BY_PROFILE_ID[measuredProfile.adapterProfileId] ??
        "measured-adapter-shadow",
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

export function requiresP4DexScoreEligibleCapabilityCoverage(pool: P4DexRoutePoolInput): boolean {
  if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd <= 0 || !pool.poolId || !pool.project || !pool.chain) return true;
  if (pool.extra?.executionCapabilityGate != null) return true;
  const capability = capabilityForPool(pool);
  if (capability.scoreEligible) return true;
  return (
    measuredExecutionProfilesForPool(pool).length > 0
  ) && pool.extra?.ammExecutionModel == null;
}

export function buildCapacityPoint(
  requestedNotionalUsd: number,
  maxCostBps: number,
  capacityUsd: number,
): ExitRouteCapacityPoint {
  return buildExitRouteCapacityPoint(
    { requestedNotionalUsd, maxCostBps, capacityUsd },
    { clampNegativeCapacity: true, usdDecimals: 2, ratioDecimals: 6 },
  );
}

export function buildCapacityCurve(
  pool: P4DexRoutePoolInput,
  capability: DexRouteSourceCapability,
): ExitRouteCapacityPoint[] | null {
  if (capability.model === "direct-orderbook") {
    const capacityUsd = pool.extra?.orderbookDepthUsd ?? 0;
    return EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd.map((notional) =>
      buildCapacityPoint(notional, EXIT_ROUTE_SCORING_TABLES.request.maxCostBps, capacityUsd),
    );
  }
  return null;
}
