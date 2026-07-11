import type { YieldPysInputsAtPublish } from "../types/yield";
import { computePYS } from "./yield-scoring";

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
