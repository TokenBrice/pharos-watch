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
