import { describe, expect, it } from "vitest";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { getAboutLeadParagraphs } from "@/lib/about-content";

describe("about lead paragraphs", () => {
  const ACTIVE_STABLECOINS = 265;
  const [lead] = getAboutLeadParagraphs({ activeStablecoins: ACTIVE_STABLECOINS }).slice(1);

  it("places the core-universe count once, ahead of the blacklist clause", () => {
    const countMatches = lead.match(new RegExp(`\\b${ACTIVE_STABLECOINS}\\b`, "gu")) ?? [];
    expect(countMatches).toHaveLength(1);
    const blacklistClause = lead.match(/public blacklist monitoring[^:]*/u)?.[0] ?? "";
    expect(blacklistClause).not.toBe("");
    expect(blacklistClause).not.toContain(String(ACTIVE_STABLECOINS));
    expect(lead.slice(0, lead.indexOf(blacklistClause))).toContain(`${ACTIVE_STABLECOINS}-asset core universe`);
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
