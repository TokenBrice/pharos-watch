import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCacheHandler,
  encodeResponseReadyCacheValue,
  getResponseReadyCacheKey,
  getCacheJsonParseFailureCountersForTests,
  readCachedJson,
  resetCacheJsonParseFailureCountersForTests,
  safeJsonParse,
} from "../api-cache-read";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { conditionalGetResponse } from "../api-response";

describe("response-ready publication validators", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps a producer digest across assessments and changes it for same-clock replacement", async () => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const handler = createCacheHandler("test", "test", "public, max-age=60", 60, {
      responseReadyCache: "json-object", responseReadySchemaId: "test:v1",
    });
    const makeDb = (value: number) => mockD1([{ match: "cache", rows: [
      { key: "test", value: "{malformed", updated_at: now },
      { key: getResponseReadyCacheKey("test"), updated_at: now,
        value: encodeResponseReadyCacheValue(JSON.stringify({ value }), "test:v1") },
    ] }]);
    const db = makeDb(1);
    const first = await handler(db);
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/"[a-f0-9]{64}"$/);
    clock.mockReturnValue((now + 2) * 1000);
    const repeat = await handler(db);
    expect(repeat.headers.get("ETag")).toBe(etag);
    expect(conditionalGetResponse(new Request("https://site-api.pharos.watch/api/test", {
      headers: { "If-None-Match": etag },
    }), repeat).status).toBe(304);
    const changed = await handler(makeDb(2));
    expect(changed.headers.get("ETag")).not.toBe(etag);
    clock.mockReturnValue((now + 480) * 1000);
    const expired = await handler(db);
    expect(expired.headers.get("Cache-Control")).toBe("no-store");
    expect(expired.headers.get("ETag")).toBeNull();
  });
});

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
