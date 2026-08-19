import type { DexExecutionCapabilityGate } from "@shared/types/market";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type {
  CurvePoolEntry,
  CurveStableswapRateInputExecutionCandidate,
  EvmV2ExecutionCandidate,
  LlamaPool,
  LiquidityFallbackCounters,
  LiquidityMetrics,
} from "./types";
import type { UniqueEvmV2ExecutionCandidateFingerprintIndex } from "./constant-product-v2";
import type {
  UniswapV4ExecutionCandidate,
  UniV3ExecutionCandidate,
} from "../measured-execution/inventory";

export const POOL_REJECTION_POOL_ID_LIMIT = 20;

export type PoolRejectionReason =
  | "invalid-pool-identity"
  | "invalid-pool-tvl"
  | "invalid-pool-volume";

export interface PoolProcessingRejection {
  reason: PoolRejectionReason;
  poolIds: string[];
  count: number;
  tvlUsd: number;
}

export interface ProcessPoolMetricsInput {
  pools: LlamaPool[];
  dexProjects: Set<string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  chainAddressToId: Map<string, string>;
  curvePoolMap: Map<string, CurvePoolEntry>;
  uniV3PoolFees: Map<string, number>;
  uniV3SymbolFees: Map<string, number>;
  aerodromeIsStable: Map<string, boolean>;
  uniV3ExecutionCandidates?: Map<string, UniV3ExecutionCandidate[]>;
  stablecoinPriceById?: Map<string, number>;
  measuredTargetCapturedAt?: number;
  validationReferences?: PriceValidationReferences;
  aerodromeV2ExecutionCandidates?: Map<string, EvmV2ExecutionCandidate>;
  curvePoolCandidatesByFingerprint?: ReadonlyMap<string, readonly CurvePoolEntry[]>;
  uniswapV4ExecutionCandidates?: ReadonlyMap<
    string,
    readonly UniswapV4ExecutionCandidate[]
  >;
  /** Report-only fallback/default counters accumulated during processing. */
  fallbackCounters?: LiquidityFallbackCounters;
}

export interface ProcessPoolMetricsResult {
  metrics: Map<string, LiquidityMetrics>;
  rejections: PoolProcessingRejection[];
}

export interface PoolProcessingContext
  extends Omit<
    ProcessPoolMetricsInput,
    | "uniV3ExecutionCandidates"
    | "measuredTargetCapturedAt"
    | "aerodromeV2ExecutionCandidates"
    | "curvePoolCandidatesByFingerprint"
    | "uniswapV4ExecutionCandidates"
    | "fallbackCounters"
  > {
  uniV3ExecutionCandidates: Map<string, UniV3ExecutionCandidate[]>;
  measuredTargetCapturedAt: number;
  aerodromeV2ExecutionCandidates: Map<string, EvmV2ExecutionCandidate>;
  uniqueAerodromeV2ExecutionCandidates: UniqueEvmV2ExecutionCandidateFingerprintIndex;
  curvePoolCandidatesByFingerprint: ReadonlyMap<string, readonly CurvePoolEntry[]>;
  uniswapV4ExecutionCandidates: ReadonlyMap<
    string,
    readonly UniswapV4ExecutionCandidate[]
  >;
}

export interface ResolvedPoolIdentity {
  pool: LlamaPool;
  matchedIds: Set<string>;
  poolSymbols: string[];
  poolType: string;
  protocol: string;
  chainNorm: string;
  addrCurveKey: string;
  fpCurveKey: string | null;
  symCurveKey: string;
}

export interface PoolProtocolEnrichment {
  curveData: CurvePoolEntry | undefined;
  curveMeasuredRouteData: CurvePoolEntry | undefined;
  curveAddressMatch: boolean;
  resolvedPoolType: string;
  qualityMultiplier: number;
  feeTierForExtra: number | undefined;
  balanceRatio: number;
  poolMaturityDays: number;
  organicFraction: number;
  hasMeasuredOrganicFraction: boolean;
  effectivePoolTvl: number;
  rawContribTvl: number;
  balanceDetails:
    | { symbol: string; balancePct: number; isTracked: boolean }[]
    | undefined;
  volumeUsd1d: number;
  volumeUsd7d: number | null;
}

export interface PoolExecutionCapability {
  ammExecutionModel?: NonNullable<
    NonNullable<LiquidityMetrics["topPools"][number]["extra"]>["ammExecutionModel"]
  >;
  evmV2ExecutionCandidate?: EvmV2ExecutionCandidate;
  curveStableswapRateInputExecutionCandidate?: CurveStableswapRateInputExecutionCandidate;
  executionCapabilityGate?: DexExecutionCapabilityGate;
  measuredExecutionTarget?: DexMeasuredExecutionTarget;
  measuredExecutionTargets?: DexMeasuredExecutionTarget[];
  measuredExecutionPhysicalPoolId?: string;
}

export class ExpectedPoolInputError extends Error {
  constructor(readonly reason: PoolRejectionReason) {
    super(reason);
    this.name = "ExpectedPoolInputError";
  }
}
