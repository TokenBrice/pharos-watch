import type { DeadStablecoin } from "@shared/types";
export { sortCemeteryCoins } from "@shared/lib/cemetery";
export type { CemeterySortMode } from "@shared/lib/cemetery";

export interface CemeteryYearSection {
  year: string;
  coins: DeadStablecoin[];
}

export function buildCemeteryYearSections(coins: DeadStablecoin[]): CemeteryYearSection[] {
  const sections: CemeteryYearSection[] = [];

  for (const coin of coins) {
    const [year] = coin.deathDate.split("-");
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
