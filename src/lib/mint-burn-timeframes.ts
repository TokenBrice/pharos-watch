const DAY_HOURS = 24;

export interface MintBurnSummaryTimeframePreset {
  shortHours: number;
  longHours: number;
}

export interface ResolvedMintBurnSummaryTimeframePreset extends MintBurnSummaryTimeframePreset {
  shortLabel: string;
  longLabel: string;
}

const DEFAULT_SUMMARY_TIMEFRAME: MintBurnSummaryTimeframePreset = {
  shortHours: 24,
  longHours: 7 * DAY_HOURS,
};

const SUMMARY_TIMEFRAME_OVERRIDES: Record<string, MintBurnSummaryTimeframePreset> = {
  // USDT mints/redeems in larger, less frequent batches, so shorter windows are often too sparse.
  "1": { shortHours: 30 * DAY_HOURS, longHours: 90 * DAY_HOURS },
};

export function formatMintBurnWindowLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "N/A";
  if (hours === 24) return "24h";
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

export function getNetFlowForHours(
  coin: {
    netFlow24hUsd: number;
    netFlow7dUsd: number;
    netFlow30dUsd: number;
    netFlow90dUsd: number;
  },
  hours: number,
): number | null {
  if (hours === 24) return coin.netFlow24hUsd;
  if (hours === 7 * DAY_HOURS) return coin.netFlow7dUsd;
  if (hours === 30 * DAY_HOURS) return coin.netFlow30dUsd;
  if (hours === 90 * DAY_HOURS) return coin.netFlow90dUsd;
  return null;
}
