import type { ScheduledWorkerRole } from "@shared/lib/scheduled-runner-registry";

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
  return parseActiveWorkerVersionMarker(row, role);
}

/** Shared by binding and offline readers of the deploy-owned activation row. */
export function parseActiveWorkerVersionMarker(
  row: unknown,
  role: ScheduledWorkerRole,
): ActiveWorkerVersionMarker | null {
  if (!row || typeof row !== "object" || !("value" in row) || typeof row.value !== "string"
    || !("updated_at" in row) || typeof row.updated_at !== "number") return null;
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
