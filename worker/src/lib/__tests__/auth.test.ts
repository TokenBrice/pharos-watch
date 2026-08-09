import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasValidAdminCredential,
  hasValidSiteProxyCredential,
  isWorkerPreviewRequest,
  requireAdmin,
  timingSafeCompare,
  withAdmin,
} from "../auth";

vi.mock("@shared/lib/cloudflare-access-jwt", () => ({
  verifyAccessJwt: vi.fn().mockResolvedValue(true),
}));

const TEST_ENV = {
  CF_ACCESS_OPS_API_AUD: "test-aud",
  CF_ACCESS_TEAM_DOMAIN: "pharos-watch",
};

describe("auth helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 when auth headers are missing", async () => {
    const request = new Request("https://x/admin");
    const result = await requireAdmin(request);
    expect(result?.status).toBe(401);
  });

  it("rejects ops-api requests when no env configured", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt" },
    });
    const result = await hasValidAdminCredential(request, false, {});
    expect(result).toBe(false);
  });

  it("rejects ops-api requests when the audience is configured but the team domain is missing", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt" },
    });
    const result = await hasValidAdminCredential(request, false, { CF_ACCESS_OPS_API_AUD: "test-aud" });
    expect(result).toBe(false);
  });

  it("rejects malformed admin request URLs", async () => {
    const malformed = {
      url: "not a valid url",
      headers: new Headers({ "Cf-Access-Jwt-Assertion": "some-jwt" }),
    } as unknown as Request;
    expect(await hasValidAdminCredential(malformed, false, TEST_ENV)).toBe(false);
  });

  it("rejects ops-api requests without JWT header", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status");
    const result = await hasValidAdminCredential(request, false, TEST_ENV);
    expect(result).toBe(false);
  });

  it("accepts ops-api request with valid JWT", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const result = await hasValidAdminCredential(request, false, TEST_ENV);
    expect(result).toBe(true);
  });

  it("accepts Access-authenticated Worker preview requests for preview-only admin controls", async () => {
    const request = new Request("https://stablecoin-api.preview.workers.dev/api/admin/preview-only-control", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const result = await hasValidAdminCredential(request, false, TEST_ENV);
    expect(result).toBe(true);
  });

  it("does not accept Access admin credentials on the public production API host", async () => {
    const request = new Request("https://api.pharos.watch/api/admin/preview-only-control", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const result = await hasValidAdminCredential(request, false, TEST_ENV);
    expect(result).toBe(false);
  });

  it("accepts trustedAdmin=true regardless of headers", async () => {
    const request = new Request("https://x/admin");
    expect(await hasValidAdminCredential(request, true)).toBe(true);
  });

  it("runs withAdmin handlers only after auth succeeds", async () => {
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));
    const allowed = await withAdmin(new Request("https://x/admin"), handler, true);
    const denied = await withAdmin(new Request("https://x/admin"), handler, false);

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("accepts the shared site-proxy secret on the site-api host", async () => {
    const request = new Request("https://site-api.pharos.watch/api/stablecoins", {
      headers: { "X-Pharos-Site-Proxy-Secret": "shared-secret" },
    });
    expect(await hasValidSiteProxyCredential(request, { SITE_API_SHARED_SECRET: "shared-secret" })).toBe(true);
  });

  it("accepts the previous site-proxy secret during the overlap window", async () => {
    const request = new Request("https://site-api.pharos.watch/api/stablecoins", {
      headers: { "X-Pharos-Site-Proxy-Secret": "previous-secret" },
    });
    expect(await hasValidSiteProxyCredential(request, {
      SITE_API_SHARED_SECRET: "shared-secret",
      SITE_API_SHARED_SECRET_PREVIOUS: "previous-secret",
    })).toBe(true);
  });

  it("accepts the previous site-proxy secret even if the current secret is temporarily absent", async () => {
    const request = new Request("https://site-api.pharos.watch/api/stablecoins", {
      headers: { "X-Pharos-Site-Proxy-Secret": "previous-secret" },
    });
    expect(await hasValidSiteProxyCredential(request, {
      SITE_API_SHARED_SECRET_PREVIOUS: "previous-secret",
    })).toBe(true);
  });

  it("accepts the shared site-proxy secret on worker preview URLs only", async () => {
    const preview = new Request("https://stablecoin-api.user.workers.dev/api/stablecoins", {
      headers: { "X-Pharos-Site-Proxy-Secret": "shared-secret" },
    });
    const publicHost = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-Pharos-Site-Proxy-Secret": "shared-secret" },
    });

    expect(await hasValidSiteProxyCredential(preview, { SITE_API_SHARED_SECRET: "shared-secret" })).toBe(true);
    expect(await hasValidSiteProxyCredential(publicHost, { SITE_API_SHARED_SECRET: "shared-secret" })).toBe(false);
  });

  it("rejects site-proxy auth when the secret is missing or malformed", async () => {
    const request = new Request("https://site-api.pharos.watch/api/stablecoins");
    expect(await hasValidSiteProxyCredential(request, { SITE_API_SHARED_SECRET: "shared-secret" })).toBe(false);
    expect(await hasValidSiteProxyCredential(request, { SITE_API_SHARED_SECRET: " " })).toBe(false);
    expect(await hasValidSiteProxyCredential(undefined, { SITE_API_SHARED_SECRET: "shared-secret" })).toBe(false);
  });

  it("rejects site-proxy auth when no usable secret is configured", async () => {
    const request = new Request("https://site-api.pharos.watch/api/stablecoins", {
      headers: { "X-Pharos-Site-Proxy-Secret": "presented-secret" },
    });
    expect(await hasValidSiteProxyCredential(request, {
      SITE_API_SHARED_SECRET: " ",
      SITE_API_SHARED_SECRET_PREVIOUS: " ",
    })).toBe(false);
  });

  it("rejects site-proxy auth when the presented secret matches neither current nor previous", async () => {
    const request = new Request("https://site-api.pharos.watch/api/stablecoins", {
      headers: { "X-Pharos-Site-Proxy-Secret": "wrong-secret" },
    });
    expect(await hasValidSiteProxyCredential(request, {
      SITE_API_SHARED_SECRET: "shared-secret",
      SITE_API_SHARED_SECRET_PREVIOUS: "previous-secret",
    })).toBe(false);
  });

  it("rejects malformed site-proxy request URLs", async () => {
    const malformed = {
      url: "not a valid url",
      headers: new Headers({ "X-Pharos-Site-Proxy-Secret": "shared-secret" }),
    } as unknown as Request;
    expect(await hasValidSiteProxyCredential(malformed, { SITE_API_SHARED_SECRET: "shared-secret" })).toBe(false);
  });

  it("recognizes worker preview hosts and rejects malformed URLs", () => {
    expect(isWorkerPreviewRequest(new Request("https://stablecoin-api.user.workers.dev/api/stablecoins"))).toBe(true);
    expect(isWorkerPreviewRequest(new Request("https://api.pharos.watch/api/stablecoins"))).toBe(false);
    expect(isWorkerPreviewRequest({ url: "not a valid url" } as Request)).toBe(false);
    expect(isWorkerPreviewRequest(undefined)).toBe(false);
  });

  it("handles timing-safe compare guard paths", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await timingSafeCompare("shared-secret", "shared-secret")).toBe(true);
    expect(await timingSafeCompare("shared-secret", "different-secret")).toBe(false);
    expect(await timingSafeCompare("", "shared-secret")).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns false for different-length strings without leaking length", async () => {
    expect(await timingSafeCompare("short", "a-much-longer-secret-value")).toBe(false);
    expect(await timingSafeCompare("a-much-longer-secret-value", "short")).toBe(false);
  });
});
