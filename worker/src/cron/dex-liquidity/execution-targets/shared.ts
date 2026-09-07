import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type {
  DexExecutionTargetFactoryInput,
  DexExecutionTargetFactoryOutput,
} from "../execution-target-registry";

export function buildRegisteredTargetInput<TCandidate>(
  input: DexExecutionTargetFactoryInput,
  candidate: TCandidate,
) {
  const { context, enrichment, stablecoinId } = input;
  return {
    stablecoinId,
    candidate,
    stablecoinPriceById: context.stablecoinPriceById,
    chainAddressToId: context.chainAddressToId,
    symbolToChainScopedIds: context.symbolToChainScopedIds,
    validationReferences: context.validationReferences,
    retainedTvlUsd: enrichment.rawContribTvl,
    capturedAt: context.measuredTargetCapturedAt,
  };
}

export function toRegisteredTargetOutput(
  measuredExecutionTarget: DexMeasuredExecutionTarget | null,
): DexExecutionTargetFactoryOutput {
  return measuredExecutionTarget
    ? { measuredExecutionTarget, executionCapabilityGate: undefined }
    : {
        executionCapabilityGate: {
          family: "measured-execution",
          reason: "target-unresolved",
        },
      };
}
