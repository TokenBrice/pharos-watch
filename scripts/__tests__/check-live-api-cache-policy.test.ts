import { describe, expect, it, vi } from "vitest";
import { API_CACHE_PROFILES } from "../../shared/lib/api-cache-profiles";
import { ENDPOINT_DEFINITIONS } from "../../shared/lib/api-endpoints/definitions";
import { compareLiveCacheControl, runLiveApiCachePolicyCheck } from "../ci/check-live-api-cache-policy.mjs";

const manifest = { zone: { browser_cache_ttl: 60 } };
const effectiveProfiles: Record<string, string> = {
  realtime: "public, s-maxage=60, max-age=60",
  producerBacked: "public, s-maxage=300, max-age=60, stale-while-revalidate=300",
  slow: "public, s-maxage=3600, max-age=300",
  noStore: "no-store",
};

function responseFor(url: string, override?: string, status = 200) {
  const path = new URL(url).pathname;
  const profile = path.endsWith("/health") ? "realtime" : path.endsWith("/stablecoins") ? "producerBacked"
    : path.endsWith("/bluechip-ratings") ? "slow" : "noStore";
  return new Response("{}", { status, headers: {
    "Content-Type": "application/json", "Cache-Control": override ?? effectiveProfiles[profile],
  } });
}

describe("live API Cache-Control drift", () => {
  it("accepts the source browser TTL (origin miss) or the documented floor (cache hit), retaining edge TTL and SWR", () => {
    expect(compareLiveCacheControl(effectiveProfiles.realtime, "realtime", 60).issues).toEqual([]);
    expect(compareLiveCacheControl(effectiveProfiles.producerBacked, "producerBacked", 60).issues).toEqual([]);
    expect(compareLiveCacheControl(effectiveProfiles.slow, "slow", 60).issues).toEqual([]);
    expect(compareLiveCacheControl('MAX-AGE="60", PUBLIC, S-MAXAGE=60', "realtime", 60).issues).toEqual([]);
    expect(compareLiveCacheControl(API_CACHE_PROFILES.perCoin, "perCoin", 60).issues).toEqual([]);
    expect(compareLiveCacheControl("public, max-age=30, s-maxage=60", "realtime", 60).issues).toContain('max-age: expected "60", found "30"');
    expect(compareLiveCacheControl("public, max-age=1200, s-maxage=300", "perCoin", 60).issues).toContain('max-age: expected "60", found "1200"');
    expect(compareLiveCacheControl("public, max-age=60, s-maxage=1200", "realtime", 60).issues).toContain('s-maxage: expected "60", found "1200"');
    expect(compareLiveCacheControl("public, s-maxage=300, max-age=60", "producerBacked", 60).issues).toContain('stale-while-revalidate: expected "300", found "absent"');
    expect(compareLiveCacheControl(API_CACHE_PROFILES.realtime, "realtime", 0).issues).toEqual([]);
  });

  it("never lifts no-store or accepts missing, duplicate, or extra directives", () => {
    expect(compareLiveCacheControl("no-store", "noStore", 60).issues).toEqual([]);
    expect(compareLiveCacheControl("no-store, max-age=60", "noStore", 60).issues).toContain('max-age: expected "absent", found "60"');
    expect(compareLiveCacheControl(null, "realtime", 60).issues[0]).toContain("malformed Cache-Control");
    expect(compareLiveCacheControl("public, max-age=60, max-age=1200", "realtime", 60).issues[0]).toContain("duplicate Cache-Control directive max-age");
    expect(compareLiveCacheControl(`${effectiveProfiles.realtime}, private`, "realtime", 60).issues).toContain('private: expected "absent", found true');
    expect(() => compareLiveCacheControl("no-store", "noStore", undefined)).toThrow("zone.browser_cache_ttl");
  });

  it("GETs exempt direct and browser-shaped site-data responses without credentials", async () => {
    const fetchImpl = vi.fn(async (url: string) => responseFor(url));
    const report = await runLiveApiCachePolicyCheck({ manifest, fetchImpl, consoleImpl: { log: vi.fn() } });
    expect(report.ok).toBe(true);
    expect(report.rows).toHaveLength(6);
    expect(report.summary).toContain("account settings are assessed separately");
    for (const [url, init] of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init.headers);
      expect(headers.has("X-API-Key")).toBe(false);
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("X-Pharos-Site-Proxy-Secret")).toBe(false);
      if (new URL(url).hostname === "api.pharos.watch") {
        expect(ENDPOINT_DEFINITIONS.find((entry) => entry.path === new URL(url).pathname)?.publicApiAccess).toBe("exempt");
      } else {
        expect(new URL(url).origin).toBe("https://pharos.watch");
        expect(new URL(url).pathname).toMatch(/^\/_site-data\//);
        expect(headers.get("Origin")).toBe("https://pharos.watch");
        expect(headers.get("Referer")).toBe("https://pharos.watch/");
      }
    }
  });

  it("fails with endpoint-specific evidence while still collecting every response", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("api.pharos.watch/api/health")) throw new Error("network unavailable");
      if (url.includes("/_site-data/health")) return responseFor(url, "public, max-age=1200, s-maxage=60");
      if (url.includes("/_site-data/stablecoins")) return responseFor(url, effectiveProfiles.producerBacked, 503);
      if (url.includes("/_site-data/bluechip-ratings")) return new Response("challenge", { headers: { "Content-Type": "text/html" } });
      return responseFor(url);
    });
    const report = await runLiveApiCachePolicyCheck({ manifest, fetchImpl, consoleImpl: { log } });
    expect(report.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(report.summary).toContain("FAIL [direct/realtime] https://api.pharos.watch/api/health");
    expect(report.summary).toContain("public GET failed: network unavailable");
    expect(report.summary).toContain('max-age: expected "60", found "1200"');
    expect(report.summary).toContain("expected direct HTTP 200, found 503");
    expect(report.summary).toContain("expected application/json response");
    expect(log).toHaveBeenCalledWith(report.summary);
  });
});
