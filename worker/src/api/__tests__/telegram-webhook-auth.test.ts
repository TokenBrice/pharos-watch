import { describe, it, expect } from "vitest";
import { timingSafeCompare, hasValidAdminCredential, requireAdmin, withAdmin } from "../../lib/auth";

describe("timingSafeCompare", () => {
  it("returns true for matching strings", async () => {
    expect(await timingSafeCompare("secret123", "secret123")).toBe(true);
  });
  it("returns false for non-matching strings", async () => {
    expect(await timingSafeCompare("secret123", "wrong")).toBe(false);
  });
  it("returns false for empty strings", async () => {
    expect(await timingSafeCompare("", "secret")).toBe(false);
  });
  it("returns false when both empty", async () => {
    expect(await timingSafeCompare("", "")).toBe(false);
  });
});

describe("hasValidAdminCredential", () => {
  it("returns true when trustedAdmin is true", async () => {
    expect(await hasValidAdminCredential(undefined, true)).toBe(true);
  });
  it("returns false when no request and not trusted", async () => {
    expect(await hasValidAdminCredential(undefined)).toBe(false);
  });
  it("returns false for non-ops-api request", async () => {
    const req = new Request("https://api.pharos.watch/api/test");
    expect(await hasValidAdminCredential(req)).toBe(false);
  });
  it("rejects ops-api request when no env configured", async () => {
    const req = new Request("https://ops-api.pharos.watch/api/test", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt" },
    });
    expect(await hasValidAdminCredential(req, false, {})).toBe(false);
  });
  it("returns false for ops-api request without JWT header", async () => {
    const req = new Request("https://ops-api.pharos.watch/api/test");
    expect(await hasValidAdminCredential(req)).toBe(false);
  });
});

describe("requireAdmin", () => {
  it("returns null when authorized", async () => {
    expect(await requireAdmin(undefined, true)).toBeNull();
  });
  it("returns 401 Response when unauthorized", async () => {
    const result = await requireAdmin(undefined);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });
});

describe("withAdmin", () => {
  it("executes handler when authorized", async () => {
    const handler = async () => new Response("ok");
    const result = await withAdmin(undefined, handler, true);
    expect(await result.text()).toBe("ok");
  });
  it("returns 401 when unauthorized", async () => {
    const handler = async () => new Response("ok");
    const result = await withAdmin(undefined, handler, false);
    expect(result.status).toBe(401);
  });
});
