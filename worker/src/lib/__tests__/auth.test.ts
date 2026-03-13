import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCryptoForAuth } from "../../api/__tests__/helpers/auth";
import { getAdminCredential, hasValidAdminCredential, requireAdmin, timingSafeEqual } from "../auth";

describe("auth helpers", () => {
  beforeEach(() => {
    stubCryptoForAuth();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when X-Admin-Key matches", async () => {
    const request = new Request("https://x/admin", {
      headers: { "X-Admin-Key": "secret-key" },
    });

    const result = await requireAdmin(request, "secret-key");
    expect(result).toBeNull();
  });

  it("returns 401 when provided admin key is wrong", async () => {
    const request = new Request("https://x/admin", {
      headers: { "X-Admin-Key": "wrong-key" },
    });

    const result = await requireAdmin(request, "secret-key");
    expect(result?.status).toBe(401);
    await expect(result?.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when auth headers are missing", async () => {
    const request = new Request("https://x/admin");

    const result = await requireAdmin(request, "secret-key");
    expect(result?.status).toBe(401);
    await expect(result?.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 401 for malformed Authorization header (without Bearer prefix)", async () => {
    const request = new Request("https://x/admin", {
      headers: { Authorization: "secret-key" },
    });

    const result = await requireAdmin(request, "secret-key");
    expect(result?.status).toBe(401);
    await expect(result?.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("accepts a valid Bearer token", async () => {
    const request = new Request("https://x/admin", {
      headers: { Authorization: "Bearer secret-key" },
    });

    const result = await requireAdmin(request, "secret-key");
    expect(result).toBeNull();
  });

  it("extracts admin credentials consistently from header and bearer auth", () => {
    const headerRequest = new Request("https://x/admin", {
      headers: { "X-Admin-Key": "secret-key" },
    });
    const bearerRequest = new Request("https://x/admin", {
      headers: { Authorization: "Bearer secret-key" },
    });

    expect(getAdminCredential(headerRequest)).toBe("secret-key");
    expect(getAdminCredential(bearerRequest)).toBe("secret-key");
  });

  it("reports valid admin credentials for Bearer auth", async () => {
    const request = new Request("https://x/admin", {
      headers: { Authorization: "Bearer secret-key" },
    });

    await expect(hasValidAdminCredential(request, "secret-key")).resolves.toBe(true);
    await expect(hasValidAdminCredential(request, "wrong-key")).resolves.toBe(false);
  });

  it("timingSafeEqual handles equal, different, and different-length strings", async () => {
    await expect(timingSafeEqual("same", "same")).resolves.toBe(true);
    await expect(timingSafeEqual("same", "diff")).resolves.toBe(false);
    await expect(timingSafeEqual("same", "same-but-longer")).resolves.toBe(false);
  });
});
