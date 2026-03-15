import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdmin, hasValidAdminCredential } from "../auth";

describe("auth helpers", () => {
  beforeEach(() => {
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 when auth headers are missing", async () => {
    const request = new Request("https://x/admin");

    const result = await requireAdmin(request);
    expect(result?.status).toBe(401);
    await expect(result?.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("accepts ops-api requests carrying Access-generated user identity", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Authenticated-User-Email": "operator@example.com" },
    });

    const result = await requireAdmin(request);
    expect(result).toBeNull();
  });

  it("accepts ops-api requests carrying service-token headers", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: {
        "CF-Access-Client-Id": "svc-id",
        "CF-Access-Client-Secret": "svc-secret",
      },
    });

    const result = await requireAdmin(request);
    expect(result).toBeNull();
  });

  it("reports admin validity from ops-api access signals only", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Authenticated-User-Email": "operator@example.com" },
    });
    const publicRequest = new Request("https://api.pharos.watch/api/status");

    expect(await hasValidAdminCredential(request)).toBe(true);
    expect(await hasValidAdminCredential(publicRequest)).toBe(false);
  });
});
