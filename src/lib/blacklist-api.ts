import { apiFetch } from "@/lib/api";
import { BlacklistResponseSchema, type BlacklistEvent, type BlacklistResponse } from "@shared/types";

export const BLACKLIST_API_PAGE_SIZE = 1000;

function buildBlacklistPath(offset = 0): string {
  const params = new URLSearchParams({ limit: String(BLACKLIST_API_PAGE_SIZE) });
  if (offset > 0) params.set("offset", String(offset));
  return `/api/blacklist?${params.toString()}`;
}

function dedupeBlacklistEvents(events: BlacklistEvent[]): BlacklistEvent[] {
  const seen = new Set<string>();
  const deduped: BlacklistEvent[] = [];

  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    deduped.push(event);
  }

  return deduped;
}

/**
 * Hydrates the full blacklist history by walking the API's capped pagination.
 * The blacklist page derives long-range charts and stats from the full dataset.
 */
export async function fetchAllBlacklistEvents(): Promise<BlacklistResponse> {
  const firstPage = await apiFetch(buildBlacklistPath(), BlacklistResponseSchema);

  if (firstPage.total <= BLACKLIST_API_PAGE_SIZE) {
    return firstPage;
  }

  const offsets: number[] = [];
  for (let offset = BLACKLIST_API_PAGE_SIZE; offset < firstPage.total; offset += BLACKLIST_API_PAGE_SIZE) {
    offsets.push(offset);
  }

  const remainingPages = await Promise.all(
    offsets.map((offset) => apiFetch(buildBlacklistPath(offset), BlacklistResponseSchema)),
  );

  return {
    ...firstPage,
    events: dedupeBlacklistEvents([...firstPage.events, ...remainingPages.flatMap((page) => page.events)]),
    total: Math.max(firstPage.total, ...remainingPages.map((page) => page.total)),
  };
}
