import {
  assessD1Capacity,
  D1_CAPACITY_FORECAST_WINDOW_SEC,
  D1_PAID_MAX_DATABASE_SIZE_BYTES,
  type D1CapacityObservation,
} from "@shared/lib/d1-capacity";
import {
  D1CapacityAssessmentSchema,
  type D1CapacityAssessment,
} from "@shared/types/status/d1-capacity";
import { getCache, setCacheIfNewer } from "../db-cache";
import { parseJsonObject } from "../json-parse";

export const D1_CAPACITY_CACHE_KEY = "ops:d1-capacity:v1";
const D1_CAPACITY_CACHE_VERSION = 1;
const D1_CAPACITY_OBSERVATION_RETENTION_SEC = 180 * 24 * 60 * 60;

interface CapacityObservationRow {
  observed_at: number;
  database_size_bytes: number;
}

interface CapacityCacheEnvelope {
  version: 1;
  assessment: D1CapacityAssessment;
}

function parseCapacityCache(value: string): D1CapacityAssessment | null {
  const envelope = parseJsonObject<Partial<CapacityCacheEnvelope>>(value);
  if (envelope?.version !== D1_CAPACITY_CACHE_VERSION) return null;
  const parsed = D1CapacityAssessmentSchema.safeParse(envelope.assessment);
  return parsed.success ? parsed.data : null;
}

export const D1_CAPACITY_OBSERVATION_INTERVAL_SEC = 60 * 60;

export async function refreshD1CapacityAssessment(
  db: D1Database,
  databaseSizeBytes: number,
  observedAt: number,
): Promise<D1CapacityAssessment> {
  const observedHour = Math.floor(observedAt / 3600) * 3600;
  await db.batch([
    db
      .prepare(
        `INSERT INTO d1_capacity_observations
           (observed_hour, observed_at, database_size_bytes, maximum_size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(observed_hour) DO UPDATE SET
           observed_at = excluded.observed_at,
           database_size_bytes = excluded.database_size_bytes,
           maximum_size_bytes = excluded.maximum_size_bytes
         WHERE excluded.observed_at >= d1_capacity_observations.observed_at`,
      )
      .bind(
        observedHour,
        observedAt,
        databaseSizeBytes,
        D1_PAID_MAX_DATABASE_SIZE_BYTES,
        observedAt,
      ),
    db
      .prepare("DELETE FROM d1_capacity_observations WHERE observed_at < ?")
      .bind(observedAt - D1_CAPACITY_OBSERVATION_RETENTION_SEC),
  ]);

  const history = await db
    .prepare(
      `SELECT observed_at, database_size_bytes
         FROM d1_capacity_observations
        WHERE observed_at >= ? AND observed_at <= ?
        ORDER BY observed_at ASC`,
    )
    .bind(observedAt - D1_CAPACITY_FORECAST_WINDOW_SEC, observedAt)
    .all<CapacityObservationRow>();
  const current: D1CapacityObservation = { observedAt, databaseSizeBytes };
  const assessment = assessD1Capacity(
    current,
    (history.results ?? []).map((row) => ({
      observedAt: row.observed_at,
      databaseSizeBytes: row.database_size_bytes,
    })),
  );
  const envelope: CapacityCacheEnvelope = {
    version: D1_CAPACITY_CACHE_VERSION,
    assessment,
  };
  await setCacheIfNewer(db, D1_CAPACITY_CACHE_KEY, JSON.stringify(envelope), observedAt);
  return assessment;
}

export async function loadCachedD1CapacityAssessment(
  db: D1Database,
  now: number,
  maxAgeSec = 26 * 60 * 60,
): Promise<D1CapacityAssessment | null> {
  const cached = await getCache(db, D1_CAPACITY_CACHE_KEY);
  if (!cached || now - cached.updatedAt > maxAgeSec) return null;
  return parseCapacityCache(cached.value);
}
