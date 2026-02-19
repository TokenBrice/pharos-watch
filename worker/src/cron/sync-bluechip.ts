import { BLUECHIP_SLUG_MAP } from "../../../src/lib/bluechip";
import type { BluechipRating, BluechipSmidge } from "../../../src/lib/types";
import { getCache, setCache } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { USER_AGENT } from "../lib/constants";

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

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function extractSmidge(coin: Record<string, unknown>): BluechipSmidge {
  const smidge: Record<string, string | null> = {};
  for (const cat of SMIDGE_CATEGORIES) {
    const catObj = coin[cat] as { translations?: { summary?: string }[] } | null;
    const summary = catObj?.translations?.[0]?.summary;
    smidge[cat] = summary ? stripHtml(summary) : null;
  }
  return smidge as unknown as BluechipSmidge;
}

export async function syncBluechip(db: D1Database): Promise<void> {
  // Check cache freshness
  const cached = await getCache(db, CACHE_KEY);
  if (cached) {
    const ageSec = Date.now() / 1000 - cached.updatedAt;
    if (ageSec < STALE_HOURS * 3600) {
      console.log("[bluechip] Cache still fresh, skipping");
      return;
    }
  }

  const entries = Object.entries(BLUECHIP_SLUG_MAP);
  const results = await Promise.allSettled(
    entries.map(async ([slug, pharosId]) => {
      const res = await fetchWithRetry(
        `${API_BASE}/${slug}`,
        { headers: { "User-Agent": USER_AGENT } },
        2,
        { passthrough404: true }
      );
      if (!res || !res.ok) return null;
      const json = (await res.json()) as { data?: Record<string, unknown>[] };
      if (!json.data || json.data.length === 0) return null;

      const coin = json.data[0];
      const grade = coin.grade as string | undefined;
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
    return;
  }

  await setCache(db, CACHE_KEY, JSON.stringify(ratingsMap));
  console.log(`[bluechip] Cache updated with ${count} ratings`);
}
