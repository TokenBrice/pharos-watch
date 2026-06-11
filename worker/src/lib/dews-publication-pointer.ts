import { getCache, setCacheIfNewer, type CacheWriteResult } from "./db-cache";

const DEWS_PUBLICATION_POINTER_CACHE_KEY = "dews:published-generation";
const DEWS_PUBLICATION_POINTER_SOURCE = "compute-dews";
const DEWS_PUBLICATION_POINTER_STATUS = "published";

interface DewsPublicationPointerPayload {
  updatedAt: number;
  source: typeof DEWS_PUBLICATION_POINTER_SOURCE;
  publishStatus: typeof DEWS_PUBLICATION_POINTER_STATUS;
}

function buildDewsPublicationPointerPayload(updatedAt: number): DewsPublicationPointerPayload {
  return {
    updatedAt,
    source: DEWS_PUBLICATION_POINTER_SOURCE,
    publishStatus: DEWS_PUBLICATION_POINTER_STATUS,
  };
}

function parseDewsPublishedGeneration(
  cached: { value: string; updatedAt: number } | null,
  nowSec: number,
): number | null {
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.value) as Partial<DewsPublicationPointerPayload> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.source !== DEWS_PUBLICATION_POINTER_SOURCE) return null;
    if (parsed.publishStatus !== DEWS_PUBLICATION_POINTER_STATUS) return null;
    if (typeof parsed.updatedAt !== "number" || !Number.isInteger(parsed.updatedAt)) return null;
    if (parsed.updatedAt < 0 || parsed.updatedAt > nowSec) return null;
    if (parsed.updatedAt !== cached.updatedAt) return null;
    return parsed.updatedAt;
  } catch {
    return null;
  }
}

export async function readDewsPublishedGeneration(db: D1Database, nowSec: number): Promise<number | null> {
  const cached = await getCache(db, DEWS_PUBLICATION_POINTER_CACHE_KEY);
  return parseDewsPublishedGeneration(cached, nowSec);
}

export async function writeDewsPublishedGeneration(
  db: D1Database,
  updatedAt: number,
  signal?: AbortSignal,
): Promise<CacheWriteResult> {
  return setCacheIfNewer(
    db,
    DEWS_PUBLICATION_POINTER_CACHE_KEY,
    JSON.stringify(buildDewsPublicationPointerPayload(updatedAt)),
    updatedAt,
    signal,
  );
}
