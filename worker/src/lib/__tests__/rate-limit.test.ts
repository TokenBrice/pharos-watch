import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkPublicApiRateLimit, resetRateLimitStateForTests } from "../rate-limit";

describe("checkPublicApiRateLimit", () => {
  beforeEach(() => {
    resetRateLimitStateForTests();
    vi.restoreAllMocks();
  });

  it("fails open for transient distributed limiter errors before the emergency threshold", async () => {
    const db = {
      prepare() {
        throw new Error("d1 unavailable");
      },
    };

    await expect(checkPublicApiRateLimit(db, "203.0.113.10", "salt")).resolves.toBeNull();
    await expect(checkPublicApiRateLimit(db, "203.0.113.10", "salt")).resolves.toBeNull();
  });

  it("returns 503 once the emergency block threshold is reached", async () => {
    const db = {
      prepare() {
        throw new Error("d1 unavailable");
      },
    };

    await checkPublicApiRateLimit(db, "203.0.113.10", "salt");
    await checkPublicApiRateLimit(db, "203.0.113.10", "salt");
    const blocked = await checkPublicApiRateLimit(db, "203.0.113.10", "salt");

    expect(blocked?.status).toBe(503);
    expect(blocked?.headers.get("Retry-After")).toBe("60");
    await expect(blocked?.json()).resolves.toEqual({ error: "Public API temporarily unavailable" });
  });

  it("resets the emergency block state after a successful distributed limiter call", async () => {
    const failingDb = {
      prepare() {
        throw new Error("d1 unavailable");
      },
    };
    const successStatement = {
      bind() {
        return this;
      },
      async first<T>() {
        return { count: 1 } as T;
      },
      async run() {
        return { meta: { changes: 1 } };
      },
    };
    const successfulDb = {
      prepare() {
        return successStatement;
      },
    };

    await checkPublicApiRateLimit(failingDb, "203.0.113.11", "salt");
    await checkPublicApiRateLimit(failingDb, "203.0.113.11", "salt");
    await expect(checkPublicApiRateLimit(successfulDb, "203.0.113.11", "salt")).resolves.toBeNull();
    await expect(checkPublicApiRateLimit(failingDb, "203.0.113.11", "salt")).resolves.toBeNull();
  });
});
