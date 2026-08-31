import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDigestSafetyMapCaptions,
  MAX_SAFETY_MAP_CARRY_FORWARD_DAYS,
  resolveDigestSafetyMap,
  type DigestSafetyMapSummary,
} from "../digest-safety-map";

const NOW_SEC = 1_777_000_000;
const DATE = "2026-04-25";
const DAY_SEC = 86_400;

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    date: DATE,
    asOfSec: NOW_SEC - 60,
    renderedAtSec: NOW_SEC - 30,
    edition: "daily",
    bytes: { png: 1_234_567 },
    ...overrides,
  };
}

function mapSummary(overrides: Record<string, unknown> = {}): DigestSafetyMapSummary {
  return {
    date: DATE,
    asOfSec: NOW_SEC - 60,
    methodologyVersion: "v9.1",
    gradedCount: 318,
    notRatedCount: 7,
    totalMcapUsd: 100_000_000_000,
    floorMcapByTier: { a: 4_700_000_000, other: 2_400_000_000 },
    tiers: [
      { tier: "A", range: "80-100", count: 13, mcapUsd: 81_800_000_000, sharePct: 81.8, leaders: [] },
      { tier: "B", range: "60-79", count: 41, mcapUsd: 7_000_000_000, sharePct: 7, leaders: [] },
      { tier: "C", range: "40-59", count: 133, mcapUsd: 3_000_000_000, sharePct: 3, leaders: [] },
      { tier: "D", range: "20-39", count: 75, mcapUsd: 5_000_000_000, sharePct: 5, leaders: [] },
      { tier: "F", range: "0-19", count: 56, mcapUsd: 3_200_000_000, sharePct: 3.2, leaders: [] },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("digest Safety Score map resolution", () => {
  it("returns the dated image only after a current manifest and successful HEAD", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/safety-scores/map.json")) {
        return new Response(JSON.stringify(manifest()), { status: 200 });
      }
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 200, headers: { "Content-Type": "image/png" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await resolveDigestSafetyMap(DATE, NOW_SEC);
    expect(result).toMatchObject({
      kind: "available",
      imageUrl: `https://pharos.watch/safety-scores/map.png?date=${DATE}`,
      freshness: "current",
      ageDays: 0,
    });
    expect(result.kind === "available" ? result.manifest.mapSummary : null).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    [1, "2026-04-24"],
    [MAX_SAFETY_MAP_CARRY_FORWARD_DAYS, "2026-04-23"],
  ])("carries a map forward by %i UTC day(s)", async (ageDays, manifestDate) => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/safety-scores/map.json")) {
        return new Response(JSON.stringify(manifest({ date: manifestDate })), { status: 200 });
      }
      expect(url).toBe(`https://pharos.watch/safety-scores/map.png?date=${manifestDate}`);
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 200, headers: { "Content-Type": "image/png" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await resolveDigestSafetyMap(DATE, NOW_SEC);

    expect(result).toMatchObject({
      kind: "available",
      imageUrl: `https://pharos.watch/safety-scores/map.png?date=${manifestDate}`,
      freshness: "carried-forward",
      ageDays,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects a manifest beyond the carry-forward window without probing its image", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(manifest({ date: "2026-04-22" })), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(resolveDigestSafetyMap(DATE, NOW_SEC)).resolves.toEqual({
      kind: "unavailable",
      reason: "manifest-too-old",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a future-dated manifest rather than carrying it backward", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(manifest({ date: "2026-04-26" })), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(resolveDigestSafetyMap(DATE, NOW_SEC)).resolves.toEqual({
      kind: "unavailable",
      reason: "manifest-too-old",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the image available without prose when mapSummary is malformed", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest({
        mapSummary: mapSummary({ tiers: [{ tier: "A", count: "13" }] }),
      })), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await resolveDigestSafetyMap(DATE, NOW_SEC);

    expect(result).toMatchObject({
      kind: "available",
      imageUrl: `https://pharos.watch/safety-scores/map.png?date=${DATE}`,
    });
    expect(result.kind === "available" ? result.manifest.mapSummary : null).toBeUndefined();
  });

  it("builds computed channel captions from a valid mapSummary", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest({ mapSummary: mapSummary() })), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await resolveDigestSafetyMap(DATE, NOW_SEC);
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;

    expect(buildDigestSafetyMapCaptions(result.manifest.mapSummary, "current", 0)).toEqual({
      tweetHook: "Of 100B USD in mapped supply, A tier’s 13 coins hold 81.8%; C/D/F’s 264 hold 11.2%. Find yours on today’s map.",
      telegramAppendixHtml: [
        "<b>Today’s map</b>",
        "Mapped supply: $100B across 318 coins",
        "A tier: 13 coins · 81.8%",
        "C/D/F tiers: 264 coins · 11.2%",
      ].join("\n"),
    });
  });

  it("labels a carried-forward caption with the map's actual date", () => {
    const summary = mapSummary({ date: "2026-04-24" });

    expect(buildDigestSafetyMapCaptions(summary, "carried-forward", 1)).toEqual({
      tweetHook: "Of 100B USD in mapped supply, A tier’s 13 coins hold 81.8%; C/D/F’s 264 hold 11.2%. Find yours on the 24 Apr map.",
      telegramAppendixHtml: [
        "<b>24 Apr map</b>",
        "Mapped supply: $100B across 318 coins",
        "A tier: 13 coins · 81.8%",
        "C/D/F tiers: 264 coins · 11.2%",
      ].join("\n"),
    });
  });

  it.each([
    [manifest({ asOfSec: NOW_SEC - (MAX_SAFETY_MAP_CARRY_FORWARD_DAYS + 1) * DAY_SEC }), "manifest-data-stale"],
    [manifest({ asOfSec: NOW_SEC + 1 }), "manifest-data-stale"],
    [manifest({ edition: "monthly" }), "manifest-invalid"],
  ])("omits a map that violates the publication contract", async (body, reason) => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(resolveDigestSafetyMap(DATE, NOW_SEC)).resolves.toEqual({ kind: "unavailable", reason });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("omits a map when the dated image is absent", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest()), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(resolveDigestSafetyMap(DATE, NOW_SEC)).resolves.toEqual({
      kind: "unavailable",
      reason: "image-http-404",
    });
  });

  it("uses an independent 8-second timeout for each phase", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const phaseSignals: AbortSignal[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      phaseSignals.push(init?.signal as AbortSignal);
      if (String(input).endsWith("/safety-scores/map.json")) {
        return new Response(JSON.stringify(manifest()), { status: 200 });
      }
      return new Response(null, { status: 200, headers: { "Content-Type": "image/png" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await resolveDigestSafetyMap(DATE, NOW_SEC);

    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 8_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 8_000);
    expect(phaseSignals[0]).toBeDefined();
    expect(phaseSignals[1]).toBeDefined();
    expect(phaseSignals[0]).not.toBe(phaseSignals[1]);
  });

  it("rethrows a caller abort instead of converting it to unavailable", async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException("caller cancelled", "AbortError");
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(resolveDigestSafetyMap(DATE, NOW_SEC, controller.signal)).rejects.toThrow("caller cancelled");
  });
});
