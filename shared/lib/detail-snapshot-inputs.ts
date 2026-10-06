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
export function detailSnapshotSourceUpdatedAt(data: unknown, headers: Headers, now?: number): number {
  const meta = isRecord(data) && isRecord(data._meta) ? data._meta : null;
  const sourceUpdatedAt = meta?.updatedAt ?? (isRecord(data) ? data.updatedAt : undefined);
  if (typeof sourceUpdatedAt === "number" && Number.isFinite(sourceUpdatedAt) && sourceUpdatedAt >= 0) {
    return sourceUpdatedAt * 1000;
  }
  const absoluteSourceClock = headers.get("X-Data-Updated-At");
  if (absoluteSourceClock !== null) {
    const seconds = parseDetailSnapshotSourceClock(absoluteSourceClock);
    if (seconds === null) {
      throw new Error("Invalid X-Data-Updated-At source clock");
    }
    return seconds * 1000;
  }
  const date = Date.parse(headers.get("Date") ?? "");
  const age = Number(headers.get("X-Data-Age") ?? 0);
  const edgeAge = Number(headers.get("Age") ?? 0);
  // Cloudflare rewrites Date on cached responses; X-Data-Age remains the age
  // at origin acquisition. Subtract edge residence with or without Date.
  const acquiredAt = (Number.isFinite(date) ? date : (now ?? Date.now())) -
    (Number.isFinite(edgeAge) ? edgeAge * 1000 : 0);
  return Math.max(0, acquiredAt - (Number.isFinite(age) ? age * 1000 : 0));
}
