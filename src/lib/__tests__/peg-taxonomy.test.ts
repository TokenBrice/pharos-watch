import { describe, expect, it } from "vitest";
import { resolveBlacklistStatusBucket, type BlacklistStatusBucketKey } from "@shared/lib/blacklist-status-buckets";
import { PEG_TAXONOMY_PAGES, type PegTaxonomyPage } from "../peg-taxonomy";

function freezeBucketCounts(page: PegTaxonomyPage): Record<BlacklistStatusBucketKey, number> {
  const counts: Record<BlacklistStatusBucketKey, number> = { yes: 0, upstream: 0, possible: 0, no: 0 };
  for (const coin of page.coins) {
    if (coin.blacklistStatus == null) continue;
    counts[resolveBlacklistStatusBucket(coin.blacklistStatus)] += 1;
  }
  return counts;
}

describe("peg risk summary freeze exposure", () => {
  it.each(PEG_TAXONOMY_PAGES.map((page) => [page.value, page] as const))(
    "names every reviewed freeze bucket for %s",
    (_peg, page) => {
      const counts = freezeBucketCounts(page);
      const indirect = counts.upstream + counts.possible;
      if (counts.yes > 0) {
        expect(page.riskSummary).toContain(`${counts.yes} tracked coin`);
        if (indirect > 0) {
          expect(page.riskSummary).toContain(
            indirect === 1 ? "1 more inherits that exposure" : `${indirect} more inherit that exposure`,
          );
        }
      } else if (indirect > 0) {
        expect(page.riskSummary).toContain(`${indirect} tracked coin`);
        expect(page.riskSummary).toContain("reviewed freeze exposure through collateral or possible controls");
      } else {
        expect(page.riskSummary).toContain("No tracked coin in this cohort is marked as directly freezable");
      }
    },
  );

  it("keeps possible and inherited exposure visible where nothing is directly freezable", () => {
    const cop = PEG_TAXONOMY_PAGES.find((page) => page.value === "COP")!;
    expect(cop.riskSummary).toContain("2 tracked coins in the cohort carry reviewed freeze exposure");
    const php = PEG_TAXONOMY_PAGES.find((page) => page.value === "PHP")!;
    expect(php.riskSummary).toContain("1 tracked coin in the cohort carries reviewed freeze exposure");
  });

  it("never collapses reviewed possible or inherited controls into an absence claim", () => {
    for (const page of PEG_TAXONOMY_PAGES) {
      const counts = freezeBucketCounts(page);
      if (counts.yes === 0 && counts.upstream + counts.possible === 0) continue;
      expect(page.riskSummary).not.toContain("No tracked coin in this cohort is marked as directly freezable");
    }
  });
});
