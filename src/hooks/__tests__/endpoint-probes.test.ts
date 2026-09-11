import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectEndpointProbes, ENDPOINT_GROUPS, ENDPOINT_PROBE_CONCURRENCY } from "../use-endpoint-probes";

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

  const freshnessCases: Array<{
    name: string;
    path: string;
    warning: string;
    ageSeconds: string | null;
    semanticStatus: string | null;
  }> = [
    {
      name: "classifies a stale Warning header as a data-health signal",
      path: "/api/stress-signals",
      warning: '110 - "Response is stale (7200s old, max 900s)"',
      ageSeconds: null,
      semanticStatus: "stale",
    },
    {
      name: "treats a newly scheduled stablecoin-detail refresh as expected stale-while-revalidate",
      path: "/api/stablecoin/pyusd-paypal",
      warning: '110 - "Stablecoin detail cache is stale; refresh scheduled"',
      ageSeconds: "301",
      semanticStatus: null,
    },
    {
      name: "classifies a persistently aging scheduled detail refresh as stale",
      path: "/api/stablecoin/pyusd-paypal",
      warning: '110 - "Stablecoin detail cache is stale; refresh scheduled"',
      ageSeconds: "601",
      semanticStatus: "stale",
    },
    {
      name: "keeps a failed scheduled-refresh warning stale inside the grace window",
      path: "/api/stablecoin/pyusd-paypal",
      warning: '110 - "Stablecoin detail cache is stale; refresh failed"',
      ageSeconds: "301",
      semanticStatus: "stale",
    },
    {
      name: "preserves degraded freshness Warning severity on 200 responses",
      path: "/api/chains",
      warning: '110 - "Response is degraded (3600s old, max 1800s)"',
      ageSeconds: null,
      semanticStatus: "degraded",
    },
  ];

  it.each(freshnessCases)("$name", async ({ path, warning, ageSeconds, semanticStatus }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          Warning: warning,
          ...(ageSeconds === null ? {} : { "X-Data-Age": ageSeconds }),
        },
      }),
    );

    const [probe] = await collectEndpointProbes([path]);

    if (semanticStatus === null) {
      // Inside the scheduled-refresh grace the warning is expected, not a
      // data-health signal: no freshness semantics may surface.
      expect(probe).toEqual(expect.objectContaining({ path, status: 200 }));
      expect(probe).not.toHaveProperty("semanticStatus");
      expect(probe).not.toHaveProperty("semanticScope");
      return;
    }
    expect(probe).toEqual(
      expect.objectContaining({
        path,
        status: 200,
        semanticStatus,
        semanticScope: "freshness",
        semanticDetail: warning,
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

  it("associates each probe result with its request path when responses settle out of order", async () => {
    const paths = ["/api/probe-first", "/api/probe-second", "/api/probe-third"];
    const statuses = [200, 404, 202];
    const deferreds = paths.map(() => Promise.withResolvers<Response>());
    let started = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => deferreds[started++]!.promise);

    const probePromise = collectEndpointProbes(paths);
    await Promise.resolve();
    expect(started).toBe(paths.length);

    // Settle in reverse order; results must still line up with request order.
    for (let index = paths.length - 1; index >= 0; index -= 1) {
      deferreds[index]!.resolve(new Response("", { status: statuses[index]! }));
    }

    await expect(probePromise).resolves.toEqual(
      paths.map((path, index) => expect.objectContaining({ path, status: statuses[index] })),
    );
  });

  it("rejects the fan-out when aborted and never starts queued probes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    // Aborted before invocation: nothing is fetched at all.
    const preAborted = new AbortController();
    preAborted.abort();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    await expect(collectEndpointProbes(["/api/chains"], preAborted.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    // Aborted mid-flight: in-flight probes settle, then the queue halts.
    const paths = Array.from({ length: ENDPOINT_PROBE_CONCURRENCY + 2 }, (_value, index) => `/api/abort-${index}`);
    const deferreds = paths.map(() => Promise.withResolvers<Response>());
    let started = 0;
    fetchMock.mockImplementation(() => deferreds[started++]!.promise);

    const controller = new AbortController();
    const probePromise = collectEndpointProbes(paths, controller.signal);
    await Promise.resolve();
    expect(started).toBe(ENDPOINT_PROBE_CONCURRENCY);

    controller.abort();
    for (const deferred of deferreds.slice(0, ENDPOINT_PROBE_CONCURRENCY)) {
      deferred.resolve(new Response("", { status: 200 }));
    }

    await expect(probePromise).rejects.toThrow();
    expect(started).toBe(ENDPOINT_PROBE_CONCURRENCY);
  });

  it("returns an error result for one failed fetch while sibling paths complete", async () => {
    const paths = ["/api/probe-ok-a", "/api/probe-fails", "/api/probe-ok-b"];
    const deferreds = paths.map(() => Promise.withResolvers<Response>());
    let started = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => deferreds[started++]!.promise);

    const probePromise = collectEndpointProbes(paths);
    await Promise.resolve();

    deferreds[0]!.resolve(new Response("", { status: 200 }));
    deferreds[1]!.reject(new Error("boom"));
    deferreds[2]!.resolve(new Response("", { status: 200 }));

    await expect(probePromise).resolves.toEqual([
      expect.objectContaining({ path: paths[0], status: 200 }),
      expect.objectContaining({ path: paths[1], status: null, error: "Network request failed" }),
      expect.objectContaining({ path: paths[2], status: 200 }),
    ]);
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
    const deferreds = paths.map(() => Promise.withResolvers<Response>());
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
