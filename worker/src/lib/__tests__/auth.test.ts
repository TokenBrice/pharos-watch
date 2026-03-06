import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCryptoForAuth } from "../../api/__tests__/helpers/auth";
import { requireAdmin, timingSafeEqual } from "../auth";

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

  it("timingSafeEqual handles equal, different, and different-length strings", async () => {
    await expect(timingSafeEqual("same", "same")).resolves.toBe(true);
    await expect(timingSafeEqual("same", "diff")).resolves.toBe(false);
    await expect(timingSafeEqual("same", "same-but-longer")).resolves.toBe(false);
  });
});
