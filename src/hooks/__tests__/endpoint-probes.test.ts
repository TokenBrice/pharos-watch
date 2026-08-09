import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectEndpointProbes, ENDPOINT_GROUPS, ENDPOINT_PROBE_CONCURRENCY } from "../use-endpoint-probes";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("collectEndpointProbes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels unread bodies for non-semantic probe routes", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const json = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: { cancel },
      json,
    } as unknown as Response);

    const result = await collectEndpointProbes(["/api/chains"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(result).toEqual([
      expect.objectContaining({
        path: "/api/chains",
        status: 200,
      }),
    ]);
    expect(result[0]).not.toHaveProperty("semanticStatus");
  });

  it("parses semantic probe routes via endpoint metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "degraded",
          warnings: ["Health cache is delayed."],
        }),
        {
          status: 200,
        },
      ),
    );

    const result = await collectEndpointProbes(["/api/health"]);

    expect(result[0]).toEqual(
      expect.objectContaining({
        path: "/api/health",
        status: 200,
        semanticStatus: "degraded",
        semanticScope: "health",
        semanticDetail: "Health cache is delayed.",
      }),
    );
  });

  it("marks malformed semantic probe JSON as stale instead of transport-healthy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await collectEndpointProbes(["/api/health"]);

    expect(result[0]).toEqual(
      expect.objectContaining({
        path: "/api/health",
        status: 200,
        semanticStatus: "stale",
        semanticScope: "health",
        error: "Invalid JSON from health probe",
      }),
    );
  });

  it("marks semantic probe contract mismatches as stale", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    const result = await collectEndpointProbes(["/api/health"]);

    expect(result[0]).toEqual(
      expect.objectContaining({
        path: "/api/health",
        status: 200,
        semanticStatus: "stale",
        semanticScope: "health",
        semanticDetail: "Response did not match the health probe contract.",
        error: "Invalid health probe response",
      }),
    );
  });

  it("routes admin probe paths through the same-origin proxy", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const adminPath = ENDPOINT_GROUPS.admin[0]!;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: { cancel },
    } as unknown as Response);

    const result = await collectEndpointProbes([adminPath]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/admin${adminPath.slice("/api".length)}`);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ headers: undefined }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(result[0]).toEqual(expect.objectContaining({ path: adminPath, status: 200 }));
  });

  it("preserves admin probe query strings when using the same-origin proxy", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const adminPath = "/api/status-history?limit=10";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: { cancel },
    } as unknown as Response);

    const result = await collectEndpointProbes([adminPath]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/status-history?limit=10");
    expect(result[0]).toEqual(expect.objectContaining({ path: adminPath, status: 200 }));
  });

  it("classifies freshness Warning headers on 200 responses as data-health signals", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          Warning: '110 - "Response is stale (7200s old, max 900s)"',
        },
      }),
    );

    const result = await collectEndpointProbes(["/api/stress-signals"]);

    expect(result[0]).toEqual(
      expect.objectContaining({
        path: "/api/stress-signals",
        status: 200,
        semanticStatus: "stale",
        semanticScope: "freshness",
        semanticDetail: '110 - "Response is stale (7200s old, max 900s)"',
      }),
    );
  });

  it("treats a newly scheduled stablecoin-detail refresh as expected stale-while-revalidate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          Warning: '110 - "Stablecoin detail cache is stale; refresh scheduled"',
          "X-Data-Age": "301",
        },
      }),
    );

    const result = await collectEndpointProbes(["/api/stablecoin/pyusd-paypal"]);

    expect(result[0]).toEqual(
      expect.objectContaining({
        path: "/api/stablecoin/pyusd-paypal",
        status: 200,
      }),
    );
    expect(result[0]).not.toHaveProperty("semanticStatus");
  });

  it("classifies a persistently aging scheduled detail refresh as stale", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          Warning: '110 - "Stablecoin detail cache is stale; refresh scheduled"',
          "X-Data-Age": "601",
        },
      }),
    );

    const result = await collectEndpointProbes(["/api/stablecoin/pyusd-paypal"]);

    expect(result[0]).toEqual(
      expect.objectContaining({
        semanticStatus: "stale",
        semanticScope: "freshness",
      }),
    );
  });

  it("keeps failed stablecoin-detail refresh warnings stale inside the scheduled-refresh grace", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          Warning: '110 - "Stablecoin detail cache is stale; refresh failed"',
          "X-Data-Age": "301",
        },
      }),
    );

    const result = await collectEndpointProbes(["/api/stablecoin/pyusd-paypal"]);

    expect(result[0]).toEqual(
      expect.objectContaining({
        semanticStatus: "stale",
        semanticScope: "freshness",
      }),
    );
  });

  it("preserves degraded freshness Warning severity on 200 responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          Warning: '110 - "Response is degraded (3600s old, max 1800s)"',
        },
      }),
    );

    const result = await collectEndpointProbes(["/api/chains"]);

    expect(result[0]).toEqual(
      expect.objectContaining({
        path: "/api/chains",
        status: 200,
        semanticStatus: "degraded",
        semanticScope: "freshness",
        semanticDetail: '110 - "Response is degraded (3600s old, max 1800s)"',
      }),
    );
  });

  it("lets stale freshness Warning severity override healthy parsed semantics", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "healthy",
          warnings: [],
        }),
        {
          status: 200,
          headers: {
            Warning: '110 - "Response is stale (7200s old, max 900s)"',
          },
        },
      ),
    );

    const result = await collectEndpointProbes(["/api/health"]);

    expect(result[0]).toEqual(
      expect.objectContaining({
        path: "/api/health",
        status: 200,
        semanticStatus: "stale",
        semanticScope: "freshness",
        semanticDetail: '110 - "Response is stale (7200s old, max 900s)"',
      }),
    );
  });

  it("returns the existing timeout error shape", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const resultPromise = collectEndpointProbes(["/api/chains"]);

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).resolves.toEqual([
      expect.objectContaining({
        path: "/api/chains",
        status: null,
        error: "Browser probe timed out",
      }),
    ]);
  });

  it("limits concurrent browser probes to avoid transport saturation", async () => {
    const paths = Array.from({ length: ENDPOINT_PROBE_CONCURRENCY + 2 }, (_value, index) => `/api/test-${index}`);
    const deferreds = paths.map(() => createDeferred<Response>());
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const deferred = deferreds[started.length]!;
      started.push(String(input));
      active += 1;
      maxActive = Math.max(maxActive, active);
      return deferred.promise.finally(() => {
        active -= 1;
      });
    });

    const probePromise = collectEndpointProbes(paths);
    await Promise.resolve();

    expect(started).toHaveLength(ENDPOINT_PROBE_CONCURRENCY);

    deferreds[0]!.resolve(new Response(""));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toHaveLength(ENDPOINT_PROBE_CONCURRENCY + 1);

    for (const deferred of deferreds.slice(1)) {
      deferred.resolve(new Response(""));
    }

    await probePromise;

    expect(maxActive).toBe(ENDPOINT_PROBE_CONCURRENCY);
  });
});
