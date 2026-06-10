import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_CACHE_PROFILE_DOCUMENTED_KEYS,
  API_CACHE_PROFILES,
  buildPerCoinCacheControl,
} from "../api-cache-profiles";

describe("API cache profiles", () => {
  it("keeps documented cache profiles stable", () => {
    expect(API_CACHE_PROFILES.realtime).toBe("public, s-maxage=60, max-age=10");
    expect(API_CACHE_PROFILES.producerBacked).toBe("public, s-maxage=300, max-age=60, stale-while-revalidate=300");
    expect(API_CACHE_PROFILES.standard).toBe("public, s-maxage=300, max-age=60");
    expect(API_CACHE_PROFILES.custom).toBe("public, s-maxage=300, max-age=300");
    expect(API_CACHE_PROFILES.perCoin).toBe("public, s-maxage=300, max-age=10");
    expect(API_CACHE_PROFILES.slow).toBe("public, s-maxage=3600, max-age=300");
    expect(API_CACHE_PROFILES.archive).toBe("public, s-maxage=86400, max-age=3600");
    expect(API_CACHE_PROFILES.noStore).toBe("no-store");
  });

  it("lists the documented profile keys in API reference order", () => {
    expect(API_CACHE_PROFILE_DOCUMENTED_KEYS).toEqual([
      "realtime",
      "producerBacked",
      "standard",
      "custom",
      "perCoin",
      "slow",
      "archive",
      "noStore",
    ]);
  });

  it("builds bounded per-coin cache headers", () => {
    expect(buildPerCoinCacheControl(300)).toBe("public, s-maxage=300, max-age=10");
    expect(buildPerCoinCacheControl(12.9)).toBe("public, s-maxage=12, max-age=10");
    expect(buildPerCoinCacheControl(-10)).toBe("public, s-maxage=0, max-age=10");
  });

  it("stays aligned with the documented API cache profile table", () => {
    const docs = readFileSync(join(process.cwd(), "docs/api-reference.md"), "utf8");
    const documentedProfileNames: Record<(typeof API_CACHE_PROFILE_DOCUMENTED_KEYS)[number], string> = {
      realtime: "realtime",
      producerBacked: "producer-backed",
      standard: "standard",
      custom: "custom",
      perCoin: "per-coin",
      slow: "slow",
      archive: "archive",
      noStore: "no-store",
    };

    for (const key of API_CACHE_PROFILE_DOCUMENTED_KEYS) {
      const profileName = documentedProfileNames[key];
      expect(docs).toContain(`| ${profileName}`);
      expect(docs).toContain(API_CACHE_PROFILES[key]);
    }
  });
});
