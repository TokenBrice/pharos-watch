export const STALE_SLOT_ABANDONED_EVENT_TYPE = "scheduled-slot-abandoned";

export function cacheKeySegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "unknown").slice(0, 96);
}

export function staleSlotEventCacheKey(scheduleKey: string): string {
  return `cron:event:${cacheKeySegment(scheduleKey)}:${cacheKeySegment(STALE_SLOT_ABANDONED_EVENT_TYPE)}`;
}
