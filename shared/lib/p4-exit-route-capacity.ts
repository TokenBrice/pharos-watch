import type {
  DexAmmExecutionModel,
  DexAmmExecutionToken,
  ExitRouteCapacityPoint,
  ExitRouteConfidence,
  ExitRouteEvidenceKind,
  ExitRouteObservation,
  ExitRouteObservationCoverage,
  ExitRouteOutput,
  LiquidityPoolSourceFamily,
} from "../types/market";

export const DEX_ROUTE_CAPABILITY_MATRIX_VERSION = "p4a.2";

const DEFAULT_NOTIONALS_USD = [100_000, 1_000_000, 10_000_000, 25_000_000] as const;
const REFERENCE_NOTIONAL_USD = 1_000_000;
const REFERENCE_COST_BPS = 200;
const IMMEDIATE_SETTLEMENT_HORIZON_SEC = 300;

type CapabilityLevel = "exact" | "partial" | "symbol-only" | "aggregate-only" | "absent";

export interface DexRouteSourceCapability {
  id: string;
  sourceFamilies: readonly LiquidityPoolSourceFamily[];
  model:
    | "direct-orderbook"
    | "constant-product"
    | "weighted-constant-mean"
    | "curve-stableswap-retained"
    | "amm-tvl-proxy"
    | "synthetic-fallback";
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
    limitations: ["Supports only Raydium standard constant-product pools with complete retained inputs."],
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
    ammExecutionModel?: DexAmmExecutionModel;
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

function capabilityById(id: string): DexRouteSourceCapability {
  const capability = DEX_ROUTE_SOURCE_CAPABILITIES.find((entry) => entry.id === id);
  if (!capability) throw new Error(`Missing DEX route capability: ${id}`);
  return capability;
}

function capabilityForPool(pool: P4DexRoutePoolInput): DexRouteSourceCapability {
  if (
    pool.poolType === "orderbook" &&
    pool.source === "cg_tickers" &&
    pool.extra?.orderbookDepthUsd != null &&
    pool.extra.orderbookDepthUsd > 0
  ) {
    return capabilityById("cg-tickers-orderbook-depth-2pct");
  }
  if (pool.extra?.ammExecutionModel?.invariant === "constant-product") {
    return capabilityById("raydium-constant-product-exact");
  }
  if (pool.extra?.ammExecutionModel?.invariant === "weighted-constant-mean") {
    return capabilityById("balancer-weighted-constant-mean-exact");
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

function canonicalAssetKey(chain: string, address: string): string {
  const normalizedAddress = /^0x[0-9a-f]{40}$/i.test(address.trim())
    ? address.trim().toLowerCase()
    : address.trim();
  return `${normalizedKey(chain)}:${normalizedAddress}`;
}

function validateAmmExecutionModel(model: DexAmmExecutionModel): string[] {
  const issues: string[] = [];
  if (!Number.isInteger(model.trackedTokenIndex) || model.trackedTokenIndex < 0 || model.trackedTokenIndex >= model.tokens.length) {
    issues.push("invalid-tracked-token-index");
  }
  if (!Number.isFinite(model.feeRate) || model.feeRate < 0 || model.feeRate >= 1) issues.push("invalid-fee");
  if (model.tokens.length < 2 || model.tokens.length > 8) issues.push("invalid-token-count");
  const identities = new Set<string>();
  for (const token of model.tokens) {
    if (!token.address?.trim() || !token.symbol?.trim()) issues.push("missing-token-identity");
    const identity = token.address.trim().toLowerCase();
    if (identities.has(identity)) issues.push("duplicate-token-identity");
    identities.add(identity);
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) issues.push("invalid-decimals");
    if (!Number.isFinite(token.balance) || token.balance <= 0) issues.push("invalid-balance");
    if (!Number.isFinite(token.referencePriceUsd) || token.referencePriceUsd <= 0) issues.push("invalid-reference-price");
  }
  if (model.invariant === "constant-product") {
    if (model.source !== "raydium" || model.tokens.length !== 2) issues.push("invalid-constant-product-model");
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

function simulateAmmOutput(
  model: DexAmmExecutionModel,
  outputTokenIndex: number,
  inputAmount: number,
): number {
  const input = model.tokens[model.trackedTokenIndex]!;
  const output = model.tokens[outputTokenIndex]!;
  const effectiveInput = inputAmount * (1 - model.feeRate);
  if (!Number.isFinite(effectiveInput) || effectiveInput <= 0) return 0;

  if (model.invariant === "constant-product") {
    return output.balance * effectiveInput / (input.balance + effectiveInput);
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
  const marginalOutputRatio = model.invariant === "constant-product"
    ? (output.balance / input.balance) * (1 - model.feeRate) * output.referencePriceUsd / input.referencePriceUsd
    : (output.balance / input.balance) * (input.weight! / output.weight!) *
      (1 - model.feeRate) * output.referencePriceUsd / input.referencePriceUsd;
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

function buildAmmCapacityCurve(
  model: DexAmmExecutionModel,
  outputTokenIndex: number,
): ExitRouteCapacityPoint[] {
  return DEFAULT_NOTIONALS_USD.map((notional) => buildCapacityPoint(
    notional,
    REFERENCE_COST_BPS,
    executableAmmInputUsd(model, outputTokenIndex, notional, REFERENCE_COST_BPS),
  ));
}

function outputFromAmmToken(chain: string, token: DexAmmExecutionToken): ExitRouteOutput {
  const assetKey = canonicalAssetKey(chain, token.address);
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
  const keys = new Set<string>([`protocol:${normalizedKey(pool.project)}`, `pool:${normalizedKey(pool.poolId)}`]);
  if (pool.poolType === "orderbook") keys.add(`venue:${normalizedKey(pool.project)}`);
  else keys.add(`chain:${normalizedKey(pool.chain)}`);
  if (output.currency) keys.add(`fiat:${normalizedKey(output.currency)}`);
  for (const assetId of output.trackedAssetIds ?? []) keys.add(`asset:${normalizedKey(assetId)}`);
  for (const assetKey of output.assetKeys ?? []) keys.add(`token:${assetKey}`);
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
    const ammModel = pool.extra?.ammExecutionModel;
    if (ammModel != null) {
      const modelIssues = validateAmmExecutionModel(ammModel);
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
          (point) => point.requestedNotionalUsd === REFERENCE_NOTIONAL_USD &&
            point.maxCostBps === REFERENCE_COST_BPS,
        );
        if (!referencePoint) continue;

        const output = outputFromAmmToken(pool.chain, outputToken);
        const outputIdentity = canonicalAssetKey(pool.chain, outputToken.address);
        observations.push({
          routeId:
            `dex:${normalizedKey(params.stablecoinId)}:${normalizedKey(pool.source)}:` +
            `${normalizedKey(pool.poolId)}:${normalizedKey(outputIdentity)}`,
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
        evidenceCounts[capability.outputEvidenceKind] =
          (evidenceCounts[capability.outputEvidenceKind] ?? 0) + 1;
        emittedForPool++;
      }
      if (emittedForPool === 0) {
        unsupportedPoolCount++;
        unsupportedReasons.noExecutableCounterAsset = (unsupportedReasons.noExecutableCounterAsset ?? 0) + 1;
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
