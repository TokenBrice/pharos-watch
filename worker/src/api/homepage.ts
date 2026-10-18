import { z } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { API_CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { buildLiveHomepageHeroSnapshot } from "@shared/lib/homepage-hero-snapshot";
import { getDisplayedPsi } from "@shared/lib/psi-view-model";
import { buildTotalMcapChartRows, TOTAL_MCAP_COHORT_IDS, TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS } from "@shared/lib/total-mcap-chart";
import { StablecoinListResponseSchema, StablecoinChartResponseSchema, SupplyHistoryResponseSchema, PegSummaryResponseSchema, PegSummaryStatsSchema } from "@shared/types/market";
import { StabilityIndexResponseSchema } from "@shared/types/stability";
import { HomepageHistorySchema, HomepageSnapshotSchema, type HomepageLaneMeta } from "@shared/types/homepage";
import { addFreshnessHeaders, buildFreshnessMeta } from "../lib/api-freshness";
import { assessFreshnessTimestamp } from "../lib/api-freshness-age";
import { jsonResponse } from "../lib/api-response";
import { handleStablecoins, handleStablecoinCharts } from "./cache-handlers";
import { handleSupplyHistory } from "./supply-history";
import { handlePegSummary } from "./peg-summary";
import { handleStabilityIndex } from "./stability-index";


const HomepagePegSummaryInputSchema = PegSummaryResponseSchema.extend({
  summary: PegSummaryStatsSchema.extend({ activeDepegCount: z.number().int().nonnegative() }).nullable(),
});
/** Owner handlers retain admission, completion fencing and publication health semantics. */
async function readLane<T>(source: string, maxAgeSec: number, schema: z.ZodType<T>, read: () => Promise<Response>): Promise<{ data: T | null; meta: HomepageLaneMeta }> {
  const now = Math.floor(Date.now() / 1000);
  let meta: HomepageLaneMeta = {
    ...buildFreshnessMeta(now, maxAgeSec, source, { assessedAt: now }),
    source, updatedAt: null, ageSeconds: null, status: "unknown", reason: "source-read-failed", warning: null,
  };
  try {
    const response = await read();
    if (!response.ok) {
      await response.body?.cancel();
      return { data: null, meta: { ...meta, reason: `source-http-${response.status}` } };
    }
    const body: unknown = await response.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return { data: null, meta: { ...meta, reason: "invalid-source-payload" } };
    const header = response.headers.get("X-Data-Updated-At");
    const updatedAt = header !== null && header !== "unknown" ? Number(header) : null;
    const timestamp = assessFreshnessTimestamp(now, updatedAt);
    const warning = response.headers.get("Warning");
    if (timestamp.reason === null && updatedAt !== null && updatedAt >= 0) {
      const verdict = buildFreshnessMeta(updatedAt, maxAgeSec, source, { assessedAt: now });
      meta = {
        ...verdict, source, warning,
        status: warning && verdict.status === "fresh" ? "degraded" : verdict.status,
        reason: warning ? "source-warning" : verdict.status === "fresh" ? null : `${verdict.status}-generation`,
      };
    } else meta = { ...meta, reason: timestamp.reason ?? "invalid-timestamp", warning };
    return { data: parsed.data, meta };
  } catch {
    return { data: null, meta };
  }
}

function responseHeaders(metas: HomepageLaneMeta[]): Record<string, string> {
  // Each source retains its own runway. A failed/degraded sibling must not be
  // cached as a fresh complete response or extend any other producer's budget.
  if (metas.some((meta) => meta.status !== "fresh")) return { "Cache-Control": API_CACHE_PROFILES.noStore };
  const assessedAt = Date.now() / 1000;
  let headers: Record<string, string> = { "Cache-Control": API_CACHE_PROFILES.producerBacked };
  for (const meta of metas) {
    const runway = Math.floor((meta.updatedAt ?? 0) + meta.freshBudgetSec - assessedAt);
    if (runway <= 0) return { "Cache-Control": API_CACHE_PROFILES.noStore };
    headers = addFreshnessHeaders(headers, meta.updatedAt!, meta.freshBudgetSec, {
      assessedAt, freshBudgetSec: meta.freshBudgetSec,
    });
  }
  // Date is the common assessment basis of every clamped lane, not dispatch's
  // later clock. Do not mislabel any one lane as the composite generation.
  return { "Cache-Control": headers["Cache-Control"]!, Date: headers.Date! };
}

export async function handleHomepageSnapshot(db: D1Database): Promise<Response> {
  const [market, psi, incidents] = await Promise.all([
    readLane("stablecoins", API_FRESHNESS_MAX_AGE_SEC.stablecoins, StablecoinListResponseSchema, () => handleStablecoins(db)),
    readLane("stability-index", API_FRESHNESS_MAX_AGE_SEC.stabilityIndex, StabilityIndexResponseSchema, () => handleStabilityIndex(db, new URL(API_PATHS.stabilityIndex(), "https://internal.invalid"))),
    readLane("peg-summary", API_FRESHNESS_MAX_AGE_SEC.pegSummary, HomepagePegSummaryInputSchema, () => handlePegSummary(db)),
  ]);
  // The PSI sample clock can precede the response clock; never renew it.
  if (psi.data?.current && psi.meta.updatedAt !== null) {
    const updatedAt = Math.min(psi.meta.updatedAt, psi.data.current.computedAt);
    const verdict = buildFreshnessMeta(updatedAt, API_FRESHNESS_MAX_AGE_SEC.stabilityIndex, "stability-index", { assessedAt: psi.meta.assessedAt });
    psi.meta = { ...psi.meta, ...verdict,
      status: psi.meta.status === "degraded" && verdict.status === "fresh" ? "degraded" : verdict.status,
      reason: psi.meta.reason ?? (verdict.status === "fresh" ? null : `${verdict.status}-generation`),
    };
  }
  const payload = HomepageSnapshotSchema.parse({
    market: { data: market.data ? buildLiveHomepageHeroSnapshot(market.data, market.meta.updatedAt ?? undefined) : null, meta: market.meta },
    psi: { data: psi.data?.current ? { ...getDisplayedPsi(psi.data.current), computedAt: psi.data.current.computedAt } : null,
      meta: psi.data?.current ? psi.meta : { ...psi.meta, status: psi.meta.updatedAt === null ? "unknown" : "degraded", reason: psi.meta.reason ?? "no-psi-observation" } },
    incidents: { data: incidents.data?.summary ? { activeDepegCount: incidents.data.summary.activeDepegCount } : null,
      meta: incidents.data?.summary ? incidents.meta : { ...incidents.meta, status: incidents.meta.updatedAt === null ? "unknown" : "degraded", reason: incidents.meta.reason ?? "incident-summary-unavailable" } },
  });
  return jsonResponse(payload, { headers: responseHeaders([payload.market.meta, payload.psi.meta, payload.incidents.meta]) });
}

export async function handleHomepageHistory(db: D1Database): Promise<Response> {
  const total = readLane("stablecoin-charts", API_FRESHNESS_MAX_AGE_SEC.stablecoinCharts, StablecoinChartResponseSchema, () => handleStablecoinCharts(db));
  const cohort = (id: string) => readLane("supply-history", API_FRESHNESS_MAX_AGE_SEC.supplyHistory, SupplyHistoryResponseSchema,
    () => handleSupplyHistory(db, new URL(API_PATHS.supplyHistory(id, TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS), "https://internal.invalid")));
  const [aggregate, usdt, usdc, usds, dai] = await Promise.all([total, cohort(TOTAL_MCAP_COHORT_IDS.usdt), cohort(TOTAL_MCAP_COHORT_IDS.usdc), cohort(TOTAL_MCAP_COHORT_IDS.usds), cohort(TOTAL_MCAP_COHORT_IDS.dai)]);
  const payload = HomepageHistorySchema.parse({
    rows: buildTotalMcapChartRows(aggregate.data ?? [], { usdtHistory: usdt.data, usdcHistory: usdc.data, usdsHistory: usds.data, daiHistory: dai.data }),
    sources: { total: aggregate.meta, usdt: usdt.meta, usdc: usdc.meta, usds: usds.meta, dai: dai.meta },
  });
  return jsonResponse(payload, { headers: responseHeaders(Object.values(payload.sources)) });
}
