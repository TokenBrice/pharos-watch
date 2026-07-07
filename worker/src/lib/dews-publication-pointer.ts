import { getCache, setCacheIfNewer, type CacheWriteResult } from "./db-cache";

const DEWS_PUBLICATION_POINTER_CACHE_KEY = "dews:published-generation";
const DEWS_PUBLICATION_POINTER_SOURCE = "compute-dews";
const DEWS_PUBLICATION_POINTER_STATUS = "published";

interface DewsPublicationPointerPayload {
  updatedAt: number;
  source: typeof DEWS_PUBLICATION_POINTER_SOURCE;
  publishStatus: typeof DEWS_PUBLICATION_POINTER_STATUS;
}

export type DewsPublishedGenerationResult =
  | { status: "ok"; computedAt: number }
  | { status: "no-pointer" }
  | { status: "invalid-pointer"; reason: string }
  | { status: "read-failed"; error: string };

function buildDewsPublicationPointerPayload(updatedAt: number): DewsPublicationPointerPayload {
  return {
    updatedAt,
    source: DEWS_PUBLICATION_POINTER_SOURCE,
    publishStatus: DEWS_PUBLICATION_POINTER_STATUS,
  };
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDewsPublishedGeneration(
  cached: { value: string; updatedAt: number } | null,
  nowSec: number,
): DewsPublishedGenerationResult {
  if (!cached) return { status: "no-pointer" };
  try {
    const parsed = JSON.parse(cached.value) as Partial<DewsPublicationPointerPayload> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "invalid-pointer", reason: "payload is not an object" };
    }
    if (parsed.source !== DEWS_PUBLICATION_POINTER_SOURCE) {
      return { status: "invalid-pointer", reason: "payload source is not compute-dews" };
    }
    if (parsed.publishStatus !== DEWS_PUBLICATION_POINTER_STATUS) {
      return { status: "invalid-pointer", reason: "payload publishStatus is not published" };
    }
    if (typeof parsed.updatedAt !== "number" || !Number.isInteger(parsed.updatedAt)) {
      return { status: "invalid-pointer", reason: "payload updatedAt is not an integer" };
    }
    if (parsed.updatedAt < 0) {
      return { status: "invalid-pointer", reason: "payload updatedAt is negative" };
    }
    if (parsed.updatedAt > nowSec) {
      return { status: "invalid-pointer", reason: "payload updatedAt is in the future" };
    }
    if (parsed.updatedAt !== cached.updatedAt) {
      return { status: "invalid-pointer", reason: "payload updatedAt does not match cache updated_at" };
    }
    return { status: "ok", computedAt: parsed.updatedAt };
  } catch (error) {
    return { status: "invalid-pointer", reason: `payload is not valid JSON: ${errorToMessage(error)}` };
  }
}

export async function readDewsPublishedGenerationResult(
  db: D1Database,
  nowSec: number,
): Promise<DewsPublishedGenerationResult> {
  try {
    const cached = await getCache(db, DEWS_PUBLICATION_POINTER_CACHE_KEY);
    return parseDewsPublishedGeneration(cached, nowSec);
  } catch (error) {
    return { status: "read-failed", error: errorToMessage(error) };
  }
}

export async function readDewsPublishedGeneration(db: D1Database, nowSec: number): Promise<number | null> {
  const result = await readDewsPublishedGenerationResult(db, nowSec);
  return result.status === "ok" ? result.computedAt : null;
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
