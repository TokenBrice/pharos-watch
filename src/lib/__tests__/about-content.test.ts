import { describe, expect, it } from "vitest";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { getAboutLeadParagraphs } from "@/lib/about-content";

describe("about lead paragraphs", () => {
  const [lead] = getAboutLeadParagraphs({ activeStablecoins: 265 }).slice(1);

  it("scopes the core-universe count to reserve and depeg coverage, not blacklist monitoring", () => {
    expect(lead).toContain("forward-looking depeg warnings across a 265-asset core universe");
    expect(lead).toContain("public blacklist monitoring:");
    expect(lead.match(/public blacklist monitoring[^:]*/u)?.[0]).not.toContain("265");
  });

  it("qualifies live reserve coverage instead of claiming every core asset has a feed", () => {
    expect(lead).toContain("Live reserve feeds where a reviewed adapter exists");
  });

  it("does not attach either the core-universe count or the freeze-scan count to the blacklist clause", () => {
    const blacklistClause = lead.match(/public blacklist monitoring[^:]*/u)?.[0] ?? "";
    expect(lead).not.toMatch(/blacklist (monitoring )?across [^.]*\b265\b/u);
    expect(blacklistClause).not.toContain(String(BLACKLIST_STABLECOINS.length));
  });
});
