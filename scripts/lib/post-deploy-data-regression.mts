/**
 * Delayed post-deploy data-volume check.
 *
 * Green CI proves activation, not that the first producer cycle still publishes
 * a complete dataset. The deploy workflow captures a read-only baseline of
 * public/keyed API counts before the Worker deploys; this module owns the pure
 * extraction, comparison and reporting used by the delayed workflow. No D1 or
 * private credential is involved: every metric comes from a public GET payload.
 *
 * Thresholds live here (one authority): a metric must retain more than half of
 * its pre-deploy count, and only baselines at or above that metric's minimum
 * are graded, so tiny counts do not flap. Unreadable evidence is `unknown`, not
 * a drop (R2); only a current 5xx fails the check.
 */

export const POST_DEPLOY_DATA_SNAPSHOT_VERSION = 1;
export const POST_DEPLOY_DATA_SNAPSHOT_KIND = "post-deploy-data-snapshot";
/** First full hourly producer cycle after the deploy. The 4-hourly reserve lane is out of scope. */
export const POST_DEPLOY_DATA_REGRESSION_WAIT_SEC = 70 * 60;
/** A count below half its baseline is a regression ("dropped by more than 50%"). */
export const POST_DEPLOY_DATA_REGRESSION_MAX_DROP_RATIO = 0.5;

export type PostDeployDataEndpointKey =
  | "stablecoins"
  | "yield-rankings"
  | "depeg-events"
  | "mint-burn-flows"
  | "dex-liquidity"
  | "daily-digest";

export interface PostDeployDataEndpointDefinition {
  key: PostDeployDataEndpointKey;
  path: string;
  producer: string;
}

export const POST_DEPLOY_DATA_ENDPOINTS: readonly PostDeployDataEndpointDefinition[] = Object.freeze([
  { key: "stablecoins", path: "/api/stablecoins", producer: "sync-stablecoins" },
  { key: "yield-rankings", path: "/api/yield-rankings", producer: "sync-yield-data" },
  { key: "depeg-events", path: "/api/depeg-events?limit=1&includeTotal=true", producer: "sync-stablecoins" },
  { key: "mint-burn-flows", path: "/api/mint-burn-flows", producer: "sync-mint-burn" },
  { key: "dex-liquidity", path: "/api/dex-liquidity", producer: "sync-dex-liquidity" },
  { key: "daily-digest", path: "/api/daily-digest", producer: "daily-digest" },
]);

const YIELD_DATA_SOURCE_FAMILIES = [
  "onchain",
  "protocol-api",
  "defillama",
  "defillama-auto",
  "rate-derived",
  "price-derived",
] as const;

export interface PostDeployDataEndpointReading {
  endpoint: PostDeployDataEndpointKey;
  path: string;
  producer: string;
  status: number;
  ok: boolean;
  generation: number | null;
  error: string | null;
}

export interface PostDeployDataMetricReading {
  id: string;
  endpoint: PostDeployDataEndpointKey;
  producer: string;
  minimumBaseline: number;
  value: number | null;
  unavailableReason: string | null;
}

export interface PostDeployDataSnapshot {
  version: typeof POST_DEPLOY_DATA_SNAPSHOT_VERSION;
  kind: typeof POST_DEPLOY_DATA_SNAPSHOT_KIND;
  capturedAt: number;
  skipped: { reason: string } | null;
  endpoints: PostDeployDataEndpointReading[];
  metrics: PostDeployDataMetricReading[];
}

interface PostDeployDataMetricDefinition {
  id: string;
  endpoint: PostDeployDataEndpointKey;
  producer: string;
  minimumBaseline: number;
  extract: (payload: unknown) => number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadArray(payload: unknown, key: string): unknown[] | null {
  if (!isRecord(payload)) return null;
  const value = payload[key];
  return Array.isArray(value) ? value : null;
}

function countYieldRows(payload: unknown, matches: (row: Record<string, unknown>) => boolean): number | null {
  const rankings = payloadArray(payload, "rankings");
  if (rankings == null) return null;
  return rankings.filter((row) => isRecord(row) && matches(row)).length;
}

function countDexCoinsWithPools(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  return Object.entries(payload).filter(([id, row]) =>
    id !== "__global__"
    && isRecord(row)
    && typeof row.poolCount === "number"
    && Number.isFinite(row.poolCount)
    && row.poolCount > 0,
  ).length;
}

const POST_DEPLOY_DATA_METRICS: readonly PostDeployDataMetricDefinition[] = [
  {
    id: "stablecoins.active",
    endpoint: "stablecoins",
    producer: "sync-stablecoins",
    minimumBaseline: 50,
    extract: (payload) => payloadArray(payload, "peggedAssets")?.length ?? null,
  },
  {
    id: "stablecoins.priced",
    endpoint: "stablecoins",
    producer: "sync-stablecoins",
    minimumBaseline: 50,
    extract: (payload) => {
      const assets = payloadArray(payload, "peggedAssets");
      if (assets == null) return null;
      return assets.filter((asset) =>
        isRecord(asset)
        && typeof asset.price === "number"
        && Number.isFinite(asset.price)
        && asset.price > 0,
      ).length;
    },
  },
  {
    id: "yield.rankings.total",
    endpoint: "yield-rankings",
    producer: "sync-yield-data",
    minimumBaseline: 20,
    extract: (payload) => payloadArray(payload, "rankings")?.length ?? null,
  },
  ...YIELD_DATA_SOURCE_FAMILIES.map((source): PostDeployDataMetricDefinition => ({
    id: `yield.rankings.source.${source}`,
    endpoint: "yield-rankings",
    producer: "sync-yield-data",
    minimumBaseline: 10,
    extract: (payload) => countYieldRows(payload, (row) => row.dataSource === source),
  })),
  {
    id: "depeg.events.total",
    endpoint: "depeg-events",
    producer: "sync-stablecoins",
    minimumBaseline: 20,
    extract: (payload) => {
      if (!isRecord(payload) || typeof payload.total !== "number" || !Number.isFinite(payload.total) || payload.total < 0) {
        return null;
      }
      return payload.total;
    },
  },
  {
    id: "mint-burn.coins",
    endpoint: "mint-burn-flows",
    producer: "sync-mint-burn",
    minimumBaseline: 20,
    extract: (payload) => payloadArray(payload, "coins")?.length ?? null,
  },
  {
    id: "dex-liquidity.coins-with-pools",
    endpoint: "dex-liquidity",
    producer: "sync-dex-liquidity",
    minimumBaseline: 20,
    extract: countDexCoinsWithPools,
  },
  {
    id: "digest.present",
    endpoint: "daily-digest",
    producer: "daily-digest",
    minimumBaseline: 1,
    extract: (payload) => {
      if (!isRecord(payload) || !("digest" in payload)) return null;
      const digest = payload.digest;
      if (digest === null) return 0;
      return typeof digest === "string" && digest.trim().length > 0 ? 1 : null;
    },
  },
];

export const POST_DEPLOY_DATA_METRIC_IDS: readonly string[] = POST_DEPLOY_DATA_METRICS.map((metric) => metric.id);

export interface PostDeployDataEndpointResult extends PostDeployDataEndpointReading {
  payload?: unknown;
}

function endpointUnavailableReason(reading: PostDeployDataEndpointReading): string {
  return reading.status === 0 ? "endpoint-read-failed" : `endpoint-http-${reading.status}`;
}

/** Extract every graded metric, including explicit zeros, so a vanished cohort is visible. */
export function buildPostDeployDataSnapshot(
  results: readonly PostDeployDataEndpointResult[],
  capturedAt: number,
  skipped: { reason: string } | null = null,
): PostDeployDataSnapshot {
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) {
    throw new Error("Post-deploy data snapshot requires a positive capture time.");
  }
  const endpoints = results.map((result) => ({
    endpoint: result.endpoint,
    path: result.path,
    producer: result.producer,
    status: result.status,
    ok: result.ok,
    generation: result.generation,
    error: result.error,
  }));
  const byEndpoint = new Map(results.map((result) => [result.endpoint, result]));
  const metrics = POST_DEPLOY_DATA_METRICS.map((metric): PostDeployDataMetricReading => {
    const reading = byEndpoint.get(metric.endpoint);
    if (!reading || !reading.ok) {
      return {
        id: metric.id,
        endpoint: metric.endpoint,
        producer: metric.producer,
        minimumBaseline: metric.minimumBaseline,
        value: null,
        unavailableReason: reading ? endpointUnavailableReason(reading) : "endpoint-not-read",
      };
    }
    const value = metric.extract(reading.payload);
    return {
      id: metric.id,
      endpoint: metric.endpoint,
      producer: metric.producer,
      minimumBaseline: metric.minimumBaseline,
      value,
      unavailableReason: value == null ? "payload-unavailable" : null,
    };
  });
  return {
    version: POST_DEPLOY_DATA_SNAPSHOT_VERSION,
    kind: POST_DEPLOY_DATA_SNAPSHOT_KIND,
    capturedAt,
    skipped,
    endpoints,
    metrics,
  };
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strict enough to reject a truncated artifact while staying dependency-free:
 * the delayed workflow runs without npm install.
 */
export function parsePostDeployDataSnapshot(value: unknown): PostDeployDataSnapshot {
  if (!isRecord(value)) throw new Error("Post-deploy data snapshot must be an object.");
  if (value.version !== POST_DEPLOY_DATA_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported post-deploy data snapshot version: ${String(value.version)}.`);
  }
  if (value.kind !== POST_DEPLOY_DATA_SNAPSHOT_KIND) throw new Error("Not a post-deploy data snapshot.");
  if (!Number.isFinite(value.capturedAt) || (value.capturedAt as number) <= 0) {
    throw new Error("Post-deploy data snapshot has an invalid capture time.");
  }
  const skipped = value.skipped;
  if (skipped !== null && (!isRecord(skipped) || typeof skipped.reason !== "string" || skipped.reason.length === 0)) {
    throw new Error("Post-deploy data snapshot has an invalid skip marker.");
  }
  if (!Array.isArray(value.endpoints) || !Array.isArray(value.metrics)) {
    throw new Error("Post-deploy data snapshot is missing endpoint or metric evidence.");
  }
  for (const endpoint of value.endpoints) {
    if (
      !isRecord(endpoint)
      || typeof endpoint.endpoint !== "string"
      || typeof endpoint.path !== "string"
      || typeof endpoint.producer !== "string"
      || !isFiniteNonNegativeInteger(endpoint.status)
      || typeof endpoint.ok !== "boolean"
      || (endpoint.generation !== null && !isFiniteNonNegativeInteger(endpoint.generation))
      || (endpoint.error !== null && typeof endpoint.error !== "string")
    ) {
      throw new Error("Post-deploy data snapshot has a malformed endpoint reading.");
    }
  }
  for (const metric of value.metrics) {
    if (
      !isRecord(metric)
      || typeof metric.id !== "string"
      || typeof metric.endpoint !== "string"
      || typeof metric.producer !== "string"
      || typeof metric.minimumBaseline !== "number"
      || !Number.isFinite(metric.minimumBaseline)
      || metric.minimumBaseline < 0
      || (metric.value !== null && (typeof metric.value !== "number" || !Number.isFinite(metric.value)))
      || (metric.unavailableReason !== null && typeof metric.unavailableReason !== "string")
    ) {
      throw new Error("Post-deploy data snapshot has a malformed metric reading.");
    }
  }
  return value as unknown as PostDeployDataSnapshot;
}

export type PostDeployDataFindingStatus = "ok" | "dropped" | "unknown";

export type PostDeployDataRegressionReason =
  | "metric-drop-exceeds-threshold"
  | "metric-baseline-unavailable"
  | "metric-current-unavailable"
  | "metric-baseline-below-minimum"
  | "endpoint-http-5xx"
  | "endpoint-read-failed"
  | "baseline-skipped"
  | "metric-not-reported";

export interface PostDeployDataRegressionFinding {
  metric: string;
  producer: string;
  status: PostDeployDataFindingStatus;
  reason: PostDeployDataRegressionReason | null;
  baseline: number | null;
  current: number | null;
  minimumBaseline: number;
  maxDropRatio: number;
}

export interface PostDeployDataEndpointFailure {
  endpoint: string;
  path: string;
  producer: string;
  status: number;
  reason: "endpoint-http-5xx" | "endpoint-read-failed";
}

export interface PostDeployDataRegressionReport {
  outcome: "passed" | "failed" | "unknown" | "skipped";
  reason: string;
  baselineCapturedAt: number;
  currentCapturedAt: number;
  budgetSeconds: number;
  maxDropRatio: number;
  findings: PostDeployDataRegressionFinding[];
  endpoints: PostDeployDataEndpointReading[];
  endpointFailures: PostDeployDataEndpointFailure[];
}

/** Only a current 5xx is a hard endpoint failure; other unreadable reads are unknown (R2). */
function classifyCurrentEndpoint(endpoint: PostDeployDataEndpointReading): PostDeployDataEndpointFailure | null {
  if (endpoint.status >= 500 && endpoint.status <= 599) {
    return {
      endpoint: endpoint.endpoint,
      path: endpoint.path,
      producer: endpoint.producer,
      status: endpoint.status,
      reason: "endpoint-http-5xx",
    };
  }
  if (!endpoint.ok) {
    return {
      endpoint: endpoint.endpoint,
      path: endpoint.path,
      producer: endpoint.producer,
      status: endpoint.status,
      reason: "endpoint-read-failed",
    };
  }
  return null;
}

export function comparePostDeployDataSnapshots(
  baseline: PostDeployDataSnapshot,
  current: PostDeployDataSnapshot,
  { budgetSeconds }: { budgetSeconds: number },
): PostDeployDataRegressionReport {
  if (baseline.skipped) {
    return {
      outcome: "skipped",
      reason: `baseline-skipped:${baseline.skipped.reason}`,
      baselineCapturedAt: baseline.capturedAt,
      currentCapturedAt: current.capturedAt,
      budgetSeconds,
      maxDropRatio: POST_DEPLOY_DATA_REGRESSION_MAX_DROP_RATIO,
      findings: [],
      endpoints: current.endpoints,
      endpointFailures: [],
    };
  }

  const baselineMetrics = new Map(baseline.metrics.map((metric) => [metric.id, metric]));
  const currentMetrics = new Map(current.metrics.map((metric) => [metric.id, metric]));
  const findings = POST_DEPLOY_DATA_METRICS.map((definition): PostDeployDataRegressionFinding => {
    const before = baselineMetrics.get(definition.id);
    const after = currentMetrics.get(definition.id);
    const base = {
      metric: definition.id,
      producer: definition.producer,
      minimumBaseline: before?.minimumBaseline ?? definition.minimumBaseline,
      maxDropRatio: POST_DEPLOY_DATA_REGRESSION_MAX_DROP_RATIO,
    };
    const baselineValue = before?.value ?? null;
    const currentValue = after?.value ?? null;
    if (before == null) {
      return { ...base, status: "unknown", reason: "metric-not-reported", baseline: null, current: currentValue };
    }
    if (baselineValue == null) {
      return { ...base, status: "unknown", reason: "metric-baseline-unavailable", baseline: null, current: currentValue };
    }
    if (after == null) {
      return { ...base, status: "unknown", reason: "metric-not-reported", baseline: baselineValue, current: null };
    }
    if (currentValue == null) {
      return { ...base, status: "unknown", reason: "metric-current-unavailable", baseline: baselineValue, current: null };
    }
    if (baselineValue < base.minimumBaseline) {
      return { ...base, status: "ok", reason: "metric-baseline-below-minimum", baseline: baselineValue, current: currentValue };
    }
    if (currentValue < baselineValue * (1 - POST_DEPLOY_DATA_REGRESSION_MAX_DROP_RATIO)) {
      return { ...base, status: "dropped", reason: "metric-drop-exceeds-threshold", baseline: baselineValue, current: currentValue };
    }
    return { ...base, status: "ok", reason: null, baseline: baselineValue, current: currentValue };
  });

  const endpointFailures = current.endpoints
    .map(classifyCurrentEndpoint)
    .filter((failure): failure is PostDeployDataEndpointFailure => failure != null);
  const dropped = findings.filter((finding) => finding.status === "dropped");
  const unknown = findings.filter((finding) => finding.status === "unknown");
  const hardEndpointFailures = endpointFailures.filter((failure) => failure.reason === "endpoint-http-5xx");
  const outcome = hardEndpointFailures.length > 0 || dropped.length > 0
    ? "failed"
    : unknown.length > 0 || endpointFailures.length > 0
      ? "unknown"
      : "passed";
  const reason = outcome === "failed"
    ? hardEndpointFailures.length > 0
      ? `endpoint-http-5xx:${hardEndpointFailures.map((failure) => failure.endpoint).join(",")}`
      : `metric-drop-exceeds-threshold:${dropped.map((finding) => finding.metric).join(",")}`
    : outcome === "unknown"
      ? `data-regression-unknown:${[
        ...unknown.map((finding) => `${finding.metric}(${finding.reason ?? ""})`),
        ...endpointFailures.map((failure) => `${failure.endpoint}(${failure.reason})`),
      ].join(",")}`
      : "data-volume-stable";

  return {
    outcome,
    reason,
    baselineCapturedAt: baseline.capturedAt,
    currentCapturedAt: current.capturedAt,
    budgetSeconds,
    maxDropRatio: POST_DEPLOY_DATA_REGRESSION_MAX_DROP_RATIO,
    findings,
    endpoints: current.endpoints,
    endpointFailures,
  };
}

function isoTimestamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

export function formatPostDeployDataRegressionMarkdown(report: PostDeployDataRegressionReport): string {
  const lines = [
    "## Post-deploy data regression",
    "",
    `- Outcome: ${report.outcome}`,
    `- Reason: \`${report.reason}\``,
    `- Baseline: ${isoTimestamp(report.baselineCapturedAt)}; current: ${isoTimestamp(report.currentCapturedAt)}`,
    `- Observation budget: ${report.budgetSeconds}s after deploy; regression threshold: drop > ${report.maxDropRatio * 100}%`,
    "- Scope: read-only public/keyed API counts; no D1 credentials.",
    "",
    "| Endpoint | Producer | HTTP | Read at | Generation |",
    "| --- | --- | --- | --- | --- |",
    ...report.endpoints.map((endpoint) =>
      `| ${endpoint.endpoint} | ${endpoint.producer} | ${endpoint.status} | ${isoTimestamp(report.currentCapturedAt)} `
      + `| ${endpoint.generation ?? "unavailable"} |`),
    "",
    "| Metric | Producer | Baseline | Current | Minimum baseline | Outcome | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.findings.map((finding) =>
      `| ${finding.metric} | ${finding.producer} | ${finding.baseline ?? "unknown"} | ${finding.current ?? "unknown"} `
      + `| ${finding.minimumBaseline} | ${finding.status} | ${finding.reason ?? ""} |`),
    "",
  ];
  return lines.join("\n") + "\n";
}
