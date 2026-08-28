import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCacheJsonParseFailureCountersForTests,
  readCachedJson,
  resetCacheJsonParseFailureCountersForTests,
  safeJsonParse,
} from "../api-cache-read";

describe("readCachedJson", () => {
  beforeEach(() => {
    resetCacheJsonParseFailureCountersForTests();
    vi.restoreAllMocks();
  });

  it("returns missing when the cache row is absent", () => {
    expect(readCachedJson("status", "stablecoins", null)).toEqual({ status: "missing" });
  });

  it("returns parsed data for valid cached json", () => {
    expect(readCachedJson<{ ok: boolean }>("status", "stablecoins", {
      value: JSON.stringify({ ok: true }),
    })).toEqual({
      status: "ok",
      data: { ok: true },
    });
  });

  it("returns malformed when the cached json is invalid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = readCachedJson("status", "stablecoins", { value: "{bad-json" });
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") {
      expect(result.message).toMatch(/Unexpected|JSON|Expected/i);
    }
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cache] Failed to parse persisted JSON (status:stablecoins); count=1:"),
    );
    expect(getCacheJsonParseFailureCountersForTests()["status:stablecoins"]?.count).toBe(1);
  });

  it("logs and counts safe JSON parse fallback failures", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(safeJsonParse("{bad-json", { fallback: true }, "daily-digest:input")).toEqual({ fallback: true });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cache] Failed to parse persisted JSON (daily-digest:input); count=1:"),
    );
    expect(getCacheJsonParseFailureCountersForTests()["daily-digest:input"]?.count).toBe(1);
  });
});
