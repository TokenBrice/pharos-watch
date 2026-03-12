import type { DeadStablecoin } from "@shared/types";

export type CemeterySortMode = "newest" | "oldest";

export const MAJOR_CEMETERY_COLLAPSE_MCAP = 1_000_000_000;

export interface CemeteryYearSection {
  year: string;
  coins: DeadStablecoin[];
}

function getDeathMonthValue(deathDate: string): number {
  const [yearPart, monthPart] = deathDate.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart ?? "1");

  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return 0;
  }

  return year * 12 + Math.max(0, month - 1);
}

function comparePeakMcapDesc(a: DeadStablecoin, b: DeadStablecoin): number {
  return (b.peakMcap ?? 0) - (a.peakMcap ?? 0);
}

function compareSymbolAsc(a: DeadStablecoin, b: DeadStablecoin): number {
  return a.symbol.localeCompare(b.symbol);
}

export function isMajorCemeteryCollapse(coin: DeadStablecoin): boolean {
  return (coin.peakMcap ?? 0) >= MAJOR_CEMETERY_COLLAPSE_MCAP;
}

export function sortCemeteryCoins(
  coins: DeadStablecoin[],
  sortMode: CemeterySortMode = "newest",
): DeadStablecoin[] {
  return [...coins].sort((a, b) => {
    const deathDiff = sortMode === "newest"
      ? getDeathMonthValue(b.deathDate) - getDeathMonthValue(a.deathDate)
      : getDeathMonthValue(a.deathDate) - getDeathMonthValue(b.deathDate);

    if (deathDiff !== 0) {
      return deathDiff;
    }

    const majorDiff = Number(isMajorCemeteryCollapse(b)) - Number(isMajorCemeteryCollapse(a));
    if (majorDiff !== 0) {
      return majorDiff;
    }

    const peakDiff = comparePeakMcapDesc(a, b);
    if (peakDiff !== 0) {
      return peakDiff;
    }

    return compareSymbolAsc(a, b);
  });
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
