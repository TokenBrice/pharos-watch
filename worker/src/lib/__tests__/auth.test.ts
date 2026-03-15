import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAdmin, hasValidAdminCredential } from "../auth";

const TEST_TOKEN_ID = "test-service-token-id";
const TEST_TOKEN_SECRET = "test-service-token-secret";
const TEST_ENV = {
  OPS_API_SERVICE_TOKEN_ID: TEST_TOKEN_ID,
  OPS_API_SERVICE_TOKEN_SECRET: TEST_TOKEN_SECRET,
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

  it("rejects ops-api requests when service token secrets are not configured", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: {
        "CF-Access-Client-Id": TEST_TOKEN_ID,
        "CF-Access-Client-Secret": TEST_TOKEN_SECRET,
      },
    });
    const result = await hasValidAdminCredential(request, false, {});
    expect(result).toBe(false);
  });

  it("rejects ops-api requests with wrong service token", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: {
        "CF-Access-Client-Id": "wrong-id",
        "CF-Access-Client-Secret": "wrong-secret",
      },
    });
    const result = await hasValidAdminCredential(request, false, TEST_ENV);
    expect(result).toBe(false);
  });

  it("accepts ops-api request with valid service token", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: {
        "CF-Access-Client-Id": TEST_TOKEN_ID,
        "CF-Access-Client-Secret": TEST_TOKEN_SECRET,
      },
    });
    const result = await hasValidAdminCredential(request, false, TEST_ENV);
    expect(result).toBe(true);
  });

  it("accepts trustedAdmin=true regardless of headers", async () => {
    const request = new Request("https://x/admin");
    expect(await hasValidAdminCredential(request, true)).toBe(true);
  });
});
