import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxyRequest, rejectInvalidProxyEnvironment, runPagesProxy, type PagesProxyHarness } from "../lib/pages-proxy-harness";
import { resolveOpsAdminUpstreamPath, resolveSiteDataRequestedPath } from "../lib/proxy-paths";

const context = {
  request: new Request("https://pharos.watch/_site-data/stablecoins?limit=2"),
  env: {},
  params: { path: ["stablecoins"] },
};

function harness(timeoutMs = 100): PagesProxyHarness<Record<string, never>, typeof context.params> {
  return {
    logPrefix: "proxy-contract",
    resolveUpstreamPath: ({ params }) => resolveSiteDataRequestedPath(params),
    buildUpstreamRequest: ({ request }, path) => createProxyRequest({
      request, origin: "https://site-api.example.test", path,
      search: new URL(request.url).search, timeoutMs, label: "Site data",
    }),
    buildResponse: (_context, _path, response) => response,
    finalizeResponse: (_context, response) => {
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Pages proxy path resolution", () => {
  it.each([undefined, "", []])("rejects an absent wildcard %j on both lanes", (path) => {
    expect(resolveOpsAdminUpstreamPath({ path })).toBeNull();
    expect(resolveSiteDataRequestedPath({ path })).toBeNull();
  });

  it("keeps operator and public-data resources on their separate upstream lanes", () => {
    expect(resolveOpsAdminUpstreamPath({ path: ["status", "history"] })).toBe("/api/status/history");
    expect(resolveSiteDataRequestedPath({ path: "stablecoins/usdc-circle" })).toBe("/_site-data/stablecoins/usdc-circle");
  });
});

describe("runPagesProxy", () => {
  it("serves buffered upstream status, headers and payload on the resolved URL", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) !== "https://site-api.example.test/_site-data/stablecoins?limit=2") {
        throw new Error("Wrong upstream resource");
      }
      return new Response('{"stablecoins":[]}', { status: 206, headers: { "X-Generation": "42" } });
    });
    const response = await runPagesProxy(context, harness());
    expect(response.status).toBe(206);
    expect(response.headers.get("X-Generation")).toBe("42");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ stablecoins: [] });
  });

  it("returns a finalized not-found response without contacting upstream for missing paths", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await runPagesProxy({ ...context, params: { path: [] } }, harness());
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["rejectRequest", "rejectUpstreamPath", "rejectMethod", "beforeFetch"] as const)(
    "finalizes the %s rejection without contacting upstream",
    async (hook) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      const proxy = harness();
      proxy[hook] = () => new Response('{"error":"Access denied"}', { status: 403 });
      const response = await runPagesProxy(context, proxy);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Access denied" });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("returns a finalized request-builder rejection without contacting upstream", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await runPagesProxy(context, {
      ...harness(),
      buildUpstreamRequest: () => new Response('{"error":"Request body too large"}', { status: 413 }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the lane's missing-path response even without a response finalizer", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await runPagesProxy({ ...context, params: { path: [] } }, {
      ...harness(),
      finalizeResponse: undefined,
      rejectUpstreamPath: (_context, path) => path === ""
        ? new Response("Unknown resource", { status: 400 })
        : null,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Unknown resource");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed for fatal environment issues while tolerating advisory issues", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reject = (code: string) => rejectInvalidProxyEnvironment({
      issues: [{ code, message: "private deployment diagnostic" }], fatalCodes: ["missing-origin"],
      logPrefix: "proxy-contract", publicMessage: "Proxy unavailable",
    });
    expect(reject("advisory")).toBeNull();
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await runPagesProxy(context, { ...harness(), validateEnv: () => reject("missing-origin") });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Proxy unavailable" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not publish a successful response when upstream is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const response = await runPagesProxy(context, harness());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Site data upstream fetch failed" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("lets the lane translate an upstream failure before finalizing the response", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const response = await runPagesProxy(context, {
      ...harness(),
      onFetchError: async (_context, path, kind, failure) => new Response(JSON.stringify({
        path, kind, upstreamStatus: failure.status,
      }), { status: 503 }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      path: "/_site-data/stablecoins", kind: "fetch-error", upstreamStatus: 502,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns a timeout only when the request reaches its deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      return promise;
    });
    let settled = false;
    const pending = runPagesProxy(context, harness()).then((response) => { settled = true; return response; });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Site data upstream timed out" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
