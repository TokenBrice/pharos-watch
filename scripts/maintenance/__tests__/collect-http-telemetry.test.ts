import { describe, expect, it, vi } from "vitest";
import { collectHttpTelemetry, HTTP_TELEMETRY_POLICY, normalizeHttpRoute, parseHttpTelemetryArgs, summarizeHttpRoute } from "../collect-http-telemetry";

const zoneId = "7197d57bc8c19191b5a0a4bf0e8a156d";
const window = { from: "2026-10-18T10:00:00.000Z", to: "2026-10-18T10:15:00.000Z" };
const now = () => "2026-10-18T10:30:00.000Z";
const status = (code: number, count: number, sampleInterval: number | null = 1) => ({ count, avg: { sampleInterval }, dimensions: { edgeResponseStatus: code } });
const latency = (count: number, p95: number | null, sampleInterval: number | null = 1) => [{ count, avg: { sampleInterval }, quantiles: { edgeTimeToFirstByteMsP95: p95 } }];
const paths = (...values: string[]) => ({ paths: values.map((clientRequestPath) => ({ dimensions: { clientRequestPath } })) });
const envelope = (fields: Record<string, unknown>) => ({ data: { viewer: { zones: [{ zoneTag: zoneId, ...fields }] } }, errors: null });
function mockedFetch(...responses: unknown[]) {
  const fn = vi.fn<typeof fetch>();
  for (const body of responses) fn.mockResolvedValueOnce(Response.json(body));
  return fn;
}
const bucket = { key: "stablecoin-detail", path: "/api/stablecoin/:id", paths: ["/api/stablecoin/usdt-tether", "/api/stablecoin/usdc-circle"] };

describe("HTTP telemetry route normalization", () => {
  it("uses static definitions and canonical dynamic descriptors without retaining identifiers", () => {
    expect(normalizeHttpRoute("/api/stablecoins?secret=not-retained")).toEqual({ key: "stablecoins", path: "/api/stablecoins" });
    expect(normalizeHttpRoute("/api/stablecoin/usdc-circle").key).toBe("stablecoin-detail");
    expect(normalizeHttpRoute("/api/stablecoin/usdt-tether")).toEqual(normalizeHttpRoute("/api/stablecoin/usdc-circle"));
    expect(normalizeHttpRoute("/api/og/stablecoin/usdc-circle")).toEqual({ key: "og-image", path: "/api/og/*" });
    expect(normalizeHttpRoute("/api/snapshots/2026-10-18.json").key).toBe("snapshot-day");
    expect(normalizeHttpRoute("/api/api-keys/123/rotate")).toEqual({ key: "api-key-rotate", path: null });
    expect(normalizeHttpRoute("/secret-scanner-path")).toEqual({ key: "unmatched", path: null });
    expect(normalizeHttpRoute("/another-scanner-path")).toEqual(normalizeHttpRoute("/secret-scanner-path"));
  });
});

describe("HTTP telemetry summaries", () => {
  it("calculates 5xx from HTTP codes, preserves server-pooled p95 and labels adaptive estimates", () => {
    const result = summarizeHttpRoute(bucket, [status(200, 90, 10), status(500, 4, 2), status(503, 6, 2)], latency(103, 812, 10));
    expect(result).toMatchObject({ status: "available", estimatedRequests: 100, estimated5xxResponses: 10, estimated5xxRate: 0.1,
      edgeTtfbP95Ms: 812, latencyEstimatedRequests: 103, samplingIntervalRange: [2, 10], samplingIntervalUnknownRows: 0 });
    expect(JSON.stringify(result)).not.toContain("usdc-circle");
  });

  it("preserves unknown sampling and zero observed 5xx without claiming missing traffic is zero", () => {
    expect(summarizeHttpRoute(bucket, [status(200, 5, null)], latency(5, 0, null))).toMatchObject({ estimated5xxResponses: 0, estimated5xxRate: 0, edgeTtfbP95Ms: 0, samplingIntervalRange: null, samplingIntervalUnknownRows: 2 });
    expect(summarizeHttpRoute(bucket, [], [])).toMatchObject({ status: "unavailable", reason: "no-observed-http-responses", estimatedRequests: null, estimated5xxRate: null, edgeTtfbP95Ms: null });
  });

  it("does not invent latency or turn a missing HTTP status into availability", () => {
    expect(summarizeHttpRoute(bucket, [status(200, 5)], latency(5, null))).toMatchObject({ status: "partial", reason: "ttfb-unavailable", edgeTtfbP95Ms: null, estimatedRequests: 5 });
    expect(summarizeHttpRoute(bucket, [status(0, 5)], latency(5, 10))).toMatchObject({ status: "partial", reason: "http-status-unavailable", estimated5xxRate: null });
    expect(() => summarizeHttpRoute(bucket, [status(200, -1)], latency(1, 10))).toThrow();
    expect(() => summarizeHttpRoute(bucket, [status(200, 1, 0)], latency(1, 10))).toThrow();
  });
});

describe("HTTP telemetry collection", () => {
  it("queries all discovered paths per normalized route for a true pooled server p95", async () => {
    const fetchImpl = mockedFetch(envelope(paths(...bucket.paths)), envelope({ s0: [status(200, 9), status(503, 1)] }), envelope({ l0: latency(10, 517) }));
    const report = await collectHttpTelemetry({ token: "private-token", zoneId, window, now, fetchImpl });
    expect(report.status).toBe("available");
    expect(report.source).toMatchObject({ queriesAttempted: 3, discoveredPaths: 2, sampling: "adaptive-estimates", latency: "edge-time-to-first-byte-ms", window });
    expect(report.routes).toHaveLength(1);
    expect(report.routes[0]).toMatchObject({ discoveredPathCount: 2, estimated5xxRate: 0.1, edgeTtfbP95Ms: 517 });
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
    expect(request.variables).toEqual({ zone: zoneId, ...window });
    expect(request.query).toContain(`clientRequestPath_in: ${JSON.stringify(bucket.paths)}`);
    expect(request.query).not.toContain("edgeTimeToFirstByteMsP95");
    const latencyRequest = JSON.parse(String(fetchImpl.mock.calls[2][1]?.body)) as { query: string };
    expect(latencyRequest.query).toContain("edgeTimeToFirstByteMsP95");
    expect(latencyRequest.query).toContain(`clientRequestPath_in: ${JSON.stringify(bucket.paths)}`);
    expect(request.query).toContain("edgeResponseStatus");
    expect(request.query).toContain('requestSource: "eyeball"');
    for (const host of HTTP_TELEMETRY_POLICY.hosts) expect(request.query).toContain(host);
    expect(request.query).not.toMatch(/\bmutation\b/);
    expect(JSON.stringify(report)).not.toContain("private-token");
    expect(JSON.stringify(report)).not.toContain("usdc-circle");
  });

  it("rejects a capped path discovery without publishing partial rates or zeroes", async () => {
    const fetchImpl = mockedFetch(envelope(paths(...Array.from({ length: HTTP_TELEMETRY_POLICY.maxPaths + 1 }, (_, i) => `/api/unknown/${i}`))));
    const report = await collectHttpTelemetry({ token: "secret", zoneId, window, fetchImpl, now });
    expect(report).toMatchObject({ status: "unavailable", reason: "path-cardinality-limit", routes: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.source.discoveredPaths).toBeNull();
  });

  it("retains no-data as unavailable rather than a zero error rate", async () => {
    const report = await collectHttpTelemetry({ token: "secret", zoneId, window, fetchImpl: mockedFetch(envelope(paths())), now });
    expect(report).toMatchObject({ status: "unavailable", reason: "no-observed-http-responses", routes: [] });
  });

  it("fails closed on HTTP, GraphQL, wrong-zone and malformed evidence without leaking credentials or HTTP bodies", async () => {
    const cases = [
      { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("private-provider-message", { status: 403 })), reason: "cloudflare-http-403" },
      { fetchImpl: mockedFetch({ errors: [{ message: "request secret rejected" }], data: null }), reason: "cloudflare-graphql-errors" },
      { fetchImpl: mockedFetch({ data: { viewer: { zones: [] } } }), reason: "zone-unavailable" },
      { fetchImpl: mockedFetch(envelope({ paths: [{ dimensions: {} }] })), reason: "invalid-path-rows" },
      { fetchImpl: mockedFetch({ unexpected: true }), reason: "zone-unavailable" },
    ];
    for (const { fetchImpl, reason } of cases) {
      const report = await collectHttpTelemetry({ token: "secret", zoneId, window, fetchImpl, now });
      expect(report).toMatchObject({ status: "unavailable", reason, routes: [] });
      expect(JSON.stringify(report)).not.toContain("private-provider-message");
      expect(JSON.stringify(report)).not.toContain("secret");
      if (reason === "cloudflare-graphql-errors") expect(report.reasonDetails).toEqual(["request [redacted] rejected"]);
    }
  });

  it("preserves route failures as unavailable and missing latency as partial", async () => {
    const fetchImpl = mockedFetch(envelope(paths("/api/stablecoins")), { errors: [{ message: "private-provider-message" }], data: null });
    const report = await collectHttpTelemetry({ token: "secret", zoneId, window, fetchImpl, now });
    expect(report).toMatchObject({ status: "unavailable", reason: "route-evidence-unavailable" });
    expect(report.routes[0]).toMatchObject({ status: "unavailable", reason: "cloudflare-graphql-errors", estimatedRequests: null, estimated5xxRate: null });
    const missing = await collectHttpTelemetry({ token: "secret", zoneId, window, now, fetchImpl: mockedFetch(envelope(paths("/api/stablecoins")), envelope({ s0: [status(200, 1)] }), envelope({ l0: latency(1, null) })) });
    expect(missing).toMatchObject({ status: "partial", reason: "route-evidence-partial" });
    expect(missing.routes[0]).toMatchObject({ status: "partial", reason: "ttfb-unavailable", edgeTtfbP95Ms: null, estimatedRequests: 1 });
  });

  it("bounds query alias cardinality and performs batches serially", async () => {
    const rawPaths = ["/api/stablecoins", "/api/yield-rankings", "/api/health", "/api/status", "/api/stablecoin/usdt-tether", "/api/stablecoin-summary/usdt-tether", "/api/stablecoin-reserves/usdt-tether", "/api/og/page/home", "/api/snapshots/2026-10-18.json"];
    const statuses = Object.fromEntries(Array.from({ length: HTTP_TELEMETRY_POLICY.routesPerQuery }, (_, i) => [`s${i}`, [status(200, 1)]]));
    const latencies = Object.fromEntries(Array.from({ length: HTTP_TELEMETRY_POLICY.routesPerQuery }, (_, i) => [`l${i}`, latency(1, 5)]));
    const fetchImpl = mockedFetch(envelope(paths(...rawPaths)), envelope(statuses), envelope(latencies), envelope({ s0: [status(200, 1)] }), envelope({ l0: latency(1, 5) }));
    const report = await collectHttpTelemetry({ token: "secret", zoneId, window, fetchImpl, now });
    expect(report.status).toBe("available");
    expect(report.routes).toHaveLength(9);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(String(fetchImpl.mock.calls[1][1]?.body)).not.toContain("s8:");
  });

  it("resolves the zone from its hostname when the optional zone ID is absent", async () => {
    const fetchImpl = mockedFetch({ success: true, result: [{ id: zoneId, name: "pharos.watch" }] }, envelope(paths("/api/stablecoins")), envelope({ s0: [status(200, 5)] }), envelope({ l0: latency(5, 12) }));
    const report = await collectHttpTelemetry({ token: "secret", window, fetchImpl, now });
    expect(report.status).toBe("available");
    expect(report.source).toMatchObject({ zoneId, zoneResolution: "hostname-lookup", queriesAttempted: 3 });
    expect(fetchImpl.mock.calls[0]).toMatchObject(["https://api.cloudflare.com/client/v4/zones?name=pharos.watch&per_page=2", { redirect: "error", headers: { Authorization: "Bearer secret" } }]);
  });

  it("does not turn unavailable or ambiguous zone lookup into zero traffic", async () => {
    for (const body of [{ success: true, result: [] }, { success: false, result: null }, { success: true, result: [{ id: zoneId, name: "another.example" }] }]) {
      const fetchImpl = mockedFetch(body);
      const report = await collectHttpTelemetry({ token: "secret", window, fetchImpl, now });
      expect(report).toMatchObject({ status: "unavailable", reason: "zone-lookup-unavailable", routes: [] });
      expect(report.source.zoneId).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("retains status counts when the real zone entitlement denies TTFB quantiles", async () => {
    const message = `zone '${zoneId}' does not have access to the field 'edgetimetofirstbytemsp95' from the path`;
    const fetchImpl = mockedFetch(envelope(paths("/api/stablecoins")), envelope({ s0: [status(200, 9), status(503, 1)] }), { data: null, errors: [{ message }] });
    const report = await collectHttpTelemetry({ token: "secret", zoneId, window, fetchImpl, now });
    expect(report).toMatchObject({ status: "partial", reason: "route-evidence-partial", reasonDetails: [message] });
    expect(report.routes[0]).toMatchObject({ status: "partial", reason: "ttfb-field-not-entitled", estimatedRequests: 10, estimated5xxResponses: 1, estimated5xxRate: 0.1, edgeTtfbP95Ms: null, latencyEstimatedRequests: null });
    expect(report.routes[0].statusCounts).toHaveLength(2);
  });
});

describe("HTTP telemetry CLI", () => {
  const clock = Date.parse("2026-10-18T10:30:00Z");
  it("defaults to a bounded lagged window and supports help", () => {
    expect(parseHttpTelemetryArgs([], clock)).toEqual({ help: false, window: { from: "2026-10-18T10:10:00.000Z", to: "2026-10-18T10:25:00.000Z" } });
    expect(parseHttpTelemetryArgs(["--help"], clock).help).toBe(true);
    expect(parseHttpTelemetryArgs(["--from", window.from, "--to", window.to], clock).window).toEqual(window);
  });
  it("preserves fractional-second and signed-offset timestamp matching", () => {
    for (const from of ["2026-10-18T10:00:00Z", "2026-10-18T10:00:00.123456Z", "2026-10-18T11:00:00+01:00", "2026-10-18T09:00:00.123456-01:00"]) {
      expect(parseHttpTelemetryArgs(["--from", from, "--to", window.to], clock).window.from).toBe(new Date(from).toISOString());
    }
    for (const suffix of [".Z", ".+01:00", ".123", ".123Zextra", ".123+0100", ".123" + "1".repeat(10000) + "x"]) {
      expect(() => parseHttpTelemetryArgs(["--from", `2026-10-18T10:00:00${suffix}`, "--to", window.to], clock)).toThrow();
    }
  });
  it("rejects unknown, duplicate, unpaired, overlong, reversed, recent and timezone-free options", () => {
    for (const args of [["--unknown"], ["--from", window.from], ["--to", window.to, "--to", window.to],
      ["--from", "2026-10-16T00:00:00Z", "--to", window.to], ["--from", window.to, "--to", window.from],
      ["--from", window.from, "--to", "2026-10-18T10:29:00Z"], ["--from", "2026-10-18T10:00:00", "--to", window.to]]) {
      expect(() => parseHttpTelemetryArgs(args, clock)).toThrow();
    }
  });
});
