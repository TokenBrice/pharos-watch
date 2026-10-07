import type { ScheduledWorkerRole } from "@shared/lib/scheduled-runner-registry";
import { getCacheUpdatedAt, setCacheIfAbsent } from "./db-cache";

const WORKER_VERSION_FIRST_SEEN_PREFIX = "worker-version-first-seen:";
const WORKER_VERSION_ACTIVATED_PREFIX = "worker-version-activated:";

let scheduledVersionFirstSeenAttemptedInIsolate = false;

function workerVersionFirstSeenCacheKey(workerVersion: string): string {
  return `${WORKER_VERSION_FIRST_SEEN_PREFIX}${workerVersion}`;
}

function workerVersionActivatedCacheKey(workerVersion: string): string {
  return `${WORKER_VERSION_ACTIVATED_PREFIX}${workerVersion}`;
}

export async function recordScheduledWorkerVersionFirstSeen(
  db: D1Database,
  workerVersion: string | null | undefined,
  firstSeenAt: number,
): Promise<void> {
  const version = workerVersion?.trim();
  if (!version || !Number.isSafeInteger(firstSeenAt) || firstSeenAt <= 0) return;
  if (scheduledVersionFirstSeenAttemptedInIsolate) return;
  scheduledVersionFirstSeenAttemptedInIsolate = true;
  await setCacheIfAbsent(
    db,
    workerVersionFirstSeenCacheKey(version),
    JSON.stringify({ workerVersion: version, firstSeenAt }),
    firstSeenAt,
  );
}

export async function getWorkerVersionFirstSeenAt(
  db: D1Database,
  workerVersion: string | null | undefined,
): Promise<number | null> {
  const version = workerVersion?.trim();
  if (!version) return null;
  const firstSeenAt = await getCacheUpdatedAt(db, workerVersionFirstSeenCacheKey(version));
  return Number.isSafeInteger(firstSeenAt) && (firstSeenAt ?? 0) > 0 ? firstSeenAt : null;
}

export async function getWorkerVersionActivatedAt(
  db: D1Database,
  workerVersion: string | null | undefined,
): Promise<number | null> {
  const version = workerVersion?.trim();
  if (!version) return null;
  const activatedAt = await getCacheUpdatedAt(db, workerVersionActivatedCacheKey(version));
  return Number.isSafeInteger(activatedAt) && (activatedAt ?? 0) > 0 ? activatedAt : null;
}

export interface ActiveWorkerVersionMarker {
  scriptName: string;
  workerVersion: string;
  activatedAt: number;
}

/** Deployment alone writes these markers after proving sole 100% activation. */
export async function getActiveWorkerVersionMarker(
  db: D1Database,
  role: ScheduledWorkerRole,
): Promise<ActiveWorkerVersionMarker | null> {
  const row = await db.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
    .bind(`worker-active-version:${role}`)
    .first<{ value: string; updated_at: number }>();
  if (!row) return null;
  try {
    const marker: unknown = JSON.parse(row.value);
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
    const value = marker as Record<string, unknown>;
    const scriptName = role === "public" ? "stablecoin-api" : "stablecoin-heavy";
    if (value.worker !== role || value.scriptName !== scriptName
      || typeof value.workerVersion !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.workerVersion)
      || !Number.isSafeInteger(value.activatedAt) || (value.activatedAt as number) <= 0
      || value.activatedAt !== row.updated_at) return null;
    return { scriptName, workerVersion: value.workerVersion, activatedAt: value.activatedAt as number };
  } catch {
    return null;
  }
}
