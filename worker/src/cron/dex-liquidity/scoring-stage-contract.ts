import type { PriceValidationReferences } from "../../lib/price-validation";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type {
  DirectApiFetchPhaseResult,
  DirectApiIntegrationResult,
  FallbackCrawlerPhaseResult,
} from "./orchestrator-phases";
import type { StagedPoolSkipDimension } from "./staging-merge";
import type { DataSources, DexPriceObs, LiquidityMetrics } from "./types";
import type { PoolProcessingRejection } from "./process-pool-types";

export interface DexLiquidityDirectApiSourceSummary {
  circuitEvents: DirectApiFetchPhaseResult["circuitEvents"];
  sourceWarnings: DirectApiFetchPhaseResult["sourceWarnings"];
  pagination: Array<
    { source: string } & NonNullable<
      DirectApiFetchPhaseResult["results"][number]["result"]["pagination"]
    >
  >;
}

export interface DexLiquidityScoringSourceState {
  validationReferences: PriceValidationReferences;
  stablecoinPriceById: Map<string, number>;
  stablecoinMcapById: Map<string, number>;
  protocolTvlCaps: DataSources["protocolTvlCaps"];
  priceObservations: Map<string, DexPriceObs[]>;
  dlYieldsAvailable: boolean;
  dlProtocolsAvailable: boolean;
  primaryRawPoolCount: number;
  failedSources: string[];
  criticalSourceFailures: string[];
  fallbackSignals: string[];
  directApiSourceSummary: DexLiquidityDirectApiSourceSummary;
}

export interface DexLiquidityPoolState {
  fallback: FallbackCrawlerPhaseResult;
  metrics: Map<string, LiquidityMetrics>;
  poolRejections: PoolProcessingRejection[];
  pancakeMeasuredExecutionTargets: Map<string, DexMeasuredExecutionTarget>;
  slipstreamMeasuredExecutionTargets: Map<string, DexMeasuredExecutionTarget>;
  stagedMergedCount: number;
  stagedSkippedCount: number;
  stagedSkippedByExactIdentityCount: number;
  stagedSkippedByUniqueDerivedIdentityCount: number;
  stagedSkippedByOptionalWildcardIdentityCount: number;
  stagedSkippedByAuthoritativeProtocolCount: number;
  stagedSkipDimensions: StagedPoolSkipDimension[];
  directApiIntegration: DirectApiIntegrationResult;
}
