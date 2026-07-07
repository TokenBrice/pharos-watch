import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, getEndpointOpsProxyTimeoutMs } from "@shared/lib/api-endpoints";
import { onRequest } from "../api/admin/[[path]].ts";

const { verifyAccessJwt } = vi.hoisted(() => ({
  verifyAccessJwt: vi.fn(),
}));
vi.mock("@shared/lib/cloudflare-access-jwt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/cloudflare-access-jwt")>();
  return { ...actual, verifyAccessJwt };
});

const BASE_ENV = {
  OPS_UI_ORIGIN: "https://ops.pharos.watch",
  OPS_API_ORIGIN: "https://ops-api.pharos.watch",
  CF_ACCESS_TEAM_DOMAIN: "pharos-watch",
  CF_ACCESS_OPS_UI_AUD: "ui-aud",
  OPS_API_SERVICE_TOKEN_ID: "id",
  OPS_API_SERVICE_TOKEN_SECRET: "secret",
};

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

describe("ops admin proxy", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    verifyAccessJwt.mockReset();
    verifyAccessJwt.mockResolvedValue(true);
  });

  it("rejects requests from non-ops hosts", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("rejects non-allowlisted admin paths", async () => {
    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/api/admin/not-real"),
      env: BASE_ENV,
      params: { path: "not-real" },
    });

    expect(response.status).toBe(404);
  });

  it("returns 401 before proxying when the UI JWT is missing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 401 before proxying when the UI JWT is invalid", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    verifyAccessJwt.mockResolvedValueOnce(false);

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a bootstrapped Access session cookie when the assertion header is absent", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: makeCookieAuthedRequest("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(verifyAccessJwt).toHaveBeenCalledWith({
      token: "valid-ui-jwt",
      aud: "ui-aud",
      teamDomain: "pharos-watch",
      expectedType: "app",
      expectedSubject: "user",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ops-api.pharos.watch/api/status",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("enforces endpoint method rules before proxying upstream", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/api/admin/backfill-depegs", { method: "GET" }),
      env: BASE_ENV,
      params: { path: "backfill-depegs" },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Allow")).toContain("POST");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 403 before proxying mutating requests without a same-origin Origin header", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/discovery-candidates/42/dismiss", { method: "POST" }),
      env: BASE_ENV,
      params: { path: ["discovery-candidates", "42", "dismiss"] },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 403 before proxying mutating requests with a foreign Origin header", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/discovery-candidates/42/dismiss", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
      env: BASE_ENV,
      params: { path: ["discovery-candidates", "42", "dismiss"] },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allowlists shared dynamic admin routes", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/discovery-candidates/42/dismiss", {
        method: "POST",
        headers: { Origin: "https://ops.pharos.watch" },
      }),
      env: BASE_ENV,
      params: { path: ["discovery-candidates", "42", "dismiss"] },
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ops-api.pharos.watch/api/discovery-candidates/42/dismiss",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("proxies the self-serve request admin list route", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ requests: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/api-key-requests-admin?limit=1"),
      env: BASE_ENV,
      params: { path: "api-key-requests-admin" },
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ops-api.pharos.watch/api/api-key-requests-admin?limit=1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("proxies self-serve reject actions with admin and idempotency headers", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: "rejected" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-123",
        "X-Idempotent-Replay": "true",
      },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/api-key-requests-admin/akr_abc12345/reject", {
        method: "POST",
        headers: {
          Origin: "https://ops.pharos.watch",
          "Idempotency-Key": "idem-123",
          "X-Pharos-Admin": "1",
        },
      }),
      env: BASE_ENV,
      params: { path: ["api-key-requests-admin", "akr_abc12345", "reject"] },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Key")).toBe("idem-123");
    expect(response.headers.get("X-Idempotent-Replay")).toBe("true");
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ops-api.pharos.watch/api/api-key-requests-admin/akr_abc12345/reject",
      expect.objectContaining({ method: "POST" }),
    );
    expect(headers.get("Idempotency-Key")).toBe("idem-123");
    expect(headers.get("X-Pharos-Admin")).toBe("1");
  });

  it("proxies self-serve release-claim actions and leaves missing admin headers to the Worker", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/api-key-requests-admin/akr_abc12345/release-claim", {
        method: "POST",
        headers: { Origin: "https://ops.pharos.watch" },
      }),
      env: BASE_ENV,
      params: { path: ["api-key-requests-admin", "akr_abc12345", "release-claim"] },
    });

    expect(response.status).toBe(403);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ops-api.pharos.watch/api/api-key-requests-admin/akr_abc12345/release-claim",
      expect.objectContaining({ method: "POST" }),
    );
    expect(headers.get("X-Pharos-Admin")).toBeNull();
  });

  it("returns 500 when the service-token pair is incomplete", async () => {
    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/status"),
      env: {
        ...BASE_ENV,
        OPS_API_SERVICE_TOKEN_SECRET: undefined,
      },
      params: { path: "status" },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Ops API proxy is not configured" });
  });

  it("returns 500 when UI Access validation bindings are missing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/status"),
      env: {
        ...BASE_ENV,
        CF_ACCESS_OPS_UI_AUD: undefined,
      },
      params: { path: "status" },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Ops UI Access validation is not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("translates Cloudflare Access redirects to 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://pharos.cloudflareaccess.com/cdn-cgi/access/login" },
    })));

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Operator API upstream auth failed" });
  });

  it("does not treat spoofed Cloudflare Access substrings as auth redirects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://example.com/login?next=pharos.cloudflareaccess.com" },
    })));

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("preserves malformed upstream redirect locations", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "not a valid URL with pharos.cloudflareaccess.com" },
    })));

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("preserves upstream Retry-After headers on degraded admin responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "temporarily unavailable" }), {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "60",
      },
    })));

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    await expect(response.json()).resolves.toEqual({ error: "temporarily unavailable" });
  });

  it("returns 502 when the upstream fetch itself fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));

    const response = await onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Operator API upstream fetch failed" });
    expect(warnSpy).toHaveBeenCalledWith("[ops-proxy] upstream fetch failed (Error): network down");
  });

  it("returns 504 when the upstream request times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
        });
      })
    )));

    const responsePromise = onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    await vi.advanceTimersByTimeAsync(20_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Operator API upstream timed out" });
  });

  it("declares ops proxy timeout budgets in endpoint metadata", () => {
    expect(getEndpointOpsProxyTimeoutMs(API_PATHS.status(), 10_000)).toBe(20_000);
    expect(getEndpointOpsProxyTimeoutMs(API_PATHS.statusHistoryBase(), 10_000)).toBe(20_000);
    expect(getEndpointOpsProxyTimeoutMs(API_PATHS.auditDepegHistoryBase(), 10_000)).toBe(45_000);
    expect(getEndpointOpsProxyTimeoutMs(API_PATHS.requestSourceStatsBase(), 10_000)).toBe(10_000);
  });

  it("gives status-history the status proxy timeout budget", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
        });
      })
    )));

    const responsePromise = onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/status-history?limit=10"),
      env: BASE_ENV,
      params: { path: "status-history" },
    });

    await vi.advanceTimersByTimeAsync(20_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Operator API upstream timed out" });
  });

  it("gives audit-depeg-history a longer proxy timeout budget", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
        });
      })
    )));

    const responsePromise = onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/audit-depeg-history?dry-run=true"),
      env: BASE_ENV,
      params: { path: "audit-depeg-history" },
    });

    await vi.advanceTimersByTimeAsync(45_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Operator API upstream timed out" });
  });

  it("keeps the default 10s proxy timeout on non-status admin routes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
        });
      })
    )));

    const responsePromise = onRequest({
      request: makeAuthedRequest("https://ops.pharos.watch/api/admin/request-source-stats"),
      env: BASE_ENV,
      params: { path: "request-source-stats" },
    });

    await vi.advanceTimersByTimeAsync(10_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Operator API upstream timed out" });
  });
});
