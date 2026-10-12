import { edgeShare, type HubExposure } from "@shared/lib/dependency-exposure";
import { formatCurrency } from "@shared/lib/format";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

/**
 * A hub's direct USD is a statistic only when at least one of its links has
 * both a known dependent supply and a known share; otherwise its knownUsd of 0
 * is an absence of data, not a measured zero (R1).
 */
export function hubDirectKnown(exposure: HubExposure, edges: readonly ReportCardsV9DependencyEdge[]): boolean {
  const excluded = new Set(exposure.direct.excludedSupplyUnknownIds);
  return edges.some(edge => edge.from === exposure.hubId && !excluded.has(edge.to) && edgeShare(edge) !== null);
}

/** "$1.23B", "$1.23B (known only)" when incomplete, or the unavailable label. */
export function formatHubDirect(exposure: HubExposure, edges: readonly ReportCardsV9DependencyEdge[], unavailable = "Unavailable"): string {
  if (!hubDirectKnown(exposure, edges)) return unavailable;
  return `${formatCurrency(exposure.direct.knownUsd, 2)}${exposure.direct.complete ? "" : " (known only)"}`;
}
