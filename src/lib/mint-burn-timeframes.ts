import { DAY_HOURS, WEEK_HOURS, THIRTY_DAYS_HOURS, NINETY_DAYS_HOURS } from "@/lib/constants";

interface MintBurnSummaryTimeframePreset {
  shortHours: number;
  longHours: number;
}

interface ResolvedMintBurnSummaryTimeframePreset extends MintBurnSummaryTimeframePreset {
  shortLabel: string;
  longLabel: string;
}

const DEFAULT_SUMMARY_TIMEFRAME: MintBurnSummaryTimeframePreset = {
  shortHours: DAY_HOURS,
  longHours: WEEK_HOURS,
};

const SUMMARY_TIMEFRAME_OVERRIDES: Record<string, MintBurnSummaryTimeframePreset> = {
  // USDT mints/redeems in larger, less frequent batches, so shorter windows are often too sparse.
  "usdt-tether": { shortHours: THIRTY_DAYS_HOURS, longHours: NINETY_DAYS_HOURS },
};

export function formatMintBurnWindowLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "N/A";
  if (hours === DAY_HOURS) return "24h";
  if (hours % DAY_HOURS === 0) return `${hours / DAY_HOURS}d`;
  return `${hours}h`;
}

export function getMintBurnSummaryTimeframe(stablecoinId: string): ResolvedMintBurnSummaryTimeframePreset {
  const override = SUMMARY_TIMEFRAME_OVERRIDES[stablecoinId];
  const raw = override ?? DEFAULT_SUMMARY_TIMEFRAME;

  const shortHours = Math.max(1, Math.floor(raw.shortHours));
  const longHours = Math.max(shortHours, Math.floor(raw.longHours));

  return {
    shortHours,
    longHours,
    shortLabel: formatMintBurnWindowLabel(shortHours),
    longLabel: formatMintBurnWindowLabel(longHours),
  };
}

interface MintBurnNetFlows {
  netFlow24hUsd: number;
  netFlow7dUsd: number;
  netFlow30dUsd: number;
  netFlow90dUsd: number;
}

export function getNetFlowForHours(
  coin: MintBurnNetFlows,
  hours: number,
): number | null {
  if (hours === DAY_HOURS) return coin.netFlow24hUsd;
  if (hours === WEEK_HOURS) return coin.netFlow7dUsd;
  if (hours === THIRTY_DAYS_HOURS) return coin.netFlow30dUsd;
  if (hours === NINETY_DAYS_HOURS) return coin.netFlow90dUsd;
  return null;
}

/**
 * Resolves the short/long net-flow values shown on the flow summary card.
 * Custom-window net flows (from the per-coin hook) win when present and finite;
 * otherwise the matching coin field is used, falling back to the 24h/7d fields.
 * Pure so it can be tested independently of the component render path.
 */
export function resolveFlowWindow(
  coin: MintBurnNetFlows,
  timeframe: Pick<MintBurnSummaryTimeframePreset, "shortHours" | "longHours">,
  shortWindowNetFlowUsd: number | undefined,
  longWindowNetFlowUsd: number | undefined,
): { shortNetFlow: number; longNetFlow: number } {
  const needsCustomShortWindow = timeframe.shortHours !== DAY_HOURS;
  const needsCustomLongWindow = timeframe.longHours !== WEEK_HOURS;
  const shouldFetchLongWindow =
    needsCustomLongWindow && timeframe.longHours !== timeframe.shortHours;

  const fallbackShortNetFlow =
    getNetFlowForHours(coin, timeframe.shortHours) ?? coin.netFlow24hUsd;
  const fallbackLongNetFlow =
    getNetFlowForHours(coin, timeframe.longHours) ?? coin.netFlow7dUsd;

  const shortNetFlowCandidate = needsCustomShortWindow
    ? (shortWindowNetFlowUsd ?? fallbackShortNetFlow)
    : coin.netFlow24hUsd;
  const longNetFlowCandidate = needsCustomLongWindow
    ? (
      shouldFetchLongWindow
        ? (longWindowNetFlowUsd ?? fallbackLongNetFlow)
        : shortNetFlowCandidate
    )
    : coin.netFlow7dUsd;

  return {
    shortNetFlow: Number.isFinite(shortNetFlowCandidate)
      ? shortNetFlowCandidate
      : coin.netFlow24hUsd,
    longNetFlow: Number.isFinite(longNetFlowCandidate)
      ? longNetFlowCandidate
      : coin.netFlow7dUsd,
  };
}
