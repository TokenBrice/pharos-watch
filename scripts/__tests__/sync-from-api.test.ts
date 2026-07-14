import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetchHeaders, fetchWithRetry, resolveApiPathUrl } from "../lib/sync-from-api";

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("adds the site API credential for deploy-time internal reads", () => {
    vi.stubEnv("DIGEST_API_KEY", "public-key");
    vi.stubEnv("SITE_API_SHARED_SECRET", "site-secret");

    expect(apiFetchHeaders(["DIGEST_API_KEY"])).toEqual({
      Accept: "application/json",
      "X-API-Key": "public-key",
      "X-Pharos-Site-Proxy-Secret": "site-secret",
    });
  });

  it("maps API paths onto the browser-facing site-data lane", () => {
    expect(resolveApiPathUrl("https://pharos.watch/_site-data", "/api/digest-archive")).toBe(
      "https://pharos.watch/_site-data/digest-archive",
    );
    expect(resolveApiPathUrl("https://pharos.watch/_site-data/", "/api/depeg-events?limit=1000")).toBe(
      "https://pharos.watch/_site-data/depeg-events?limit=1000",
    );
  });

  it("keeps site-data release reads browser-shaped", () => {
    vi.stubEnv("DIGEST_API_KEY", "public-key");
    vi.stubEnv("SITE_API_SHARED_SECRET", "site-secret");

    expect(apiFetchHeaders(["DIGEST_API_KEY"], { url: "https://pharos.watch/_site-data/digest-archive" })).toEqual({
      Accept: "application/json",
      Origin: "https://pharos.watch",
    });
  });

  it("retries caller-declared transient statuses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry(
      "https://api.pharos.watch/api/health",
      {},
      { logLabel: "test", retryStatuses: [403], backoffMs: [0] },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry undeclared client errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry(
      "https://api.pharos.watch/api/health",
      {},
      { logLabel: "test", retryStatuses: [403], backoffMs: [0] },
    );

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
