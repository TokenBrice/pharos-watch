import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_CACHE_PROFILE_DOCUMENTED_KEYS,
  API_CACHE_PROFILES,
  buildPerCoinCacheControl,
} from "../api-cache-profiles";

describe("API cache profiles", () => {

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

    const rows = [...docs.matchAll(/^\| ([\w-]+)\s*\| `([^`]+)`\s*\|/gm)];
    for (const key of API_CACHE_PROFILE_DOCUMENTED_KEYS) {
      const profileName = documentedProfileNames[key];
      expect(rows.filter((row) => row[1] === profileName).map((row) => row[2]))
        .toEqual([API_CACHE_PROFILES[key]]);
    }
  });
});
