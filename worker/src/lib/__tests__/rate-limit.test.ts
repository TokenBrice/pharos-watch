import { describe, it, expect } from "vitest";
import { checkRateLimit } from "../rate-limit";

describe("checkRateLimit", () => {
  it("allows requests within the limit", () => {
    const ip = `test-allow-${Date.now()}`;
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit(ip, 60, 60_000)).toBeNull();
    }
  });

  it("returns 429 when limit is exceeded", () => {
    const ip = `test-exceed-${Date.now()}`;
    for (let i = 0; i < 61; i++) {
      checkRateLimit(ip, 60, 60_000);
    }
    const result = checkRateLimit(ip, 60, 60_000);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  it("includes Retry-After header in 429 response", () => {
    const ip = `test-retry-${Date.now()}`;
    for (let i = 0; i < 62; i++) {
      checkRateLimit(ip, 60, 60_000);
    }
    const result = checkRateLimit(ip, 60, 60_000);
    expect(result).not.toBeNull();
    expect(result!.headers.get("Retry-After")).toBeTruthy();
  });
});
