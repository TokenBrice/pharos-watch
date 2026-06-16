import type { DeadStablecoin } from "@shared/types";
export { sortCemeteryCoins } from "@shared/lib/cemetery";
export type { CemeterySortMode } from "@shared/lib/cemetery";

export interface CemeteryYearSection {
  year: string;
  coins: DeadStablecoin[];
}

/**
 * Groups coins into contiguous year sections. Precondition: `coins` must be
 * pre-sorted by death date (see `sortCemeteryCoins`) — the grouping coalesces
 * only adjacent same-year coins, so unsorted input would split a year into
 * multiple sections. A missing/malformed `deathDate` is bucketed under
 * "Unknown" rather than producing an `undefined` year key.
 */
export function buildCemeteryYearSections(coins: DeadStablecoin[]): CemeteryYearSection[] {
  const sections: CemeteryYearSection[] = [];

  for (const coin of coins) {
    const year = coin.deathDate?.split("-")[0] ?? "Unknown";
    const currentSection = sections.at(-1);

    if (currentSection?.year === year) {
      currentSection.coins.push(coin);
      continue;
    }

    sections.push({
      year,
      coins: [coin],
    });
  }

  return sections;
}
