import { z } from "zod";
import { getEndpointDefinition } from "../../shared/lib/api-endpoints/definitions";
import { findDynamicEndpointDescriptor } from "../../shared/lib/api-endpoints/dynamic";
import { assertCliUsage, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

export const HTTP_TELEMETRY_POLICY = {
  dataset: "httpRequestsAdaptiveGroups", hosts: ["api.pharos.watch", "site-api.pharos.watch", "ops-api.pharos.watch"],
  maxPaths: 1000, maxPathLength: 2048, routesPerQuery: 8, maxWindowMs: 86400000,
  defaultWindowMs: 900000, ingestionLagMs: 300000, requestTimeoutMs: 30000,
} as const;
const API_URL = "https://api.cloudflare.com/client/v4/graphql";
const number = z.number().finite().nonnegative();
const interval = z.number().finite().min(1).nullish().transform((value) => value ?? null);
const pathRows = z.array(z.object({ dimensions: z.object({ clientRequestPath: z.string().min(1).max(HTTP_TELEMETRY_POLICY.maxPathLength) }) }));
const statusRows = z.array(z.object({ count: number, avg: z.object({ sampleInterval: interval }), dimensions: z.object({ edgeResponseStatus: z.number().int().min(0).max(999) }) }));
const latencyRows = z.array(z.object({ count: number, avg: z.object({ sampleInterval: interval }), quantiles: z.object({ edgeTimeToFirstByteMsP95: number.nullable() }) })).max(1);
const envelope = z.object({ errors: z.array(z.unknown()).nullish(), data: z.object({ viewer: z.object({ zones: z.array(z.object({ zoneTag: z.string() }).passthrough()) }) }).nullish() });
type Window = { from: string; to: string };
type Route = { key: string; path: string | null };
type Bucket = Route & { paths: string[] };
type RouteResult = Route & {
  status: "available" | "unavailable"; reason: string | null; discoveredPathCount: number;
  estimatedRequests: number | null; estimated5xxResponses: number | null; estimated5xxRate: number | null;
  statusCounts: { httpStatus: number; estimatedRequests: number; sampleInterval: number | null }[];
  edgeTtfbP95Ms: number | null; latencyEstimatedRequests: number | null;
  samplingIntervalRange: [number, number] | null; samplingIntervalUnknownRows: number;
};
export type HttpTelemetryReport = {
  schemaVersion: 1; generatedAt: string; status: "available" | "unavailable"; reason: string | null;
  source: { dataset: string; zoneId: string; hosts: readonly string[]; requestSource: "eyeball"; sampling: "adaptive-estimates"; latency: "edge-time-to-first-byte-ms"; window: Window; queriesAttempted: number; discoveredPaths: number | null };
  routes: RouteResult[]; caveats: string[];
};
const USAGE = `Usage: npm run ops:http-telemetry -- [--from <ISO> --to <ISO>]
Read-only Cloudflare zone HTTP counts, 5xx rates and p95 edge TTFB; JSON to stdout, no local or remote writes.
Requires CLOUDFLARE_ZONE_ANALYTICS_READ (Zone / Analytics / Read) and CLOUDFLARE_ZONE_ID.
Default: 15 minutes ending 5 minutes ago. Explicit paired UTC/offset timestamps: at most 24 hours, ending at least 5 minutes ago.
Adaptive estimates cover the three API hosts, not exclusively Worker invocations. TTFB is not full-response/client latency.
At most 1000 discovered paths; capped/failed reads are unavailable, never zero. Exits: 0 available, 1 unavailable, 2 usage; --help exits 0.`;

export function normalizeHttpRoute(path: string): Route {
  const pathname = path.split("?", 1)[0];
  const definition = getEndpointDefinition(pathname);
  if (definition) return { key: definition.key, path: definition.path };
  const dynamic = findDynamicEndpointDescriptor(pathname);
  if (dynamic) return { key: dynamic.key, path: dynamic.requestAttribution?.routePath ?? null };
  return { key: "unmatched", path: null };
}

export function parseHttpTelemetryArgs(argv: string[], now = Date.now()): { help: boolean; window: Window } {
  const { values } = parseStrictCliArgs(argv, { options: { from: { type: "string" }, to: { type: "string" } } });
  const fallbackTo = now - HTTP_TELEMETRY_POLICY.ingestionLagMs;
  if (values.help) return { help: true, window: { from: new Date(fallbackTo - HTTP_TELEMETRY_POLICY.defaultWindowMs).toISOString(), to: new Date(fallbackTo).toISOString() } };
  assertCliUsage((values.from === undefined) === (values.to === undefined), "--from and --to must be supplied together");
  const parseTime = (value: unknown, fallback: number) => {
    if (value === undefined) return fallback;
    assertCliUsage(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value), "timestamps must be timezone-qualified ISO timestamps");
    const parsed = Date.parse(value as string);
    assertCliUsage(Number.isFinite(parsed), "invalid timestamp");
    return parsed;
  };
  const to = parseTime(values.to, fallbackTo);
  const from = parseTime(values.from, to - HTTP_TELEMETRY_POLICY.defaultWindowMs);
  assertCliUsage(from < to && to - from <= HTTP_TELEMETRY_POLICY.maxWindowMs, "window must be increasing and at most 24 hours");
  assertCliUsage(to <= fallbackTo, "window must end at least 5 minutes ago");
  return { help: false, window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() } };
}

function unavailable(bucket: Bucket, reason: string): RouteResult {
  return { key: bucket.key, path: bucket.path, discoveredPathCount: bucket.paths.length, status: "unavailable", reason,
    estimatedRequests: null, estimated5xxResponses: null, estimated5xxRate: null, statusCounts: [], edgeTtfbP95Ms: null,
    latencyEstimatedRequests: null, samplingIntervalRange: null, samplingIntervalUnknownRows: 0 };
}

export function summarizeHttpRoute(bucket: Bucket, statuses: unknown, latency: unknown): RouteResult {
  const rows = statusRows.parse(statuses);
  const pooled = latencyRows.parse(latency)[0];
  if (rows.length >= 1000) return unavailable(bucket, "status-row-limit");
  if (!rows.length || !pooled || pooled.count === 0) return unavailable(bucket, "no-observed-http-responses");
  const requests = rows.reduce((sum, row) => sum + row.count, 0);
  if (requests === 0) return unavailable(bucket, "no-observed-http-responses");
  const errors = rows.filter((row) => row.dimensions.edgeResponseStatus >= 500 && row.dimensions.edgeResponseStatus < 600).reduce((sum, row) => sum + row.count, 0);
  const intervals = [...rows.map((row) => row.avg.sampleInterval), pooled.avg.sampleInterval];
  const known = intervals.filter((value): value is number => value !== null);
  const statusKnown = rows.every((row) => row.dimensions.edgeResponseStatus >= 100 && row.dimensions.edgeResponseStatus < 600);
  const reason = !statusKnown ? "http-status-unavailable" : pooled.quantiles.edgeTimeToFirstByteMsP95 === null ? "ttfb-unavailable" : null;
  return { key: bucket.key, path: bucket.path, discoveredPathCount: bucket.paths.length, status: reason ? "unavailable" : "available", reason,
    estimatedRequests: requests, estimated5xxResponses: errors, estimated5xxRate: statusKnown ? errors / requests : null,
    statusCounts: rows.map((row) => ({ httpStatus: row.dimensions.edgeResponseStatus, estimatedRequests: row.count, sampleInterval: row.avg.sampleInterval })).sort((a, b) => a.httpStatus - b.httpStatus),
    edgeTtfbP95Ms: pooled.quantiles.edgeTimeToFirstByteMsP95, latencyEstimatedRequests: pooled.count,
    samplingIntervalRange: known.length ? [Math.min(...known), Math.max(...known)] : null,
    samplingIntervalUnknownRows: intervals.length - known.length };
}

export async function collectHttpTelemetry({ token, zoneId, window, fetchImpl = fetch, now = () => new Date().toISOString() }: {
  token: string; zoneId: string; window: Window; fetchImpl?: typeof fetch; now?: () => string;
}): Promise<HttpTelemetryReport> {
  const report: HttpTelemetryReport = { schemaVersion: 1, generatedAt: now(), status: "unavailable", reason: null,
    source: { dataset: HTTP_TELEMETRY_POLICY.dataset, zoneId, hosts: HTTP_TELEMETRY_POLICY.hosts, requestSource: "eyeball", sampling: "adaptive-estimates", latency: "edge-time-to-first-byte-ms", window, queriesAttempted: 0, discoveredPaths: null }, routes: [],
    caveats: ["Zone HTTP traffic includes edge/auth/WAF responses and is not an exact stablecoin-api invocation population.",
      "Counts and rates are adaptive estimates; sample interval 1 does not guarantee an unsampled census.",
      "5xx rate uses the sum of returned status-group estimates as denominator; independent pooled counts can differ.",
      "p95 is computed by Cloudflare over each normalized route's discovered paths, never by averaging path/status percentiles.",
      "Latency is edge TTFB, not full-response duration, Worker wall time, or browser end-to-end latency.",
      "Path discovery and route reads are separate bounded queries, not a snapshot; ingestion can change between reads.",
      "Only observed routes are emitted; absent routes have no measurement. Unknown paths share one unmatched bucket; raw paths and query strings are not emitted."] };
  const baseFilter = `datetime_geq: $from, datetime_lt: $to, clientRequestHTTPHost_in: ${JSON.stringify(HTTP_TELEMETRY_POLICY.hosts)}, requestSource: "eyeball"`;
  const query = async (selection: string): Promise<Record<string, unknown>> => {
    report.source.queriesAttempted++;
    let response: Response;
    try {
      response = await fetchImpl(API_URL, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: `query HttpTelemetry($zone: string!, $from: Time!, $to: Time!) { viewer { zones(filter: {zoneTag: $zone}) { zoneTag ${selection} } } }`, variables: { zone: zoneId, ...window } }), signal: AbortSignal.timeout(HTTP_TELEMETRY_POLICY.requestTimeoutMs) });
    } catch { throw new Error("cloudflare-request-failed"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`cloudflare-http-${response.status}`); }
    let decoded: unknown;
    try { decoded = await response.json(); } catch { throw new Error("cloudflare-invalid-json"); }
    const parsed = envelope.safeParse(decoded);
    if (!parsed.success) throw new Error("cloudflare-invalid-envelope");
    if (parsed.data.errors?.length) throw new Error("cloudflare-graphql-errors");
    const zones = parsed.data.data?.viewer.zones;
    if (!zones || zones.length !== 1 || zones[0].zoneTag !== zoneId) throw new Error("zone-unavailable");
    return zones[0];
  };
  try {
    const discovery = await query(`paths: httpRequestsAdaptiveGroups(limit: ${HTTP_TELEMETRY_POLICY.maxPaths + 1}, filter: {${baseFilter}}) { dimensions { clientRequestPath } }`);
    const decoded = pathRows.safeParse(discovery.paths);
    if (!decoded.success) throw new Error("invalid-path-rows");
    if (decoded.data.length > HTTP_TELEMETRY_POLICY.maxPaths) throw new Error("path-cardinality-limit");
    report.source.discoveredPaths = decoded.data.length;
    if (!decoded.data.length) throw new Error("no-observed-http-responses");
    const buckets = new Map<string, Bucket>();
    for (const row of decoded.data) {
      const path = row.dimensions.clientRequestPath;
      const normalized = normalizeHttpRoute(path);
      const bucket = buckets.get(normalized.key) ?? { ...normalized, paths: [] };
      bucket.paths.push(path);
      buckets.set(normalized.key, bucket);
    }
    const ordered = [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
    for (let offset = 0; offset < ordered.length; offset += HTTP_TELEMETRY_POLICY.routesPerQuery) {
      const batch = ordered.slice(offset, offset + HTTP_TELEMETRY_POLICY.routesPerQuery);
      try {
        const selection = batch.map((bucket, index) => {
          const filter = `${baseFilter}, clientRequestPath_in: ${JSON.stringify(bucket.paths)}`;
          return `s${index}: httpRequestsAdaptiveGroups(limit: 1000, filter: {${filter}}) { count avg { sampleInterval } dimensions { edgeResponseStatus } }
            l${index}: httpRequestsAdaptiveGroups(limit: 1, filter: {${filter}}) { count avg { sampleInterval } quantiles { edgeTimeToFirstByteMsP95 } }`;
        }).join("\n");
        const result = await query(selection);
        for (const [index, bucket] of batch.entries()) {
          try { report.routes.push(summarizeHttpRoute(bucket, result[`s${index}`], result[`l${index}`])); }
          catch { report.routes.push(unavailable(bucket, "invalid-route-rows")); }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "collection-failed";
        report.routes.push(...ordered.slice(offset).map((bucket) => unavailable(bucket, reason)));
        break;
      }
    }
    report.status = report.routes.every((route) => route.status === "available") ? "available" : "unavailable";
    report.reason = report.status === "available" ? null : "route-evidence-unavailable";
  } catch (error) { report.reason = error instanceof Error ? error.message : "collection-failed"; }
  return report;
}

runDirectCli(import.meta.url, async () => {
  const args = parseHttpTelemetryArgs(process.argv.slice(2));
  if (writeCliHelpIfRequested({ help: args.help }, USAGE)) return;
  const token = process.env.CLOUDFLARE_ZONE_ANALYTICS_READ;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  assertCliUsage(typeof token === "string" && token.trim().length > 0, "CLOUDFLARE_ZONE_ANALYTICS_READ is required");
  assertCliUsage(typeof zoneId === "string" && /^[a-f0-9]{32}$/i.test(zoneId), "CLOUDFLARE_ZONE_ID must be a zone ID");
  const report = await collectHttpTelemetry({ token: token as string, zoneId: zoneId as string, window: args.window });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "available") process.exitCode = 1;
}, { label: "http-telemetry", usage: USAGE });
