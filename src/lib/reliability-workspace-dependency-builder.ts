import { isPublicImpactCircuitKey } from "@shared/lib/public-health";
import type {
  ReliabilityDependenciesModel,
  ReliabilityWorkspaceInput,
} from "@/lib/reliability-workspace-model";

export function buildDependenciesModel(input: ReliabilityWorkspaceInput): ReliabilityDependenciesModel {
  const dependencyHealth = input.data.dependencyHealth;
  const dependencies = dependencyHealth?.dependencies ?? {};
  const roots = (dependencyHealth?.rootCauseGroups ?? []).map((root) => ({
    id: root.rootDependencyId,
    label: dependencies[root.rootDependencyId]?.label ?? root.rootDependencyId,
    status: root.rootStatus,
    criticality: root.criticality,
    reason: root.rootReason,
    impactedCount: root.impactedDependencyIds.length,
    consumers: root.consumerIds,
  }));
  const providerCircuits = [...(input.data.providerCircuitHealth?.openProviders ?? [])].sort((left, right) => {
    const stateRank = { open: 2, "half-open": 1, closed: 0 } as const;
    return stateRank[right.state] - stateRank[left.state] || right.consecutiveFailures - left.consecutiveFailures;
  });
  const publicCircuits = Object.entries(input.healthData?.circuits ?? {})
    .filter(([key, circuit]) => isPublicImpactCircuitKey(key) && circuit.state !== "closed")
    .sort((left, right) => {
      const stateRank = { open: 2, "half-open": 1, closed: 0 } as const;
      return stateRank[right[1].state] - stateRank[left[1].state] || left[0].localeCompare(right[0]);
    });
  const canaryChecks = Object.values(input.data.canaries?.checks ?? {}).sort((left, right) => {
    const statusRank = { error: 3, degraded: 2, skipped: 1, ok: 0 } as const;
    return statusRank[right.status] - statusRank[left.status] || left.label.localeCompare(right.label);
  });

  const diagnostics = {
    capturedAt: input.data.timestamp,
    dependencyRoots: roots.map((root) => ({
      id: root.id,
      status: root.status,
      criticality: root.criticality,
      impactedCount: root.impactedCount,
      consumers: root.consumers,
    })),
    providerCircuits: providerCircuits.map((circuit) => ({
      providerId: circuit.providerId,
      family: circuit.family,
      state: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      openedAt: circuit.openedAt,
      lastFailureAt: circuit.lastFailureAt,
      lastSuccessAt: circuit.lastSuccessAt,
    })),
    publicCircuits: publicCircuits.map(([name, circuit]) => ({
      name,
      state: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      openedAt: circuit.openedAt,
      lastFailureAt: circuit.lastFailureAt,
      lastSuccessAt: circuit.lastSuccessAt,
    })),
    canaries: canaryChecks.map((check) => ({
      checkId: check.checkId,
      status: check.status,
      severity: check.severity,
      observedAt: check.observedAt,
      durationMs: check.durationMs,
    })),
  };

  return {
    roots,
    dependencySummary: dependencyHealth?.summary ?? null,
    providerCircuits,
    providerSummary: input.data.providerCircuitHealth,
    publicCircuits,
    publicCircuitEvidenceAvailable: input.healthData != null,
    canaryChecks,
    canarySummary: input.data.canaries,
    diagnosticText: JSON.stringify(diagnostics, null, 2),
  };
}

