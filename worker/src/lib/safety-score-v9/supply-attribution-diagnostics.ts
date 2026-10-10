import type { SupplyAttributionAttemptDiagnostic } from "@shared/types/safety-score-v9-supply-attribution";

export function emitSupplyAttributionDiagnostic(
  callback: ((diagnostic: SupplyAttributionAttemptDiagnostic) => void) | undefined,
  detail: Pick<SupplyAttributionAttemptDiagnostic, "observer" | "sourceId"> & Partial<SupplyAttributionAttemptDiagnostic>,
): void {
  callback?.({ laneId: null, chainId: null, providerOrigin: null, method: "unknown", phase: "observation", beforeCursor: null, afterCursor: null, targetCursor: null, pinObservedAtSec: null, finalizedLagBlocks: null, persisted: false, authenticatedCursorAdvanced: false, incompleteBootstrap: false, hardEvidenceFailure: false, failurePredicate: null, ...detail });
}
