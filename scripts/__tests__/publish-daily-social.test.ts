import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { DailySocialManifestSchema, dailySocialImageKey } from "@shared/lib/daily-social-manifest";
import { buildDailySocialAltText, buildDailySocialTweetText, type DailySocialSnapshot } from "@shared/lib/daily-social";
import { captureWithFallback, makeDailySocialManifest, planDailySocial, publishDailySocial, type DailySocialKv } from "../maintenance/publish-daily-social";

const now = Date.parse("2026-09-14T11:30:00Z") / 1000;
const snapshot: DailySocialSnapshot = { schemaVersion: 1, editionDate: "2026-09-14", scheduledAt: now + 1800,
  capturedAt: now, asOf: now - 300, topic: "market-growth", title: "This week's market-cap growers",
  subtitle: "Seven-day dollars added", unit: "usd", rows: [{ id: "usdc-circle", name: "USD Coin", symbol: "USDC", value: 100e6, context: "$10B market cap" }],
  highlights: [], source: "Pharos API", methodology: "Positive changes among comparable tracked assets." };
let png: Uint8Array;
beforeAll(async () => {
  png = new Uint8Array(await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#102030" } }).png().toBuffer());
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function memoryKv() {
  const entries = new Map<string, Uint8Array>();
  const kv: DailySocialKv = { get: vi.fn(async (key) => entries.get(key) ?? null), put: vi.fn(async (key, value) => { entries.set(key, value); }) };
  return { kv, entries };
}

describe("daily social preparation and publication", () => {
  it("plans only before the Belgrade deadline and skips a completed edition", async () => {
    const { kv } = memoryKv();
    expect(await planDailySocial(kv, now - 3600)).toMatchObject({ shouldPrepare: false });
    expect(kv.get).not.toHaveBeenCalled();
    expect(await planDailySocial(kv, now)).toMatchObject({ shouldPrepare: true });
    await publishDailySocial(kv, makeDailySocialManifest(snapshot, png, now), png);
    expect(await planDailySocial(kv, now + 5)).toMatchObject({ shouldPrepare: false, reason: "already-prepared" });
  });

  it("verifies content-addressed bytes before committing a dated manifest", async () => {
    const { kv } = memoryKv();
    const manifest = makeDailySocialManifest(snapshot, png, now);
    expect(await publishDailySocial(kv, manifest, png)).toBe("prepared");
    expect(vi.mocked(kv.put).mock.calls.map(([key]) => key)).toEqual([
      dailySocialImageKey(snapshot.editionDate, hash(png)), "daily-social:2026-09-14.json",
    ]);
    expect(await publishDailySocial(kv, manifest, png)).toBe("already-prepared");
    expect(kv.put).toHaveBeenCalledTimes(2);
  });

  it("does not publish a manifest after failed image readback", async () => {
    const { kv } = memoryKv();
    vi.mocked(kv.get).mockResolvedValue(null);
    await expect(publishDailySocial(kv, makeDailySocialManifest(snapshot, png, now), png)).rejects.toThrow("readback");
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it("rejects a corrupt or incorrectly sized PNG before writing anything", async () => {
    const { kv } = memoryKv();
    const corrupt = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await expect(publishDailySocial(kv, makeDailySocialManifest(snapshot, corrupt, now), corrupt)).rejects.toThrow();
    const tiny = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "#102030" } }).png().toBuffer());
    await expect(publishDailySocial(kv, makeDailySocialManifest(snapshot, tiny, now), tiny)).rejects.toThrow("1600×1000");
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("can recover with a fresh capture without overwriting an uncommitted image", async () => {
    const { kv, entries } = memoryKv();
    const orphan = new Uint8Array([...png, 2]);
    const orphanKey = dailySocialImageKey(snapshot.editionDate, hash(orphan));
    entries.set(orphanKey, orphan);
    await publishDailySocial(kv, makeDailySocialManifest(snapshot, png, now), png);
    expect(entries.get(orphanKey)).toEqual(orphan);
    expect(kv.put).toHaveBeenCalledTimes(2);
  });

  it("dry run reads target state and never writes", async () => {
    const { kv } = memoryKv();
    expect(await publishDailySocial(kv, makeDailySocialManifest(snapshot, png, now), png, true)).toBe("would-publish");
    expect(kv.get).toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects wrong clocks, wrong weekday content, altered copy and old data", () => {
    expect(() => makeDailySocialManifest(snapshot, png, snapshot.scheduledAt)).toThrow();
    expect(() => makeDailySocialManifest({ ...snapshot, scheduledAt: snapshot.scheduledAt - 3600 }, png, now)).toThrow();
    expect(() => makeDailySocialManifest({ ...snapshot, topic: "safety" }, png, now)).toThrow();
    expect(() => makeDailySocialManifest({ ...snapshot, asOf: now - 4 * 3600 }, png, now)).toThrow();
    expect(() => makeDailySocialManifest(snapshot, new Uint8Array([0]), now)).toThrow();
    expect(DailySocialManifestSchema.safeParse({ ...makeDailySocialManifest(snapshot, png, now), tweetText: "unverified text" }).success).toBe(false);
    expect(DailySocialManifestSchema.safeParse({ ...makeDailySocialManifest(snapshot, png, now), altText: "unverified alt text" }).success).toBe(false);
  });

  it("allows only explicit overview fallbacks for the day's topic", () => {
    const fallback = { ...snapshot, topic: "market-overview" as const, fallbackFor: "market-growth" as const };
    expect(() => makeDailySocialManifest(fallback, png, now)).not.toThrow();
    expect(() => makeDailySocialManifest({ ...fallback, fallbackFor: "yield-watch" }, png, now)).toThrow();
    expect(() => makeDailySocialManifest({ ...fallback, topic: "safety" }, png, now)).toThrow();
  });

  it("uses fresh overview data after a topic fails, preserving the intended topic", async () => {
    const capture = vi.fn().mockRejectedValueOnce(new Error("missing history")).mockResolvedValueOnce({ ...snapshot, topic: "market-overview" });
    const result = await captureWithFallback("market-growth", snapshot, now, capture);
    expect(result.topic).toBe("market-overview");
    expect(result.fallbackFor).toBe("market-growth");
    expect(result.subtitle).toContain("evidence unavailable");
    expect(capture).toHaveBeenCalledTimes(2);
    expect(buildDailySocialTweetText(result).length).toBeLessThanOrEqual(280);
    expect(buildDailySocialAltText(result).length).toBeLessThanOrEqual(1000);
  });

  it("fails closed when neither source is usable", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("API unavailable"));
    await expect(captureWithFallback("market-growth", snapshot, now, capture)).rejects.toThrow("API unavailable");
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("falls back when the requested topic would be stale at the scheduled time", async () => {
    const capture = vi.fn().mockResolvedValueOnce({ ...snapshot, asOf: snapshot.scheduledAt - 3 * 3600 - 1 })
      .mockResolvedValueOnce({ ...snapshot, topic: "market-overview" });
    const result = await captureWithFallback("market-growth", snapshot, now, capture);
    expect(result.fallbackFor).toBe("market-growth");
    expect(result.asOf).toBe(snapshot.asOf);
  });
});
