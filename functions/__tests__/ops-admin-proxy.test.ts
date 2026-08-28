import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, getEndpointOpsProxyTimeoutMs } from "@shared/lib/api-endpoints";
import { MAX_OPS_ADMIN_REQUEST_BODY_BYTES, onRequest } from "../api/admin/[[path]].ts";
import type { OpsAdminProxyEnv } from "../lib/ops-env";
import { makePagesProxyContext } from "./helpers/pages-context";
import {
  matchesHttpResponseObservation,
  observeHttpResponse,
  type HttpResponseObservation,
} from "@shared/test-utils/http-response-contract";
import { mockFetch } from "@shared/test-utils/mock-fetch";

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

function installOpsFetch(
  path: string,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return mockFetch([{
    match: `https://ops-api.pharos.watch${path}`,
    body,
    status,
    headers,
  }], { requireMatch: true, strictUrl: true });
}

function installOpsResponse(path: string, response: Response) {
  return mockFetch([{
    match: `https://ops-api.pharos.watch${path}`,
    outcomes: [{ response }],
  }], { requireMatch: true, strictUrl: true });
}

function installOpsError(path: string, error: Error) {
  return mockFetch([{
    match: `https://ops-api.pharos.watch${path}`,
    outcomes: [error],
  }], { requireMatch: true, strictUrl: true });
}

function installOpsTimeout(path: string) {
  return mockFetch([{
    match: `https://ops-api.pharos.watch${path}`,
    outcomes: [{ stall: true }],
  }], { requireMatch: true, strictUrl: true });
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
    installOpsFetch("/api/status", { z: "last", a: "first" }, 200, {
      "Cache-Control": "public, max-age=300",
    });
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
    const fetchSpy = mockFetch([], { requireMatch: true });

    const response = await onRequest(adminContext(new Request("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(401);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 401 before proxying when the UI JWT is invalid", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });
    verifyAccessJwtUserIdentity.mockResolvedValueOnce(null);

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a bootstrapped Access session cookie when the assertion header is absent", async () => {
    const fetchSpy = installOpsFetch("/api/status", { ok: true }, 200, {
      "Cache-Control": "public, max-age=300",
    });

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
    expect(fetchSpy.getHistory()).toHaveLength(1);
    expect(fetchSpy.getHistory()[0]).toMatchObject({
      url: "https://ops-api.pharos.watch/api/status",
      method: "GET",
    });
  });

  it("accepts the Cloudflare Access token header when the assertion header is absent", async () => {
    verifyAccessJwtUserIdentity.mockResolvedValueOnce({
      email: "operator@pharos.watch",
      subject: "operator-subject",
    });
    const fetchSpy = installOpsFetch("/api/status", { ok: true });

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
    expect(fetchSpy.getHistory()).toHaveLength(1);
  });

  it("forwards only the verified JWT actor and ignores a browser-supplied actor header", async () => {
    verifyAccessJwtUserIdentity.mockResolvedValueOnce({
      email: "verified@pharos.watch",
      subject: "verified-subject",
    });
    const fetchSpy = installOpsFetch("/api/status", { ok: true });

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status", {
        headers: { "Cf-Access-Authenticated-User-Email": "spoofed@evil.example" },
      })),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy.getHistory()[0]?.headers["cf-access-authenticated-user-email"]).toBe("verified@pharos.watch");
    expect(fetchSpy.getHistory()[0]?.headers["cf-access-authenticated-user-email"]).not.toBe("spoofed@evil.example");
  });

  it("enforces endpoint method rules before proxying upstream", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });

    const response = await onRequest(
      adminContext(new Request("https://ops.pharos.watch/api/admin/backfill-depegs", { method: "GET" })),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Allow")).toContain("POST");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 403 before proxying mutating requests without a same-origin Origin header", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });

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
    const fetchSpy = mockFetch([], { requireMatch: true });

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
    const fetchSpy = installOpsFetch("/api/api-keys/42/update", { ok: true });

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/api-keys/42/update", {
        method: "POST",
        headers: { Origin: "https://ops.pharos.watch" },
      })),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy.getHistory()[0]).toMatchObject({
      url: "https://ops-api.pharos.watch/api/api-keys/42/update",
      method: "POST",
    });
  });

  it("rejects declared oversized request bodies before proxying", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });

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
    const fetchSpy = installOpsFetch("/api/api-key-requests-admin?limit=1", { requests: [] });

    const response = await onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/api-key-requests-admin?limit=1")),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy.getHistory()[0]).toMatchObject({
      url: "https://ops-api.pharos.watch/api/api-key-requests-admin?limit=1",
      method: "GET",
    });
  });

  it("proxies self-serve reject actions with admin and execution metadata headers", async () => {
    const fetchSpy = installOpsFetch("/api/api-key-requests-admin/akr_abc12345/reject", { status: "rejected" }, 200, {
      "Idempotency-Key": "idem-123",
      "X-Execution-Certainty": "unknown",
      "X-Idempotent-Replay": "true",
    });

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
    expect(fetchSpy.getHistory()[0]).toMatchObject({
      url: "https://ops-api.pharos.watch/api/api-key-requests-admin/akr_abc12345/reject",
      method: "POST",
    });
    expect(fetchSpy.getHistory()[0]?.headers["idempotency-key"]).toBe("idem-123");
    expect(fetchSpy.getHistory()[0]?.headers["x-pharos-admin"]).toBe("1");
  });

  it("proxies self-serve release-claim actions and leaves missing admin headers to the Worker", async () => {
    const fetchSpy = installOpsFetch(
      "/api/api-key-requests-admin/akr_abc12345/release-claim",
      { error: "Forbidden" },
      403,
    );

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
    expect(fetchSpy.getHistory()[0]).toMatchObject({
      url: "https://ops-api.pharos.watch/api/api-key-requests-admin/akr_abc12345/release-claim",
      method: "POST",
    });
    expect(fetchSpy.getHistory()[0]?.headers["x-pharos-admin"]).toBeUndefined();
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
    const fetchSpy = mockFetch([], { requireMatch: true });

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
    const fetchSpy = mockFetch([], { requireMatch: true });

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
    installOpsResponse(
      "/api/status",
      new Response(null, {
        status: 302,
        headers: { Location: "https://pharos.cloudflareaccess.com/cdn-cgi/access/login" },
      }),
    );

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Operator API upstream auth failed" });
  });

  it("does not treat spoofed Cloudflare Access substrings as auth redirects", async () => {
    installOpsResponse(
      "/api/status",
      new Response(null, {
        status: 302,
        headers: { Location: "https://example.com/login?next=pharos.cloudflareaccess.com" },
      }),
    );

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("preserves malformed upstream redirect locations", async () => {
    installOpsResponse(
      "/api/status",
      new Response(null, {
        status: 302,
        headers: { Location: "not a valid URL with pharos.cloudflareaccess.com" },
      }),
    );

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("preserves upstream Retry-After headers on degraded admin responses", async () => {
    installOpsFetch("/api/status", { error: "temporarily unavailable" }, 503, { "Retry-After": "60" });

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    await expect(response.json()).resolves.toEqual({ error: "temporarily unavailable" });
  });

  it("returns 502 when the upstream fetch itself fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    installOpsError("/api/status", new Error("network down"));

    const response = await onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Operator API upstream fetch failed" });
    expect(warnSpy).toHaveBeenCalledWith("[ops-proxy] upstream fetch failed (Error): network down");
  });

  it("returns 504 when the upstream request times out", async () => {
    vi.useFakeTimers();
    installOpsTimeout("/api/status");

    const responsePromise = onRequest(adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/status")));

    await vi.advanceTimersByTimeAsync(20_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Operator API upstream timed out" });
  });

  it("keeps the timeout active while the upstream response body is read", async () => {
    vi.useFakeTimers();
    installOpsResponse(
      "/api/status",
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'));
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
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
    installOpsTimeout("/api/status-history?limit=10");

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
    installOpsTimeout("/api/audit-depeg-history?dry-run=true");

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
    installOpsTimeout("/api/request-source-stats");

    const responsePromise = onRequest(
      adminContext(makeAuthedRequest("https://ops.pharos.watch/api/admin/request-source-stats")),
    );

    await vi.advanceTimersByTimeAsync(10_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Operator API upstream timed out" });
  });
});
