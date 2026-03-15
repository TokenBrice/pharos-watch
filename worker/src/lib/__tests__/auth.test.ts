import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAdmin, hasValidAdminCredential } from "../auth";

vi.mock("../jwt-verify", () => ({
  verifyAccessJwt: vi.fn().mockResolvedValue(true),
}));

describe("auth helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 when auth headers are missing", async () => {
    const request = new Request("https://x/admin");
    const result = await requireAdmin(request);
    expect(result?.status).toBe(401);
  });

  it("rejects ops-api requests when CF_ACCESS_OPS_API_AUD is not configured", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Authenticated-User-Email": "operator@example.com" },
    });
    const result = await requireAdmin(request);
    expect(result?.status).toBe(401);
  });

  it("rejects ops-api requests with spoofed service token headers when AUD not set", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: {
        "CF-Access-Client-Id": "svc-id",
        "CF-Access-Client-Secret": "svc-secret",
      },
    });
    const result = await requireAdmin(request);
    expect(result?.status).toBe(401);
  });

  it("accepts ops-api request with valid JWT when AUD is configured", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const env = { CF_ACCESS_OPS_API_AUD: "test-aud" };
    const result = await hasValidAdminCredential(request, false, env);
    expect(result).toBe(true);
  });

  it("accepts trustedAdmin=true regardless of headers", async () => {
    const request = new Request("https://x/admin");
    expect(await hasValidAdminCredential(request, true)).toBe(true);
  });
});
