import type { DepegEventsResponse, DepegPendingIncident } from "@shared/types";

export function extractPendingDepegIncidents(
  data: Pick<DepegEventsResponse, "pending"> | undefined,
): DepegPendingIncident[] {
  return [...(data?.pending ?? [])].sort((a, b) => {
    const peakDelta = Math.abs(b.peakSeenBps) - Math.abs(a.peakSeenBps);
    return peakDelta !== 0 ? peakDelta : b.firstSeenAt - a.firstSeenAt;
  });
}

export function mapPendingIncidentsByCoin(
  pendingIncidents: readonly DepegPendingIncident[],
): Map<string, DepegPendingIncident> {
  return new Map(pendingIncidents.map((incident) => [incident.stablecoinId, incident]));
}
