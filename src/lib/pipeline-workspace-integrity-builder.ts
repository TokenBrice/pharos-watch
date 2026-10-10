import type { StatusResponse } from "@shared/types";
import { classifyPublicationDiagnostic } from "@shared/lib/status-thresholds";
import { formatAge } from "@/lib/pipeline-workspace-format";
import { healthSeverity, worstSeverity, SEVERITY_RANK } from "@/lib/status/workspace-mode";
import type {
  PipelineIntegrityModel,
  PipelineIntegrityRow,
  PipelineSeverity,
} from "@/lib/pipeline-workspace-model";

function unknownIntegrityRow(
  id: string,
  label: string,
  rawCode: string,
  detail: string,
  currentValue = "Unknown",
): PipelineIntegrityRow {
  return { id, label, rawCode, state: "unknown", currentValue, detail };
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
      const diagnostic = classifyPublicationDiagnostic(surface);
      const state: PipelineSeverity = failure ? "unknown" : healthSeverity(diagnostic.status);
      publicationRows.push({
        id: `publication-${surface.surface}`,
        label: surface.label,
        rawCode: surface.surface,
        state,
        currentValue: failure ? "Unavailable" : diagnostic.status === "healthy" ? "Published" : diagnostic.status,
        detail: failure
          ? `${failure.message} (${failure.code}; source ${surface.sourceOfTruth})`
          : `Source ${surface.sourceOfTruth}; latest attempt ${attemptState ?? "not reported"}${diagnostic.reason ? `; ${diagnostic.reason}` : ""}.`,
      });
      failures.delete(surface.surface);
    });
    failures.forEach((failure, surface) => {
      publicationRows.push(unknownIntegrityRow(
        `publication-${surface}`, surface, surface,
        `${failure.message} (${failure.code})`, "Unavailable",
      ));
    });
  } else {
    publicationRows.push(unknownIntegrityRow(
      "publication-unavailable", "Publication health", "publicationHealth",
      "No publication-health payload was returned.",
    ));
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
      dependencyRows.push(unknownIntegrityRow(
        "dependency-empty", "Dependency inventory", "dependencyHealth.dependencies",
        "Dependency health returned an empty inventory.",
      ));
    }
  } else {
    dependencyRows.push(unknownIntegrityRow(
      "dependency-unavailable", "Dependency health", "dependencyHealth",
      "No dependency-health payload was returned.",
    ));
  }

  const stablecoinPublication = data.dataQuality?.stablecoinPublication;
  const repairDebt = data.dataQuality?.repairDebt;
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
      : unknownIntegrityRow(
          "stablecoin-publication", "Stablecoin publication coverage", "stablecoin_publication",
          "The status payload did not include publication coverage.",
        ),
    repairDebt
      ? {
          id: "repair-debt",
          label: "Pipeline repair debt",
          rawCode: "repair_debt",
          state: repairDebt.status === "ok" ? "healthy" : repairDebt.status === "present" ? "watch" : "unknown",
          currentValue: repairDebt.status === "unknown" ? "Unknown" : String(repairDebt.openCount),
          detail: `Source ${repairDebt.source}; oldest ${repairDebt.oldestAgeSec == null ? "unknown" : formatAge(repairDebt.oldestAgeSec, "old")}.`,
        }
      : unknownIntegrityRow(
          "repair-debt", "Pipeline repair debt", "repair_debt",
          "The status payload did not include repair-debt evidence.",
        ),
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
