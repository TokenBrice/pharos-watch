// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from "vitest";
import { Activity, BookOpen, ShieldCheck, Waves } from "lucide-react";

import {
  HOMEPAGE_DISCOVERY_POOL,
  HOMEPAGE_DISCOVERY_ROTATION_POOL,
  HOMEPAGE_DISCOVERY_STORAGE_KEY,
  advanceHomepageDiscoveryRotation,
  getHomepageDiscoveryCycleLength,
  interleaveDiscoverySuggestions,
  normalizeHomepageDiscoveryRotationState,
  selectHomepageDiscoverySuggestions,
  type HomepageDiscoverySuggestion,
} from "@/lib/homepage-discovery";

function suggestion(
  href: string,
  groupLabel: string,
  title = href,
): HomepageDiscoverySuggestion {
  return {
    title,
    description: `Open ${title}`,
    shortDescription: `Open ${title}`,
    href,
    groupLabel,
    accent: "var(--brand-accent)",
    icon: Activity,
  };
}

describe("homepage discovery pool", () => {
  it("dedupes route hrefs and interleaves the core discovery families", () => {
    const hrefs = HOMEPAGE_DISCOVERY_ROTATION_POOL.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(HOMEPAGE_DISCOVERY_ROTATION_POOL).toHaveLength(HOMEPAGE_DISCOVERY_POOL.length);
    expect(hrefs).not.toContain("/learn/");
    expect(hrefs).not.toContain("/methodology/");
    expect(hrefs).not.toContain("/start/");

    const firstFourGroups = [
      ...new Set(
        selectHomepageDiscoverySuggestions(HOMEPAGE_DISCOVERY_ROTATION_POOL, 0)
          .slice(0, 4)
          .map((item) => item.groupLabel),
      ),
    ];
    expect(firstFourGroups).toEqual(["CORE", "TRACK", "ANALYZE", "MONITOR"]);

    const selectedGroups = new Set(
      selectHomepageDiscoverySuggestions(HOMEPAGE_DISCOVERY_ROTATION_POOL, 0).map(
        (item) => item.groupLabel,
      ),
    );
    expect(selectedGroups).toEqual(new Set(["CORE", "TRACK", "ANALYZE", "MONITOR"]));
  });

  it("keeps duplicate hrefs from entering an interleaved pool", () => {
    const pool = interleaveDiscoverySuggestions([
      suggestion("/safety-scores/", "CORE", "Safety"),
      suggestion("/liquidity/", "TRACK", "Liquidity"),
      suggestion("/safety-scores/", "REFERENCE", "Report Cards"),
    ]);

    expect(pool.map((item) => item.href)).toEqual(["/safety-scores/", "/liquidity/"]);
  });

  it("selects one spotlight plus the next four suggestions from the chosen cursor", () => {
    const pool = [
      suggestion("/a/", "CORE"),
      suggestion("/b/", "TRACK"),
      suggestion("/c/", "ANALYZE"),
      suggestion("/d/", "MONITOR"),
      suggestion("/e/", "LEARN"),
      suggestion("/f/", "REFERENCE"),
      suggestion("/g/", "GUIDE"),
    ];

    expect(selectHomepageDiscoverySuggestions(pool, 0).map((item) => item.href)).toEqual([
      "/a/",
      "/b/",
      "/c/",
      "/d/",
      "/e/",
    ]);
    expect(selectHomepageDiscoverySuggestions(pool, 1).map((item) => item.href)).toEqual([
      "/b/",
      "/c/",
      "/d/",
      "/e/",
      "/f/",
    ]);
    expect(selectHomepageDiscoverySuggestions(pool, 5).map((item) => item.href)).toEqual([
      "/f/",
      "/g/",
      "/a/",
      "/b/",
      "/c/",
    ]);
  });

  it("keeps the chosen cursor as the spotlight when fewer than five suggestions exist", () => {
    const pool = [
      { ...suggestion("/a/", "CORE"), icon: ShieldCheck },
      { ...suggestion("/b/", "TRACK"), icon: Waves },
      { ...suggestion("/c/", "REFERENCE"), icon: BookOpen },
    ];

    expect(selectHomepageDiscoverySuggestions(pool, 1).map((item) => item.href)).toEqual([
      "/b/",
      "/c/",
      "/a/",
    ]);
  });
});

describe("homepage discovery rotation state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("normalizes corrupt or negative rotation state", () => {
    expect(normalizeHomepageDiscoveryRotationState(null)).toEqual({ cursor: 0 });
    expect(normalizeHomepageDiscoveryRotationState({ cursor: -3 })).toEqual({ cursor: 0 });
    expect(normalizeHomepageDiscoveryRotationState({ cursor: 2.8 })).toEqual({ cursor: 2 });
    expect(normalizeHomepageDiscoveryRotationState({ cursor: "2" })).toEqual({ cursor: 0 });
  });

  it("chooses a random spotlight cursor and stores it as the last visit cursor", () => {
    window.localStorage.setItem(HOMEPAGE_DISCOVERY_STORAGE_KEY, JSON.stringify({ cursor: 1 }));

    expect(advanceHomepageDiscoveryRotation(window.localStorage, 4, () => 0.9)).toBe(3);
    expect(JSON.parse(window.localStorage.getItem(HOMEPAGE_DISCOVERY_STORAGE_KEY) ?? "null")).toEqual({
      cursor: 3,
    });

    expect(advanceHomepageDiscoveryRotation(window.localStorage, 4, () => 0.9)).toBe(0);
    expect(JSON.parse(window.localStorage.getItem(HOMEPAGE_DISCOVERY_STORAGE_KEY) ?? "null")).toEqual({
      cursor: 0,
    });
  });

  it("keeps the cycle length bounded to the number of possible spotlights", () => {
    expect(getHomepageDiscoveryCycleLength(0)).toBe(1);
    expect(getHomepageDiscoveryCycleLength(3)).toBe(3);
    expect(getHomepageDiscoveryCycleLength(11)).toBe(11);
  });
});
