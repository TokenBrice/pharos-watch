import { logWorkerEventArgs } from "../lib/structured-log";
import { BLUECHIP_SLUG_MAP } from "@shared/lib/bluechip-slugs";
import { includeActiveTrackedIds } from "./shared/exclude-frozen";
import { BluechipGradeSchema } from "@shared/types/core";
import type { BluechipRating, BluechipSmidge } from "@shared/types/market";
import { getCache, shouldSkipFreshCache, setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../lib/response-body";
import { validatePayloadWithSchema } from "../lib/api-schema";
import { USER_AGENT, CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { parseBluechipRatingsCache } from "../lib/bluechip-cache";
import { sleepWithSignal } from "../lib/abort";
import { z } from "zod";

const CACHE_KEY = "bluechip-ratings";
const STALE_HOURS = 6;
const API_BASE = "https://backend.bluechip.org/coin-data";

const SMIDGE_CATEGORIES = [
  "stability",
  "management",
  "implementation",
  "decentralization",
  "governance",
  "externals",
] as const;

const BluechipCategorySchema = z.object({
  translations: z.array(z.object({ summary: z.string().optional() })).optional(),
}).nullable().optional();

const BluechipCoinSchema = z.object({
  grade: BluechipGradeSchema,
  collateralization: z.number().optional(),
  smart_contract_audit: z.boolean().optional(),
  date_of_rating: z.string().nullable().optional(),
  date_last_change: z.string().nullable().optional(),
  stability: BluechipCategorySchema.optional(),
  management: BluechipCategorySchema.optional(),
  implementation: BluechipCategorySchema.optional(),
  decentralization: BluechipCategorySchema.optional(),
  governance: BluechipCategorySchema.optional(),
  externals: BluechipCategorySchema.optional(),
});

const BluechipResponseSchema = z.object({
  data: z.array(BluechipCoinSchema),
});

function stripHtml(html: string): string {
  let text = "";
  let inTag = false;
  for (const char of html) {
    if (char === "<") {
      inTag = true;
      continue;
    }
    if (char === ">") {
      inTag = false;
      continue;
    }
    if (!inTag) {
      text += char;
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

function extractSmidge(coin: Record<string, unknown>): BluechipSmidge {
  const smidge: BluechipSmidge = {
    stability: null,
    management: null,
    implementation: null,
    decentralization: null,
    governance: null,
    externals: null,
  };
  for (const cat of SMIDGE_CATEGORIES) {
    const catObj = coin[cat] as { translations?: { summary?: string }[] } | null;
    const summary = catObj?.translations?.[0]?.summary;
    smidge[cat] = summary ? stripHtml(summary) : null;
  }
  return smidge;
}

async function parseBluechipResponseJson(
  res: Response,
  slug: string,
): Promise<unknown | null> {
  try {
    return await res.json();
  } catch (error) {
    logWorkerEventArgs("handler", "warn", `[bluechip] Failed to parse JSON for ${slug}:`, error);
    return null;
  }
}

export async function syncBluechip(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  if (await shouldSkipFreshCache(db, CACHE_KEY, STALE_HOURS * 3600)) {
    logWorkerEventArgs("handler", "info", "[bluechip] Cache still fresh, skipping");
    return { itemCount: 0, metadata: JSON.stringify({ reason: "cache-fresh" }) };
  }

  if (!(await shouldAttemptFetch(db, CIRCUIT_SOURCE.BLUECHIP))) {
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "bluechip-circuit-open" }) };
  }

  const entries = includeActiveTrackedIds(
    Object.entries(BLUECHIP_SLUG_MAP),
    ([, pharosId]) => pharosId,
  );
  const existingCache = await getCache(db, CACHE_KEY);
  const existingRatings = parseBluechipRatingsCache(
    existingCache?.value,
    "sync-bluechip:existing-cache",
  );

  // Process in batches of 3 with 500ms delay to avoid flooding backend.bluechip.org
  const BATCH_SIZE = 3;
  const results: PromiseSettledResult<{ pharosId: string; rating: BluechipRating } | null>[] = [];
  let invalidPayloads = 0;
  const failedSlugs: { slug: string; reason: string }[] = [];

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    if (i > 0) await sleepWithSignal(500, signal);
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async ([slug, pharosId]) => {
        const res = await fetchWithRetry(
          `${API_BASE}/${slug}`,
          { headers: { "User-Agent": USER_AGENT }, signal },
          2,
          { passthrough404: true }
        );
        if (!res || !res.ok) {
          failedSlugs.push({ slug, reason: res ? `http-${res.status}` : "no-response" });
          await cancelResponseBodyQuietly(res);
          return null;
        }
        const payload = await parseBluechipResponseJson(res, slug);
        if (payload == null) {
          invalidPayloads++;
          failedSlugs.push({ slug, reason: "json-parse-failed" });
          return null;
        }
        const validation = validatePayloadWithSchema(
          BluechipResponseSchema,
          payload,
          `sync-bluechip:${slug}`,
        );
        if (!validation.ok) {
          invalidPayloads++;
          failedSlugs.push({ slug, reason: "invalid-payload" });
          logWorkerEventArgs("handler", "warn", `[bluechip] Invalid payload for ${slug}: ${validation.issues}`);
          return null;
        }
        if (validation.data.data.length === 0) {
          failedSlugs.push({ slug, reason: "empty-data" });
          return null;
        }

        const coin = validation.data.data[0];
        const grade = coin.grade;
        if (!grade) {
          failedSlugs.push({ slug, reason: "no-grade" });
          return null;
        }

        const rating: BluechipRating = {
          grade,
          slug,
          collateralization: coin.collateralization ?? 0,
          smartContractAudit: coin.smart_contract_audit ?? false,
          dateOfRating: coin.date_of_rating ?? "",
          dateLastChange: coin.date_last_change ?? null,
          smidge: extractSmidge(coin),
        };
        return { pharosId, rating };
      })
    );
    results.push(...batchResults);
  }

  const freshRatingsMap: Record<string, BluechipRating> = {};
  let freshCount = 0;
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      freshRatingsMap[result.value.pharosId] = result.value.rating;
      freshCount++;
    }
  }

  const totalEntries = entries.length;
  const partialCoverage = freshCount > 0 && freshCount < totalEntries;
  const ratingsMap: Record<string, BluechipRating> = {
    ...existingRatings,
    ...freshRatingsMap,
  };

  await recordOutcomeSafe(db, CIRCUIT_SOURCE.BLUECHIP, freshCount > 0);

  if (freshCount === 0) {
    logWorkerEventArgs("handler", "warn", "[bluechip] No ratings fetched, preserving cache");
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "upstream-no-ratings", failedSlugs }),
    };
  }

  const cacheResult = await setCacheIfNewer(db, CACHE_KEY, JSON.stringify(ratingsMap), syncStartSec, signal);
  logWorkerEventArgs("handler", "info",
    cacheResult.written
      ? `[bluechip] Cache updated with ${Object.keys(ratingsMap).length} ratings (${freshCount} fresh)`
      : `[bluechip] Cache update skipped; newer row exists (${freshCount} fresh fetched)`,
  );
  return {
    ...(partialCoverage ? { status: "degraded" as const } : {}),
    itemCount: cacheResult.written ? freshCount : 0,
    metadata: JSON.stringify({
      ratingsFetched: freshCount,
      ratingsPublished: cacheResult.written ? Object.keys(ratingsMap).length : 0,
      totalMappedRatings: totalEntries,
      retainedFromCache: Math.max(0, Object.keys(ratingsMap).length - freshCount),
      fallbackMode: partialCoverage ? "partial-cache-merge" : null,
      invalidPayloads,
      cacheKey: CACHE_KEY,
      syncStartSec,
      cacheWriteMode: cacheResult.written ? "published" : "skipped-newer",
      casSkipped: cacheResult.skippedBecauseNewer,
      ...(failedSlugs.length > 0 ? { failedSlugs } : {}),
    }),
  };
}
