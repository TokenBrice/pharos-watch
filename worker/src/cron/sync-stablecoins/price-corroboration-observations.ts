import { z } from "zod";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { PriceObservedAtModeSchema } from "@shared/types/price";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEventArgs } from "../../lib/structured-log";

export const PRICE_CORROBORATION_OBSERVATIONS_KEY = "price:corroboration-observations:v1";
export const DEX_REFRESH_CACHE_KEY = "price:dex-refresh:v1";
// Bound the handoff across hourly replacement; source TTLs remain independent.
const STAGING_MAX_AGE_SEC = (60 + 15) * 60;
/** Lead time from the :09/:24/:39/:54 staging slot to the next :15/:30/:45/:00 publication. */
const STAGING_TO_NEXT_PUBLICATION_SEC =
  CRON_SCHEDULE_CADENCES.quarterHourly.intervalSec -
  (CRON_SCHEDULE_CADENCES.statusSelfCheckOffset.offsetSec % CRON_SCHEDULE_CADENCES.quarterHourly.intervalSec);
const ObservationsSchema = z.array(z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  chain: z.string().optional(),
  target: z.string().optional(),
  price: z.number().finite().positive(),
  recentActivity: z.object({
    evidence: z.literal("positive-volume-m5"),
    collectedAt: z.number().int().positive(),
  }).optional(),
  observedAt: z.number().int().positive().nullable(),
  observedAtMode: PriceObservedAtModeSchema.nullable(),
}));
export type PriceCorroborationObservation = z.infer<typeof ObservationsSchema>[number];

// For exact-address display fallback the registry TTL bounds collection age.
function stagingClock(row: PriceCorroborationObservation): number | null {
  if (row.recentActivity) {
    if (row.source !== "dexscreener-exact" || !row.chain || !row.target) return null;
    const { collectedAt } = row.recentActivity;
    if (row.observedAt === null && row.observedAtMode === "unknown") return collectedAt;
    return row.observedAt === collectedAt && row.observedAtMode === "local_fetch" ? collectedAt : null;
  }
  return row.observedAtMode == null || row.observedAtMode === "unknown" ? null : row.observedAt;
}

/** Both v1 readers on rollback require a dated local fetch for qualified DEX activity. */
export function toV1PriceObservation(row: PriceCorroborationObservation): PriceCorroborationObservation {
  if (row.recentActivity && stagingClock(row) != null) {
    return { ...row, observedAt: row.recentActivity.collectedAt, observedAtMode: "local_fetch" };
  }
  return row;
}

function resolveEligibleStagingSourceMaxAgeSec(observation: PriceCorroborationObservation): number | null {
  const source = getPricingSourceRegistryEntry(observation.source);
  const maxAge = source?.maxTrustedAgeSec;
  if (
    !isObservedPrice({ priceSource: observation.source, priceObservedAtMode: observation.observedAtMode }) ||
    !source ||
    source.isRetired ||
    source.trustTier === "cached_replay" ||
    (source.freshnessKind === "upstream" && source.requiresObservedAt && observation.observedAtMode !== "upstream") ||
    typeof maxAge !== "number" ||
    !Number.isFinite(maxAge) ||
    maxAge <= 0
  ) {
    return null;
  }
  return maxAge;
}

/**
 * Whether an observation fetched in a :09/:24/:39/:54 staging slot can still be
 * fresh when the next quarter-hour publication runs. Excludes sources whose
 * whole lifetime is at or below the staging-to-publication lead time (e.g.
 * 5-minute exact-pool/Mento routes) and quotes whose original clock will
 * already have expired by the next publication slot.
 */
function canObservationReachNextPublication(
  observation: PriceCorroborationObservation,
  slotStartedAt: number,
): boolean {
  const maxAge = resolveEligibleStagingSourceMaxAgeSec(observation);
  if (maxAge == null || maxAge <= STAGING_TO_NEXT_PUBLICATION_SEC) return false;
  const clock = stagingClock(observation);
  if (clock == null) return false;
  return clock + maxAge > slotStartedAt + STAGING_TO_NEXT_PUBLICATION_SEC;
}

export function filterStageablePriceObservations(
  observations: readonly PriceCorroborationObservation[],
  slotStartedAt: number,
): PriceCorroborationObservation[] {
  return observations.filter((observation) => canObservationReachNextPublication(observation, slotStartedAt));
}

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
    JSON.stringify(observations.map(toV1PriceObservation)), slotStartedAt, signal);
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
      const maxAge = resolveEligibleStagingSourceMaxAgeSec(observation);
      if (maxAge == null) {
        summary.discarded.sourceIneligible++;
        continue;
      }
      const clock = stagingClock(observation);
      if (clock == null) {
        summary.discarded.unknownTime++;
        continue;
      }
      if (clock > nowSec) {
        summary.discarded.futureTime++;
        continue;
      }
      const headroom = maxAge - (nowSec - clock);
      if (headroom <= 0) {
        summary.discarded.sourceExpired++;
        continue;
      }
      summary.eligibleObservationCount++;
      summary.minimumFreshnessHeadroomSec = Math.min(summary.minimumFreshnessHeadroomSec ?? headroom, headroom);
      const rows = byId.get(observation.id) ?? [];
      rows.push(observation.recentActivity ? { ...observation, observedAt: null, observedAtMode: "unknown" } : observation);
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
    for (const row of [...observations].sort((a, b) => stagingClock(b)! - stagingClock(a)!)) {
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
      const headroom = getPricingSourceRegistryEntry(row.source)!.maxTrustedAgeSec! - (nowSec - stagingClock(row)!);
      summary.minimumFreshnessHeadroomSec = Math.min(summary.minimumFreshnessHeadroomSec ?? Infinity, headroom);
    }
  }
  return hourly;
}
