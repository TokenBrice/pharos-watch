import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../api/admin/[[path]].ts";

const BASE_ENV = {
  OPS_UI_ORIGIN: "https://ops.pharos.watch",
  OPS_API_ORIGIN: "https://ops-api.pharos.watch",
  OPS_API_SERVICE_TOKEN_ID: "id",
  OPS_API_SERVICE_TOKEN_SECRET: "secret",
};

describe("ops admin proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects requests from non-ops hosts", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(404);
  });

  it("rejects non-allowlisted admin paths", async () => {
    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/api/admin/not-real"),
      env: BASE_ENV,
      params: { path: "not-real" },
    });

    expect(response.status).toBe(404);
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
    expect(response.headers.get("Allow")).toContain("POST");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 500 when the service-token pair is incomplete", async () => {
    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/api/admin/status"),
      env: {
        ...BASE_ENV,
        OPS_API_SERVICE_TOKEN_SECRET: undefined,
      },
      params: { path: "status" },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Ops API proxy is not configured" });
  });

  it("translates Cloudflare Access redirects to 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://pharos.cloudflareaccess.com/cdn-cgi/access/login" },
    })));

    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Operator API upstream auth failed" });
  });

  it("returns 502 when the upstream fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));

    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/api/admin/status"),
      env: BASE_ENV,
      params: { path: "status" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Operator API upstream fetch failed" });
  });
});
