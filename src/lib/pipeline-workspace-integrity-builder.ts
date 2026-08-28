import { formatElapsedSeconds } from "@shared/lib/format";
import type { StatusResponse } from "@shared/types";
import { healthSeverity, worstSeverity, SEVERITY_RANK } from "@/lib/status/workspace-mode";
import type {
  PipelineIntegrityModel,
  PipelineIntegrityRow,
  PipelineSeverity,
} from "@/lib/pipeline-workspace-model";

function formatAge(ageSeconds: number | null, suffix = "since last sample"): string {
  if (ageSeconds == null) return "Last sample not reported";
  return `${formatElapsedSeconds(ageSeconds)} ${suffix}`;
}

export function buildPipelineIntegrityModel(data: StatusResponse): PipelineIntegrityModel {
  const publicationRows: PipelineIntegrityRow[] = [];
  const publication = data.publicationHealth;
  if (publication) {
    const failures = new Map((publication.failedSurfaces ?? []).map((failure) => [failure.surface, failure]));
    Object.values(publication.surfaces).forEach((surface) => {
      if (!surface) return;
      const failure = failures.get(surface.surface);
      const attemptState = surface.lastAttemptedGeneration?.state;
      const state: PipelineSeverity = failure || attemptState === "failed" || attemptState === "rejected"
        ? "critical"
        : surface.lastPublishedGeneration
          ? "healthy"
          : "unknown";
      publicationRows.push({
        id: `publication-${surface.surface}`,
        label: surface.label,
        rawCode: surface.surface,
        state,
        currentValue: failure ? "Failed" : surface.lastPublishedGeneration ? "Published" : "Unknown",
        detail: failure
          ? `${failure.message} (${failure.code}; source ${surface.sourceOfTruth})`
          : `Source ${surface.sourceOfTruth}; latest attempt ${attemptState ?? "not reported"}.`,
      });
      failures.delete(surface.surface);
    });
    failures.forEach((failure, surface) => {
      publicationRows.push({
        id: `publication-${surface}`,
        label: surface,
        rawCode: surface,
        state: "critical",
        currentValue: "Failed",
        detail: `${failure.message} (${failure.code})`,
      });
    });
  } else {
    publicationRows.push({
      id: "publication-unavailable",
      label: "Publication health",
      rawCode: "publicationHealth",
      state: "unknown",
      currentValue: "Unknown",
      detail: "No publication-health payload was returned.",
    });
  }

  const dependencyRows: PipelineIntegrityRow[] = [];
  const dependencyHealth = data.dependencyHealth;
  if (dependencyHealth) {
    Object.values(dependencyHealth.dependencies)
      .sort((left, right) => SEVERITY_RANK[healthSeverity(right.status)] - SEVERITY_RANK[healthSeverity(left.status)])
      .forEach((dependency) => {
        dependencyRows.push({
          id: `dependency-${dependency.id}`,
          label: dependency.label,
          rawCode: dependency.id,
          state: healthSeverity(dependency.status),
          currentValue: dependency.status === "unknown" ? "Unknown" : dependency.status,
          detail: [
            dependency.reason,
            `source ${dependency.sourceOfTruth}`,
            dependency.producerJob ? `producer ${dependency.producerJob}` : null,
            dependency.consumers.length > 0 ? `consumers ${dependency.consumers.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("; "),
        });
      });
    if (dependencyRows.length === 0) {
      dependencyRows.push({
        id: "dependency-empty",
        label: "Dependency inventory",
        rawCode: "dependencyHealth.dependencies",
        state: "unknown",
        currentValue: "Unknown",
        detail: "Dependency health returned an empty inventory.",
      });
    }
  } else {
    dependencyRows.push({
      id: "dependency-unavailable",
      label: "Dependency health",
      rawCode: "dependencyHealth",
      state: "unknown",
      currentValue: "Unknown",
      detail: "No dependency-health payload was returned.",
    });
  }

  const stablecoinPublication = data.dataQuality.stablecoinPublication;
  const repairDebt = data.dataQuality.repairDebt;
  const controlRows: PipelineIntegrityRow[] = [
    stablecoinPublication
      ? {
          id: "stablecoin-publication",
          label: "Stablecoin publication coverage",
          rawCode: "stablecoin_publication",
          state:
            stablecoinPublication.status === "complete"
              ? "healthy"
              : stablecoinPublication.status === "incomplete"
                ? "critical"
                : "unknown",
          currentValue:
            stablecoinPublication.status === "unknown"
              ? "Unknown"
              : `${stablecoinPublication.presentActiveCount + stablecoinPublication.waivedActiveCount}/${stablecoinPublication.expectedActiveCount}`,
          detail: `${stablecoinPublication.missingActiveIds.length} missing; ${stablecoinPublication.waivedActiveCount} waived; ${stablecoinPublication.expiredWaiverIds.length} expired waivers.`,
        }
      : {
          id: "stablecoin-publication",
          label: "Stablecoin publication coverage",
          rawCode: "stablecoin_publication",
          state: "unknown",
          currentValue: "Unknown",
          detail: "The status payload did not include publication coverage.",
        },
    repairDebt
      ? {
          id: "repair-debt",
          label: "Pipeline repair debt",
          rawCode: "repair_debt",
          state: repairDebt.status === "ok" ? "healthy" : repairDebt.status === "present" ? "watch" : "unknown",
          currentValue: repairDebt.status === "unknown" ? "Unknown" : String(repairDebt.openCount),
          detail: `Source ${repairDebt.source}; oldest ${repairDebt.oldestAgeSec == null ? "unknown" : formatAge(repairDebt.oldestAgeSec, "old")}.`,
        }
      : {
          id: "repair-debt",
          label: "Pipeline repair debt",
          rawCode: "repair_debt",
          state: "unknown",
          currentValue: "Unknown",
          detail: "The status payload did not include repair-debt evidence.",
        },
  ];

  const rows = [...publicationRows, ...dependencyRows, ...controlRows];
  const issueCount = rows.filter((row) => row.state !== "healthy").length;
  return {
    publicationRows,
    dependencyRows,
    controlRows,
    issueCount,
    severity: worstSeverity(rows.map((row) => row.state)),
  };
}

