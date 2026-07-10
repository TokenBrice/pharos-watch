import { computePYS } from "@shared/lib/yield-scoring";
import type { YieldPysInputsAtPublish } from "@shared/types/yield";

export function recomputePublishedPys(inputs: YieldPysInputsAtPublish): number {
  return computePYS({
    apy30d: inputs.apy30d,
    safetyScore: inputs.safetyScore,
    apyVarianceScore: inputs.varianceScore,
    benchmarkRate: inputs.benchmarkRate,
    sourceRiskPenalty: inputs.sourceRiskPenalty,
    scalingFactor: inputs.scalingFactor,
  });
}

export function publishedPysRecomputesExactly(inputs: YieldPysInputsAtPublish, publishedScore: number): boolean {
  return Object.is(recomputePublishedPys(inputs), publishedScore);
}
