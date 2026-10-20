import { isRecord } from "./type-guards";

// Sequential cache reads keep full detail bodies out of the batch working set.
// Ten compact entries, each <=128 KiB, also fit comfortably under the Pages proxy cap.
export const DETAIL_SNAPSHOT_INPUT_ENTRY_MAX_BYTES = 128 * 1024;
export const DETAIL_SNAPSHOT_SUPPLY_HISTORY_DAYS = 90;

/** Parse a nonnegative decimal Unix clock without regex backtracking. */
export function parseDetailSnapshotSourceClock(value: string): number | null {
  if (value.length === 0) return null;
  let decimalSeen = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 46) {
      if (decimalSeen || index === 0 || index === value.length - 1) return null;
      decimalSeen = true;
    } else if (code < 48 || code > 57) {
      return null;
    }
  }
  const seconds = Number(value);
  return Number.isFinite(seconds * 1000) ? seconds : null;
}

/** Body provenance wins, then the origin clock, then legacy HTTP age reconstruction. */
export function detailSnapshotSourceUpdatedAt(data: unknown, headers: Headers): number | null {
  const meta = isRecord(data) && isRecord(data._meta) ? data._meta : null;
  const sourceUpdatedAt = meta?.updatedAt ?? (isRecord(data) ? data.updatedAt : undefined);
  if (typeof sourceUpdatedAt === "number" && Number.isFinite(sourceUpdatedAt * 1000) && sourceUpdatedAt >= 0) {
    return sourceUpdatedAt * 1000;
  }
  const absoluteSourceClock = headers.get("X-Data-Updated-At");
  if (absoluteSourceClock !== null) {
    const seconds = parseDetailSnapshotSourceClock(absoluteSourceClock);
    return seconds === null ? null : seconds * 1000;
  }
  const date = Date.parse(headers.get("Date") ?? "");
  const sourceAge = headers.get("X-Data-Age");
  const edgeAge = headers.get("Age");
  const ageSeconds = sourceAge === null ? null : parseDetailSnapshotSourceClock(sourceAge);
  const edgeAgeSeconds = edgeAge === null ? null : parseDetailSnapshotSourceClock(edgeAge);
  if (!Number.isFinite(date) || ageSeconds === null || edgeAgeSeconds === null) return null;
  // Cloudflare rewrites Date on cached responses; subtract both the origin's
  // source age and edge residence only when all legacy evidence is proven.
  return Math.max(0, date - edgeAgeSeconds * 1000 - ageSeconds * 1000);
}
