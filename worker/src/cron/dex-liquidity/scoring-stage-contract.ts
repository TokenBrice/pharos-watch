import type { PriceValidationReferences } from "../../lib/price-validation";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { SolanaMeasuredExecutionTarget } from "@shared/types/solana-measured-execution";
import type { TronMeasuredExecutionTarget } from "@shared/types/tron-measured-execution";
import type {
  DirectApiFetchPhaseResult,
  DirectApiIntegrationResult,
  FallbackCrawlerPhaseResult,
} from "./orchestrator-phases";
import type { StagedPoolSkipDimension } from "./staging-merge";
import type { DataSources, DexPriceObs, LiquidityMetrics } from "./types";

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
  pancakeMeasuredExecutionTargets: Map<string, DexMeasuredExecutionTarget>;
  fluidMeasuredExecutionTargets: Map<string, DexMeasuredExecutionTarget>;
  slipstreamMeasuredExecutionTargets: Map<string, DexMeasuredExecutionTarget>;
  solanaMeasuredExecutionTargets: Map<string, SolanaMeasuredExecutionTarget>;
  tronMeasuredExecutionTargets: Map<string, TronMeasuredExecutionTarget>;
  stagedMergedCount: number;
  stagedSkippedCount: number;
  stagedSkippedByExactIdentityCount: number;
  stagedSkippedByUniqueDerivedIdentityCount: number;
  stagedSkippedByOptionalWildcardIdentityCount: number;
  stagedSkippedByAuthoritativeProtocolCount: number;
  stagedSkipDimensions: StagedPoolSkipDimension[];
  directApiIntegration: DirectApiIntegrationResult;
}
