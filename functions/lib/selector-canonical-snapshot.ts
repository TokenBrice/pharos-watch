import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { SITE_DATA_PROXY_SECRET_HEADER } from "@shared/lib/site-data-lane";
import { buildSelectorRows } from "@shared/lib/selector/data-adapter";
import { buildV9SelectorSnapshot } from "@shared/lib/selector/v9-data-adapter";
import { runSelector } from "@shared/lib/selector/engine";
import { createVerifiedSelectorSnapshot } from "@shared/lib/selector/snapshot";
import type { SelectorInput, SelectorOutput } from "@shared/lib/selector/types";
import {
  BluechipRatingsMapSchema,
  DexLiquidityMapSchema,
  PegSummaryResponseSchema,
  StablecoinListResponseSchema,
  StressSignalsAllResponseSchema,
  type BluechipRatingsMap,
  type DexLiquidityMap,
  type PegSummaryResponse,
  type StablecoinListResponse,
  type StressSignalsAllResponse,
} from "@shared/types/market";
import { RedemptionBackstopsResponseSchema, type RedemptionBackstopsResponse } from "@shared/types/redemption";
import { ReportCardsResponseSchema, type ReportCardsResponse } from "@shared/types/report-cards";
import { ReportCardsV9ResponseSchema, type ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import type { V9SelectorSnapshot } from "@shared/types/selector-v9";
import { YieldRankingsResponseSchema, type YieldRankingsResponse } from "@shared/types/yield";
import { resolveSiteApiOrigin, type SiteDataProxyEnv } from "./site-api-env";
import { fetchUpstreamProxy } from "./upstream-proxy";

const SELECTOR_CANONICAL_FETCH_TIMEOUT_MS = 12_000;

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } };
}

export type SelectorCanonicalSnapshotEnv = Pick<SiteDataProxyEnv, "SITE_API_ORIGIN" | "SITE_API_SHARED_SECRET">;

async function fetchCanonicalSource<T>(
  request: Request,
  env: SelectorCanonicalSnapshotEnv,
  path: string,
  schema: RuntimeSchema<T>,
): Promise<T> {
  const origin = resolveSiteApiOrigin(env);
  const secret = env.SITE_API_SHARED_SECRET?.trim();
  if (!origin || !secret) {
    throw new Error("Canonical selector data lane is not configured");
  }

  const result = await fetchUpstreamProxy(request, {
    upstreamUrl: new URL(path, origin).toString(),
    method: "GET",
    headers: new Headers({
      Accept: "application/json",
      [SITE_DATA_PROXY_SECRET_HEADER]: secret,
    }),
    timeoutMs: SELECTOR_CANONICAL_FETCH_TIMEOUT_MS,
    timeoutReason: new DOMException("Canonical selector source timed out", "TimeoutError"),
    logPrefix: "selector-snapshot",
    timeoutMessage: "Canonical selector source timed out",
    fetchFailedMessage: "Canonical selector source fetch failed",
  });
  if (!result.ok || !result.response.ok) {
    throw new Error(`Canonical selector source unavailable: ${path}`);
  }

  const raw = (await result.response.json()) as unknown;
  const payload =
    raw && typeof raw === "object" && !Array.isArray(raw) && "_meta" in raw
      ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== "_meta"))
      : raw;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Canonical selector source contract failed: ${path} (${parsed.error.issues.length} issues)`);
  }
  return parsed.data;
}

async function loadCanonicalSelectorSources(request: Request, env: SelectorCanonicalSnapshotEnv) {
  // Pages Functions share the Workers connection budget. Each batch fully
  // consumes at most four responses before the next group opens.
  const [stablecoinsData, pegData, reportData, stressData] = await Promise.all([
    fetchCanonicalSource<StablecoinListResponse>(request, env, API_PATHS.stablecoins(), StablecoinListResponseSchema),
    fetchCanonicalSource<PegSummaryResponse>(request, env, API_PATHS.pegSummary(), PegSummaryResponseSchema),
    fetchCanonicalSource<ReportCardsResponse>(request, env, API_PATHS.reportCards(), ReportCardsResponseSchema),
    fetchCanonicalSource<StressSignalsAllResponse>(
      request,
      env,
      API_PATHS.stressSignals(),
      StressSignalsAllResponseSchema,
    ),
  ]);
  const [dexData, yieldData, bluechipData, redemptionData] = await Promise.all([
    fetchCanonicalSource<DexLiquidityMap>(request, env, API_PATHS.dexLiquidity(), DexLiquidityMapSchema),
    fetchCanonicalSource<YieldRankingsResponse>(request, env, API_PATHS.yieldRankings(), YieldRankingsResponseSchema),
    fetchCanonicalSource<BluechipRatingsMap>(request, env, API_PATHS.bluechipRatings(), BluechipRatingsMapSchema),
    fetchCanonicalSource<RedemptionBackstopsResponse>(
      request,
      env,
      API_PATHS.redemptionBackstops(),
      RedemptionBackstopsResponseSchema,
    ),
  ]);
  return { stablecoinsData, pegData, reportData, stressData, dexData, yieldData, bluechipData, redemptionData };
}

export async function recomputeVerifiedSelectorSnapshot(
  input: SelectorInput,
  request: Request,
  env: SelectorCanonicalSnapshotEnv,
  now = Date.now(),
): Promise<SelectorOutput> {
  const sources = await loadCanonicalSelectorSources(request, env);
  const dataset = buildSelectorRows({
    ...sources,
    pegCurrency: input.pegCurrency,
    now,
  });
  return createVerifiedSelectorSnapshot(
    runSelector(
      input,
      { rows: dataset.rows },
      {
        timestamp: dataset.timestamp,
        datasetHash: dataset.datasetHash,
        methodologyVersions: dataset.methodologyVersions,
      },
    ),
  );
}

/**
 * Dark V9 canonical lane. It persists the full source identity and intentionally
 * returns no recommendation until the V9 selector floors are reviewed.
 */
export async function recomputeDeferredV9SelectorSnapshot(
  request: Request,
  env: SelectorCanonicalSnapshotEnv,
  expectedIdentity: SafetyScoreV9PublicationIdentity,
  now = Date.now(),
): Promise<V9SelectorSnapshot> {
  const reportData = await fetchCanonicalSource<ReportCardsV9Response>(
    request,
    env,
    API_PATHS.reportCardsV9(),
    ReportCardsV9ResponseSchema,
  );
  return buildV9SelectorSnapshot(reportData, expectedIdentity, now);
}
