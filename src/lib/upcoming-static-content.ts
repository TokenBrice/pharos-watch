import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import type { LaunchMilestone, PegCurrency, StablecoinMeta } from "@shared/types";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { dateScore, formatFuzzyDate } from "@/lib/pre-launch";

/**
 * Static `/upcoming/` body sections built from registry metadata at build
 * time: a dated launch-news list and per-currency groups. Nothing here reads a
 * clock, so server and hydrated HTML match.
 */

export const LATEST_LAUNCH_NEWS_LIMIT = 10;

type UpcomingStaticCoin = Pick<StablecoinMeta, "id" | "name" | "symbol" | "flags" | "milestones">;

export interface LaunchNewsItem {
  key: string;
  /** Registry date verbatim, for `<time dateTime>`. */
  date: string;
  /** "Sep 25, 2026", or the recorded precision ("Mar 2026"). */
  dateLabel: string;
  symbol: string;
  title: string;
  href: string;
}

/** The newest milestones across every pre-launch coin, newest first; equal dates keep registry order. */
export function buildLatestLaunchNews(
  coins: readonly UpcomingStaticCoin[],
  limit = LATEST_LAUNCH_NEWS_LIMIT,
): LaunchNewsItem[] {
  return coins
    .flatMap((coin) =>
      (coin.milestones ?? []).map((milestone: LaunchMilestone) => ({ coin, milestone, score: dateScore(milestone.date) })),
    )
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ coin, milestone }) => ({
      key: `${coin.id}-${milestone.date}-${milestone.title}`,
      date: milestone.date,
      dateLabel: formatFuzzyDate(milestone.date),
      symbol: coin.symbol,
      title: milestone.title,
      href: buildStablecoinUrl(coin.id),
    }));
}

export interface UpcomingCurrencyGroup {
  peg: PegCurrency;
  /** "Upcoming Hong Kong Dollar (HKD) stablecoins" */
  heading: string;
  /** The peg's `/stablecoins/<peg>/` hub, when one exists, and its link label. */
  hubHref: string | null;
  hubLabel: string;
  coins: { id: string; name: string; symbol: string; href: string }[];
}

const UNCODED_PEGS: ReadonlySet<PegCurrency> = new Set<PegCurrency>(["GOLD", "SILVER", "VAR"]);

function groupHeading(peg: PegCurrency): string {
  if (peg === "OTHER") return "Upcoming stablecoins on other pegs";
  const label = PEG_LABELS_SHORT[peg] ?? peg;
  return UNCODED_PEGS.has(peg) ? `Upcoming ${label} stablecoins` : `Upcoming ${label} (${peg}) stablecoins`;
}

/** Pre-launch coins grouped by peg, largest group first (ties by first appearance); "other" pegs last. */
export function buildUpcomingCurrencyGroups(coins: readonly UpcomingStaticCoin[]): UpcomingCurrencyGroup[] {
  const groups = new Map<PegCurrency, UpcomingCurrencyGroup>();
  for (const coin of coins) {
    const peg = coin.flags.pegCurrency;
    let group = groups.get(peg);
    if (!group) {
      group = {
        peg,
        heading: groupHeading(peg),
        hubHref: buildPegLandingUrl(peg),
        hubLabel: `All ${UNCODED_PEGS.has(peg) ? PEG_LABELS_SHORT[peg] : peg} stablecoins`,
        coins: [],
      };
      groups.set(peg, group);
    }
    group.coins.push({ id: coin.id, name: coin.name, symbol: coin.symbol, href: buildStablecoinUrl(coin.id) });
  }
  return [...groups.values()].sort(
    (left, right) =>
      Number(left.peg === "OTHER") - Number(right.peg === "OTHER") || right.coins.length - left.coins.length,
  );
}
