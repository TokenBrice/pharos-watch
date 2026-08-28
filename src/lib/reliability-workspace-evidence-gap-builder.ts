import type { StatusResponse, StatusSectionKey } from "@shared/types";
import type {
  ReliabilityEvidenceGap,
  ReliabilityMode,
  ReliabilityWorkspaceInput,
} from "@/lib/reliability-workspace-model";
import { RELIABILITY_MODES } from "@/lib/reliability-workspace-model";

const SECTION_ERROR_META: Partial<Record<StatusSectionKey, { mode: ReliabilityMode; label: string }>> = {
  dependencyHealth: { mode: "dependencies", label: "Dependency health" },
  providerCircuitHealth: { mode: "dependencies", label: "Provider circuits" },
  canaries: { mode: "dependencies", label: "Invariant canaries" },
};

export function collectReliabilityEvidenceGaps(input: ReliabilityWorkspaceInput): ReliabilityEvidenceGap[] {
  const gaps = new Map<string, ReliabilityEvidenceGap>();
  const add = (gap: ReliabilityEvidenceGap) => {
    if (!gaps.has(gap.rawCode)) gaps.set(gap.rawCode, gap);
  };

  if (input.healthError) {
    add({
      mode: "impact",
      label: "Public health",
      rawCode: "publicHealth",
      code: "query_failed",
      message: input.healthError,
      kind: "failure",
    });
  } else if (!input.healthLoading && !input.healthData) {
    add({
      mode: "impact",
      label: "Public health",
      rawCode: "publicHealth",
      code: "not_loaded",
      message: "No public-health response is available.",
      kind: "missing",
    });
  }

  if (input.probesError) {
    add({
      mode: "endpoints",
      label: "Browser endpoint probes",
      rawCode: "browserProbes",
      code: "query_failed",
      message: input.probesError,
      kind: "failure",
    });
  } else if (
    !input.probesLoading &&
    (input.probes === undefined || input.probes.length === 0 || input.browserProbeSummary == null)
  ) {
    add({
      mode: "endpoints",
      label: "Browser endpoint probes",
      rawCode: "browserProbes",
      code: "not_loaded",
      message: "No browser-origin probe response is available.",
      kind: "missing",
    });
  }

  if (!input.data.probe.timestamp || input.data.probe.sampleCount <= 0 || input.data.probe.status === "unknown") {
    add({
      mode: "endpoints",
      label: "Worker self-check probes",
      rawCode: "workerProbe",
      code: "sample_missing",
      message: "The worker-origin self-check sample is unavailable or empty.",
      kind: "missing",
    });
  }

  if (input.requestSourceError) {
    add({
      mode: "demand",
      label: "Request attribution",
      rawCode: "requestSourceStats",
      code: "query_failed",
      message: input.requestSourceError,
      kind: "failure",
    });
  } else if (!input.requestSourceLoading && !input.requestSourceStats) {
    add({
      mode: "demand",
      label: "Request attribution",
      rawCode: "requestSourceStats",
      code: "not_loaded",
      message: "No request-attribution response is available.",
      kind: "missing",
    });
  }

  (
    Object.entries(input.data.sectionErrors) as Array<
      [StatusSectionKey, StatusResponse["sectionErrors"][StatusSectionKey]]
    >
  ).forEach(([rawCode, error]) => {
    const meta = SECTION_ERROR_META[rawCode];
    if (!meta || !error) return;
    add({ ...meta, rawCode, code: error.code, message: error.message, kind: "failure" });
  });

  const optionalEvidence = [
    ["dependencyHealth", "Dependency health", input.data.dependencyHealth],
    ["providerCircuitHealth", "Provider circuits", input.data.providerCircuitHealth],
    ["canaries", "Invariant canaries", input.data.canaries],
  ] as const;
  optionalEvidence.forEach(([rawCode, label, value]) => {
    if (value || gaps.has(rawCode)) return;
    add({
      mode: "dependencies",
      label,
      rawCode,
      code: "not_reported",
      message: `${label} is not present in the status payload.`,
      kind: "missing",
    });
  });

  if (Object.keys(input.data.caches).length === 0) {
    add({
      mode: "cache",
      label: "Cache freshness inventory",
      rawCode: "caches",
      code: "empty_inventory",
      message: "No cache freshness rows are present in the status payload.",
      kind: "missing",
    });
  }

  return [...gaps.values()].sort((left, right) => {
    const modeDelta =
      RELIABILITY_MODES.findIndex((mode) => mode.id === left.mode) -
      RELIABILITY_MODES.findIndex((mode) => mode.id === right.mode);
    return modeDelta || left.label.localeCompare(right.label);
  });
}
