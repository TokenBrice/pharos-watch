import { PUBLIC_DATASET_CURRENT_EXPORTS } from "@/lib/datasets/public-dataset-current";
import { numberValue } from "@shared/lib/type-guards";
import { buildHomepageHeroSnapshot, type HomepageHeroSnapshot } from "@shared/lib/homepage-hero-snapshot";
import { classifySupplyCoverage, parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import { z } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { toSiteDataPath } from "@shared/lib/site-data-lane";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { getCacheRatioThresholds } from "@shared/lib/status-thresholds";
import { buildTotalMcapChartRows, TOTAL_MCAP_COHORT_IDS, TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS } from "@shared/lib/total-mcap-chart";
import { StablecoinChartResponseSchema, SupplyHistoryResponseSchema } from "@shared/types/market";
import { HomepageHistorySchema, type HomepageLaneMeta } from "@shared/types/homepage";

interface TopStablecoinsDatasetRow {
  id?: unknown;
  pegType?: unknown;
  circulatingUsd?: unknown;
  supplyProvenance?: unknown;
}

interface TopStablecoinsDataset {
  _meta?: {
    asOfISO?: unknown;
  };
  rows?: TopStablecoinsDatasetRow[];
}

export type { HomepageHeroSnapshot } from "@shared/lib/homepage-hero-snapshot";

const TOP_STABLECOINS_DATASET = PUBLIC_DATASET_CURRENT_EXPORTS["top-stablecoins"] as TopStablecoinsDataset;

function asOfISO(): string | null {
  const value = TOP_STABLECOINS_DATASET._meta?.asOfISO;
  return typeof value === "string" && value ? value : null;
}

export async function getHomepageHeroSnapshot(): Promise<HomepageHeroSnapshot> {
  const rows = Array.isArray(TOP_STABLECOINS_DATASET.rows) ? TOP_STABLECOINS_DATASET.rows : [];
  const snapshot = buildHomepageHeroSnapshot(
    rows.flatMap((row) => {
      if (typeof row.id !== "string" || typeof row.pegType !== "string") return [];
      return [{
        id: row.id,
        pegType: row.pegType,
        circulatingUsd: numberValue(row.circulatingUsd),
        // Rows exported before provenance existed (or with malformed metadata) stay unknown, never complete.
        supplyCoverage: classifySupplyCoverage(parseSupplyObservationProvenance(row.supplyProvenance).provenance),
      }];
    }),
    asOfISO(),
  );
  // Build-only acquisition: five existing transports, no new cron/upstream
  // fanout. Never seed their global query keys with this bounded view.
  const total = fetchDatedHistory(API_PATHS.stablecoinCharts(), "stablecoin-charts", API_FRESHNESS_MAX_AGE_SEC.stablecoinCharts, StablecoinChartResponseSchema);
  const cohorts = Object.values(TOTAL_MCAP_COHORT_IDS).map((id) =>
    fetchDatedHistory(API_PATHS.supplyHistory(id, TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS), "supply-history", API_FRESHNESS_MAX_AGE_SEC.supplyHistory, SupplyHistoryResponseSchema));
  const [aggregate, usdt, usdc, usds, dai] = await Promise.all([total, ...cohorts] as const);
  if (aggregate.data && usdt && usdc && usds && dai) {
    snapshot.history = HomepageHistorySchema.parse({
      // A bounded recent preview retains every point and every gap in its window.
      rows: buildTotalMcapChartRows(aggregate.data, {
        usdtHistory: usdt.data, usdcHistory: usdc.data, usdsHistory: usds.data, daiHistory: dai.data,
      }).slice(-90),
      sources: { total: aggregate.meta, usdt: usdt.meta, usdc: usdc.meta, usds: usds.meta, dai: dai.meta },
    });
  }
  return snapshot;
}

async function fetchDatedHistory<T>(path: string, source: string, maxAgeSec: number, schema: z.ZodType<T>): Promise<{ data: T | null; meta: HomepageLaneMeta }> {
  const assessedAt = Math.floor(Date.now() / 1000);
  const ratios = getCacheRatioThresholds(source);
  const meta: HomepageLaneMeta = {
    source, updatedAt: null, ageSeconds: null, assessedAt,
    freshBudgetSec: maxAgeSec * ratios.degraded, degradedBudgetSec: maxAgeSec * ratios.stale,
    status: "unknown", reason: "dated-build-fallback", warning: null,
  };
  try {
    const response = await fetch(new URL(toSiteDataPath(path)!, SITE_ORIGIN), {
      headers: { Origin: SITE_ORIGIN }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) { await response.body?.cancel(); return { data: null, meta: { ...meta, reason: `source-http-${response.status}` } }; }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) return { data: null, meta: { ...meta, reason: "invalid-source-payload" } };
    const timestamp = response.headers.get("X-Data-Updated-At");
    const updatedAt = timestamp !== null ? Number(timestamp) : NaN;
    if (Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt <= assessedAt) {
      return { data: parsed.data, meta: { ...meta, updatedAt, ageSeconds: assessedAt - updatedAt, status: "stale" } };
    }
    return { data: parsed.data, meta: { ...meta, reason: "missing-generation" } };
  } catch {
    return { data: null, meta: { ...meta, reason: "source-read-failed" } };
  }
}
