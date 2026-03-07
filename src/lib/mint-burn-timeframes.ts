import { DAY_HOURS, WEEK_HOURS, THIRTY_DAYS_HOURS, NINETY_DAYS_HOURS } from "@/lib/constants";

export interface MintBurnSummaryTimeframePreset {
  shortHours: number;
  longHours: number;
}

export interface ResolvedMintBurnSummaryTimeframePreset extends MintBurnSummaryTimeframePreset {
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

export function getNetFlowForHours(
  coin: {
    netFlow24hUsd: number;
    netFlow7dUsd: number;
    netFlow30dUsd: number;
    netFlow90dUsd: number;
  },
  hours: number,
): number | null {
  if (hours === DAY_HOURS) return coin.netFlow24hUsd;
  if (hours === WEEK_HOURS) return coin.netFlow7dUsd;
  if (hours === THIRTY_DAYS_HOURS) return coin.netFlow30dUsd;
  if (hours === NINETY_DAYS_HOURS) return coin.netFlow90dUsd;
  return null;
}
