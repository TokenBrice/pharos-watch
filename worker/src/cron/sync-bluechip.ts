import { BLUECHIP_SLUG_MAP } from "../lib/bluechip-slugs";
import type { BluechipGrade, BluechipRating, BluechipSmidge } from "@shared/types";
import { shouldSkipFreshCache, setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { fetchWithRetry } from "../lib/fetch-retry";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { USER_AGENT } from "../lib/constants";
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
});

const BluechipCoinSchema = z.object({
  grade: z.string(),
  collateralization: z.number().optional(),
  smart_contract_audit: z.boolean().optional(),
  date_of_rating: z.string().optional(),
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
  return html.replace(/<[^>]*>/g, "").trim();
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

export async function syncBluechip(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  if (await shouldSkipFreshCache(db, CACHE_KEY, STALE_HOURS * 3600)) {
    console.log("[bluechip] Cache still fresh, skipping");
    return { itemCount: 0, metadata: JSON.stringify({ reason: "cache-fresh" }) };
  }

  const entries = Object.entries(BLUECHIP_SLUG_MAP);

  // Process in batches of 3 with 500ms delay to avoid flooding backend.bluechip.org
  const BATCH_SIZE = 3;
  const results: PromiseSettledResult<{ pharosId: string; rating: BluechipRating } | null>[] = [];
  let invalidPayloads = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async ([slug, pharosId]) => {
        const res = await fetchWithRetry(
          `${API_BASE}/${slug}`,
          { headers: { "User-Agent": USER_AGENT }, signal },
          2,
          { passthrough404: true }
        );
        if (!res || !res.ok) return null;
        const payload = await res.json();
        const validation = validatePayloadWithSchema(
          BluechipResponseSchema,
          payload,
          `sync-bluechip:${slug}`,
        );
        if (!validation.ok) {
          invalidPayloads++;
          console.warn(`[bluechip] Invalid payload for ${slug}: ${validation.issues}`);
          return null;
        }
        if (validation.data.data.length === 0) return null;

        const coin = validation.data.data[0];
        const grade = coin.grade as BluechipGrade | undefined;
        if (!grade) return null;

        const rating: BluechipRating = {
          grade,
          slug,
          collateralization: (coin.collateralization as number) ?? 0,
          smartContractAudit: (coin.smart_contract_audit as boolean) ?? false,
          dateOfRating: (coin.date_of_rating as string) ?? "",
          dateLastChange: (coin.date_last_change as string) ?? null,
          smidge: extractSmidge(coin),
        };
        return { pharosId, rating };
      })
    );
    results.push(...batchResults);
  }

  const ratingsMap: Record<string, BluechipRating> = {};
  let count = 0;
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      ratingsMap[result.value.pharosId] = result.value.rating;
      count++;
    }
  }

  if (count === 0) {
    console.warn("[bluechip] No ratings fetched, preserving cache");
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "upstream-no-ratings" }),
    };
  }

  await setCacheIfNewer(db, CACHE_KEY, JSON.stringify(ratingsMap), syncStartSec);
  console.log(`[bluechip] Cache updated with ${count} ratings`);
  return {
    itemCount: count,
    metadata: JSON.stringify({
      ratingsFetched: count,
      invalidPayloads,
    }),
  };
}
