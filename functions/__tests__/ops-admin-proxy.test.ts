import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, getEndpointOpsProxyTimeoutMs } from "@shared/lib/api-endpoints";
import { MAX_OPS_ADMIN_REQUEST_BODY_BYTES, onRequest } from "../api/admin/[[path]].ts";
import type { OpsAdminProxyEnv } from "../lib/ops-env";
import { makePagesProxyContext } from "./helpers/pages-context";
import {
  matchesHttpResponseObservation,
  observeHttpResponse,
  type HttpResponseObservation,
} from "../../scripts/test-utils/http-response-contract";

const { verifyAccessJwtUserIdentity } = vi.hoisted(() => ({
  verifyAccessJwtUserIdentity: vi.fn(),
}));
vi.mock("@shared/lib/cloudflare-access-jwt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/cloudflare-access-jwt")>();
  return { ...actual, verifyAccessJwtUserIdentity };
});

const BASE_ENV = {
  OPS_UI_ORIGIN: "https://ops.pharos.watch",
  OPS_API_ORIGIN: "https://ops-api.pharos.watch",
  CF_ACCESS_TEAM_DOMAIN: "pharos-watch",
  CF_ACCESS_OPS_UI_AUD: "ui-aud",
  OPS_API_SERVICE_TOKEN_ID: "id",
  OPS_API_SERVICE_TOKEN_SECRET: "secret",
};

/** Pages context bag for the `/api/admin/[[path]]` catch-all. */
function adminContext(request: Request, env: OpsAdminProxyEnv = BASE_ENV) {
  return makePagesProxyContext({ request, env, mountPath: "/api/admin" });
}

function readFetchInit(fetchSpy: unknown): RequestInit {
  const calls = (fetchSpy as { mock: { calls: Array<unknown[]> } }).mock.calls;
  return (calls[0]?.[1] ?? {}) as RequestInit;
}

function makeAuthedRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Cf-Access-Jwt-Assertion")) {
    headers.set("Cf-Access-Jwt-Assertion", "valid-ui-jwt");
  }
  return new Request(url, {
    ...init,
    headers,
  });
}

function makeCookieAuthedRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Cookie")) {
    headers.set("Cookie", "CF_Authorization=valid-ui-jwt");
  }
  return new Request(url, {
    ...init,
    headers,
  });
}

function makeStreamedAuthedPost(chunks: string[], headers: Record<string, string> = {}): Request {
  const encoder = new TextEncoder();
  return makeAuthedRequest("https://ops.pharos.watch/api/admin/backfill-depegs", {
    method: "POST",
    headers: { Origin: "https://ops.pharos.watch", ...headers },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("ops admin proxy", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    verifyAccessJwtUserIdentity.mockReset();
    verifyAccessJwtUserIdentity.mockResolvedValue({ email: "operator@pharos.watch", subject: "operator-subject" });
  });

  it("keeps the response contract for operator no-store policy", async () => {
    verifyAccessJwtUserIdentity.mockResolvedValueOnce({
      email: "operator@pharos.watch",
      subject: "operator-subject",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ z: "last", a: "first" }), {
            status: 200,
            headers: { "Cache-Control": "public, max-age=300", "Content-Type": "application/json" },
          }),
      ),
    );
    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));
    const observed = await observeHttpResponse(response, [
      "Cache-Control",
      "CDN-Cache-Control",
      "Cloudflare-CDN-Cache-Control",
      "Content-Type",
    ]);
    const expected: HttpResponseObservation = {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "cdn-cache-control": "no-store",
        "cloudflare-cdn-cache-control": "no-store",
        "content-type": "application/json",
      },
      bodyKind: "json",
      canonicalBody: { a: "first", z: "last" },
    };

    expect(observed).toEqual(expected);
    expect(matchesHttpResponseObservation(observed, expected)).toBe(true);
  });

  it("rejects requests from non-ops hosts", async () => {
    const response = await onRequest(adminContext(new Request("https://pharos.watch/api/admin/status")));

    expect(response.status).toBe(404);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("rejects non-allowlisted admin paths", async () => {
    const response = await onRequest(adminContext(new Request("https://ops.pharos.watch/api/admin/not-real")));

    expect(response.status).toBe(404);
  });

  it("returns 401 before proxying when the UI JWT is missing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(adminContext(new Request("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(401);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 401 before proxying when the UI JWT is invalid", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    verifyAccessJwtUserIdentity.mockResolvedValueOnce(null);

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a bootstrapped Access session cookie when the assertion header is absent", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Cache-Control": "public, max-age=300", "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeCookieAuthedRequest("https://ops.pharos.watch/api/admin/status")),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(verifyAccessJwtUserIdentity).toHaveBeenCalledWith({
      token: "valid-ui-jwt",
      aud: "ui-aud",
      teamDomain: "pharos-watch",
      expectedType: "app",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ops-api.pharos.watch/api/status",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("accepts the Cloudflare Access token header when the assertion header is absent", async () => {
    verifyAccessJwtUserIdentity.mockResolvedValueOnce({
      email: "operator@pharos.watch",
      subject: "operator-subject",
    });
    const fetchSpy = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(new Request("https://ops.pharos.watch/api/admin/status", {
        headers: { "cf-access-token": "valid-access-token" },
      })),
    );

    expect(response.status).toBe(200);
    expect(verifyAccessJwtUserIdentity).toHaveBeenCalledWith({
      token: "valid-access-token",
      aud: "ui-aud",
      teamDomain: "pharos-watch",
      expectedType: "app",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("forwards only the verified JWT actor and ignores a browser-supplied actor header", async () => {
    verifyAccessJwtUserIdentity.mockResolvedValueOnce({
      email: "verified@pharos.watch",
      subject: "verified-subject",
    });
    const fetchSpy = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status", {
        headers: { "Cf-Access-Authenticated-User-Email": "spoofed@evil.example" },
      })),
    );

    expect(response.status).toBe(200);
    const upstreamInit = readFetchInit(fetchSpy);
    const upstreamHeaders = new Headers(upstreamInit.headers);
    expect(upstreamHeaders.get("Cf-Access-Authenticated-User-Email")).toBe("verified@pharos.watch");
    expect(upstreamHeaders.get("Cf-Access-Authenticated-User-Email")).not.toBe("spoofed@evil.example");
  });

  it("enforces endpoint method rules before proxying upstream", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(new Request("https://ops.pharos.watch/api/admin/backfill-depegs", { method: "GET" })),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Allow")).toContain("POST");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 403 before proxying mutating requests without a same-origin Origin header", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/api-keys/42/update", {
        method: "POST",
      })),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 403 before proxying mutating requests with a foreign Origin header", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/api-keys/42/update", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      })),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allowlists shared dynamic admin routes", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/api-keys/42/update", {
        method: "POST",
        headers: { Origin: "https://ops.pharos.watch" },
      })),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ops-api.pharos.watch/api/api-keys/42/update",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("rejects declared oversized request bodies before proxying", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeStreamedAuthedPost(["{}"], {
        "Content-Length": String(MAX_OPS_ADMIN_REQUEST_BODY_BYTES + 1),
      })),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps allowed request bodies streaming to the upstream", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(ReadableStream);
      const body = await new Response(init?.body).text();
      expect(body).toBe('{"dryRun":true}');
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(adminContext(makeStreamedAuthedPost(['{"dry', 'Run":true}'])));

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("aborts streamed request bodies that cross the cap", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Response(init?.body).arrayBuffer();
      return Response.json({ impossible: true });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeStreamedAuthedPost(["x".repeat(MAX_OPS_ADMIN_REQUEST_BODY_BYTES), "x"])),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("proxies the self-serve request admin list route", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ requests: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/api-key-requests-admin?limit=1")),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ops-api.pharos.watch/api/api-key-requests-admin?limit=1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("proxies self-serve reject actions with admin and execution metadata headers", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "rejected" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "idem-123",
            "X-Execution-Certainty": "unknown",
            "X-Idempotent-Replay": "true",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/api-key-requests-admin/akr_abc12345/reject", {
        method: "POST",
        headers: {
          Origin: "https://ops.pharos.watch",
          "Idempotency-Key": "idem-123",
          "X-Pharos-Admin": "1",
        },
      })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Key")).toBe("idem-123");
    expect(response.headers.get("X-Execution-Certainty")).toBe("unknown");
    expect(response.headers.get("X-Idempotent-Replay")).toBe("true");
    const headers = new Headers(readFetchInit(fetchSpy).headers);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ops-api.pharos.watch/api/api-key-requests-admin/akr_abc12345/reject",
      expect.objectContaining({ method: "POST" }),
    );
    expect(headers.get("Idempotency-Key")).toBe("idem-123");
    expect(headers.get("X-Pharos-Admin")).toBe("1");
  });

  it("proxies self-serve release-claim actions and leaves missing admin headers to the Worker", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeAuthedRequest(
        "https://ops.pharos.watch/api/admin/api-key-requests-admin/akr_abc12345/release-claim",
        {
          method: "POST",
          headers: { Origin: "https://ops.pharos.watch" },
        },
      )),
    );

    expect(response.status).toBe(403);
    const headers = new Headers(readFetchInit(fetchSpy).headers);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ops-api.pharos.watch/api/api-key-requests-admin/akr_abc12345/release-claim",
      expect.objectContaining({ method: "POST" }),
    );
    expect(headers.get("X-Pharos-Admin")).toBeNull();
  });

  it("returns 500 when the service-token pair is incomplete", async () => {
    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status"), {
        ...BASE_ENV,
        OPS_API_SERVICE_TOKEN_SECRET: undefined,
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Ops API proxy is not configured" });
  });

  it("does not send service credentials to a non-canonical configured origin", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status"), {
        ...BASE_ENV,
        OPS_API_ORIGIN: "https://attacker.example",
      }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 500 when UI Access validation bindings are missing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status"), {
        ...BASE_ENV,
        CF_ACCESS_OPS_UI_AUD: undefined,
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Ops UI Access validation is not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("translates Cloudflare Access redirects to 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://pharos.cloudflareaccess.com/cdn-cgi/access/login" },
          }),
      ),
    );

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Operator API upstream auth failed" });
  });

  it("does not treat spoofed Cloudflare Access substrings as auth redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://example.com/login?next=pharos.cloudflareaccess.com" },
          }),
      ),
    );

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("preserves malformed upstream redirect locations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "not a valid URL with pharos.cloudflareaccess.com" },
          }),
      ),
    );

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("preserves upstream Retry-After headers on degraded admin responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "temporarily unavailable" }), {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "60",
            },
          }),
      ),
    );

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    await expect(response.json()).resolves.toEqual({ error: "temporarily unavailable" });
  });

  it("returns 502 when the upstream fetch itself fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Operator API upstream fetch failed" });
    expect(warnSpy).toHaveBeenCalledWith("[ops-proxy] upstream fetch failed (Error): network down");
  });

  it("returns 504 when the upstream request times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
            });
          }),
      ),
    );

    const responsePromise = onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    await vi.advanceTimersByTimeAsync(20_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Operator API upstream timed out" });
  });

  it("keeps the timeout active while the upstream response body is read", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"partial":'));
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const responsePromise = onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    await vi.advanceTimersByTimeAsync(20_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({ error: "Operator API upstream timed out" });
  });

  it("declares ops proxy timeout budgets in endpoint metadata", () => {
    expect(getEndpointOpsProxyTimeoutMs(API_PATHS.status(), 10_000)).toBe(20_000);
    expect(getEndpointOpsProxyTimeoutMs(API_PATHS.statusHistoryBase(), 10_000)).toBe(20_000);
    expect(getEndpointOpsProxyTimeoutMs(API_PATHS.auditDepegHistoryBase(), 10_000)).toBe(45_000);
    expect(getEndpointOpsProxyTimeoutMs(API_PATHS.requestSourceStatsBase(), 10_000)).toBe(10_000);
  });

  it("gives status-history the status proxy timeout budget", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
            });
          }),
      ),
    );

    const responsePromise = onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status-history?limit=10")),
    );

    await vi.advanceTimersByTimeAsync(20_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Operator API upstream timed out" });
  });

  it("gives audit-depeg-history a longer proxy timeout budget", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
            });
          }),
      ),
    );

    const responsePromise = onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/audit-depeg-history?dry-run=true")),
    );

    await vi.advanceTimersByTimeAsync(45_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Operator API upstream timed out" });
  });

  it("keeps the default 10s proxy timeout on non-status admin routes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
            });
          }),
      ),
    );

    const responsePromise = onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/request-source-stats")),
    );

    await vi.advanceTimersByTimeAsync(10_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Operator API upstream timed out" });
  });
});
