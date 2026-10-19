import {
  REQUEST_ATTRIBUTION_BUCKET_SEC,
  REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  REQUEST_ATTRIBUTION_RETENTION_DAYS,
  createBufferedAttributionRecorder,
  isEnvFlagEnabled,
  requestAttributionInverseRate,
  selectRequestAttributionSample,
  type ApiRequestRouteMetric,
  type BufferedAttributionEntry,
} from "@shared/lib/request-attribution";
import {
  REQUEST_SOURCE_LOW_SAMPLE_MINIMUM,
  REQUEST_SOURCE_MEASUREMENT_VERSION,
  REQUEST_SOURCE_POLICY_ID,
  REQUEST_SOURCE_SAMPLE_INVERSE_RATE,
  type AttributionMeasurement,
  type ApiRequestAttributionResponse,
  type ApiRequestAttributionSplit,
  type ApiRequestConsumerClass,
  type ApiRequestWorkerLane,
} from "@pharos/contracts/request-source";

export { isRequestSourceAttributionDisabled } from "@shared/lib/request-attribution";

const API_REQUEST_SOURCE_STATS_RETENTION_SEC = REQUEST_ATTRIBUTION_RETENTION_DAYS * 24 * 60 * 60;
const REQUEST_ATTRIBUTION_FLUSH_DELAY_MS = 10;
const REQUEST_ATTRIBUTION_BATCH_SIZE = 50;
const API_KEY_REQUEST_ATTRIBUTION_DISABLED_ENV = "API_KEY_REQUEST_ATTRIBUTION_DISABLED";

interface BufferedWorkerRequestAttribution extends BufferedAttributionEntry {
  lane: ApiRequestWorkerLane;
  consumerClass: ApiRequestConsumerClass;
  authenticationClass: "keyed" | "unkeyed" | "not-applicable";
  sampleInverseRate: number;
}

interface BufferedApiKeyRequestAttribution extends BufferedAttributionEntry {
  apiKeyId: number;
}

const workerRequestRecorder = createBufferedAttributionRecorder<BufferedWorkerRequestAttribution, D1Database>({
  batchSize: REQUEST_ATTRIBUTION_BATCH_SIZE,
  flushDelayMs: REQUEST_ATTRIBUTION_FLUSH_DELAY_MS,
  pruneIntervalSec: REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  retentionSec: API_REQUEST_SOURCE_STATS_RETENTION_SEC,
  insertSql: `INSERT INTO api_request_source_samples (
           bucket_start,
           route_key,
           route_path,
           lane,
           consumer_class,
           authentication_class,
           sample_inverse_rate,
           sample_count
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket_start, route_key, lane, consumer_class, authentication_class, sample_inverse_rate)
         DO UPDATE SET
           sample_count = sample_count + excluded.sample_count,
           route_path = excluded.route_path`,
  pruneSql: [],
  logLabel: "worker",
  buildKey: (entry) => `${entry.bucketStart}\t${entry.route.routeKey}\t${entry.lane}\t${entry.consumerClass}\t${entry.authenticationClass}\t${entry.sampleInverseRate}`,
  bindInsertParams: (entry) => [
    entry.bucketStart,
    entry.route.routeKey,
    entry.route.routePath,
    entry.lane,
    entry.consumerClass,
    entry.authenticationClass,
    entry.sampleInverseRate,
    entry.requestCount,
  ],
  mergeBuffered: (existing, incoming) => {
    existing.requestCount += incoming.requestCount;
    existing.route = incoming.route;
  },
});

const apiKeyRequestRecorder = createBufferedAttributionRecorder<BufferedApiKeyRequestAttribution, D1Database>({
  batchSize: REQUEST_ATTRIBUTION_BATCH_SIZE,
  flushDelayMs: REQUEST_ATTRIBUTION_FLUSH_DELAY_MS,
  pruneIntervalSec: REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  retentionSec: API_REQUEST_SOURCE_STATS_RETENTION_SEC,
  insertSql: `INSERT INTO api_key_request_stats (
       api_key_id,
       bucket_start,
       request_count,
       source_v2_request_count
     )
     VALUES (?, ?, ?, ?)
     ON CONFLICT(api_key_id, bucket_start)
     DO UPDATE SET
       request_count = request_count + excluded.request_count,
       source_v2_request_count = source_v2_request_count + excluded.source_v2_request_count`,
  pruneSql: [],
  logLabel: "api-key",
  buildKey: (entry) => `${entry.bucketStart}\t${entry.apiKeyId}`,
  bindInsertParams: (entry) => [
    entry.apiKeyId,
    entry.bucketStart,
    entry.requestCount,
    entry.requestCount,
  ],
  mergeBuffered: (existing, incoming) => {
    existing.requestCount += incoming.requestCount;
  },
});

export function resetRequestAttributionStateForTests(): void {
  workerRequestRecorder.reset();
  apiKeyRequestRecorder.reset();
}

export function isApiKeyRequestAttributionDisabled(env: unknown): boolean {
  return isEnvFlagEnabled(env, API_KEY_REQUEST_ATTRIBUTION_DISABLED_ENV);
}

export async function recordWorkerRequestAttribution(
  db: D1Database,
  route: ApiRequestRouteMetric,
  lane: ApiRequestWorkerLane,
  consumerClass: ApiRequestConsumerClass,
  authenticationClass: BufferedWorkerRequestAttribution["authenticationClass"],
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const sampleInverseRate = requestAttributionInverseRate();
  if (!selectRequestAttributionSample(sampleInverseRate)) return;
  const bucketStart = nowSec - (nowSec % REQUEST_ATTRIBUTION_BUCKET_SEC);
  await workerRequestRecorder.record(
    db,
    {
      bucketStart,
      route,
      lane,
      consumerClass,
      authenticationClass,
      sampleInverseRate,
      requestCount: 1,
    },
    nowSec,
  );
}

export async function recordApiKeyRequestAttribution(
  db: D1Database,
  apiKeyId: number,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const bucketStart = nowSec - (nowSec % REQUEST_ATTRIBUTION_BUCKET_SEC);
  await apiKeyRequestRecorder.record(
    db,
    {
      apiKeyId,
      bucketStart,
      route: { routeKey: "api-key", routePath: "/api/*" },
      requestCount: 1,
    },
    nowSec,
  );
}


export interface SourceAggregateRow {
  dimension: "total" | "route" | "bucket" | "lane" | "delivery" | "legacy-public" | "unkeyed";
  dimension_key: string;
  route_path: string;
  consumer_class: ApiRequestConsumerClass;
  inverse_rate: number;
  legacy: number;
  observed_count: number;
}

export interface SourceKeyRow {
  api_key_id: number;
  name: string;
  masked_token: string;
  traffic_class: ApiRequestConsumerClass;
  is_active: number;
  expires_at: number | null;
  rate_limit_per_minute: number;
  request_count: number;
}

export interface SourceKeySummaryRow {
  keyed_requests: number;
  legacy_keyed_requests: number;
  invalid_markers: number;
  total_keys: number;
}

interface CountEvidence {
  value: number;
  legacy: number;
  strata: Map<number, number>;
}

function emptyEvidence(): CountEvidence {
  return { value: 0, legacy: 0, strata: new Map() };
}

function addEvidence(target: CountEvidence, source: CountEvidence): void {
  target.value += source.value;
  target.legacy += source.legacy;
  for (const [rate, count] of source.strata) {
    target.strata.set(rate, (target.strata.get(rate) ?? 0) + count);
  }
}

function combineEvidence(...values: CountEvidence[]): CountEvidence {
  const combined = emptyEvidence();
  for (const value of values) addEvidence(combined, value);
  return combined;
}

function variance(evidence: CountEvidence): number {
  let result = 0;
  for (const [rate, count] of evidence.strata) result += count * rate * (rate - 1);
  return result;
}

function recordedEvidence(count: number): CountEvidence {
  return { value: count, legacy: count, strata: new Map() };
}

function measurement(evidence: CountEvidence, sampledRegime = false): AttributionMeasurement {
  const probabilityStrata = [...evidence.strata].sort(([a], [b]) => a - b)
    .map(([inverseRate, observedSampleCount]) => ({ inverseRate, observedSampleCount }));
  const observedSampleCount = probabilityStrata.reduce((sum, row) => sum + row.observedSampleCount, 0);
  const sampledCount = probabilityStrata.reduce((sum, row) => sum + (row.inverseRate > 1 ? row.observedSampleCount : 0), 0);
  const estimated = sampledCount > 0 || sampledRegime;
  if (sampledRegime && !probabilityStrata.some((row) => row.inverseRate > 1)) {
    probabilityStrata.push({ inverseRate: REQUEST_SOURCE_SAMPLE_INVERSE_RATE, observedSampleCount: 0 });
  }
  const lowSample = estimated && sampledCount < REQUEST_SOURCE_LOW_SAMPLE_MINIMUM;
  const noObservations = evidence.legacy + observedSampleCount === 0;
  return {
    kind: estimated ? evidence.legacy > 0 ? "mixed" : "estimated" : "observed",
    observedSampleCount,
    recordedCount: evidence.legacy,
    probabilityStrata,
    coverage: noObservations ? "unknown" : "best-effort",
    reason: lowSample ? "low-sample" : noObservations ? "no-observations" : null,
    standardError: lowSample || noObservations ? null : Math.sqrt(variance(evidence)),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((100 * numerator / denominator).toFixed(2)) : 0;
}

function shareMeasurement(a: CountEvidence, b: CountEvidence, sampledRegime: boolean): AttributionMeasurement {
  const result = measurement(combineEvidence(a, b), sampledRegime);
  const total = a.value + b.value;
  // Delta-method SE for a/(a+b); the two Bernoulli event sets are disjoint.
  return {
    ...result,
    standardError: result.standardError == null || total === 0 ? null
      : 100 * Math.sqrt(b.value ** 2 * variance(a) + a.value ** 2 * variance(b)) / total ** 2,
  };
}

function split(site: CountEvidence, external: CountEvidence, sampledRegime: boolean): ApiRequestAttributionSplit {
  const total = combineEvidence(site, external);
  const shares = shareMeasurement(site, external, sampledRegime);
  return {
    siteRequests: site.value, externalRequests: external.value, totalRequests: total.value,
    siteSharePct: ratio(site.value, total.value), externalSharePct: ratio(external.value, total.value),
    measurement: {
      siteRequests: measurement(site, sampledRegime), externalRequests: measurement(external, sampledRegime),
      totalRequests: measurement(total, sampledRegime), siteSharePct: shares, externalSharePct: shares,
    },
  };
}

export function buildApiRequestAttributionResponse(config: {
  generatedAt: number; from: number; to: number; bucketSizeSec: number; routeLimit: number; apiKeyLimit: number;
  rows: SourceAggregateRow[]; keySummary: SourceKeySummaryRow; keyRows: SourceKeyRow[];
}): ApiRequestAttributionResponse {
  const groups = new Map<string, { key: string; path: string; site: CountEvidence; external: CountEvidence }>();
  const sampledRegime = config.rows.some((row) => row.legacy === 0)
    || config.keySummary.keyed_requests > config.keySummary.legacy_keyed_requests;
  for (const row of config.rows) {
    const id = `${row.dimension}:${row.dimension_key}`;
    let group = groups.get(id);
    if (!group) {
      group = { key: row.dimension_key, path: row.route_path, site: emptyEvidence(), external: emptyEvidence() };
      groups.set(id, group);
    }
    const target = row.consumer_class === "site" ? group.site : group.external;
    target.value += row.observed_count * row.inverse_rate;
    if (row.legacy === 1) target.legacy += row.observed_count;
    else target.strata.set(row.inverse_rate, (target.strata.get(row.inverse_rate) ?? 0) + row.observed_count);
  }
  const get = (dimension: string, key = "") => groups.get(`${dimension}:${key}`)
    ?? { key, path: "", site: emptyEvidence(), external: emptyEvidence() };
  const list = (dimension: string) => [...groups].filter(([id]) => id.startsWith(`${dimension}:`)).map(([, group]) => group);
  const total = get("total");
  const totals = split(total.site, total.external, sampledRegime || groups.size === 0);
  const delivery = (key: string) => get("delivery", key).site;
  const publicSite = delivery("public-api-site");
  const keyed = recordedEvidence(config.keySummary.keyed_requests);
  const legacyPublic = get("legacy-public");
  const legacyUnkeyed = legacyPublic.site.value + legacyPublic.external.value - config.keySummary.legacy_keyed_requests;
  const invalidReason = config.keySummary.invalid_markers > 0 ? "invalid-key-regime"
    : legacyUnkeyed < 0 ? "legacy-keyed-exceeds-source" : null;
  const unkeyed = combineEvidence(recordedEvidence(invalidReason ? 0 : legacyUnkeyed), get("unkeyed").site, get("unkeyed").external);
  const keySplit = split(keyed, unkeyed, sampledRegime);
  const unavailable: AttributionMeasurement = {
    ...keySplit.measurement.totalRequests, kind: "unavailable", coverage: "unknown",
    reason: invalidReason, standardError: null,
  };
  const keyMeasurement = invalidReason ? unavailable : keySplit.measurement.totalRequests;
  const keyShareMeasurement = invalidReason ? unavailable : keySplit.measurement.siteSharePct;
  const denominator = invalidReason ? null : keySplit.totalRequests;
  const returnedRequests = config.keyRows.reduce((sum, row) => sum + row.request_count, 0);
  const apiKeys = config.keyRows.map((row) => ({
    apiKeyId: row.api_key_id, name: row.name, maskedToken: row.masked_token, trafficClass: row.traffic_class,
    isActive: row.is_active === 1, expiresAt: row.expires_at, rateLimitPerMinute: row.rate_limit_per_minute,
    requestCount: row.request_count,
    shareOfKeyedRequestsPct: ratio(row.request_count, keyed.value),
    shareOfTotalPublicApiRequestsPct: denominator == null ? null : ratio(row.request_count, denominator),
    measurement: {
      requestCount: measurement(recordedEvidence(row.request_count)),
      shareOfKeyedRequestsPct: measurement(keyed),
      shareOfTotalPublicApiRequestsPct: invalidReason ? unavailable
        : shareMeasurement(recordedEvidence(row.request_count), combineEvidence(recordedEvidence(keyed.value - row.request_count), unkeyed), sampledRegime),
    },
  }));
  const deliveryEvidence = {
    totalSiteRequests: total.site, pagesCacheHits: delivery("pages-cache-hit"),
    pagesUpstreamFetches: delivery("pages-upstream-fetch"), pagesUpstreamTimeouts: delivery("pages-upstream-timeout"),
    pagesUpstreamErrors: delivery("pages-upstream-error"), publicApiSiteRequests: publicSite,
  };
  return {
    measurementVersion: REQUEST_SOURCE_MEASUREMENT_VERSION, policyId: REQUEST_SOURCE_POLICY_ID,
    generatedAt: config.generatedAt,
    window: {
      from: config.from, to: config.to, durationSec: config.to - config.from, bucketSizeSec: config.bucketSizeSec,
      routeLimit: config.routeLimit, apiKeyLimit: config.apiKeyLimit, retentionDays: REQUEST_ATTRIBUTION_RETENTION_DAYS,
    },
    totals,
    siteDelivery: {
      totalSiteRequests: totals.siteRequests, pagesCacheHits: deliveryEvidence.pagesCacheHits.value,
      pagesUpstreamFetches: deliveryEvidence.pagesUpstreamFetches.value, pagesUpstreamTimeouts: deliveryEvidence.pagesUpstreamTimeouts.value,
      pagesUpstreamErrors: deliveryEvidence.pagesUpstreamErrors.value, publicApiSiteRequests: publicSite.value,
      measurement: {
        totalSiteRequests: totals.measurement.siteRequests,
        pagesCacheHits: measurement(deliveryEvidence.pagesCacheHits, sampledRegime),
        pagesUpstreamFetches: measurement(deliveryEvidence.pagesUpstreamFetches, sampledRegime),
        pagesUpstreamTimeouts: measurement(deliveryEvidence.pagesUpstreamTimeouts),
        pagesUpstreamErrors: measurement(deliveryEvidence.pagesUpstreamErrors),
        publicApiSiteRequests: measurement(publicSite, sampledRegime),
      },
    },
    lanes: (["public-api", "site-api"] as const).map((lane) => ({ lane, ...split(get("lane", lane).site, get("lane", lane).external, sampledRegime) })),
    routes: list("route").map((group) => ({ routeKey: group.key, routePath: group.path, ...split(group.site, group.external, sampledRegime) }))
      .sort((a, b) => b.totalRequests - a.totalRequests || a.routeKey.localeCompare(b.routeKey)).slice(0, config.routeLimit),
    buckets: list("bucket").map((group) => ({ bucketStart: Number(group.key), ...split(group.site, group.external, sampledRegime) }))
      .sort((a, b) => a.bucketStart - b.bucketStart),
    keyedPublicApi: {
      keyedRequests: keyed.value, unkeyedRequests: invalidReason ? null : unkeyed.value, totalRequests: denominator,
      keyedSharePct: invalidReason ? null : keySplit.siteSharePct, unkeyedSharePct: invalidReason ? null : keySplit.externalSharePct,
      totalKeys: config.keySummary.total_keys, returnedKeys: apiKeys.length,
      omittedKeys: config.keySummary.total_keys - apiKeys.length, omittedRequests: keyed.value - returnedRequests,
      truncated: config.keySummary.total_keys > apiKeys.length,
      measurement: {
        keyedRequests: measurement(keyed), unkeyedRequests: invalidReason ? unavailable : measurement(unkeyed, sampledRegime),
        totalRequests: keyMeasurement, keyedSharePct: keyShareMeasurement, unkeyedSharePct: keyShareMeasurement,
      },
    },
    apiKeys,
    scope: { countsTotalSiteDemand: true, countsWorkerLoad: true, includesPagesProxyCacheHits: true },
  };
}
