import { z } from "zod";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEventArgs } from "../../lib/structured-log";

export const PRICE_CORROBORATION_OBSERVATIONS_KEY = "price:corroboration-observations:v1";
// The next hourly primary publishes before its replacement corroboration runs.
const STAGING_MAX_AGE_SEC = (60 + 15) * 60;
const ObservationsSchema = z.array(z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  price: z.number().finite().positive(),
  observedAt: z.number().int().positive().nullable(),
  observedAtMode: z.enum(["upstream", "local_fetch", "unknown"]).nullable(),
}));
export type PriceCorroborationObservation = z.infer<typeof ObservationsSchema>[number];

export async function writePriceCorroborationObservations(
  db: D1Database,
  observations: PriceCorroborationObservation[],
  slotStartedAt: number,
  signal?: AbortSignal,
): Promise<void> {
  await setCacheIfNewer(db, PRICE_CORROBORATION_OBSERVATIONS_KEY,
    JSON.stringify(observations), slotStartedAt, signal);
}

export async function loadPriceCorroborationObservations(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<Map<string, PriceCorroborationObservation[]>> {
  const byId = new Map<string, PriceCorroborationObservation[]>();
  try {
    const cached = await getCache(db, PRICE_CORROBORATION_OBSERVATIONS_KEY, signal);
    if (!cached || cached.updatedAt > nowSec || nowSec - cached.updatedAt >= STAGING_MAX_AGE_SEC) return byId;
    const parsed = ObservationsSchema.safeParse(JSON.parse(cached.value));
    if (!parsed.success) return byId;
    for (const observation of parsed.data) {
      const source = getPricingSourceRegistryEntry(observation.source);
      const maxAge = source?.maxTrustedAgeSec;
      if (!source || source.isRetired || source.trustTier === "cached_replay" ||
          !maxAge || maxAge <= 0 || observation.observedAt == null ||
          observation.observedAtMode == null || observation.observedAtMode === "unknown" ||
          observation.observedAt > nowSec || nowSec - observation.observedAt >= maxAge) continue;
      const rows = byId.get(observation.id) ?? [];
      rows.push(observation);
      byId.set(observation.id, rows);
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Hourly price observations unavailable:", error);
  }
  return byId;
}
