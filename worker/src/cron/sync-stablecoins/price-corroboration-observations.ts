import { z } from "zod";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEventArgs } from "../../lib/structured-log";

export const PRICE_CORROBORATION_OBSERVATIONS_KEY = "price:corroboration-observations:v1";
export const DEX_REFRESH_CACHE_KEY = "price:dex-refresh:v1";
// Bound the handoff across hourly replacement; source TTLs remain independent.
const STAGING_MAX_AGE_SEC = (60 + 15) * 60;
const ObservationsSchema = z.array(z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  chain: z.string().optional(),
  target: z.string().optional(),
  price: z.number().finite().positive(),
  observedAt: z.number().int().positive().nullable(),
  observedAtMode: z.enum(["upstream", "local_fetch", "unknown"]).nullable(),
}));
export type PriceCorroborationObservation = z.infer<typeof ObservationsSchema>[number];

export interface PriceObservationEffectiveness {
  stagingStatus: "missing" | "future" | "expired" | "invalid" | "read-error" | "ok";
  stagingSlotStartedAt: number | null;
  hourlyStagingStatus?: PriceObservationEffectiveness["stagingStatus"];
  dexStagingStatus?: PriceObservationEffectiveness["stagingStatus"];
  stagingAgeSec: number | null;
  loadedObservationCount: number | null;
  eligibleObservationCount: number;
  discarded: { sourceIneligible: number; unknownTime: number; futureTime: number; sourceExpired: number; superseded: number };
  publication: {
    alreadyPriced: number; assetAbsent: number; policyRejected: number;
    selected: number; notNeededAfterSelection: number;
  };
  minimumFreshnessHeadroomSec: number | null;
}

export async function writePriceCorroborationObservations(
  db: D1Database,
  observations: PriceCorroborationObservation[],
  slotStartedAt: number,
  signal?: AbortSignal,
): Promise<void> {
  await setCacheIfNewer(db, PRICE_CORROBORATION_OBSERVATIONS_KEY,
    JSON.stringify(observations), slotStartedAt, signal);
}

async function loadObservationCache(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
  key = PRICE_CORROBORATION_OBSERVATIONS_KEY,
): Promise<{ byId: Map<string, PriceCorroborationObservation[]>; summary: PriceObservationEffectiveness }> {
  const byId = new Map<string, PriceCorroborationObservation[]>();
  const summary: PriceObservationEffectiveness = {
    stagingStatus: "missing", stagingSlotStartedAt: null, stagingAgeSec: null,
    loadedObservationCount: null, eligibleObservationCount: 0,
    discarded: { sourceIneligible: 0, unknownTime: 0, futureTime: 0, sourceExpired: 0, superseded: 0 },
    publication: { alreadyPriced: 0, assetAbsent: 0, policyRejected: 0, selected: 0, notNeededAfterSelection: 0 },
    minimumFreshnessHeadroomSec: null,
  };
  const result = { byId, summary };
  try {
    const cached = await getCache(db, key, signal);
    if (!cached) return result;
    summary.stagingSlotStartedAt = cached.updatedAt;
    summary.stagingAgeSec = nowSec - cached.updatedAt;
    if (cached.updatedAt > nowSec) {
      summary.stagingStatus = "future";
      return result;
    }
    if (nowSec - cached.updatedAt >= STAGING_MAX_AGE_SEC) {
      summary.stagingStatus = "expired";
      return result;
    }
    summary.stagingStatus = "invalid";
    const payload = JSON.parse(cached.value);
    const parsed = ObservationsSchema.safeParse(key === DEX_REFRESH_CACHE_KEY ? payload?.observations : payload);
    if (!parsed.success) return result;
    summary.stagingStatus = "ok";
    summary.loadedObservationCount = parsed.data.length;
    for (const observation of parsed.data) {
      const source = getPricingSourceRegistryEntry(observation.source);
      const maxAge = source?.maxTrustedAgeSec;
      if (!source || source.isRetired || source.trustTier === "cached_replay" || !maxAge || maxAge <= 0) {
        summary.discarded.sourceIneligible++;
        continue;
      }
      if (observation.observedAt == null || observation.observedAtMode == null || observation.observedAtMode === "unknown") {
        summary.discarded.unknownTime++;
        continue;
      }
      if (observation.observedAt > nowSec) {
        summary.discarded.futureTime++;
        continue;
      }
      const headroom = maxAge - (nowSec - observation.observedAt);
      if (headroom <= 0) {
        summary.discarded.sourceExpired++;
        continue;
      }
      summary.eligibleObservationCount++;
      summary.minimumFreshnessHeadroomSec = Math.min(summary.minimumFreshnessHeadroomSec ?? headroom, headroom);
      const rows = byId.get(observation.id) ?? [];
      rows.push(observation);
      byId.set(observation.id, rows);
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
    if (summary.stagingStatus !== "invalid") summary.stagingStatus = "read-error";
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Hourly price observations unavailable:", error);
  }
  return result;
}

export async function loadPriceCorroborationObservations(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<{ byId: Map<string, PriceCorroborationObservation[]>; summary: PriceObservationEffectiveness }> {
  const hourly = await loadObservationCache(db, nowSec, signal);
  const dex = await loadObservationCache(db, nowSec, signal, DEX_REFRESH_CACHE_KEY);
  for (const [id, observations] of dex.byId) {
    hourly.byId.set(id, [...(hourly.byId.get(id) ?? []), ...observations]);
  }
  let superseded = 0;
  for (const [id, observations] of hourly.byId) {
    const newestBySource = new Map<string, PriceCorroborationObservation>();
    for (const row of [...observations].sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))) {
      if (newestBySource.has(row.source)) superseded++;
      else newestBySource.set(row.source, row);
    }
    // Older conflicting prices from the same source must never corroborate
    // another candidate or become fallback evidence after its newest row fails.
    hourly.byId.set(id, [...newestBySource.values()]);
  }
  const summary = hourly.summary;
  summary.hourlyStagingStatus = summary.stagingStatus;
  summary.dexStagingStatus = dex.summary.stagingStatus;
  if (dex.summary.stagingStatus === "ok") {
    summary.stagingStatus = "ok";
    summary.stagingSlotStartedAt = Math.max(summary.hourlyStagingStatus === "ok" ? summary.stagingSlotStartedAt ?? 0 : 0, dex.summary.stagingSlotStartedAt ?? 0);
    summary.stagingAgeSec = nowSec - summary.stagingSlotStartedAt;
    summary.loadedObservationCount = (summary.loadedObservationCount ?? 0) + (dex.summary.loadedObservationCount ?? 0);
  }
  for (const reason of ["sourceIneligible", "unknownTime", "futureTime", "sourceExpired"] as const) {
    summary.discarded[reason] += dex.summary.discarded[reason];
  }
  summary.discarded.superseded = superseded;
  summary.eligibleObservationCount = [...hourly.byId.values()].reduce((count, rows) => count + rows.length, 0);
  summary.minimumFreshnessHeadroomSec = null;
  for (const rows of hourly.byId.values()) {
    for (const row of rows) {
      const headroom = getPricingSourceRegistryEntry(row.source)!.maxTrustedAgeSec! - (nowSec - row.observedAt!);
      summary.minimumFreshnessHeadroomSec = Math.min(summary.minimumFreshnessHeadroomSec ?? Infinity, headroom);
    }
  }
  return hourly;
}
