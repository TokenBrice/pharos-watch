import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAdmin, hasValidAdminCredential } from "../auth";

vi.mock("../jwt-verify", () => ({
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

  it("accepts trustedAdmin=true regardless of headers", async () => {
    const request = new Request("https://x/admin");
    expect(await hasValidAdminCredential(request, true)).toBe(true);
  });
});
