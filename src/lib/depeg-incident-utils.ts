import { numberValue as readNumber } from "@shared/lib/type-guards";

export interface PendingDepegIncident {
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  firstSeenAt: number;
  lastSeenAt?: number | null;
  firstSeenBps?: number | null;
  lastSeenBps?: number | null;
  peakSeenBps?: number | null;
  reason?: string | null;
  ageSec?: number | null;
  expiresAt?: number | null;
  confirmationCategories?: string[];
  missingConfirmationCategories?: string[];
}

type PendingCarrier = {
  pendingIncidents?: unknown;
  pendingDepegs?: unknown;
  pending?: unknown;
};

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizePendingIncident(value: unknown): PendingDepegIncident | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const stablecoinId = typeof row.stablecoinId === "string" ? row.stablecoinId : null;
  const symbol = typeof row.symbol === "string" ? row.symbol : stablecoinId;
  const direction = row.direction === "above" || row.direction === "below" ? row.direction : null;
  const firstSeenAt = readNumber(row.firstSeenAt);
  if (!stablecoinId || !symbol || !direction || firstSeenAt == null) return null;

  return {
    stablecoinId,
    symbol,
    direction,
    firstSeenAt,
    lastSeenAt: readNumber(row.lastSeenAt),
    firstSeenBps: readNumber(row.firstSeenBps),
    lastSeenBps: readNumber(row.lastSeenBps),
    peakSeenBps: readNumber(row.peakSeenBps),
    reason: typeof row.reason === "string" ? row.reason : null,
    ageSec: readNumber(row.ageSec),
    expiresAt: readNumber(row.expiresAt),
    confirmationCategories: readStringArray(row.confirmationCategories ?? row.availableConfirmationCategories),
    missingConfirmationCategories: readStringArray(row.missingConfirmationCategories),
  };
}

export function extractPendingDepegIncidents(data: PendingCarrier | undefined): PendingDepegIncident[] {
  const carrier = data;
  const candidates = carrier?.pendingIncidents ?? carrier?.pendingDepegs ?? carrier?.pending;
  if (!Array.isArray(candidates)) return [];

  return candidates
    .flatMap((item) => {
      const normalized = normalizePendingIncident(item);
      return normalized ? [normalized] : [];
    })
    .sort((a, b) => {
      const aPeak = Math.abs(a.peakSeenBps ?? a.lastSeenBps ?? a.firstSeenBps ?? 0);
      const bPeak = Math.abs(b.peakSeenBps ?? b.lastSeenBps ?? b.firstSeenBps ?? 0);
      if (bPeak !== aPeak) return bPeak - aPeak;
      return b.firstSeenAt - a.firstSeenAt;
    });
}

export function mapPendingIncidentsByCoin(
  pendingIncidents: readonly PendingDepegIncident[],
): Map<string, PendingDepegIncident> {
  return new Map(pendingIncidents.map((incident) => [incident.stablecoinId, incident]));
}
