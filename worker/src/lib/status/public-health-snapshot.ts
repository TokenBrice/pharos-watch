import { HealthResponseSchema, type HealthResponse } from "@shared/types/status";
import { z } from "zod";
import { STATUS_SYSTEM_FRESHNESS_SEC } from "../status-reliability-shared";
import { loadStatusSnapshotPayload, writeStatusSnapshotPayload, type StatusSnapshotLoadResult } from "./status-snapshot-cache";

/**
 * The admitted public-health projection published by the status self-check.
 * `/api/health` reads only this key (plus its live scheduler overlay), never
 * the operator assessment envelope in `status:raw-snapshot:v1`.
 */
export const STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY = "status:public-health-snapshot:v1";
export const STATUS_PUBLIC_HEALTH_SNAPSHOT_MAX_AGE_SEC = STATUS_SYSTEM_FRESHNESS_SEC;

const StatusPublicHealthSnapshotPayloadSchema = z.object({
  version: z.literal(1),
  producedAt: z.number().finite(),
  publicHealth: HealthResponseSchema,
});

export function loadStatusPublicHealthSnapshot(
  db: D1Database,
  now: number,
  maxAgeSec = STATUS_PUBLIC_HEALTH_SNAPSHOT_MAX_AGE_SEC,
): Promise<StatusSnapshotLoadResult<z.output<typeof StatusPublicHealthSnapshotPayloadSchema>>> {
  return loadStatusSnapshotPayload(
    db, STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY, StatusPublicHealthSnapshotPayloadSchema, now, maxAgeSec,
  );
}

export function writeStatusPublicHealthSnapshot(
  db: D1Database,
  now: number,
  publicHealth: HealthResponse,
): Promise<boolean> {
  return writeStatusSnapshotPayload(db, STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY, now, {
    version: 1,
    producedAt: now,
    publicHealth,
  });
}
