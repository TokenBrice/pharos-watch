import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { DailySocialManifestSchema, dailySocialImageKey } from "@shared/lib/daily-social-manifest";
import { type DailySocialSnapshot } from "@shared/lib/daily-social";
import { captureWithFallback, makeDailySocialManifest, publishDailySocial, type DailySocialKv } from "../maintenance/publish-daily-social";

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

  it("rejects wrong clocks, wrong weekday content, altered copy and old data", () => {
    expect(() => makeDailySocialManifest(snapshot, png, snapshot.scheduledAt)).toThrow();
    expect(() => makeDailySocialManifest({ ...snapshot, scheduledAt: snapshot.scheduledAt - 3600 }, png, now)).toThrow();
    expect(() => makeDailySocialManifest({ ...snapshot, topic: "safety" }, png, now)).toThrow();
    expect(() => makeDailySocialManifest({ ...snapshot, asOf: now - 4 * 3600 }, png, now)).toThrow();
    expect(() => makeDailySocialManifest(snapshot, new Uint8Array([0]), now)).toThrow();
    expect(DailySocialManifestSchema.safeParse({ ...makeDailySocialManifest(snapshot, png, now), tweetText: "unverified text" }).success).toBe(false);
    expect(DailySocialManifestSchema.safeParse({ ...makeDailySocialManifest(snapshot, png, now), altText: "unverified alt text" }).success).toBe(false);
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
