import type { ReportCardsSnapshotInputs } from "../report-cards-snapshot-inputs";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";

export function createV9CaptureDexSnapshot(
  legacy: Pick<ReportCardsFixedInput, "dexLiqMap" | "inputMethodologyVersions">,
  observedAt: number,
): ReportCardsSnapshotInputs["dexLiquiditySnapshot"] {
  return {
    latestUpdatedAt: observedAt,
    map: Object.fromEntries(Object.entries(legacy.dexLiqMap).map(([id, row]) => [id, {
      liquidityScore: row.liquidityScore, concentrationHhi: row.concentrationHhi,
      poolCount: row.poolCount, chainCount: row.chainCount,
      exitRouteObservations: row.exitRouteObservations,
      exitRouteObservationCoverage: row.exitRouteObservationCoverage,
      methodologyVersion: legacy.inputMethodologyVersions.dexLiquidity[0],
    }])),
  };
}
