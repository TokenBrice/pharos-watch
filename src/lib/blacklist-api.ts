import { ApiFetchError, apiFetch } from "@/lib/api";
import { BlacklistResponseSchema, type BlacklistEvent, type BlacklistResponse } from "@shared/types";

export const BLACKLIST_API_PAGE_SIZE = 1000;
const BLACKLIST_API_BATCH_SIZE = 3;
const BLACKLIST_API_MAX_RETRIES = 2;
const BLACKLIST_API_RETRY_BASE_MS = 750;

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

function isRetryableBlacklistError(error: unknown): boolean {
  if (error instanceof ApiFetchError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  return error instanceof TypeError;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBlacklistPage(offset = 0): Promise<BlacklistResponse> {
  const path = buildBlacklistPath(offset);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await apiFetch(path, BlacklistResponseSchema);
    } catch (error) {
      if (!isRetryableBlacklistError(error) || attempt >= BLACKLIST_API_MAX_RETRIES) {
        throw error;
      }

      await sleep(BLACKLIST_API_RETRY_BASE_MS * 2 ** attempt);
    }
  }
}

/**
 * Hydrates the full blacklist history by walking the API's capped pagination.
 * Remaining pages are fetched in small batches so transient rate limits do not
 * take down the entire page.
 */
export async function fetchAllBlacklistEvents(): Promise<BlacklistResponse> {
  const firstPage = await fetchBlacklistPage();

  if (firstPage.total <= BLACKLIST_API_PAGE_SIZE) {
    return firstPage;
  }

  const offsets: number[] = [];
  for (let offset = BLACKLIST_API_PAGE_SIZE; offset < firstPage.total; offset += BLACKLIST_API_PAGE_SIZE) {
    offsets.push(offset);
  }

  const remainingPages: BlacklistResponse[] = [];
  for (let index = 0; index < offsets.length; index += BLACKLIST_API_BATCH_SIZE) {
    const batchOffsets = offsets.slice(index, index + BLACKLIST_API_BATCH_SIZE);
    const batchPages = await Promise.all(batchOffsets.map((offset) => fetchBlacklistPage(offset)));
    remainingPages.push(...batchPages);
  }

  return {
    ...firstPage,
    events: dedupeBlacklistEvents([...firstPage.events, ...remainingPages.flatMap((page) => page.events)]),
    total: Math.max(firstPage.total, ...remainingPages.map((page) => page.total)),
  };
}
