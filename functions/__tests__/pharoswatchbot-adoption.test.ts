import { afterEach, describe, expect, it, vi } from "vitest";

const siteApiEnvOverride = vi.hoisted(() => ({ forceNullOrigin: false }));

vi.mock("../lib/site-api-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/site-api-env")>();
  return {
    ...actual,
    resolveSiteApiOrigin: (env: Parameters<typeof actual.resolveSiteApiOrigin>[0]) =>
      siteApiEnvOverride.forceNullOrigin ? null : actual.resolveSiteApiOrigin(env),
  };
});

import { onRequest } from "../pharoswatchbot-adoption";

const ENV = {
  SITE_ORIGIN: "https://pharos.watch",
  OPS_UI_ORIGIN: "https://ops.pharos.watch",
  SITE_API_ORIGIN: "https://site-api.pharos.watch",
  SITE_API_SHARED_SECRET: "shared-secret",
  TELEGRAM_ADOPTION_IP_HASH_SECRET: "test-secret",
};

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request("https://pharos.watch/pharoswatchbot-adoption", {
    method: "POST",
    headers: {
      Origin: "https://pharos.watch",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function installFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PharosWatchBot adoption Pages forwarder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("forwards the same-origin click to the Worker and preserves the response contract", async () => {
    const fetchMock = installFetch(new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Analytics-Quality": "best-effort; suppression=5",
      },
    }));

    const result = await onRequest({
      request: request({ campaign: "landing", placement: "hero" }),
      env: ENV,
    });

    expect(result.status).toBe(204);
    expect(result.headers.get("X-Analytics-Quality")).toBe("best-effort; suppression=5");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://site-api.pharos.watch/api/telegram-adoption");
    expect(init?.method).toBe("POST");
    const upstreamHeaders = new Headers(init?.headers);
    expect(upstreamHeaders.get("X-Pharos-Site-Proxy-Secret")).toBe("shared-secret");
    expect(upstreamHeaders.get("X-Pharos-Telegram-Adoption-Client-Hash")).toMatch(/^[0-9a-f]{32}$/);
    expect(upstreamHeaders.get("CF-Connecting-IP")).toBeNull();
    expect(upstreamHeaders.get("Origin")).toBe("https://pharos.watch");
    await expect(new Response(init?.body as BodyInit).json()).resolves.toEqual({
      campaign: "landing",
      placement: "hero",
    });
  });

  it("keeps method and same-origin rejection in Pages without forwarding", async () => {
    const fetchMock = installFetch(new Response(null, { status: 204 }));
    const getRequest = new Request("https://pharos.watch/pharoswatchbot-adoption", { method: "GET" });
    const foreignRequest = request(
      { campaign: "landing", placement: "hero" },
      { Origin: "https://evil.example" },
    );

    expect((await onRequest({ request: getRequest, env: ENV })).status).toBe(405);
    expect((await onRequest({ request: foreignRequest, env: ENV })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes Worker validation and quota responses through unchanged", async () => {
    const fetchMock = installFetch(new Response(null, {
      status: 429,
      headers: { "Retry-After": "60" },
    }));

    const result = await onRequest({
      request: request({ campaign: "landing", placement: "hero" }),
      env: ENV,
    });

    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("60");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards Worker schema rejection instead of validating the body in Pages", async () => {
    const fetchMock = installFetch(new Response(null, { status: 400 }));

    const result = await onRequest({
      request: request({ campaign: "landing", placement: "custom" }),
      env: ENV,
    });

    expect(result.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed for missing proxy configuration or client-IP secret", async () => {
    const fetchMock = installFetch(new Response(null, { status: 204 }));

    expect(
      (await onRequest({
        request: request({ campaign: "landing", placement: "hero" }),
        env: { ...ENV, SITE_API_ORIGIN: undefined },
      })).status,
    ).toBe(500);
    expect(
      (await onRequest({
        request: request({ campaign: "landing", placement: "hero" }),
        env: { ...ENV, TELEGRAM_ADOPTION_IP_HASH_SECRET: undefined },
      })).status,
    ).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when origin resolution diverges from env validation", async () => {
    // Defends the buildUpstreamRequest guard: validatePagesSiteDataProxyEnv and
    // resolveSiteApiOrigin are separate functions that could drift apart.
    const fetchMock = installFetch(new Response(null, { status: 204 }));
    siteApiEnvOverride.forceNullOrigin = true;
    try {
      const result = await onRequest({
        request: request({ campaign: "landing", placement: "hero" }),
        env: ENV,
      });
      expect(result.status).toBe(500);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      siteApiEnvOverride.forceNullOrigin = false;
    }
  });

  it("normalizes upstream fetch failures to the proxy error contract", async () => {
    installFetch(new Error("upstream unavailable"));
    const result = await onRequest({
      request: request({ campaign: "landing", placement: "hero" }),
      env: ENV,
    });

    expect(result.status).toBe(502);
  });
});
