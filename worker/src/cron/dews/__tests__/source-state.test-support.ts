import type { DewsSourceState } from "../../../lib/dews/contracts";

export function emptyDewsDependencyDiagnostics(): DewsSourceState["dependencyDiagnostics"] {
  return {
    psi: { generationId: null, updatedAt: null, ageSeconds: null, freshnessBudgetSec: 3600, reason: "missing-sample" },
    dexLiquidity: {
      totalRows: 0,
      freshRows: 0,
      staleRows: 0,
      freshnessAgeSec: null,
      staleThresholdSec: 7200,
      latestGenerationId: null,
      latestGenerationState: null,
      latestGenerationStartedAt: null,
      latestGenerationPublishedAt: null,
      latestGenerationFailedAt: null,
      latestGenerationFailureReason: null,
      latestPublishedGenerationId: null,
      latestPublishedAt: null,
      latestPublishedAgeSec: null,
    },
  };
}
