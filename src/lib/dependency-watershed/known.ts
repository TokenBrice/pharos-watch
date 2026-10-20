import { exposureKnown, type HubExposure } from "@shared/lib/dependency-exposure";
import type { DependencyClaimAvailability } from "@shared/lib/dependency-hubs-model";
import { formatCurrency } from "@shared/lib/format";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

export function hubDirectKnown(exposure: HubExposure, edges: readonly ReportCardsV9DependencyEdge[]): boolean {
  return exposureKnown(exposure.direct, edges.filter(edge => edge.from === exposure.hubId));
}

/** Classified serial subtotals keep absent supply distinct from an empty category. */
export function formatClaimSubtotal(knownUsd: number, availability: DependencyClaimAvailability): string {
  if (!availability.known) return "Unavailable";
  return `${formatCurrency(knownUsd, 2)}${availability.complete ? "" : " (known only)"}`;
}

/** "$1.23B", "$1.23B (known only)" when incomplete, or the unavailable label. */
export function formatHubDirect(exposure: HubExposure, edges: readonly ReportCardsV9DependencyEdge[], unavailable = "Unavailable"): string {
  if (!hubDirectKnown(exposure, edges)) return unavailable;
  return `${formatCurrency(exposure.direct.knownUsd, 2)}${exposure.direct.complete ? "" : " (known only)"}`;
}
