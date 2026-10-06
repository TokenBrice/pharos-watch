import { isRecord } from "./type-guards";

// Sequential cache reads keep full detail bodies out of the batch working set.
// Ten compact entries, each <=128 KiB, also fit comfortably under the Pages proxy cap.
export const DETAIL_SNAPSHOT_INPUT_ENTRY_MAX_BYTES = 128 * 1024;
export const DETAIL_SNAPSHOT_SUPPLY_HISTORY_DAYS = 90;

/** Body provenance wins; otherwise reproduce the HTTP Date/data-age source clock. */
export function detailSnapshotSourceUpdatedAt(data: unknown, headers: Headers, now?: number): number {
  const meta = isRecord(data) && isRecord(data._meta) ? data._meta : null;
  const sourceUpdatedAt = meta?.updatedAt ?? (isRecord(data) ? data.updatedAt : undefined);
  if (typeof sourceUpdatedAt === "number" && Number.isFinite(sourceUpdatedAt) && sourceUpdatedAt >= 0) {
    return sourceUpdatedAt * 1000;
  }
  const date = Date.parse(headers.get("Date") ?? "");
  const age = Number(headers.get("X-Data-Age") ?? 0);
  const edgeAge = Number(headers.get("Age") ?? 0);
  // A server Date already predates edge residence. Without it, subtract both ages.
  const acquiredAt = Number.isFinite(date) ? date : (now ?? Date.now()) - (Number.isFinite(edgeAge) ? edgeAge * 1000 : 0);
  return Math.max(0, acquiredAt - (Number.isFinite(age) ? age * 1000 : 0));
}
