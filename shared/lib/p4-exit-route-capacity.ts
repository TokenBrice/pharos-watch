import type {
  ExitRouteCapacityPoint,
  ExitRouteConfidence,
  ExitRouteEvidenceKind,
  ExitRouteObservation,
  ExitRouteObservationCoverage,
  ExitRouteOutput,
  LiquidityPoolSourceFamily,
} from "@shared/types/market";

export const DEX_ROUTE_CAPABILITY_MATRIX_VERSION = "p4a.1";

const DEFAULT_NOTIONALS_USD = [100_000, 1_000_000, 10_000_000, 25_000_000] as const;
const REFERENCE_NOTIONAL_USD = 1_000_000;
const REFERENCE_COST_BPS = 200;
const IMMEDIATE_SETTLEMENT_HORIZON_SEC = 300;

type CapabilityLevel = "exact" | "partial" | "symbol-only" | "aggregate-only" | "absent";

export interface DexRouteSourceCapability {
  id: string;
  sourceFamilies: readonly LiquidityPoolSourceFamily[];
  model: "direct-orderbook" | "curve-stableswap-retained" | "amm-tvl-proxy" | "synthetic-fallback";
  tokenIdentity: CapabilityLevel;
  exactBalancesOrReserves: CapabilityLevel;
  poolInvariantParameters: CapabilityLevel;
  outputIdentity: CapabilityLevel;
  fees: CapabilityLevel;
  observationTime: "producer-run" | "source-observed" | "absent";
  outputEvidenceKind: ExitRouteEvidenceKind;
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
  };
}

export interface P4DexRouteObservationResult {
  observations: ExitRouteObservation[];
  coverage: ExitRouteObservationCoverage;
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

function capabilityForPool(pool: P4DexRoutePoolInput): DexRouteSourceCapability {
  if (
    pool.poolType === "orderbook" &&
    pool.source === "cg_tickers" &&
    pool.extra?.orderbookDepthUsd != null &&
    pool.extra.orderbookDepthUsd > 0
  ) {
    return DEX_ROUTE_SOURCE_CAPABILITIES[0]!;
  }
  if (pool.extra?.measurement?.synthetic === true) {
    return DEX_ROUTE_SOURCE_CAPABILITIES[5]!;
  }
  if (
    pool.source === "dl" &&
    pool.poolType === "curve-stableswap" &&
    pool.extra?.amplificationCoefficient != null &&
    (pool.extra.balanceDetails?.length ?? 0) > 1
  ) {
    return DEX_ROUTE_SOURCE_CAPABILITIES[1]!;
  }
  if (pool.source === "direct_api") return DEX_ROUTE_SOURCE_CAPABILITIES[2]!;
  if (pool.source === "dl") return DEX_ROUTE_SOURCE_CAPABILITIES[3]!;
  return DEX_ROUTE_SOURCE_CAPABILITIES[4]!;
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
  const keys = new Set<string>([`protocol:${normalizedKey(pool.project)}`, `pool:${normalizedKey(pool.poolId)}`]);
  if (pool.poolType === "orderbook") keys.add(`venue:${normalizedKey(pool.project)}`);
  else keys.add(`chain:${normalizedKey(pool.chain)}`);
  if (output.currency) keys.add(`fiat:${normalizedKey(output.currency)}`);
  for (const assetId of output.trackedAssetIds ?? []) keys.add(`asset:${normalizedKey(assetId)}`);
  for (const item of output.basketWeights ?? []) {
    if (item.assetId) keys.add(`asset:${normalizedKey(item.assetId)}`);
    else if (item.symbol) keys.add(`asset-symbol:${normalizedKey(item.symbol)}`);
  }
  return [...keys].sort();
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

  for (const pool of params.retainedPools) {
    if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd <= 0 || !pool.poolId || !pool.project || !pool.chain) {
      unsupportedPoolCount++;
      unsupportedReasons.invalidRetainedPool = (unsupportedReasons.invalidRetainedPool ?? 0) + 1;
      continue;
    }
    const capability = capabilityForPool(pool);
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
      routeId: `dex:${normalizedKey(params.stablecoinId)}:${normalizedKey(pool.source)}:${normalizedKey(pool.poolId)}`,
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
  }

  return {
    observations,
    coverage: {
      status: observations.length > 0 ? "populated" : params.retainedPools.length > 0 ? "unsupported" : "unknown",
      capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
      retainedPoolCount: params.retainedPools.length,
      observationCount: observations.length,
      scoreEligibleObservationCount: observations.filter((observation) => observation.scoreEligible).length,
      unsupportedPoolCount,
      evidenceCounts,
      unsupportedReasons,
    },
  };
}
